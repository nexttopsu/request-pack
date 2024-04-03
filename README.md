### npm install

```bash
npm install request-pack
```

### yarn install

```bash
yarn add request-pack
```

#### test

```js
const { Worker, Task } = require('request-pack');

function main() {
    const worker = new Worker({
        worker: __filename,
        pip: 3, // 线程数
        workerOption: {}
    });

    // 接收消息
    worker.on('message', (data, workId) => {
        console.log(data, workId, 'result---');
    });

    // 错误
    worker.on('error', (error) => {
        console.log(error, 'error---');
    });

    // 每当检测到所有任务都执行完成时触发
    worker.on('done', () => {
        console.log('task done--- exit...');
        // 退出所有子线程
        worker.exitall();
    });

    worker.post({ link:'https://www.baidu.com/' });
    worker.post({ link:'https://www.baidu.com/' });
    worker.post({ link:'https://www.baidu.com/' });
}


// 子线程
async function thread(data, done) {
    console.log("threadPost", data.link);
    try {
        const res = await new Task(data).request(data.link).parse({ list: 'a/each(self/text(), self/attr(href))' }).run();
        done(res);
    }
    catch(err) {
        done({ type: 'error', message: err.message || err });
    }
}

// 当worker是当前文件时可使用
Worker.run({ main, thread });
```
