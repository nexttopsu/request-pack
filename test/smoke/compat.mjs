/**
 * 发布产物的运行时冒烟测试（不依赖 tsx / 测试框架）。
 *
 * 走的是 package.json 的 exports → dist，所以验证的是「用户装到包之后拿到的东西」，
 * 同时可以用来确认 engines 下限（Node 18）能跑。
 *
 * 用法：npm run build && node test/smoke/compat.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
    createHttp,
    createFetcher,
    createTaskScheduler,
    html2object,
    text,
    html,
    attr,
    loop,
    nullable,
    object,
    json,
    TaskPool,
    utils,
} from 'request-pack';

/* 解析：组合器、嵌套对象、可空字段、标量数组 */
const data = html2object(
    `<h1>hi</h1>
     <div class="card"><h2>卡片</h2></div>
     <ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul>
     <script type="application/ld+json">{"id":7}</script>`,
    {
        title: text('h1'),
        missing: nullable(text('.nope')),
        card: object('.card', { name: text('h2') }),
        ld: json('script[type="application/ld+json"]'),
        links: loop('li', { name: text('a'), href: attr('href', 'a') }),
        labels: loop('li', text('a')),
    }
);
assert.equal(data.title, 'hi');
assert.equal(data.missing, null);
assert.equal(data.card.name, '卡片');
assert.equal(data.ld.id, 7);
assert.deepEqual(data.links, [{ name: 'A', href: '/a' }, { name: 'B', href: '/b' }]);
assert.deepEqual(data.labels, ['A', 'B']);

/* 工具函数 */
assert.equal(utils.resolveUrl('/x', 'https://example.com/a/b'), 'https://example.com/x');
assert.equal(utils.getDocumentBase('<base href="/s/">', 'https://example.com/a/b'), 'https://example.com/s/');

/* HTTP 客户端能创建、配置生效 */
const http = createHttp({ retry: 1, minInterval: 0 });
assert.equal(typeof http.getText, 'function');
assert.equal(typeof http.instance.request, 'function');

/* 任务池：真实的 worker + defineThreadTask，含成功与抛错两条路径 */
const pool = new TaskPool({
    worker: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
    concurrency: 2,
    taskTimeout: 10_000,
});
const { results, errors } = await pool.addTasks([{ n: 1 }, { n: 13 }, { n: 2 }]).run();

assert.deepEqual(results, [2, 4]);
assert.equal(errors.length, 1);
assert.equal(errors[0].error, 'unlucky');
assert.equal(errors[0].reason, 'task');

/* createFetcher：本地起服务跑一遍完整链路（fetch → html2object → 校验 → parser → 复验） */
const FIXTURE = `<!doctype html><html><head><title>页面</title></head><body>
<h1 class="title">主标题</h1>
<div class="card"><h2>卡片</h2></div>
<ul class="tags"><li>前端</li><li>解析</li></ul>
<script type="application/ld+json">{"name":"商品","price":9.9}</script>
</body></html>`;

/* 组合器挂在 html2object 上：与命名导出同一引用，且可直接构造 schema */
const combinators = { text, html, attr, json, loop, object, nullable };
for (const [name, fn] of Object.entries(combinators)) {
    assert.equal(html2object[name], fn, `html2object.${name} 应与命名导出是同一个函数`);
}
const viaNamespace = html2object(FIXTURE, {
    title: html2object.text('h1.title'),
    inner: html2object.html('h1.title'),
    cover: html2object.attr('data-x', 'h1.title'),
    ld: html2object.json('script[type="application/ld+json"]'),
    tags: html2object.loop('ul.tags li', html2object.text('')),
    card: html2object.object('.card', { name: html2object.text('h2') }),
    missing: html2object.nullable(html2object.text('.nope')),
});
assert.equal(viaNamespace.title, '主标题');
assert.equal(viaNamespace.inner, '主标题');
assert.equal(viaNamespace.cover, '');
assert.equal(viaNamespace.ld.price, 9.9);
assert.deepEqual(viaNamespace.tags, ['前端', '解析']);
assert.deepEqual(viaNamespace.card, { name: '卡片' });
assert.equal(viaNamespace.missing, null);

const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/page`;

const request = createFetcher({
    type: 'axios',
    retries: 0,
    timeoutMs: 5000,
    schema: {
        title: text('h1.title', { required: true }),
        missing: nullable(text('.nope')),
        tags: loop('ul.tags li', text(''), { minItems: 1 }),
        card: object('.card', { name: text('h2') }),
        ld: json('script[type="application/ld+json"]'),
    },
    parser: [async data => ({ ...data, title: `${data.title} ok` })],
});
const fetched = await request(pageUrl);
assert.equal(fetched.title, '主标题 ok');
assert.equal(fetched.missing, null);
assert.deepEqual(fetched.tags, ['前端', '解析']);
assert.equal(fetched.card.name, '卡片');
assert.equal(fetched.ld.price, 9.9);
assert.equal(typeof request.outputSchema.parse, 'function');
assert.match(await request.raw(pageUrl), /<h1 class="title">/);
const safe = await request.safe(pageUrl);
assert.equal(safe.ok, true);
assert.equal(safe.meta.transport, 'axios');
assert.equal(safe.meta.status, 200);
await request.close();

/* 单线程调度器：结果按输入顺序、失败进 errors、restart 只重跑错误项（只用 Node 18 API） */
const calls = new Map();
let round = 1;
const job = createTaskScheduler([1, 2, 3], {
    concurrency: 2,
    logging: false,
    handler: async (item, index) => {
        calls.set(index, (calls.get(index) ?? 0) + 1);
        await Promise.resolve();
        if (round === 1 && index === 1) throw new Error('boom');
        return item * 2;
    },
});
let seen;
job.start().done((results, errors) => {
    seen = { results, errors };
});
const first = await job.wait();
assert.deepEqual(first.results.map(r => r.index), [0, 1, 2]);
assert.deepEqual(first.errors.map(e => e.index), [1]);
assert.equal(first.errors[0].reason, 'task');

round = 2;
const second = await job.restart().wait();
assert.deepEqual(second.errors, []);
assert.deepEqual(second.results.map(r => r.value), [2, 4, 6]);
assert.equal(calls.get(0), 1, '成功项不应被重跑');
assert.equal(calls.get(1), 2, '失败项应重跑一次');
assert.ok(seen && seen.results.length === 3, 'done 回调应收到完整结果数组');

/* CJS 产物：未安装 playwright 时 require('request-pack') 也不能报错（懒加载不被降级成 require） */
const require = createRequire(import.meta.url);
const cjs = require('request-pack');
assert.equal(typeof cjs.createFetcher, 'function');
assert.equal(typeof cjs.createHttp, 'function');
assert.equal(typeof cjs.createTaskScheduler, 'function');
assert.equal(typeof cjs.html2object, 'function');

server.closeAllConnections?.();
await new Promise(resolve => server.close(() => resolve()));

console.log(`smoke ok on ${process.version}`);
