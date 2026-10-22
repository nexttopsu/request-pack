import { Worker as ThreadWorker, parentPort, isMainThread, type WorkerOptions } from 'worker_threads';
import { EventEmitter } from 'events';

/* ------------------------------------------------------------------ */
/* 子线程侧：显式注册任务处理器                                          */
/* ------------------------------------------------------------------ */

/**
 * 在 worker 文件中注册子线程任务处理器。
 * 主线程 import 该文件时是空操作；只有 worker_threads 派生的子线程会真正挂载消息监听。
 *
 * @example
 * // my-worker.ts
 * export const task = defineThreadTask(async (data: { url: string }) => {
 *     const html = await http.get(data.url);
 *     return parse(html);
 * });
 */
export function defineThreadTask<T = any, R = any>(
    handler: (data: T) => Promise<R> | R
): (data: T) => Promise<R> {
    if (!isMainThread && parentPort) {
        const port = parentPort;
        port.on('message', async (msg: { id: number; data: T }) => {
            try {
                const result = await handler(msg.data);
                port.postMessage({ id: msg.id, ok: true, result });
            } catch (err) {
                port.postMessage({
                    id: msg.id,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        });
    }
    return handler as (data: T) => Promise<R>;
}

/* ------------------------------------------------------------------ */
/* 主线程侧：任务池                                                     */
/* ------------------------------------------------------------------ */

export interface TaskPoolOptions {
    /** worker 文件路径，通常是 __filename */
    worker: string;
    /** 最大并发线程数，默认 3 */
    concurrency?: number;
    /** 透传给 worker_threads 的原始配置 */
    workerOption?: WorkerOptions;
}

export interface TaskError {
    task: any;
    error: string;
}

export interface TaskPoolResult<R = any> {
    results: R[];
    errors: TaskError[];
}

interface ThreadSlot {
    worker: ThreadWorker;
    busy: boolean;
}

/**
 * 基于 worker_threads 的任务池。
 *
 * @example
 * const pool = new TaskPool({ worker: __filename, concurrency: cpus().length - 1 });
 * pool.on('progress', ({ done, total }) => console.log(`${done}/${total}`));
 * const { results, errors } = await pool
 *     .addTasks(urls.map(url => ({ url })))
 *     .run();
 */
export class TaskPool<R = any> extends EventEmitter {
    private readonly workerPath: string = '';
    private readonly concurrency: number = 3;
    private readonly workerOption: WorkerOptions | undefined = undefined;

    private queue: { id: number; data: any }[] = [];
    private slots: ThreadSlot[] = [];
    private readonly resultMap = new Map<number, R>();
    private readonly errors: TaskError[] = [];
    private nextId = 0;
    private doneCount = 0;
    private total = 0;
    private running = false;
    private resolvers: ((result: TaskPoolResult<R>) => void)[] = [];

    constructor(options: TaskPoolOptions) {
        super();
        this.workerPath = options.worker;
        this.concurrency = options.concurrency && options.concurrency > 0 ? options.concurrency : 3;
        this.workerOption = options.workerOption;
    }

    /** 添加单个任务 */
    addTask(task: any): this {
        this.queue.push({ id: this.nextId++, data: task });
        this.total++;
        if (this.running) void this.pump();
        return this;
    }

    /** 批量添加任务 */
    addTasks(tasks: any[]): this {
        for (const task of tasks) this.addTask(task);
        return this;
    }

    /**
     * 启动任务池并等待全部任务完成。
     * 任务中途可继续 addTask，Promise 会在所有任务结束后才 resolve。
     * 单个任务失败不会中断整体，错误收集在返回值的 errors 中，同时触发 'taskError' 事件。
     */
    run(): Promise<TaskPoolResult<R>> {
        return new Promise(resolve => {
            this.resolvers.push(resolve);
            if (!this.running) {
                this.running = true;
                void this.pump();
            }
        });
    }

    /** 终止所有子线程（未完成任务丢弃） */
    async destroy(): Promise<void> {
        const slots = this.slots;
        this.slots = [];
        this.queue = [];
        await Promise.all(slots.map(slot => slot.worker.terminate()));
    }

    private pump(): void {
        // 为排队任务补充空闲槽位
        while (this.queue.length > 0) {
            const idle = this.slots.find(slot => !slot.busy);
            if (idle) {
                this.dispatch(idle);
                continue;
            }
            if (this.slots.length < this.concurrency) {
                this.spawn();
                continue;
            }
            break;
        }
        this.checkDone();
    }

    private spawn(): void {
        const worker = new ThreadWorker(this.workerPath, this.workerOption);
        const slot: ThreadSlot = { worker, busy: false };
        worker.on('message', (msg: { id: number; ok: boolean; result?: R; error?: string }) => {
            slot.busy = false;
            this.doneCount++;
            if (msg.ok) {
                this.resultMap.set(msg.id, msg.result as R);
            } else {
                const task = this.taskById.get(msg.id);
                const item: TaskError = { task, error: msg.error ?? 'unknown error' };
                this.errors.push(item);
                this.emit('taskError', item);
            }
            this.taskById.delete(msg.id);
            this.emit('progress', { done: this.doneCount, total: this.total });
            void this.pump();
        });
        worker.on('error', (err: Error) => {
            // 线程级崩溃：该线程上正在执行的任务记为失败
            slot.busy = false;
            for (const [id] of this.taskById) {
                const item: TaskError = { task: this.taskById.get(id), error: `thread crashed: ${err.message}` };
                this.errors.push(item);
                this.emit('taskError', item);
                this.doneCount++;
                this.taskById.delete(id);
            }
            worker.terminate().finally(() => {
                this.slots = this.slots.filter(s => s !== slot);
                void this.pump();
            });
        });
        this.slots.push(slot);
    }

    private readonly taskById = new Map<number, any>();

    private dispatch(slot: ThreadSlot): void {
        const task = this.queue.shift();
        if (!task) return;
        slot.busy = true;
        this.taskById.set(task.id, task.data);
        slot.worker.postMessage({ id: task.id, data: task.data });
    }

    private checkDone(): void {
        if (!this.running) return;
        const allFinished = this.queue.length === 0 && this.slots.every(slot => !slot.busy);
        if (allFinished && this.doneCount >= this.total) {
            const result: TaskPoolResult<R> = {
                results: [...this.resultMap.values()],
                errors: [...this.errors],
            };
            this.resultMap.clear();
            this.errors.length = 0;
            this.doneCount = 0;
            this.total = 0;
            this.running = false;
            const resolvers = this.resolvers;
            this.resolvers = [];
            void this.destroy().finally(() => resolvers.forEach(resolve => resolve(result)));
        }
    }
}
