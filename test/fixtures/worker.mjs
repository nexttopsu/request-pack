import { parentPort } from 'worker_threads';

// 任务协议 fixture：模拟 defineThreadTask 生成的子线程行为
// 接收 { id, data: { ms, name, fail, crash } }，返回 { id, ok, result | error }
// crash: true 时直接退出进程，用于验证线程崩溃只影响手上那一个任务

parentPort.on('message', async (msg) => {
    const { id, data } = msg;
    if (data.crash) {
        process.exit(1);
    }
    await new Promise(resolve => setTimeout(resolve, data.ms));
    if (data.fail) {
        parentPort.postMessage({ id, ok: false, error: 'boom: ' + data.name });
    } else {
        parentPort.postMessage({ id, ok: true, result: 'done: ' + data.name });
    }
});
