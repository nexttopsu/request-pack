import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { delay, decode } from '../src/lib/utils.ts';
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
});
