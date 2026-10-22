import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { delay, decode, resolveUrl, getBaseHref, getDocumentBase } from '../src/lib/utils.ts';
import * as utils from '../src/lib/utils.ts';
import iconv from 'iconv-lite';

describe('utils', () => {
    it('delay 按毫秒等待', async () => {
        const start = Date.now();
        await delay(50);
        assert.ok(Date.now() - start >= 45);
    });

    it('decode 按 encoding 解码 buffer', () => {
        const buf = iconv.encode('中文', 'gbk');
        assert.equal(decode(buf, 'gbk'), '中文');
    });

    it('resolveUrl 把相对链接解析为绝对地址', () => {
        assert.equal(resolveUrl('/a/b', 'https://example.com/x/y'), 'https://example.com/a/b');
        assert.equal(resolveUrl('c.html', 'https://example.com/dir/page'), 'https://example.com/dir/c.html');
        assert.equal(resolveUrl('https://other.com/z', 'https://example.com'), 'https://other.com/z');
        // 无法解析时原样返回，不抛错
        assert.equal(resolveUrl('mailto:a@b.com'), 'mailto:a@b.com');
        assert.equal(resolveUrl('/a', 'not a url'), '/a');
    });

    it('getBaseHref 读取 <base href>', () => {
        assert.equal(getBaseHref('<head><base href="/static/"></head>'), '/static/');
        assert.equal(getBaseHref('<head></head>'), undefined);
    });

    it('getDocumentBase 优先 <base href> 并相对页面地址解析', () => {
        const html = '<head><base href="/static/"></head>';
        assert.equal(getDocumentBase(html, 'https://example.com/dir/page'), 'https://example.com/static/');
        assert.equal(getDocumentBase('<head></head>', 'https://example.com/dir/page'), 'https://example.com/dir/page');
    });

    it('透出 iconv 本体，方便直接用更多编码能力', () => {
        assert.equal(utils.iconv, iconv);
        assert.equal(utils.iconv.decode(utils.iconv.encode('測試', 'big5'), 'big5'), '測試');
        assert.equal(utils.iconv.encodingExists('shift_jis'), true);
    });
});
