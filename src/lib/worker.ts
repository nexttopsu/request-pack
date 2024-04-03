import workerThreads from 'worker_threads'
import EventEmitter from 'events'

export type WorkerCallback = (data: any, taskid?: number) => void;
export interface WorkerCoreOptions {
    worker: string;
    workerOption?: workerThreads.WorkerOptions;
    callback: WorkerCallback;
}

class WorkerCore {
    static _int = 0;

    id = ++WorkerCore._int;
    isWorker = false;
    worker: workerThreads.Worker;
    callback: WorkerCallback;

    constructor (options: WorkerCoreOptions) {
        this.callback = options.callback;
        this.worker = new workerThreads.Worker(options.worker, options.workerOption);

        this.worker.on('message', (data: any) => {
            this.isWorker = false;
            this.callback(data, this.id);
        });
    }

    post<T>(data: T) {
        this.isWorker = true;
        this.worker.postMessage(data || {});
    }

    exit() {
        this.worker.terminate();
    }
}

interface WorkerOptions {
    worker: string;
    workerOption?: workerThreads.WorkerOptions;
    pip?: number;
}

class Workers {
    static defaults = { pip: 5 };
    static isMainThread = workerThreads.isMainThread;
    static parentPort = workerThreads.parentPort;

    static run(option: { main:() => void, thread: (data:any, post:(data: any) => void) => void }) {
        if ( workerThreads.isMainThread ) {
            option.main.call(workerThreads);
        } else {
            const parentPort = workerThreads.parentPort;
            if (parentPort) {
                const postMessage = parentPort.postMessage.bind(parentPort);
                parentPort.on('message', (data) => {
                    option.thread.call(workerThreads, data, postMessage);
                });
            }
        }
    }

    readonly workerThreads = workerThreads;
    readonly pip: number;
    readonly events = new EventEmitter();

    _workers: WorkerCore[] = [];
    _cache: any = [];

    constructor(options:WorkerOptions) {
        this.pip = options.pip || Workers.defaults.pip;
        this._workers = Array.from({ length: this.pip }).map(_ => {
            return new WorkerCore({
                worker: options.worker,
                workerOption: options.workerOption,
                callback: (...args) => {
                    try {
                        this.cachePost();
                        this.events.emit('message', ...args);
                        if (!this.isWorker) {
                            this.events.emit('done', {});
                        }
                    }
                    catch(err: any) {
                        this.events.emit('error', err);
                    }
                }
            });
        });
    }

    get count() {
        return this._workers.filter(work => !work.isWorker).length;
    }

    get isWorker() {
        return this._workers.some(work => work.isWorker);
    }

    on(eventName: 'message' | 'done' | 'error', listener: (...args: any[]) => void) {
        return this.events.on(eventName, listener);
    }

    post<T>(data: T) {
        let work = this._workers.find(work => !work.isWorker);
        if (work) {
            work.post(data);
        }
        else {
            this._cache.push(data);
        }
        return this
    }

    cachePost() {
        if (this._cache && this._cache.length > 0) {
            const work = this._workers.find(work => !work.isWorker);
            if (work) {
                const data = this._cache.shift();
                work.post(data);
            }
        }
        return this
    }

    exit(id: number) {
        const index = this._workers.findIndex(work => work.id === id);
        if (index !== -1) {
            this._workers[index].exit();
            this._workers.splice(index, 1);
        }
        return this
    }

    exitall() {
        this._workers.forEach(work => work.exit());
        this._workers = [];
    }
}


export default Workers
