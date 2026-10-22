# request-pack

轻量爬虫工具包：**HTTP 请求 → 并发调度 → 结构化解析**，三个模块正交，可独立使用。

```bash
npm install request-pack
# 或
yarn add request-pack
```

## HTTP `createHttp`

所有配置显式传入，无任何隐藏默认值（不传代理就是直连）。

```ts
import { createHttp } from 'request-pack';

const http = createHttp({
    timeout: 30_000,
    proxy: { host: '127.0.0.1', port: 1080 }, // 不需要代理就不传
});

// get / post 直接返回 data（不再是 AxiosResponse）
const data = await http.get('https://www.baidu.com');
const result = await http.post('https://api.example.com', { a: 1 });

// 二进制内容用专门的方法
const buf = await http.getBuffer('https://www.baidu.com/img/flexible/logo/pc/result.png');
// fs.writeFileSync('./logo.png', buf);

// 需要更细粒度控制时，可拿到底层 axios 实例
http.instance.defaults.headers['User-Agent'] = 'Mozilla/5.0 ...';
```

## 并发任务池 `TaskPool`

基于 `worker_threads`。主线程侧是 `TaskPool`，子线程侧用 `defineThreadTask` 注册处理器，两者彻底分离，全程 Promise，错误不会被吞掉。

```ts
// ── my-worker.ts（任务处理器 + 主线程逻辑可以写在同一个文件）──
import { defineThreadTask, TaskPool } from 'request-pack';
import { cpus } from 'os';

// 子线程执行体：主线程 import 时是空操作，不会产生副作用
export const task = defineThreadTask(async (data: { url: string }) => {
    return await fetchAndParse(data.url);
});

// 主线程：创建任务池并等待完成
async function main() {
    const pool = new TaskPool({
        worker: __filename,                    // 本文件作为 worker 脚本
        concurrency: cpus().length - 1,        // 线程数，默认 3
    });

    // 可选：进度与任务级错误事件
    pool.on('progress', ({ done, total }) => console.log(`${done}/${total}`));
    pool.on('taskError', ({ task, error }) => console.error('任务失败', task, error));

    const { results, errors } = await pool
        .addTasks(urls.map(url => ({ url })))
        .run();  // 单个任务失败不会中断整体，失败的任务收集在 errors 里
}
```

## HTML 解析 `html2object`

用类型安全的 schema 组合器代替魔法字符串，结果类型自动推导，`loop` 输出对象数组，支持嵌套。

```ts
import { html2object, text, html, attr, loop } from 'request-pack';

const schema = {
    title: text('title'),
    h1:    html('h1.todo'),
    list:  loop('#list li', {
        href: attr('data-href'),
        name: text('span'),
        // 需要时还可以继续嵌套 loop
    }),
};

const data = html2object(html, schema, ['.ad']); // 第三参可选：解析前移除干扰节点
// => {
//      title: '标题',
//      h1: '<span>Todo</span>',
//      list: [{ href: '/1', name: '1' }, { href: '/2', name: '2' }, ...]
//    }
```

非法 schema 会直接抛出带字段名的错误，不再静默丢失。

## utils

```ts
import { utils } from 'request-pack';

await utils.delay(2000);            // 等待毫秒
utils.decode(buffer, 'gbk');        // 按编码解码 buffer（iconv-lite）
utils.iconv;                        // iconv-lite 本体
```

## 开发

```bash
npm run dev         # tsx 运行 example.ts
npm test            # Node 内置 test runner（node --test，需 Node >= 22）
npm run typecheck   # tsc --noEmit
npm run build       # tsup 构建 CJS(.cjs) + ESM(.mjs) + 类型声明到 dist/
```

## 运行时要求

- 库本身：Node >= 16
- 跑测试：Node >= 22（Node 内置 test runner 直接执行 .ts，无需额外测试框架）

## License

ISC
