import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { html2object, text, html, attr, loop } from '../src/lib/parser.ts';

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
    });
});
