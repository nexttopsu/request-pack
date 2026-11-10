# request-pack

**轻量请求工具包**：HTTP 请求 → 并发调度 → 结构化解析，外加一条把它们串起来的高层管线 `createFetcher`。

三个基础模块互相独立，可以只用其中一个，也可以组合使用。Node 原生能力优先，运行时硬依赖只有必要的四个（axios / cheerio / iconv-lite / zod）。`playwright` 是**可选 peer 依赖**，只有用 browser 分支才需要装，绝不会拖着 Chromium 一起下载。

```bash
npm install request-pack
```

```ts
import { createHttp, TaskPool, defineThreadTask, html2object, createFetcher, text, attr, loop } from 'request-pack';
```

## 目录

- [HTTP 客户端 `createHttp`](#http-客户端-createhttp)
- [并发任务池 `TaskPool`](#并发任务池-taskpool)
- [HTML 解析 `html2object`](#html-解析-html2object)
- [高层管线 `createFetcher`](#高层管线-createfetcher)
- [工具函数 `utils`](#工具函数-utils)
- [完整示例](#完整示例)
- [开发](#开发)

---

## HTTP 客户端 `createHttp`

基于官方 axios（`>= 1.16.1` 起原生支持 HTTPS 代理的 CONNECT 隧道）。**不会偷偷挂代理**——不传 `proxy` 就是直连，也不会读 `HTTP_PROXY` 环境变量。其余默认值只有两个，且都可覆盖：`timeout: 30_000`、一个常见的桌面浏览器 `User-Agent`。

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

编码嗅探也可以单独使用（例如你已经有一份 Buffer）：

```ts
import { detectCharset, utils } from 'request-pack';

const charset = detectCharset(headers, buffer) ?? 'utf-8';
const html = utils.decode(buffer, charset);
```

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
| `text(selector, { first?, index?, required?, min?, max?, pattern? })` | `string` | 取文本并 trim |
| `html(selector, { first?, index?, required?, min?, max?, pattern? })` | `string` | 取 innerHTML 并 trim |
| `attr(name, selector?, { index?, required?, min?, max?, pattern? })` | `string` | 取属性；省略 selector 时读当前节点自身 |
| `json(selector, zodSchema?)` | `any` | 把元素文本当 JSON 解析（典型场景：JSON-LD） |
| `loop(selector, schema, { minItems?, maxItems? })` | `T[]` | 遍历匹配元素；schema 传对象 → 对象数组，传单个字段 → 标量数组 |
| `object(selector?, schema)` | `T` | 在子树内解析，产出嵌套对象 |
| `nullable(field)` | `string \| null` | 未匹配时返回 `null`，与「匹配但内容为空」区分开 |

- selector 传空字符串 `''` 表示**当前节点自身**（在 `loop` 内部取值时常用）。
- `text('li')` 默认会把**所有**匹配元素的文本拼在一起；只要第一个时加 `{ first: true }`，要第 N 个用 `{ index: n }`。
- `loop` / `object` 支持**任意层嵌套**。
- 第三个参数 `removeSelector: string[]` 可在解析前先移除干扰节点（广告、脚本等）。
- `required?` / `min?` / `max?` / `pattern?` / `minItems?` / `maxItems?` 是**输出约束**：`html2object` 自身仍是 best-effort，不会据此报错；它们由 `createFetcher` 编译成输出校验规则（见下节）。这些可选字段不改变组合器的返回类型，`ParsedResult<S>` 推导与旧版完全一致。

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

## 高层管线 `createFetcher`

把「请求 → HTML 结构化解析 → zod 输出校验 → 结果加工 → 复验」串成一次调用。它不重写下面三个模块：抓取走 `createHttp().getText()`（自动识别 GBK），解析走 `html2object()`，校验由创建时编译出的 zod schema 负责。

```ts
import { createFetcher, text, nullable, loop } from 'request-pack';

const request = createFetcher({
    type: 'axios',                        // 'axios' | 'browser'
    retries: 2,
    timeoutMs: 20_000,
    proxy: { host: '127.0.0.1', port: 1080 },
    headers: { 'Accept-Language': 'zh-CN' },
    logging: false,
    schema: {
        title: text('h1.title', { required: true }),
        price: nullable(text('.price')),
        tags: loop('.tag', text('')),
    },
    // parser：处理结果的函数，或函数数组；串行 await，支持 Promise
    parser: [async (data) => ({ ...data, title: data.title.trim() })],
});

const res = await request('https://example.com/a');
// res.title: string / res.price: string | null / res.tags: string[] —— 静态推导 + 运行时已校验
console.log(res.title, res.price, res.tags);
await request.close();
```

> **没有插件系统**，也没有 `definePlugin` / `requires` / 钩子链。要加工结果就传 `parser`；要改本次请求用 `request(url, overrides)`；要换字段用 `request.with({ schema })`。

### 流水线顺序

```
fetch → html2object → outputSchema.parse → parser 函数链 → 同一个 outputSchema.parse → res
```

- `createHttp` 的重试**只包住 axios 请求**；browser 分支由 browserTransport 内部实现同等重试，同样只覆盖 fetch。所以**解析 / 校验 / 加工失败不会重试**，也不会额外包一层重试循环。
- `raw(url)` 只跑到 fetch，跳过解析、校验与加工，返回原始 HTML，用来调选择器。
- `parser` 数组按声明顺序**串行 `await` 执行**，每一步拿到上一步的返回值；上下文 `ctx` 是 `Object.freeze` 的只读对象 `{ url, finalUrl, status, html, transport }`。函数返回 `undefined` 表示沿用上一步结果（允许就地修改）。加工函数抛错会包装成 `phase:'plugin'` 的 `FetcherError`。
- **加工后必须用同一个 `outputSchema` 再 `parse()` 一次**，否则类型与「输出一致」的保证都会失效。把 `required` 字段改成空串会在这里被拦下。
- 任何失败（配置、抓取、解析、输出不符 schema、加工、超时）一律抛 `FetcherError`：不填空、不 coerce、不返回 partial 数据、没有 strict/lenient 开关。

### 配置项与底层映射

| 配置 | 映射到底层 | 默认 / 约束 |
|---|---|---|
| `type` | 选 `createHttp` 或 browserTransport | 必填 `'axios' \| 'browser'` |
| `retries` | `createHttp({ retry: { retries } })`；browser 分支内部同等次数重试 | `0`，0–10 整数 |
| `timeoutMs` | `createHttp({ timeout: timeoutMs })` + 请求级 `AbortSignal.timeout(ms)` 总时限 | `20_000`，100–300000 |
| `proxy` | **原样复用 `ProxyConfig`**，透传 `createHttp({ proxy })` / `chromium.launch({ proxy })` | 不传即直连（`proxy:false`），不读环境变量 |
| `headers` | `createHttp({ headers })` / `page.setExtraHTTPHeaders` | `{}`；键须是 RFC 7230 token，值不得含 CRLF |
| `http` | 其余 `AxiosRequestConfig` 透传 `createHttp`；`timeout/proxy/headers` 以显式配置键为准 | — |
| `logging` | `boolean \| Logger`（`{ info?, warn?, error? }`） | `false` / 省略 → noop，**不硬编码 `console`** |
| `headless` | 仅 browser 分支 → `chromium.launch({ headless })` | `true` |
| `schema` | 创建时 zod 校验整棵 Field 树 → 编译 `outputSchema`；解析时原样传给 `html2object` | 必填 |
| `parser` | 结果加工函数 / 函数数组 | `[]` |
| `removeSelector` | `html2object(html, schema, removeSelector)` 的第三参数 | — |
| `waitUntil` / `blockResources` / `viewport` | browser 分支 → `page.goto` / `page.route` / `browser.newPage` | — |

`type:'browser'` 才允许 `headless / waitUntil / blockResources / viewport`；`type:'axios'` 写 `headless` 会在 **TS 编译期和运行时都被拒绝**。其余校验规则：`retries` 0–10 整数、`timeoutMs` 100–300000、字段名 `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`、selector 长度 ≤ 500（**允许空串**）、`attr` 必须有 `name`、`loop` 必须有 `selector` 与 `schema`、Field 树嵌套深度 ≤ 8。错误信息的字段路径沿用解析器风格，如 `schema.tags[0].href.selector`。

### 创建时编译 / 两处使用

创建时用 `z.discriminatedUnion('type', …) + z.lazy()` 校验 Options 与整棵 Field 树，再 `compileFieldTree(schema)` 编译成 `z.ZodType<ParsedResult<S>>`，**缓存进闭包、全实例复用**。编译映射与 `html2object` 的运行时行为严格对齐：`text/html/attr → string`（约束 → `min/max/regex`，最后才 `.nullable()`）、`json → unknown`（可用 `json(selector, zodSchema)` 覆盖）、`loop + Schema 对象 → array(object(...))`、`loop + 单个 Field → array(compileField(...))`、`object → object(...)`。判定 loop 子 schema 用的是 `html2object` 里同一个 `isFieldShape()`。

**schema 不允许运行时切换**：`request(url, overrides)` 只接受 `headers / signal / timeoutMs / proxy / http`，类型上 `schema?: never`，运行时也会拒绝。要换字段必须派生新实例：

```ts
const detail = request.with({ schema: { heading: text('h1') } });
// detail 的类型是 Fetcher<{ heading: TextField }>，重新走完整校验与编译
const plain = request.with({ timeoutMs: 5_000 });   // 不换 schema → Fetcher<原 S>
```

### `Fetcher<S>` 成员

| 成员 | 行为 |
|---|---|
| `request(url, overrides?)` | `Promise<ParsedResult<S>>`，失败抛 `FetcherError` |
| `request.safe(url, overrides?)` | `{ ok:true, data, meta } \| { ok:false, error, meta }`，**不抛错**；`meta = { finalUrl, status, elapsedMs, transport }` |
| `request.raw(url, overrides?)` | 原始 HTML 字符串，跳过解析 / 校验 / 加工 |
| `request.close()` | 释放连接池与浏览器，幂等；关闭后调用抛 `code:'CLOSED'` |
| `request[Symbol.asyncDispose]` | 仅在运行时存在该 Symbol 时挂上 `close` |
| `request.with(overrides)` | 派生新实例，可换 schema（泛型重载保证静态类型跟着变） |
| `request.outputSchema` | 暴露编译后的 zod schema，供测试与复用 |

### `FetcherError`

统一 `extends Error`，字段 `{ code, phase, fieldPath?, plugin?, url?, cause? }`。`plugin` 字段保留枚举语义，现在用于标记出错的 `parser` 加工函数。

| code | phase | 含义 |
|---|---|---|
| `INVALID_CONFIG` / `INVALID_SCHEMA` | `config` | 创建时配置 / Field 树非法、请求级 overrides 非法 |
| `CLOSED` | `fetch` | 实例已 `close()` |
| `FETCH_FAILED` / `ABORTED` | `fetch` | 抓取失败 / 被外部 `signal` 取消 |
| `BROWSER_MISSING` / `BROWSER_FAILED` | `browser` | 未装 playwright / Chromium 启动或渲染失败 |
| `TIMEOUT` | `timeout` | 超过 `timeoutMs` 总时限 |
| `PARSE_FAILED` | `parse` | `html2object` 抛错（原 message 里的字段路径保留） |
| `VALIDATE_FAILED` | `validate` | 解析结果或加工结果不符 `outputSchema`，`fieldPath` 如 `list[0].href` |
| `TRANSFORM_FAILED` | `plugin` | `parser` 加工函数抛错 |
| `UNEXPECTED` | `fetch` | 兜底 |

### `nullable` 与 `required` 的区别

| | 作用层面 | 未匹配 | 匹配但为空 |
|---|---|---|---|
| `nullable(field)` | 解析行为 + 静态类型 | `null`（类型变 `string \| null`） | `''` |
| `required: true` | `outputSchema` 输出约束 | `''` → 校验失败 | `''` → 校验失败 |

两者可以叠加：`nullable(text('.p', { required: true }))` 未匹配返回 `null` 合法，一旦匹配到空节点就仍会被拦。`html2object` 本身不会因为 `required` 报错，它仍是 best-effort。

### 生命周期与 Node 18 注意点

- **Node 18 没有 `Symbol.asyncDispose`，`await using` 不可用**，必须手动 `await request.close()`。`composeSignals()` 自行用 `AbortController` + 事件监听实现，不用 Node 18.17 上不存在的 `AbortSignal.any()`，并在 `finally` 里 `dispose()` 移除监听。
- `timeoutMs` 是**单次请求总时限**（抓取 + 渲染 + 解析 + 校验）。axios 侧同时设 `timeout` 防底层挂死。**明确限制：cheerio 解析是同步 CPU 操作，无法被 signal 中断**，只能在阶段边界检查 `signal.aborted`，不要指望它能打断一次超大的解析。
- browser 分支的 Chromium **懒启动 + 实例内复用**，不是每次 request 都 launch；`headless`、`proxy`、`waitUntil`、`blockResources`、`viewport` 分别映射到 launch / goto / route / newPage。

### browser 分支与 playwright

`playwright` 只放在 **optional peerDependencies**（`peerDependenciesMeta.optional: true`），不在 `dependencies` 里 —— 不装它也不影响 axios 分支，更不会触发 Chromium 下载。未安装时创建 browser 实例会给出可操作提示，不吐堆栈：

```
未安装 playwright：请执行 npm i playwright && npx playwright install chromium
```

CJS 产物里用运行时构造的动态 `import()` 加载 playwright，避免 esbuild 把它降级成 `require('playwright')`；`npm run test:smoke` 会在未安装 playwright 时验证 `require('request-pack')` 依然正常。

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
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

const http = createHttp({ timeout: 15_000 });

export const task = defineThreadTask(async ({ url }: { url: string }) => {
    const page = await http.getText(url);          // 自动识别编码
    return html2object(page, {
        title: text('h1'),
        links: loop('.list a', { href: attr('href'), name: text('') }),
    });
});

async function main() {
    const pool = new TaskPool({
        worker: fileURLToPath(import.meta.url),    // ESM 下没有 __filename
        concurrency: cpus().length - 1,
    });
    const urls = ['https://example.com/1', 'https://example.com/2'];

    const { results, errors } = await pool
        .addTasks(urls.map(url => ({ url })))
        .run();

    console.log(`成功 ${results.length}，失败 ${errors.length}`);
}

// worker 线程会重新执行这个文件，必须拦住入口逻辑
if (isMainThread) void main();
```

```bash
npx tsx crawler.ts
```

> 仓库里的 [`example.ts`](./example.ts) 是同一套流程的可运行版本：本地起一个测试站点（含 GBK 页面），跑通请求 → 并发 → 解析，`npm run dev` 直接看结果。

> 浏览器打开 [`playground.html`](./playground.html) 可以可视化编辑 `html2object` 的 schema：左侧点击页面元素自动生成选择器，中间增删字段，右侧实时预览解析结果并生成对应的 TS 代码。零依赖单文件，双击即用。

---

## 开发

```bash
npm run dev           # 先构建，再跑 example.ts（走 dist 产物，验证 exports）
npm test              # tsx --test，Node 内置 test runner（显式列出 6 个测试文件）
npm run test:coverage # 带覆盖率（需 Node >= 20），文件列表与 npm test 一致
npm run test:smoke    # 产物冒烟：直接跑 dist，不依赖 tsx（可在 Node 18 上验证）
npm run typecheck     # tsc --noEmit（含 test/ 与 example.ts）
npm run build         # tsup 构建到 dist/
```

`test/compiler.test.ts` 覆盖 zod 配置校验与编译映射，`test/fetcher.test.ts` 覆盖完整链路、parser 复验、重试边界、超时与生命周期；两者都已加入 `scripts.test` / `scripts.test:coverage` 的显式文件列表（不用 glob，所以必须手动登记）。

### 构建产物

| 文件 | 用途 |
|---|---|
| `dist/index.cjs` | CommonJS，`require('request-pack')` |
| `dist/index.mjs` | ESM，`import ... from 'request-pack'` |
| `dist/index.d.ts` / `dist/index.d.mts` | 对应两种模块解析的类型声明 |

### 环境要求

| 用途 | 版本要求 | 原因 |
|---|---|---|
| 使用这个库 | Node **>= 18.17** | `cheerio` 1.0 的下限；产物 target 为 node18 |
| 跑测试 | Node **>= 20** | 测试里的 worker 直接加载 `.ts`，依赖 Node 20 的 `module.register` |
| 构建 | Node **>= 22.18** | `tsup` 9 的引擎要求 |

CI 分三个 job：`test`（Node 20 / 22）、`build`（Node 22）、`compat`（Node 18 跑 `test:smoke` 验证产物能在引擎下限运行）。

## License

ISC
