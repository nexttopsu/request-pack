import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { html2object, text, html, attr, loop, object, json, nullable } from '../src/lib/parser.ts';

const htmlStr = `<html>
<head><title>标题</title></head>
<body>
<h1 class="todo"><span>Todo</span></h1>
<ul id="list">
    <li data-href="/1"><span>1</span></li>
    <li data-href="/2"><span>2</span></li>
    <li data-href="/3"><span>3</span></li>
</ul>
</body>
</html>`;

describe('html2object', () => {
    it('解析基础字段与列表', () => {
        const schema = {
            title: text('title'),
            h1_html: html('h1.todo'),
            list: loop('#list li', {
                href: attr('data-href'),
                name: text('span'),
            }),
        };
        const result = html2object(htmlStr, schema);
        assert.deepEqual(result, {
            title: '标题',
            h1_html: '<span>Todo</span>',
            list: [
                { href: '/1', name: '1' },
                { href: '/2', name: '2' },
                { href: '/3', name: '3' },
            ],
        });
    });

    it('顶层 attr 提取文档属性', () => {
        const result = html2object('<html lang="zh"></html>', { lang: attr('lang', 'html') });
        assert.equal(result.lang, 'zh');
    });

    it('支持 removeSelector 移除干扰节点', () => {
        const dirty = '<body><p class="ad">广告</p><p>正文</p></body>';
        const result = html2object(dirty, { body: text('body') }, ['.ad']);
        assert.equal(result.body, '正文');
    });

    it('loop 内嵌套 loop', () => {
        const doc = `<ul class="a">
            <li><span>group1</span><ul class="b"><li class="item">x</li><li class="item">y</li></ul></li>
            <li><span>group2</span><ul class="b"><li class="item">z</li></ul></li>
        </ul>`;
        const result = html2object(doc, {
            groups: loop('ul.a > li', {
                name: text('span'),
                items: loop('ul.b > li.item', { v: text('') }),
            }),
        });
        assert.deepEqual(result.groups, [
            { name: 'group1', items: [{ v: 'x' }, { v: 'y' }] },
            { name: 'group2', items: [{ v: 'z' }] },
        ]);
    });

    it('非法字段直接抛错而不是静默吞掉', () => {
        assert.throws(() => html2object(htmlStr, { bad: { type: 'unknown' } } as any), /未知/);
        assert.throws(() => html2object(htmlStr, { bad: 'not-a-field' } as any), /不是合法/);
        assert.throws(() => html2object(htmlStr, { bad: text(undefined as any) }), /selector/);
        assert.throws(() => html2object(htmlStr, { bad: { type: 'loop', selector: 'li' } } as any), /子 schema/);
        assert.throws(() => html2object(htmlStr, { bad: { type: 'object' } } as any), /子 schema/);
    });
});

describe('html2object · 定位与取值', () => {
    it('first / index 只取指定位置的元素', () => {
        const result = html2object(htmlStr, {
            first: text('#list li', { first: true }),
            second: text('#list li', { index: 1 }),
            href: attr('data-href', '#list li', { index: 2 }),
        });
        assert.deepEqual(result, { first: '1', second: '2', href: '/3' });
    });

    it('loop 传单个字段时产出标量数组', () => {
        const result = html2object(htmlStr, { labels: loop('#list li', text('span')) });
        assert.deepEqual(result.labels, ['1', '2', '3']);
    });

    it('object 在子树内取多个字段', () => {
        const doc = '<div class="card"><h2>卡片标题</h2><span class="price">¥19.9</span></div>';
        const result = html2object(doc, {
            card: object('.card', { title: text('h2'), price: text('.price') }),
        });
        assert.deepEqual(result.card, { title: '卡片标题', price: '¥19.9' });
    });

    it('object 不带选择器时在当前节点内查找', () => {
        const result = html2object('<div><h2>标题</h2></div>', {
            meta: object({ title: text('h2') }),
        });
        assert.deepEqual(result.meta, { title: '标题' });
    });

    it('json 解析 JSON-LD', () => {
        const doc = '<script type="application/ld+json">{"name":"商品","price":9.9}</script>';
        const result = html2object(doc, { ld: json('script[type="application/ld+json"]') });
        assert.equal(result.ld.name, '商品');
        assert.equal(result.ld.price, 9.9);
    });

    it('json 内容非法时抛错并指出字段', () => {
        assert.throws(
            () => html2object('<script type="application/ld+json">{oops</script>', { ld: json('script') }),
            /字段 "ld" 的内容不是合法 JSON/
        );
    });

    it('nullable 区分「未匹配」与「匹配但为空」', () => {
        const doc = '<div><p class="empty"></p></div>';
        const result = html2object(doc, {
            missing: nullable(text('.nope')),
            empty: nullable(text('.empty')),
            missingAttr: nullable(attr('href', 'a')),
        });
        assert.equal(result.missing, null);
        assert.equal(result.empty, '');
        assert.equal(result.missingAttr, null);
    });

    it('错误信息带字段路径', () => {
        assert.throws(
            () => html2object('<ul><li></li></ul>', { list: loop('li', { href: attr(undefined as any) }) }),
            /list\[0\]\.href/
        );
    });
});

/* 组合器挂在 html2object 上，与命名导出的函数并存 */
describe('html2object 上挂载的 7 个组合器', () => {
    type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;

    it('全部可访问，且与命名导出是同一个函数引用', () => {
        assert.equal(html2object.text, text);
        assert.equal(html2object.html, html);
        assert.equal(html2object.attr, attr);
        assert.equal(html2object.json, json);
        assert.equal(html2object.loop, loop);
        assert.equal(html2object.object, object);
        assert.equal(html2object.nullable, nullable);
        assert.equal(typeof html2object, 'function');
    });

    it('用挂载方法构造的 schema 与命名导出写法解析结果完全一致', () => {
        const doc = `${htmlStr}<script type="application/ld+json">{"name":"商品"}</script>`;
        const viaNamespace = html2object(doc, {
            title: html2object.text('title'),
            heading: html2object.html('h1.todo'),
            firstHref: html2object.attr('data-href', 'li', { first: true }),
            ld: html2object.json('script'),
            items: html2object.loop('#list li', {
                label: html2object.text('span'),
                href: html2object.attr('data-href'),
            }),
            card: html2object.object('body', { h1: html2object.text('h1') }),
            whole: html2object.object({ body: html2object.text('h1') }),
            missing: html2object.nullable(html2object.text('.nope')),
        });
        const viaNamed = html2object(doc, {
            title: text('title'),
            heading: html('h1.todo'),
            firstHref: attr('data-href', 'li', { first: true }),
            ld: json('script'),
            items: loop('#list li', { label: text('span'), href: attr('data-href') }),
            card: object('body', { h1: text('h1') }),
            whole: object({ body: text('h1') }),
            missing: nullable(text('.nope')),
        });

        assert.deepEqual(viaNamespace, viaNamed);
        assert.equal(viaNamespace.title, '标题');
        assert.equal(viaNamespace.heading, '<span>Todo</span>');
        assert.equal(viaNamespace.firstHref, '/1');
        assert.equal(viaNamespace.ld.name, '商品');
        assert.deepEqual(viaNamespace.items.map(i => i.href), ['/1', '/2', '/3']);
        assert.equal(viaNamespace.missing, null);
    });

    it('ParsedResult 静态推导与既有写法一致', () => {
        const data = html2object('<p>x</p>', {
            title: html2object.text('h1'),
            price: html2object.nullable(html2object.text('.p')),
            tags: html2object.loop('li', html2object.text('')),
            card: html2object.object({ name: html2object.text('h2') }),
        });
        type _推导不变 = Assert<IsEqual<
            typeof data,
            { title: string; price: string | null; tags: string[]; card: { name: string } }
        >>;
        assert.equal(data.title, '');
        assert.equal(data.price, null);
        assert.deepEqual(data.tags, []);
    });

    it('约束选项通过挂载写法传入时同样生效', () => {
        const field = html2object.nullable(html2object.text('.p', { required: true, min: 2 }));
        assert.equal(field.required, true);
        assert.equal(field.min, 2);
        assert.equal(field.nullable, true);
        const loopField = html2object.loop('li', html2object.text(''), { minItems: 1 });
        assert.equal(loopField.minItems, 1);
        // html2object 仍是 best-effort，不因约束报错；匹配到空节点返回 ''，列表未匹配返回 []
        assert.deepEqual(html2object('<p class="p"></p>', { a: field, b: loopField }), { a: '', b: [] });
    });
});
