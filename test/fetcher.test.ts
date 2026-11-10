import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import * as api from '../src/index.ts';
import { createFetcher } from '../src/index.ts';
import {
    attr, json, loop, nullable, object, text,
    type ParsedResult, type Schema,
} from '../src/lib/parser.ts';
import { compileFieldTree } from '../src/lib/fetcher/compiler.ts';
import { createFetcherCore, type FetcherDeps } from '../src/lib/fetcher/fetcher.ts';
import { playwrightResolvable } from '../src/lib/fetcher/transport.ts';
import type { AxiosFetcherOptions, Fetcher, FetcherError } from '../src/lib/fetcher/index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const PAGE = `<!doctype html><html><head><title>页面</title></head><body>
<p class="ad">广告</p>
<h1 class="title">主标题</h1>
<div class="card"><h2>卡片</h2><span class="price">¥19.9</span></div>
<ul class="tags"><li>前端</li><li>解析</li></ul>
<ul class="list"><li><a href="/1">一</a></li><li><a href="/2">二</a></li></ul>
<script type="application/ld+json">{"name":"商品","price":9.9}</script>
</body></html>`;
const NO_TITLE = '<html><body><p>没有标题</p></body></html>';
const BAD_JSON = '<html><body><script type="application/ld+json">{oops</script></body></html>';

let server: Server;
let port: number;
let base: string;
const hits: Record<string, number> = {};

before(async () => {
    server = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        hits[path] = (hits[path] ?? 0) + 1;
        const ok = (body: string): void => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(body);
        };
        if (path.startsWith('/flaky')) {
            if (hits[path] <= 2) { res.writeHead(503); res.end('busy'); return; }
            ok(PAGE); return;
        }
        if (path === '/slow') {
            setTimeout(() => { if (!res.writableEnded) ok(PAGE); }, 1000);
            return;
        }
        if (path.startsWith('/no-title')) { ok(NO_TITLE); return; }
        if (path.startsWith('/bad-json')) { ok(BAD_JSON); return; }
        ok(PAGE);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
});

after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
});

function axiosFetcher<S extends Schema>(options: Omit<AxiosFetcherOptions<S>, 'type'>): Fetcher<S> {
    return createFetcher<S>({ ...options, type: 'axios' } as AxiosFetcherOptions<S>);
}

const isFetcherError = (value: unknown): value is FetcherError =>
    !!value && typeof value === 'object' && (value as FetcherError).name === 'FetcherError';

describe('createFetcher · 完整链路与静态类型', () => {
    it('合法配置 + 本地 fixture：值、静态类型与 outputSchema 一致', async () => {
        const request = axiosFetcher({
            timeoutMs: 5000,
            schema: {
                title: text('h1.title', { required: true }),
                price: nullable(text('.card .price')),
                tags: loop('ul.tags li', text('')),
                items: loop('ul.list li', { href: attr('href', 'a'), name: text('a') }),
                card: object('.card', { name: text('h2') }),
                ld: json('script[type="application/ld+json"]'),
            },
        });
        const res = await request(`${base}/page`);

        type _title = Expect<Equal<typeof res.title, string>>;
        type _price = Expect<Equal<typeof res.price, string | null>>;
        type _tags = Expect<Equal<typeof res.tags, string[]>>;
        type _items = Expect<Equal<typeof res.items, Array<{ href: string; name: string }>>>;
        type _card = Expect<Equal<typeof res.card, { name: string }>>;
        void (0 as unknown as _title);
        void (0 as unknown as _price);
        void (0 as unknown as _tags);
        void (0 as unknown as _items);
        void (0 as unknown as _card);

        assert.deepEqual(res, {
            title: '主标题',
            price: '¥19.9',
            tags: ['前端', '解析'],
            items: [{ href: '/1', name: '一' }, { href: '/2', name: '二' }],
            card: { name: '卡片' },
            ld: { name: '商品', price: 9.9 },
        });
        assert.deepEqual(request.outputSchema.parse(res), res);
        await request.close();
    });

    it('safe / raw / outputSchema / removeSelector / asyncDispose 特性检测', async () => {
        const request = axiosFetcher({
            timeoutMs: 5000,
            removeSelector: ['.ad'],
            schema: { body: text('body') },
        });
        const safe = await request.safe(`${base}/page`);
        assert.equal(safe.ok, true);
        assert.equal(safe.meta.transport, 'axios');
        assert.equal(safe.meta.finalUrl, `${base}/page`);
        assert.equal(safe.meta.status, 200);
        assert.equal(typeof safe.meta.elapsedMs, 'number');
        if (safe.ok) {
            assert.match(safe.data.body, /主标题/);
            assert.doesNotMatch(safe.data.body, /广告/);
        }
        assert.match(await request.raw(`${base}/page`), /<h1 class="title">/);
        assert.equal(typeof request.outputSchema.parse, 'function');
        const dispose = (Symbol as any).asyncDispose as symbol | undefined;
        if (dispose) assert.equal((request as any)[dispose], request.close);
        await request.close();
    });

    it('缺 title 且 required:true → phase:validate，错误带字段路径', async () => {
        const request = axiosFetcher({
            timeoutMs: 5000,
            schema: { title: text('h1.title', { required: true }) },
        });
        await assert.rejects(request(`${base}/no-title-check`), error => {
            assert.ok(isFetcherError(error));
            assert.equal(error.phase, 'validate');
            assert.equal(error.fieldPath, 'title');
            assert.match(error.message, /title/);
            return true;
        });
        await request.close();
    });

    it('nullable 与 required 共存：未匹配为 null，匹配但为空仍被拦', async () => {
        const request = axiosFetcher({
            timeoutMs: 5000,
            schema: { p: nullable(text('.missing', { required: true })) },
        });
        const res = await request(`${base}/page`);
        assert.equal(res.p, null);
        assert.equal(request.outputSchema.safeParse({ p: '' }).success, false);
        await request.close();
    });
});

describe('createFetcher · 创建时校验与编译缓存', () => {
    it('Field 树非法抛 config 错，路径带 schema.tags[0]', () => {
        assert.throws(
            () => createFetcher({ type: 'axios', schema: { bad: { selector: 'x' } } as any }),
            error => isFetcherError(error) && error.phase === 'config' && /schema\.bad/.test(error.message)
        );
        assert.throws(
            () => createFetcher({
                type: 'axios',
                schema: { tags: loop('.tag', { href: text('x'.repeat(501)) }) },
            }),
            error => isFetcherError(error) && error.phase === 'config' && /schema\.tags\[0\]/.test(error.message)
        );
        assert.throws(
            () => createFetcher({ type: 'axios', schema: { '0bad': text('x') } }),
            error => isFetcherError(error) && error.phase === 'config'
        );
        assert.throws(
            () => createFetcher({ type: 'axios', schema: { a: text('a') }, retries: 11 } as any),
            error => isFetcherError(error) && error.phase === 'config'
        );
    });

    it('type:axios 传 headless：编译期与运行时双重拒绝', () => {
        const createBad = () => {
            // @ts-expect-error axios 分支编译期拒绝 browser 专属的 headless
            return createFetcher({ type: 'axios', headless: true, schema: { title: text('h1') } });
        };
        assert.throws(
            createBad,
            error => isFetcherError(error) && error.phase === 'config' && /headless/.test(error.message)
        );
    });

    it('请求级禁止传 schema；10 次请求只编译 1 次，with 换 schema 才重新编译', async () => {
        let compiles = 0;
        const deps = {
            compile: (schema: Schema) => { compiles++; return compileFieldTree(schema); },
        } as unknown as FetcherDeps;

        const request = createFetcherCore({
            type: 'axios', timeoutMs: 5000, schema: { title: text('h1.title') },
        }, deps);
        assert.equal(compiles, 1);

        const typeOnly = (_url: string) => {
            // @ts-expect-error 请求级 overrides 禁止接受 schema
            return request(_url, { schema: { title: text('h1') } });
        };
        void typeOnly;

        for (let i = 0; i < 10; i++) await request(`${base}/page`);
        assert.equal(compiles, 1, '同一实例必须复用编译产物');

        const derived = request.with({ schema: { heading: text('h1.title') } });
        assert.equal(compiles, 2, 'with 换 schema 必须重新编译');
        const changed = await derived(`${base}/page`);
        type _heading = Expect<Equal<typeof changed.heading, string>>;
        void (0 as unknown as _heading);
        assert.equal(changed.heading, '主标题');
        assert.notEqual(request.outputSchema, derived.outputSchema);
        assert.equal(request.outputSchema.safeParse({ title: 'x' }).success, true);
        assert.equal(derived.outputSchema.safeParse({ title: 'x' }).success, false);

        await request.close();
        await derived.close();
    });
});

describe('createFetcher · parser 结果加工与复验', () => {
    it('数组按序串行 await，ctx 只读，Promise 结果可用', async () => {
        const steps: string[] = [];
        const request = axiosFetcher({
            timeoutMs: 5000,
            schema: { title: text('h1.title', { required: true }) },
            parser: [
                async (data, ctx) => {
                    steps.push('a');
                    assert.ok(Object.isFrozen(ctx));
                    assert.equal(ctx.status, 200);
                    assert.match(ctx.html, /<h1/);
                    return { ...data, title: `${data.title}!` };
                },
                data => {
                    steps.push('b');
                    return { ...data, title: `${data.title}?` };
                },
            ],
        });
        const res = await request(`${base}/page`);
        assert.equal(res.title, '主标题!?');
        assert.deepEqual(steps, ['a', 'b']);
        await request.close();
    });

    it('parser 把 title 改成空串 → 同一个 outputSchema 复验拦截', async () => {
        const request = axiosFetcher({
            timeoutMs: 5000,
            schema: { title: text('h1.title', { required: true }) },
            parser: [data => ({ ...data, title: '' })],
        });
        await assert.rejects(request(`${base}/page`), error => {
            assert.ok(isFetcherError(error));
            assert.equal(error.phase, 'validate');
            assert.equal(error.fieldPath, 'title');
            return true;
        });
        await request.close();
    });

    it('parser 抛错包装为 phase:plugin，信息保留原 message', async () => {
        const request = axiosFetcher({
            timeoutMs: 5000,
            schema: { title: text('h1.title') },
            parser: [() => { throw new Error('加工炸了'); }],
        });
        await assert.rejects(request(`${base}/page`), error => {
            assert.ok(isFetcherError(error));
            assert.equal(error.phase, 'plugin');
            assert.equal(error.code, 'TRANSFORM_FAILED');
            assert.match(error.message, /加工炸了/);
            return true;
        });
        await request.close();
    });
});

describe('createFetcher · 重试边界 / 超时 / 取消', () => {
    it('retries 只作用于 fetch；解析 / 校验失败不重试（用请求计数断言）', async () => {
        const flaky = axiosFetcher({
            timeoutMs: 5000,
            retries: 2,
            schema: { title: text('h1.title', { required: true }) },
        });
        assert.equal((await flaky(`${base}/flaky-retry`)).title, '主标题');
        assert.equal(hits['/flaky-retry'], 3, '首次 + 2 次重试');
        await flaky.close();

        const validating = axiosFetcher({
            timeoutMs: 5000,
            retries: 2,
            schema: { title: text('h1.title', { required: true }) },
        });
        await assert.rejects(validating(`${base}/no-title-retry`), error => isFetcherError(error) && error.phase === 'validate');
        assert.equal(hits['/no-title-retry'], 1, '校验失败不得重试 fetch');
        await validating.close();

        const parsing = axiosFetcher({
            timeoutMs: 5000,
            retries: 2,
            schema: { ld: json('script[type="application/ld+json"]') },
        });
        await assert.rejects(parsing(`${base}/bad-json-retry`), error => {
            assert.ok(isFetcherError(error));
            assert.equal(error.phase, 'parse');
            assert.match(error.message, /字段 "ld"/);
            return true;
        });
        assert.equal(hits['/bad-json-retry'], 1, '解析失败不得重试 fetch');
        await parsing.close();
    });

    it('timeoutMs 超时抛 phase:timeout；safe 返回 ok:false；外部 signal 能取消', async () => {
        const request = axiosFetcher({ timeoutMs: 150, schema: { title: text('h1.title') } });
        await assert.rejects(request(`${base}/slow`), error => {
            assert.ok(isFetcherError(error));
            assert.equal(error.phase, 'timeout');
            assert.equal(error.code, 'TIMEOUT');
            return true;
        });

        const safe = await request.safe(`${base}/slow`);
        assert.equal(safe.ok, false);
        assert.equal(safe.meta.transport, 'axios');
        if (!safe.ok) assert.equal(safe.error.phase, 'timeout');

        const controller = new AbortController();
        controller.abort();
        await assert.rejects(request(`${base}/page`, { signal: controller.signal }), error => {
            assert.ok(isFetcherError(error));
            assert.equal(error.code, 'ABORTED');
            return true;
        });
        await request.close();
    });
});

describe('createFetcher · 生命周期 / 回归', () => {
    it('axios close 幂等、无残留连接；包根导出不牵连 playwright', async () => {
        const request = axiosFetcher({ timeoutMs: 5000, schema: { title: text('h1.title') } });
        await request(`${base}/page`);
        await request.close();
        await request.close();
        await assert.rejects(request(`${base}/page`), error => isFetcherError(error) && error.code === 'CLOSED');
        await new Promise<void>(resolve => setImmediate(resolve));
        const connections = await new Promise<number>((resolve, reject) =>
            server.getConnections((error, count) => error ? reject(error) : resolve(count))
        );
        assert.equal(connections, 0, 'close() 后不应有残留连接');

        assert.equal(typeof api.createFetcher, 'function');
        assert.equal(typeof api.createHttp, 'function');
        assert.equal(typeof api.html2object, 'function');
        assert.equal(typeof api.TaskPool, 'function');
        assert.equal(typeof api.utils.resolveUrl, 'function');
    });

    it('未装 playwright 时 browser 实例给出安装提示，不吐堆栈', () => {
        const schema = { title: text('h1.title') };
        if (playwrightResolvable()) {
            const request = createFetcher({ type: 'browser', schema });
            assert.equal(typeof request, 'function');
            void request.close();
        } else {
            assert.throws(
                () => createFetcher({ type: 'browser', schema }),
                error => {
                    assert.ok(isFetcherError(error));
                    assert.equal(error.phase, 'browser');
                    assert.equal(error.code, 'BROWSER_MISSING');
                    assert.match(error.message, /npm i playwright && npx playwright install chromium/);
                    return true;
                }
            );
        }
    });

    it('回归：组合器约束选项不改变既有解析行为与类型推导', () => {
        const plain = html2objectDirect({ a: text('h1'), b: nullable(text('.p')), c: loop('ul.list li', text('')) });
        const constrained = html2objectDirect({
            a: text('h1', { required: true }),
            b: nullable(text('.p', { min: 1 })),
            c: loop('ul.list li', text(''), { minItems: 0 }),
        });
        type _same = Expect<Equal<typeof plain, typeof constrained>>;
        void (0 as unknown as _same);
        assert.deepEqual(constrained.a, '主标题');
        assert.equal(constrained.b, null);
        assert.deepEqual(constrained.c, ['一', '二']);
    });
});

/** 直接调 html2object，验证组合器加约束后解析结果完全不变 */
function html2objectDirect<S extends Schema>(schema: S): ParsedResult<S> {
    return api.html2object(PAGE, schema);
}
