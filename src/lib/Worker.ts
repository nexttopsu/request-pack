import { Worker as _Worker, parentPort, isMainThread, type WorkerOptions } from 'worker_threads'

export interface WorkerOption {
    pip?: number;
    worker: string;
    thread: (...args: any[]) => Promise<void>,
    tasks?: any[],
    main?: (worker: Worker) => void,
    done?: (worker: Worker) => void,
    workerOption?: WorkerOptions
}

export class Worker {
    _pip: number = 3;
    _worker: string = '';
    _workerOption: WorkerOptions | undefined = undefined;
    _workers: {wait: 0 | 1, worker: _Worker}[] = [];
    _tasks: any[] = [];
    _done: WorkerOption['done'] = undefined;
    constructor(opts: WorkerOption) {
        // 主线程
        if (isMainThread) {
            this._pip = opts.pip || 3;
            this._worker = opts.worker;
            this._done = opts.done;
            this._workerOption = opts.workerOption;
            this._tasks = opts.tasks || [];
            opts.main?.(this);
        }
        // 子线程
        else {
            parentPort?.on('message', async (params: any) => {
                try {
                    await opts.thread(params);
                }
                finally {
                    parentPort!.postMessage({ ok: 1 });
                }
            });
        }
    }

    private waitWorker() {
        const wk = this._workers.find(item => item.wait === 0);

        // 如果有等待的线程
        if (wk) return wk

        // 添加新线程
        if (this._workers.length < this._pip) {
            const worker = new _Worker(this._worker, this._workerOption);
            const wk = { wait: 0 as 0 | 1, worker }
            worker.on('message', () => {
                wk.wait = 0;
                void this.runTask();
            });
            this._workers.push(wk);
            return wk;
        }

        return null;
    }

    private runTask = async () => {
        const wk = this.waitWorker();
        if (this._tasks.length && wk) {
            wk.wait = 1;
            wk.worker.postMessage(this._tasks.shift());
        }

        if (this.isTaskRunEnd) {
            void await this.stop();
            this._done?.(this);
        }
    }

    get isTaskRunEnd() {
        return this._tasks.length === 0 && this._workers.every(wk => wk.wait === 0);
    }

    async stop() {
        for(let item of this._workers) {
            await item.worker.terminate();
        }
        this._workers = [];
    }

    addTask(args: any[]) {
        if (isMainThread)
        {
            this._tasks.push(...args);
        }
        return this;
    }

    start() {
        if (isMainThread) {
            Array.from({ length: this._pip }).forEach(this.runTask);
        }
    }
}
