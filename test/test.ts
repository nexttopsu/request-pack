import { Worker, utils } from '../src';
import { cpus } from 'os';


new Worker({
    worker: __filename, // 使用当前文件执行
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
