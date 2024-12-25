## 安装

### npm install

```bash
npm install request-pack
```



### yarn install

```bash
yarn add request-pack
```



## 使用

### 多线程 `worker`

```js
import { Worker, utils } from 'request-pack';
import { cpus } from 'os';

new Worker({
    worker: __filename, // 使用当前文件执行子线程
    pip: cpus().length - 1, // 线程数量，默认3个

    // 主线程，添加任务
    main(worker) {
        worker.addTask(Array.from({length: 1000}).map((_, i) => ({ i }))).start();
    },

    // 子线程，执行任务  data => { i: 0 }
    thread: async (data: { i: number }) => {
        await utils.delay(Math.random() * 1000);
        console.log('执行结束 ....', data);
    },

    // 任务执行完毕
    done(worker) {
        console.log('任务全部执行完毕', worker);
    },
});
```



### 请求 `request`

```js
import { request_inst, request, request_buffer } from 'request-pack'

request_inst.defaults.proxy = {
    host: "127.0.0.1",
    port: 1080
}
request_inst.defaults.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 6.1; Win64; WOW64) AppleWebKit/537.36 (KHTML, like Gecko/2010010 Safari/537.36';

// 不使用代理
request('https://www.baidu.com').then(res => {
    console.log(res);
});

// 使用代理发送请求
request('https://www.youtube.com', undefined, true).then(res => {
    console.log(res);
});

// 获取buffer
request_buffer('https://www.baidu.com/img/flexible/logo/pc/result.png').then(res => {
    // 保存图片
    // const buff = res.data;
    // fs.writeFileSync(path.resolve('./test.png'), buff);
    console.log(res);
});
```



### HTML 转 Object `html2object`

```js
import { html2object } from 'request-pack'

const html = `<html>
<head><title>标题</title></head>
<body>

<h1 class="todo"><span>Todo</span></h1>
<ul id="list">
    <li data-href="/1"><span>1</span></li>
    <li data-href="/2"><span>2</span></li>
    <li data-href="/3"><span>3</span></li>
</ul>
</body>
<html>`

const result = html2object(html, {
    title: 'title/text()',
    h1: '.todo/text()',
    h1_html: '.todo/html()',
    list: '#list li/loop(/attr(data-href), span/text())'
});

console.log(result);
// ==> result
// {
//     title: '标题',
//     h1: 'Todo',
//     h1_html: '<span>Todo</span>',
//     list: [ [ '/1', '1' ], [ '/2', '2' ], [ '/3', '3' ] ]
// }
```



### utils

```js
import { utils } from 'request-pack';

// utils.delay
await utils.delay(2000); // 等待 毫秒

// utils.decode
utils.decode(buffer, 'UTF-8'); // 转编码
```

