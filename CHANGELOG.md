# Changelog

## 1.0.1

- 修复：`exports["."]` 顶层补声明 `"types": "./dist/index.d.ts"`，`moduleResolution: "nodenext"`（及部分 bundler）下不再报"找不到类型声明"

## 1.0.0

首个稳定版。三个模块互相独立：HTTP 请求 / 并发任务池 / HTML 结构化解析。

### HTTP `createHttp`

- `createHttp(options)` 工厂，不传代理即直连（显式 `proxy: false`，不继承 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量）
- `get` / `post` 直接返回响应体；`request()` 覆盖 PUT / DELETE / HEAD
- `getText()` 按 `Content-Type` 与 `<meta charset>` 自动识别编码（GBK 等站点不乱码）
- `getBuffer()` 拉取二进制内容
- `retry`：次数 / 退避倍数 / 上限 / 抖动 / 自定义 `shouldRetry`，识别 `Retry-After`
- `minInterval`：同一客户端相邻请求的最小间隔
- `instance`：底层 axios 实例，拦截器与 `defaults` 照常可用
- 代理支持 `http` / `https`，由 axios >= 1.16.1 的 CONNECT 隧道实现（不支持 socks）

### 并发任务池 `TaskPool`

- 主线程 `TaskPool` 与子线程 `defineThreadTask` 职责分离，全程 Promise
- 并发数控制、任务中途追加、多个 `run()` 共享结果
- `taskTimeout` 任务超时，超时后终止并重建该线程
- 线程崩溃隔离：只把该线程手上的任务记为失败，其他线程不受影响，自动补线程
- `keepAlive` 线程复用 + `dispose()` 释放
- `results` / `errors` / `items` 均按提交顺序排列；`items` 给出每个任务的完整去向
- `TaskError.reason`（`task` / `timeout` / `crash` / `disposed`）与子线程堆栈
- 事件：`progress`、`taskError`

### HTML 解析 `html2object`

- 组合器 schema：`text` / `html` / `attr` / `json` / `loop` / `object` / `nullable`
- 结果类型由 TypeScript 自动推导，`nullable()` 推导为 `string | null`
- `first` / `index` 控制取第几个匹配元素
- `object()` 在子树内解析多个字段；`loop` 支持任意层嵌套
- `json()` 解析 JSON-LD 等 JSON 文本节点
- 解析前可用 `removeSelector` 移除广告、脚本等干扰节点
- schema 写错立即抛错，错误信息带字段路径（如 `list[0].href`）

### 工具函数 `utils`

- `delay` / `decode` / `iconv`
- `resolveUrl` / `getBaseHref` / `getDocumentBase`：相对链接转绝对链接

### 工程

- 产物：`dist/index.cjs`、`dist/index.mjs`、`dist/index.d.ts`、`dist/index.d.mts`
- 运行时要求 Node.js >= 18.17；测试用 `tsx --test`（Node 内置 test runner），构建用 `tsup`
- `npm run test:smoke`：直接跑 dist 的产物冒烟，可在 Node 18 上验证引擎下限
- CI：Node 20 / 22 跑测试，Node 22 构建，Node 18 跑产物冒烟
- 依赖仅三个：`axios` / `cheerio` / `iconv-lite`
