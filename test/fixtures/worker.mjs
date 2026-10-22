import { parentPort } from 'worker_threads';

// 任务协议 fixture：模拟 defineThreadTask 生成的子线程行为
// 接收 { id, data: { ms, name, fail } }，返回 { id, ok, result | error }

parentPort.on('message', async (msg) => {
    const { id, data } = msg;
    await new Promise(resolve => setTimeout(resolve, data.ms));
    if (data.fail) {
        parentPort.postMessage({ id, ok: false, error: 'boom: ' + data.name });
    } else {
        parentPort.postMessage({ id, ok: true, result: 'done: ' + data.name });
    }
});
