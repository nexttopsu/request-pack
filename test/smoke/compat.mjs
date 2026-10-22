/**
 * 发布产物的运行时冒烟测试（不依赖 tsx / 测试框架）。
 *
 * 走的是 package.json 的 exports → dist，所以验证的是「用户装到包之后拿到的东西」，
 * 同时可以用来确认 engines 下限（Node 18）能跑。
 *
 * 用法：npm run build && node test/smoke/compat.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
    createHttp,
    html2object,
    text,
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

console.log(`smoke ok on ${process.version}`);
