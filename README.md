# request-pack

**轻量爬虫工具包**：HTTP 请求 → 并发调度 → 结构化解析。

三个模块互相独立，可以只用其中一个，也可以串成一条完整的抓取管线。Node 原生能力优先，依赖只留必要的三个（axios / cheerio / iconv-lite）。

```bash
npm install request-pack
```

```ts
import { createHttp, TaskPool, defineThreadTask, html2object, text, attr, loop } from 'request-pack';
```

## 目录

- [HTTP 客户端 `createHttp`](#http-客户端-createhttp)
- [并发任务池 `TaskPool`](#并发任务池-taskpool)
- [HTML 解析 `html2object`](#html-解析-html2object)
- [工具函数 `utils`](#工具函数-utils)
- [完整示例](#完整示例)
- [开发](#开发)

---

## HTTP 客户端 `createHttp`

基于官方 axios（`>= 1.16.1` 起原生支持 HTTPS 代理的 CONNECT 隧道）。**所有配置显式传入，没有任何隐藏默认值**——不传代理就是直连，不会被塞进某个本地端口。

```ts
import { createHttp } from 'request-pack';

const http = createHttp({
    timeout: 30_000,
    headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    proxy: { host: '127.0.0.1', port: 1080 },   // 不需要代理就不传这个字段
});
```

### 方法

| 方法 | 返回 | 说明 |
|---|---|---|
| `http.get(url, config?)` | `Promise<T>` | 直接返回响应体，不用再 `.data` |
| `http.post(url, data?, config?)` | `Promise<T>` | 同上 |
| `http.getText(url, config?)` | `Promise<string>` | **抓网页用这个**：按 charset 自动解码，GBK 站点不乱码 |
| `http.getBuffer(url, config?)` | `Promise<Buffer>` | 拉取图片 / 文件等二进制内容 |
| `http.request(config)` | `Promise<T>` | 通用入口，PUT / DELETE / HEAD 等都走它 |
| `http.instance` | `AxiosInstance` | 底层 axios 实例，需要拦截器、`defaults` 等能力时使用 |

```ts
const html = await http.getText('https://example.com');       // 自动识别编码
const buf  = await http.getBuffer('https://example.com/a.png');
const data = await http.post('https://api.example.com/items', { id: 1 });

// 底层能力照常可用
http.instance.interceptors.response.use(res => res);
http.instance.defaults.headers['Referer'] = 'https://example.com';
```

### 重试与限速

```ts
const http = createHttp({
    retry: {
        retries: 3,        // 重试次数（不含首次），默认 0 —— 默认不重试
        delay: 500,        // 首次退避毫秒
        factor: 2,         // 退避倍数：500 → 1000 → 2000
        maxDelay: 10_000,  // 单次退避上限
        jitter: true,      // 随机抖动，避免多线程同时重试
        // shouldRetry: (err, attempt) => ...   // 自定义判定
    },
    minInterval: 300,      // 同一客户端相邻请求至少间隔 300ms
});
```

- 默认可重试的情形：网络层失败、`408`、`425`、`429`、`500/502/503/504`。
- 响应带 `Retry-After` 时优先按它等待。
- `minInterval` 只在**当前客户端实例**内生效，多线程 / 多进程之间不共享（限速要全局生效得放在任务分发层）。

### 代理配置

```ts
interface ProxyConfig {
    protocol?: 'http' | 'https';   // 默认 http
    host: string;
    port: number;
    auth?: { username: string; password: string };
}
```

> 不传 `proxy` 时会显式设置 `proxy: false`，**不会**继承 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量——想要环境代理请显式传入。
>
> axios 不支持 socks 代理。需要 socks5 时，用 `http.instance.defaults.httpsAgent` 挂 `socks-proxy-agent`。

---

## 并发任务池 `TaskPool`

基于 `worker_threads`。**主线程**用 `TaskPool` 派发任务，**子线程**用 `defineThreadTask` 注册处理器，两侧职责彻底分离，全程 Promise，任务错误不会被吞掉。

### 子线程：注册任务处理器

在 worker 文件里导出一个任务函数：

```ts
// crawler.ts
import { defineThreadTask } from 'request-pack';

export const task = defineThreadTask(async (data: { url: string }) => {
    const res = await fetch(data.url);
    return { url: data.url, status: res.status };
});
```

`defineThreadTask` 在主线程被 import 时是**空操作**（不产生副作用、不挂监听），只有被 `worker_threads` 派生的子线程才真正接管消息。

### 主线程：创建任务池

```ts
import { TaskPool } from 'request-pack';
import { cpus } from 'node:os';

const pool = new TaskPool<{ url: string; status: number }>({
    worker: __filename,              // worker 脚本路径，通常就是当前文件
    concurrency: cpus().length - 1,  // 并发线程数，默认 3
    taskTimeout: 30_000,             // 单任务超时（从派发开始计时），超时后换掉卡住的线程
    keepAlive: false,                // true：任务跑完保留线程供下一批复用，需自行 dispose()
    workerOption: {},                // 可选，透传给 worker_threads
});

pool.on('progress', ({ done, total }) => {
    console.log(`${done}/${total}`);
});
pool.on('taskError', ({ task, error, reason }) => {
    console.warn('任务失败', reason, task, error);
});

const { results, errors, items } = await pool
    .addTasks(urls.map(url => ({ url })))
    .run();
```

### API

| 成员 | 说明 |
|---|---|
| `addTask(task)` | 添加单个任务，返回 `this` 支持链式调用 |
| `addTasks(tasks)` | 批量添加，返回 `this` |
| `run()` | 启动并等待全部任务结束，返回 `{ results, errors, items }` |
| `dispose()` | 终止所有线程并释放资源；未完成任务记为 `disposed`，挂起的 `run()` 以当前进度 resolve |
| `destroy()` | `dispose()` 的别名（旧名字） |
| `on('progress', cb)` | 每完成一个任务触发，参数 `{ done, total }` |
| `on('taskError', cb)` | 单个任务失败时触发，参数 `TaskError` |

`TaskError` 形状：

```ts
{
    task: any;                  // 原始任务数据
    error: string;              // 错误消息
    stack?: string;             // 子线程里的原始堆栈
    reason: 'task' | 'timeout' | 'crash' | 'disposed';
}
```

### 行为约定

- **单个任务失败不会中断整体**：失败项进入 `errors`，其余任务照常跑完。
- **结果按提交顺序**：`results`、`errors`、`items` 都按 `addTask` 的顺序排列，不再受完成快慢影响；`items` 给出每个任务的完整去向（含 `task`），便于和输入数组一一对齐。
- **任务可中途追加**：`run()` 之后继续 `addTask` 也会被执行，Promise 等全部结束才 resolve。
- **多个 `run()` 共享同一批结果**：并发调用会拿到同一个结果对象。
- **超时只杀该任务**：`taskTimeout` 从派发那一刻开始计时（含线程冷启动），超时后该任务记为 `timeout`，对应线程被终止并重建——卡死的线程不能复用。
- **崩溃隔离**：worker 线程崩溃只把它手上的那一个任务记为 `crash`，其他线程上的任务不受影响，池子会自动补线程继续跑。
- **线程复用**：默认每次 `run()` 结束就释放线程；频繁分多批跑时用 `keepAlive: true`，并在结束时 `await pool.dispose()`。
- ESM 环境下没有 `__filename`，用 `fileURLToPath(import.meta.url)` 代替。

---

## HTML 解析 `html2object`

用 schema 组合器代替字符串 DSL，复制粘贴选择器时不会写错括号，结果类型可被 TypeScript 推导。

```ts
import { html2object, text, html, attr, loop } from 'request-pack';

const data = html2object(page, {
    title: text('title'),
    content: html('article .body'),
    author: text('.meta .name'),
    tags: loop('.tag-list li', {          // 列表 → 对象数组
        name: text('span'),
        href: attr('href', 'a'),
    }),
});
// => {
//      title: '标题',
//      content: '<p>...</p>',
//      author: '张三',
//      tags: [{ name: '前端', href: '/tag/fe' }, ...]
//    }
```

### 组合器

| 组合器 | 结果 | 说明 |
|---|---|---|
| `text(selector, { first?, index? })` | `string` | 取文本并 trim |
| `html(selector, { first?, index? })` | `string` | 取 innerHTML 并 trim |
| `attr(name, selector?, { index? })` | `string` | 取属性；省略 selector 时读当前节点自身 |
| `json(selector)` | `any` | 把元素文本当 JSON 解析（典型场景：JSON-LD） |
| `loop(selector, schema)` | `T[]` | 遍历匹配元素；schema 传对象 → 对象数组，传单个字段 → 标量数组 |
| `object(selector?, schema)` | `T` | 在子树内解析，产出嵌套对象 |
| `nullable(field)` | `string \| null` | 未匹配时返回 `null`，与「匹配但内容为空」区分开 |

- selector 传空字符串 `''` 表示**当前节点自身**（在 `loop` 内部取值时常用）。
- `text('li')` 默认会把**所有**匹配元素的文本拼在一起；只要第一个时加 `{ first: true }`，要第 N 个用 `{ index: n }`。
- `loop` / `object` 支持**任意层嵌套**。
- 第三个参数 `removeSelector: string[]` 可在解析前先移除干扰节点（广告、脚本等）。

```ts
const data = html2object(page, {
    title: text('title'),
    price: nullable(text('.price')),                  // 没有这个节点 → null
    cover: attr('src', 'img.cover', { first: true }),
    firstLi: text('li', { first: true }),             // 只取第一个，不拼接
    card: object('.card', {                           // 子树内取多个字段
        name: text('h2'),
        price: text('.price'),
    }),
    ld: json('script[type="application/ld+json"]'),   // 结构化数据
});

// 解析前先移除广告与脚本
const clean = html2object(page, { article: text('#content') }, ['.ad', 'script']);
```

### 错误处理

schema 写错会**立即抛错**，错误信息带字段路径，嵌套列表能定位到第几条：

```
html2object: 字段 "list[0].href" 缺少属性名 name
html2object: 字段 "list" 不是合法的 schema 字段（请使用 text/html/attr/json/loop/object 组合器构造）
html2object: 字段 "ld" 的内容不是合法 JSON：Unexpected token o
```

---

## 工具函数 `utils`

```ts
import { utils } from 'request-pack';

await utils.delay(1000);                              // 等待指定毫秒
utils.decode(buffer, 'gbk');                          // 按编码解码 Buffer
utils.resolveUrl('/a/b', 'https://example.com/x/y');  // → https://example.com/a/b
utils.getBaseHref(html);                              // 文档里的 <base href>
utils.getDocumentBase(html, pageUrl);                 // 基准地址：<base> 优先，否则页面地址
utils.iconv;                                          // iconv-lite 本体
```

抓列表页时通常这样把相对链接转成绝对链接：

```ts
const base = utils.getDocumentBase(html, pageUrl);
const links = html2object(html, { href: attr('href', 'a.next') }).href;
const next = utils.resolveUrl(links, base);
```

---

## 完整示例

一个最小的并发抓取流程：请求 → 并发 → 解析。

```ts
// crawler.ts
import { createHttp, defineThreadTask, TaskPool, html2object, text, attr, loop } from 'request-pack';
import { cpus } from 'node:os';

const http = createHttp({ timeout: 15_000 });

export const task = defineThreadTask(async ({ url }: { url: string }) => {
    const page = await http.getText(url);          // 自动识别编码
    return html2object(page, {
        title: text('h1'),
        links: loop('.list a', { href: attr('href'), name: text('') }),
    });
});

async function main() {
    const pool = new TaskPool({ worker: __filename, concurrency: cpus().length - 1 });
    const urls = ['https://example.com/1', 'https://example.com/2'];

    const { results, errors } = await pool
        .addTasks(urls.map(url => ({ url })))
        .run();

    console.log(`成功 ${results.length}，失败 ${errors.length}`);
}

void main();
```

```bash
npx tsx crawler.ts
```

---

## 开发

```bash
npm run dev           # tsx 运行 example.ts
npm test              # tsx --test，Node 内置 test runner
npm run test:coverage # 带覆盖率（需 Node >= 20）
npm run typecheck     # tsc --noEmit（含 test/ 目录）
npm run build         # tsup 构建到 dist/
```

### 构建产物

| 文件 | 用途 |
|---|---|
| `dist/index.cjs` | CommonJS，`require('request-pack')` |
| `dist/index.mjs` | ESM，`import ... from 'request-pack'` |
| `dist/index.d.ts` / `dist/index.d.mts` | 对应两种模块解析的类型声明 |

### 环境要求

- 运行库：Node **>= 18.17**（`cheerio` 1.0 的下限）
- 跑测试：Node **>= 18**（`tsx` 转译 TS，不需要额外测试框架）
- CI 在 Node 18 / 20 / 22 三个版本上跑 `typecheck + test + build`

## License

ISC
