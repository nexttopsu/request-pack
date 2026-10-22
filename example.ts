/**
 * 端到端示例：HTTP 请求 → 并发调度 → 结构化解析。
 *
 * 为了不依赖外网，示例在本地起了一个 HTTP 服务：
 * - `/`              列表页（UTF-8）
 * - `/item/1` `/item/2`  详情页（UTF-8）
 * - `/gbk`           GBK 编码的页面，演示 getText() 自动识别编码
 *
 * 运行：npm run dev（会先构建，示例走的是 dist 产物 + 包自引用）
 */
import { createServer } from 'node:http';
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
    createHttp,
    defineThreadTask,
    TaskPool,
    html2object,
    text,
    html,
    attr,
    loop,
    nullable,
    utils,
} from 'request-pack'; // 包内自引用，走 package.json 的 exports（等效于用户 npm install 后的 import）

/* ----------------------------- 本地测试站点 ----------------------------- */

const indexPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>示例站点</title></head>
<body>
  <h1>文章列表</h1>
  <ul class="list">
    <li><a href="/item/1"><span>线程池入门</span></a></li>
    <li><a href="/item/2"><span>HTML 解析技巧</span></a></li>
    <li><a href="/item/3"><span>编码识别</span></a></li>
  </ul>
</body></html>`;

const detailPage = (id: string, name: string, price: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${name}</title></head>
<body>
  <h1>${name}</h1>
  <p class="price">${price}</p>
  <article><p>这是第 ${id} 篇的正文。</p></article>
</body></html>`;

// GBK 页面：响应头不带 charset，只在 <meta> 里声明，用来验证编码嗅探
const gbkPage = utils.iconv.encode(
    `<!doctype html><html><head><meta charset="gbk"><title>中文编码测试</title></head>
<body><h1>这是一个 GBK 编码的页面</h1></body></html>`,
    'gbk'
);

const PAGES: Record<string, { body: string | Buffer; type: string }> = {
    '/': { body: indexPage, type: 'text/html' },
    '/item/1': { body: detailPage('1', '线程池入门', '¥ 39.00'), type: 'text/html' },
    '/item/2': { body: detailPage('2', 'HTML 解析技巧', '¥ 49.00'), type: 'text/html' },
    '/item/3': { body: detailPage('3', '编码识别', '¥ 59.00'), type: 'text/html' },
    '/gbk': { body: gbkPage, type: 'text/html' },
};

function startSite(): Promise<{ origin: string; close: () => void }> {
    const server = createServer((req, res) => {
        const page = PAGES[(req.url ?? '/').split('?')[0]];
        if (!page) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': page.type }).end(page.body);
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
        });
    });
}

/* ----------------------------- 子线程任务 ----------------------------- */

const http = createHttp({ timeout: 5_000 });

/**
 * 子线程里执行的任务：抓页面并解析。
 * 主线程 import 本文件时，defineThreadTask 是空操作，不会挂监听。
 */
export const crawl = defineThreadTask(async ({ url }: { url: string }) => {
    const page = await http.getText(url); // 自动识别编码，GBK 页面也不会乱码

    const data = html2object(page, {
        title: text('h1'),
        price: nullable(text('.price')), // 列表页没有价格 → null
        links: loop('.list li', {
            name: text('a span'),
            href: attr('href', 'a'),
        }),
        content: nullable(html('article')),
    });

    return {
        url,
        ...data,
        links: data.links.map(link => ({ ...link, href: utils.resolveUrl(link.href, url) })),
    };
});

/* ------------------------------- 主线程 ------------------------------- */

type CrawlResult = Awaited<ReturnType<typeof crawl>>;

async function main(): Promise<void> {
    const site = await startSite();
    const urls = ['/', '/item/1', '/item/2', '/item/3', '/gbk'].map(path => site.origin + path);

    const pool = new TaskPool<CrawlResult>({
        worker: fileURLToPath(import.meta.url), // ESM 下没有 __filename
        concurrency: 2,
        taskTimeout: 10_000,
    });

    pool.on('progress', ({ done, total }) => console.log(`[进度] ${done}/${total}`));
    pool.on('taskError', ({ error, reason }) => console.warn(`[失败:${reason}]`, error));

    const { results, errors } = await pool.addTasks(urls.map(url => ({ url }))).run();

    for (const item of results) {
        console.log('\n' + item.url);
        console.log(JSON.stringify(item, null, 2));
    }
    console.log(`\n成功 ${results.length}，失败 ${errors.length}`);

    site.close();
}

// worker 线程会重新执行本文件，这里必须拦住，否则子线程也会起服务、建线程池
if (isMainThread) {
    void main();
}
