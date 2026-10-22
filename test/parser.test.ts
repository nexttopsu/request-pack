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
