# Changelog

## 1.3.0

新增单线程任务调度器 `TaskScheduler` / `createTaskScheduler`，把 7 个解析组合器收敛到 `html2object` 函数对象上，并修复 `createFetcher` 的 `with()` 派生缺陷。**无破坏性变更**：既有模块的公开签名与行为、`exports`、tsup 单入口、4 个 dist 文件名、依赖、`engines` 一律不变，新模块零依赖。

> 版本由已发布的 `1.2.0` 直接跳到 `1.3.0`：本批改动含新增 API，原计划的补丁版 `1.2.1` 不再单独发布，其 `with()` 修复一并并入本版。

- **单线程**：不创建 `worker_threads`，在当前事件循环里用 Promise 池控制 `concurrency`；与 `TaskPool`（子线程跑 CPU 密集任务）互补，适合一组受控并发的 I/O 任务
- **结果按输入下标排序**：`results` 长度恒等于任务列表长度，每项 `{ ok, status, value, result, error?, item, index }`，`result` 是 `value` 的别名；`errors` 为 `{ error, item, index, reason, cause? }`，两者都是只读快照
- **链式 API**：`start()` / `done(cb)` / `stop()` / `restart()` 全部返回实例本身，另有 `results` / `errors` / `status` getter 与 `wait(): Promise<{ results, errors }>`
- **失败不中断整批**：同步 throw 与 rejected Promise 都记为 `failed`；`stop()` 只停止派发、在途 Promise 照常跑完并结算，未派发项记为 `cancelled`；`restart()` 只重跑 `failed` + `cancelled`，成功结果保留，在途未结算时先等待再开新一轮
- **日志显式化**：不传 / `false` 静默，`true` 才绑定 `console`，也可传自定义 `SchedulerLogger`；不读环境变量
- **组合器收敛到 `html2object`**：7 个组合器（`text / html / attr / json / loop / object / nullable`）用 `Object.assign` 挂到 `html2object` 函数对象上，可写 `html2object.text(...)`；**与命名导出是同一个函数引用，不是第二套构造器**，根入口原有命名导出全部保留，零破坏。解析行为与 `ParsedResult<S>` 推导不变；README 主示例改用新写法。`test/parser.test.ts` 补 4 个用例（引用同一性、两种写法结果一致、静态推导、约束选项），smoke 补 7 个方法的运行时断言。
- `src/index.ts` 新增一行 re-export；新类型统一用 `Scheduler*` 前缀，避免与 `pool.ts` 的 `TaskError` / `TaskOutcome` 冲突
- `test/scheduler.test.ts` 新增 18 个用例（顺序、并发上限、失败、stop 在途、restart 边界、链式、快照、配置校验、日志与异常兜底），已加入 `scripts.test` / `scripts.test:coverage` 的显式文件列表；`test/smoke/compat.mjs` 补 Node 18 可跑的全链路与 CJS 导出断言。新模块行覆盖率 100%
- **修复 `createFetcher.with()` 派生缺陷**：`with({ schema })` 换字段时原本会继承按旧结果形状写的 `parser` 加工函数，旧函数访问新结果里不存在的字段会抛 `TRANSFORM_FAILED`，README 里「创建时配 `parser`、再 `with({ schema })`」的示例写法会直接失败。现在只要传了新 `schema` 且未显式提供 `parser`，派生实例就不带加工链；显式传 `parser`（含 `[]`）以传入为准，不换 schema 的 `with({ timeoutMs })` 等行为不变。`Fetcher.with` 泛型重载的 JSDoc 与 README 写清该语义，`test/fetcher.test.ts` 新增 2 个回归测试。
- 版本 `1.2.0 → 1.3.0`，`package.json` 与 `package-lock.json`（顶部 + `packages[""]`）同步；`exports`、单入口、4 个 dist 文件名、依赖、`engines`、`cheerio ~1.0.0` 锁均不变。

## 1.2.0

新增向后兼容的高层管线 `createFetcher`，把「请求 → HTML 结构化解析 → 输出校验 → 结果加工 → 复验」串成一次调用。**无破坏性变更**：既有 `createHttp` / `TaskPool` / `html2object` / `utils` 的公开签名与行为一律不变，`exports`、单入口与 4 个 dist 文件名不变，engines 仍是 `>=18.17`。

### 新增 `createFetcher`

- 一次编译、两处使用：创建时用 zod 的 `z.discriminatedUnion('type', …) + z.lazy()` 校验 Options 与整棵 Field 树，编译出 `outputSchema` 缓存进闭包；每次请求在 `html2object` 之后校验，在结果加工之后**用同一个 schema 复验**
- 失败一律抛 `FetcherError`（`code` / `phase` / `fieldPath` / `plugin` / `url` / `cause`），不填空、不 coerce、不返回 partial 数据、无 strict/lenient 开关
- **`parser` 配置取代插件系统**：结果加工函数或函数数组，按序串行 `await`（支持 Promise），上下文只读（`Object.freeze`）；不提供 `definePlugin` / `requires` / 钩子链 / 模块级注册表
- `safe()` / `raw()` / `close()` / `outputSchema` / `with()`（含换 schema 的泛型重载）；`request(url, overrides)` 禁止运行时切换 schema
- `retries` 直接映射到 `createHttp({ retry: { retries } })`，重试只覆盖 fetch，解析 / 校验 / 加工失败不重试；`timeoutMs` 同时映射到 axios `timeout` 与请求总时限
- `type:'axios'` 与 `type:'browser'` 判别联合，browser 专属键在编译期与运行时双重拒绝；`proxy` 原样复用 `ProxyConfig`
- Node 18 兼容：自实现 `composeSignals()`（不用 `AbortSignal.any()`）、`Symbol.asyncDispose` 运行时特性检测；README 如实说明 cheerio 同步解析无法被 signal 中断
- browser 分支：Chromium 懒启动 + 实例内复用，playwright 仅 optional peer，CJS 产物用运行时构造的动态 `import()` 避免被降级成 `require`

### 组合器（只加可选字段）

- `text` / `html` / `attr` 的 options 新增 `required? / min? / max? / pattern?`；`loop` 新增第三参数 `{ minItems?, maxItems? }`；`json(selector, zodSchema?)` 可选覆盖输出校验
- 约束只挂在 Field 上，`html2object` 仍是 best-effort、不据此报错；`ParsedResult<S>` 推导与现有测试完全不变
- 导出 `isFieldShape()`，供 `compileFieldTree` 与解析器共用同一个判据

### 依赖与工程

- **硬依赖由 3 个增至 4 个**：axios / cheerio / iconv-lite / **zod `^4`**。校验是 `createFetcher` 的必需能力，从 `src/index.ts` 根入口直接 re-export，放 optional peer 会让 `import 'request-pack'` 直接失败；zod 是纯 JS、无平台 API，不影响 Node 18 下限
- `playwright >=1.40.0` 进 `optional peerDependencies`（`peerDependenciesMeta.optional: true`），**绝不进 dependencies**，避免 Chromium 下载拖垮轻量定位
- 版本 `1.1.1 → 1.2.0`，`package.json` 与 `package-lock.json`（顶部 + `packages[""]`）同步
- `test/compiler.test.ts` / `test/fetcher.test.ts` 加入 `scripts.test` 与 `scripts.test:coverage` 的显式文件列表；`test/smoke/compat.mjs` 补 axios 完整链路与「未装 playwright 时 `require('request-pack')` 正常」断言
- `test/smoke` 仍只用 Node 18 API；CI 三个 job 结构、构建产物表、`prepublishOnly`、cheerio `~1.0.0` 锁均不变
- 顺带把 axios 的传递依赖 `follow-redirects` 从 1.16.1 锁到 1.16.3，`npm audit` 恢复 0 漏洞

## 1.1.1

- 修复：worker 以 code 0 提前退出（最常见的是 worker 文件漏写 `defineThreadTask`）时任务永久挂起、`run()` 永不返回；现在记为 `crash` 并提示检查 `defineThreadTask`
- 修复：超时 / 崩溃后迟到的回包可能误清同一线程下一个任务的超时计时器
- 修复：`retry.retries` 传入 `NaN` 会导致无限重试；`retries` / `delay` / `factor` / `maxDelay` 非法值统一回落到默认
- 增强：`Content-Type` 中带引号的 `charset="gbk"` 也能识别
- 优化：`getText` / `getBuffer` 拿到的已是 Buffer 时不再二次拷贝
- 工程：`prepublishOnly` 补上 `test:smoke`

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
