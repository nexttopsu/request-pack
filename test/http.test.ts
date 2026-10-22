import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import iconv from 'iconv-lite';
import { createHttp, detectCharset } from '../src/lib/http.ts';

let server: Server;
let base: string;
const hits: Record<string, number> = {};

before(async () => {
    server = createServer((req, res) => {
        const url = req.url ?? '/';
        hits[url] = (hits[url] ?? 0) + 1;

        if (url === '/gbk') {
            const body = iconv.encode('<html><body><h1>中文标题</h1></body></html>', 'gbk');
            res.writeHead(200, { 'content-type': 'text/html; charset=gbk' });
            res.end(body);
            return;
        }
        if (url === '/meta') {
            // 响应头不带 charset，靠 <meta> 嗅探
            const body = iconv.encode('<html><head><meta charset="gbk"></head><body>元信息编码</body></html>', 'gbk');
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(body);
            return;
        }
        if (url.startsWith('/flaky')) {
            // 前两次 503，第三次才成功
            if (hits[url] < 3) {
                res.writeHead(503);
                res.end('busy');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, attempts: hits[url] }));
            return;
        }
        if (url === '/retry-after') {
            // 第一次 429 并带 Retry-After，第二次成功
            if (hits[url] < 2) {
                res.writeHead(429, { 'retry-after': '0.05' });
                res.end('slow down');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (url === '/no-charset') {
            // 响应头与 meta 都不带 charset，只能靠 createHttp 的 encoding 兜底
            const body = iconv.encode('<html><body>兜底编码</body></html>', 'gbk');
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end(body);
            return;
        }
        if (url === '/json') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ hello: 'world' }));
            return;
        }
        if (url === '/bin') {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(Buffer.from([1, 2, 3, 4]));
            return;
        }
        res.writeHead(404);
        res.end('not found');
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('createHttp · 基础请求', () => {
    it('get 返回已解析的 JSON', async () => {
        const http = createHttp();
        const data = await http.get<{ hello: string }>(`${base}/json`);
        assert.equal(data.hello, 'world');
    });

    it('getBuffer 返回 Buffer', async () => {
        const http = createHttp();
        const buf = await http.getBuffer(`${base}/bin`);
        assert.ok(Buffer.isBuffer(buf));
        assert.deepEqual([...buf], [1, 2, 3, 4]);
    });

    it('request 可自定义 method', async () => {
        const http = createHttp();
        const data = await http.request<{ hello: string }>({ url: `${base}/json`, method: 'GET' });
        assert.equal(data.hello, 'world');
    });
});

describe('createHttp · 编码识别', () => {
    it('按 Content-Type 的 charset 解码 GBK 页面', async () => {
        const http = createHttp();
        const text = await http.getText(`${base}/gbk`);
        assert.match(text, /中文标题/);
    });

    it('响应头没有 charset 时按 <meta> 嗅探', async () => {
        const http = createHttp();
        const text = await http.getText(`${base}/meta`);
        assert.match(text, /元信息编码/);
    });

    it('detectCharset 优先响应头，其次 meta，都不认识返回 undefined', () => {
        const gbkBody = iconv.encode('<meta charset="gb2312">', 'gbk');
        assert.equal(detectCharset({ 'content-type': 'text/html; charset=gbk' }, gbkBody), 'gbk');
        assert.equal(detectCharset({ 'content-type': 'text/html' }, gbkBody), 'gbk');
        assert.equal(detectCharset({ 'content-type': 'text/html' }, Buffer.from('no charset here')), undefined);
        assert.equal(detectCharset({ 'content-type': 'text/html; charset=totally-fake' }, Buffer.from('')), undefined);
    });

    it('嗅探不出来时用 encoding 兜底', async () => {
        const http = createHttp({ encoding: 'gbk' });
        const text = await http.getText(`${base}/no-charset`);
        assert.match(text, /兜底编码/);
    });
});

describe('createHttp · 重试', () => {
    it('默认不重试，503 直接抛错', async () => {
        const http = createHttp();
        await assert.rejects(() => http.get(`${base}/flaky-default`), /503/);
        assert.equal(hits['/flaky-default'], 1);
    });

    it('配置 retry 后按退避重试直到成功', async () => {
        const http = createHttp({ retry: { retries: 3, delay: 5, jitter: false } });
        const data = await http.get<{ ok: boolean; attempts: number }>(`${base}/flaky-retry`);
        assert.equal(data.ok, true);
        assert.equal(data.attempts, 3);
    });

    it('shouldRetry 可以否决重试', async () => {
        const http = createHttp({ retry: { retries: 5, delay: 1, shouldRetry: () => false } });
        await assert.rejects(() => http.get(`${base}/flaky-veto`), /503/);
        assert.equal(hits['/flaky-veto'], 1);
    });

    it('retry 传数字时按次数重试', async () => {
        const http = createHttp({ retry: 2 });
        const data = await http.get<{ ok: boolean; attempts: number }>(`${base}/flaky-number`);
        assert.equal(data.ok, true);
        assert.equal(data.attempts, 3); // 首次 + 2 次重试
    });

    it('响应带 Retry-After 时按它等待', async () => {
        const http = createHttp({ retry: { retries: 1, delay: 3000 } }); // 退避设很大，靠 Retry-After 才快
        const start = Date.now();
        const data = await http.get<{ ok: boolean }>(`${base}/retry-after`);
        const elapsed = Date.now() - start;

        assert.equal(data.ok, true);
        assert.ok(elapsed < 2000, `未按 Retry-After 等待，耗时 ${elapsed}ms`);
    });

    it('重试耗尽后抛出最后一次的错误', async () => {
        const http = createHttp({ retry: { retries: 1, delay: 1 } });
        await assert.rejects(() => http.get(`${base}/flaky-exhaust`), /503/);
        assert.equal(hits['/flaky-exhaust'], 2);
    });

    it('4xx 不在默认可重试范围内，直接抛错', async () => {
        const http = createHttp({ retry: 3 });
        await assert.rejects(() => http.get(`${base}/missing`), /404/);
        assert.equal(hits['/missing'], 1);
    });
});

describe('createHttp · 限速', () => {
    it('minInterval 让相邻请求至少间隔指定毫秒', async () => {
        const http = createHttp({ minInterval: 40 });
        const start = Date.now();
        await Promise.all([http.get(`${base}/json`), http.get(`${base}/json`), http.get(`${base}/json`)]);
        const elapsed = Date.now() - start;

        assert.ok(elapsed >= 70, `限速未生效，耗时 ${elapsed}ms`);
        assert.ok(elapsed < 400, `限速过度，耗时 ${elapsed}ms`);
    });
});
