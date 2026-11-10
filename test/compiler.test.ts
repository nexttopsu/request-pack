import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
    attr, html, json, loop, nullable, object, text,
    isFieldShape,
    type Field, type ParsedResult, type Schema, type TextField,
} from '../src/lib/parser.ts';
import { compileField, compileFieldTree, compileSchema } from '../src/lib/fetcher/compiler.ts';
import { FetcherError } from '../src/lib/fetcher/errors.ts';
import { formatPath, validateOptions } from '../src/lib/fetcher/schema.ts';
import { composeSignals } from '../src/lib/fetcher/signals.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

describe('compileFieldTree · 编译映射', () => {
    it('text / html / attr 的 required / min / max / pattern 与 nullable 顺序', () => {
        const required = compileFieldTree({ title: text('h1', { required: true }) });
        assert.equal(required.safeParse({ title: '' }).success, false, 'required 必须拦住空串');
        assert.equal(required.safeParse({ title: '有值' }).success, true);

        const bounded = compileFieldTree({
            code: text('code', { min: 2, max: 4, pattern: /^\d+$/ }),
            body: html('body', { max: 3 }),
            href: attr('href', 'a', { required: true }),
        });
        assert.equal(bounded.safeParse({ code: '12', body: 'ab', href: '/x' }).success, true);
        assert.equal(bounded.safeParse({ code: '1', body: 'ab', href: '/x' }).success, false, 'min');
        assert.equal(bounded.safeParse({ code: '12345', body: 'ab', href: '/x' }).success, false, 'max');
        assert.equal(bounded.safeParse({ code: 'abc', body: 'ab', href: '/x' }).success, false, 'pattern');
        assert.equal(bounded.safeParse({ code: '12', body: 'abcd', href: '/x' }).success, false);
        assert.equal(bounded.safeParse({ code: '12', body: 'ab', href: '' }).success, false);

        const stringPattern = compileField(text('x', { pattern: '^[A-Z]+$' }));
        assert.equal(stringPattern.safeParse('ABC').success, true);
        assert.equal(stringPattern.safeParse('abc').success, false);

        // nullable 在约束之后：未匹配是 null，空串仍受 required 约束
        const nullableRequired = compileFieldTree({ price: nullable(text('.p', { required: true })) });
        assert.equal(nullableRequired.safeParse({ price: null }).success, true);
        assert.equal(nullableRequired.safeParse({ price: '' }).success, false);
    });

    it('json 默认 unknown，传入 zod schema 时按它校验', () => {
        const loose = compileFieldTree({ ld: json('script') });
        assert.equal(loose.safeParse({ ld: null }).success, true);
        assert.equal(loose.safeParse({ ld: 7 }).success, true);
        assert.deepEqual(loose.parse({ ld: { a: 1 } }), { ld: { a: 1 } });

        const strict = compileFieldTree({
            ld: json('script', z.object({ id: z.number() })),
        });
        assert.equal(strict.safeParse({ ld: { id: 7 } }).success, true);
        assert.equal(strict.safeParse({ ld: { id: '7' } }).success, false);
        // 单字段 loop 里的 json 运行时可能是对象/数字，不能用 string 误拦
        const scalarJson = compileFieldTree({ list: loop('script', json('')) });
        assert.equal(scalarJson.safeParse({ list: [{ any: 'thing' }, 3, null] }).success, true);
    });

    it('loop 的对象 / 标量分支与 minItems / maxItems', () => {
        const objects = compileFieldTree({
            list: loop('li', { href: attr('href'), name: text('span') }, { minItems: 1, maxItems: 2 }),
        });
        assert.equal(objects.safeParse({ list: [] }).success, false, 'minItems');
        assert.equal(objects.safeParse({ list: [{ href: '/a', name: 'A' }] }).success, true);
        assert.equal(objects.safeParse({ list: [{ href: '/a' }] }).success, false, '缺子字段');

        const scalars = compileFieldTree({ tags: loop('li', text(''), { minItems: 1 }) });
        assert.equal(scalars.safeParse({ tags: [] }).success, false);
        assert.equal(scalars.safeParse({ tags: ['a', 'b'] }).success, true);
        assert.equal(scalars.safeParse({ tags: [1] }).success, false);
    });

    it('object 递归、顶层 z.object，且与 isFieldShape 同构', () => {
        const tree = compileFieldTree({
            card: object('.card', {
                name: text('h2'),
                tags: loop('li', text('')),
            }),
        });
        assert.equal(tree.safeParse({ card: { name: '卡片', tags: ['x'] } }).success, true);
        assert.equal(tree.safeParse({ card: { name: '卡片' } }).success, false);

        // Schema 对象里恰好有个名为 type 的键：isFieldShape 判定为 false，编译器也按对象数组处理
        const tricky: Schema = { type: text('span') };
        assert.equal(isFieldShape(tricky), false);
        assert.equal(isFieldShape(text('span')), true);
        const shape = compileSchema(tricky);
        assert.equal(shape.type.safeParse('字符串').success, true);
        const compiled = compileField(loop('li', tricky));
        assert.equal(compiled.safeParse([{ type: '字符串' }]).success, true);
        assert.equal(compiled.safeParse(['字符串']).success, false);
    });
});

describe('validateOptions · 创建时校验', () => {
    const base = { type: 'axios' as const };

    const configError = (schema: any, extra: Record<string, unknown> = {}): FetcherError => {
        try {
            validateOptions({ ...base, ...extra, schema } as any);
        } catch (error) {
            assert.ok(error instanceof FetcherError);
            assert.equal(error.phase, 'config');
            return error;
        }
        throw new Error('本应抛 FetcherError');
    };

    it('拒绝缺 type / attr 缺 name / selector 超长 / 非法字段名', () => {
        assert.match(configError({ bad: { selector: 'x' } }).message, /schema\.bad/);
        assert.match(configError({ bad: { type: 'attr' } }).message, /schema\.bad/);
        assert.match(configError({ bad: text('x'.repeat(501)) }).message, /schema\.bad\.selector/);
        assert.match(configError({ '0bad': text('x') }).message, /schema\.0bad/);
    });

    it('嵌套 loop 的错误路径带索引（schema.tags[0] 形式）', () => {
        const schema = { tags: loop('.tag', { href: text('x'.repeat(501)) }) };
        const error = configError(schema);
        assert.match(error.message, /schema\.tags\[0\]/);
        assert.match(error.fieldPath ?? '', /schema\.tags\[0\]/);
    });

    it('Field 树嵌套深度 > 8 抛 config 错', () => {
        let nested: Field = text('span');
        for (let i = 0; i < 9; i++) nested = object({ inner: nested });
        assert.match(configError({ deep: nested }).message, /深度超过 8/);
    });

    it('retries / timeoutMs / headers / proxy 边界', () => {
        assert.match(configError({ a: text('a') }, { retries: 11 }).message, /retries/);
        assert.match(configError({ a: text('a') }, { timeoutMs: 99 }).message, /timeoutMs/);
        assert.match(configError({ a: text('a') }, { headers: { 'Bad Header': 'x' } }).message, /headers/);
        assert.match(configError({ a: text('a') }, { headers: { 'X-Test': 'a\r\nb' } }).message, /header/);
        assert.match(configError({ a: text('a') }, { proxy: { host: '', port: 99999 } }).message, /proxy/);
    });

    it('type:axios 传 headless 在运行时也被拒绝', () => {
        assert.match(configError({ a: text('a') }, { headless: true }).message, /headless/);
    });

    it('browser 分支接受专属键，默认值显式且 logging 不硬编码 console', () => {
        const cfg = validateOptions({
            type: 'browser',
            headless: false,
            waitUntil: 'domcontentloaded',
            blockResources: ['image'],
            viewport: { width: 800, height: 600 },
            schema: { a: text('a') },
        });
        assert.equal(cfg.headless, false);
        assert.equal(cfg.waitUntil, 'domcontentloaded');
        assert.deepEqual(cfg.blockResources, ['image']);
        assert.deepEqual(cfg.viewport, { width: 800, height: 600 });
        assert.equal(cfg.logging, false);
        assert.deepEqual(cfg.logger, {});
        const axiosCfg = validateOptions({ ...base, schema: { a: text('a') } });
        assert.equal(axiosCfg.retries, 0);
        assert.equal(axiosCfg.timeoutMs, 20_000);
        assert.equal(axiosCfg.proxy, undefined, '不传代理就是直连');
    });

    it('formatPath 拼出 list[0].href 风格路径', () => {
        assert.equal(formatPath(['list', 0, 'href']), 'list[0].href');
        assert.equal(formatPath(['title']), 'title');
        assert.equal(formatPath([]), '');
    });
});

describe('composeSignals · Node 18 兼容', () => {
    it('任一 signal 取消都会传播，dispose 可重复调用', () => {
        const a = new AbortController();
        const b = new AbortController();
        const composed = composeSignals(a.signal, undefined, b.signal);
        assert.equal(composed.signal.aborted, false);
        b.abort('stop');
        assert.equal(composed.signal.aborted, true);
        assert.equal(composed.signal.reason, 'stop');
        composed.dispose();
        composed.dispose();

        const already = new AbortController();
        already.abort();
        assert.equal(composeSignals(already.signal).signal.aborted, true);
    });
});

describe('类型级断言 · 约束选项不改变 ParsedResult 推导', () => {
    it('带约束 / 不带约束的推导完全一致，nullable 与 required 可共存', () => {
        const plain = {
            title: text('h1'),
            price: nullable(text('.p')),
            tags: loop('li', text('')),
            items: loop('li', { href: attr('href'), name: text('span') }),
            card: object({ name: text('h2') }),
            ld: json('script'),
        };
        const constrained = {
            title: text('h1', { required: true }),
            price: nullable(text('.p', { required: true, min: 1, pattern: /^\d/ })),
            tags: loop('li', text(''), { minItems: 1, maxItems: 5 }),
            items: loop('li', { href: attr('href', undefined, { required: true }), name: text('span') }),
            card: object({ name: text('h2') }),
            ld: json('script'),
        };

        type _same = Expect<Equal<ParsedResult<typeof plain>, ParsedResult<typeof constrained>>>;
        type _title = Expect<Equal<ParsedResult<typeof constrained>['title'], string>>;
        type _price = Expect<Equal<ParsedResult<typeof constrained>['price'], string | null>>;
        type _tags = Expect<Equal<ParsedResult<typeof constrained>['tags'], string[]>>;
        type _items = Expect<Equal<ParsedResult<typeof constrained>['items'], Array<{ href: string; name: string }>>>;
        type _card = Expect<Equal<ParsedResult<typeof constrained>['card'], { name: string }>>;
        type _text = Expect<Equal<ReturnType<typeof text>, TextField>>;

        const combined = nullable(text('.p', { required: true }));
        type _combined = Expect<Equal<ParsedResult<{ p: typeof combined }>['p'], string | null>>;
        assert.equal(combined.required, true);
        assert.equal(combined.nullable, true);
        void (0 as unknown as _same);
        void (0 as unknown as _title);
        void (0 as unknown as _price);
        void (0 as unknown as _tags);
        void (0 as unknown as _items);
        void (0 as unknown as _card);
        void (0 as unknown as _text);
        void (0 as unknown as _combined);
    });
});
