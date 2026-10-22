# Changelog

## 1.1.0

### 新增

- `http`：`retry` 配置（次数 / 退避倍数 / 上限 / 抖动 / 自定义 `shouldRetry`），自动识别 `Retry-After`
- `http`：`minInterval` 限速，保证同一客户端相邻请求的最小间隔
- `http`：`getText()` 按 `Content-Type` 与 `<meta charset>` 自动识别编码，GBK 站点不再乱码
- `http`：通用 `request()` 入口，支持 PUT / DELETE / HEAD 等
- `pool`：`taskTimeout` 任务超时，超时后终止并重建该线程
- `pool`：`keepAlive` 线程复用 + `dispose()` 释放
- `pool`：`items` 字段，按提交顺序给出每个任务的完整去向
- `pool`：`TaskError.reason`（`task` / `timeout` / `crash` / `disposed`）与子线程堆栈
- `parser`：`object()` 在子树内解析多个字段
- `parser`：`json()` 解析 JSON-LD 等 JSON 文本节点
- `parser`：`first` / `index` 选项，只取指定位置的元素
- `parser`：`nullable()` 让未匹配返回 `null`，与「匹配但为空」区分
- `parser`：错误信息带字段路径（如 `list[0].href`）
- `utils`：`resolveUrl` / `getBaseHref` / `getDocumentBase`

### 修复

- `pool`：线程崩溃时不再把其他线程上的任务误判为失败，也不会重复累加完成数
- `pool`：`results` 改为按提交顺序返回，不再是完成顺序
- `http`：显式 `proxy: false`，不再隐式继承 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量
- `tsconfig`：`include` 中的 `tests/` 实为 `test/`，测试文件此前从未参与类型检查
- `engines` 与构建 target 对齐到 Node 18（原为 `>=16` + `node20`）

### 变更

- 运行时要求 Node.js 18+；测试改用 `tsx --test`，在 Node 18 上即可运行
- 移除冗余的 `.npmignore`（改由 `package.json` 的 `files` 控制）
- `cheerio` 升级到 1.0.0 正式版

## 1.0.0

首个稳定版：`createHttp` / `TaskPool` + `defineThreadTask` / `html2object` 三件套，CJS + ESM 双格式产物。
