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
                    stack: err instanceof Error ? err.stack : undefined,
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
    /**
     * 单个任务超时（毫秒），0 或不传表示不限。
     * 超时后该任务记为 timeout 失败，对应线程会被终止并重建——卡死的线程不能复用。
     */
    taskTimeout?: number;
    /**
     * 任务跑完后保留线程供下一批复用，默认 false（每次 run 结束即释放）。
     * 开启后请自行调用 dispose() 释放线程。
     */
    keepAlive?: boolean;
}

export type TaskFailureReason = 'task' | 'timeout' | 'crash' | 'disposed';

export interface TaskError {
    /** 对应的原始任务数据 */
    task: any;
    /** 错误消息 */
    error: string;
    /** 子线程里的原始堆栈 */
    stack?: string;
    /** 失败原因分类，便于上层统计 */
    reason: TaskFailureReason;
}

export interface TaskOutcome<R = any> {
    task: any;
    ok: boolean;
    result?: R;
    error?: TaskError;
}

export interface TaskPoolResult<R = any> {
    /** 成功结果，按任务提交顺序排列（不是完成顺序） */
    results: R[];
    errors: TaskError[];
    /** 每个任务的完整去向，成功/失败按提交顺序排列，便于和输入对齐 */
    items: TaskOutcome<R>[];
}

interface Slot {
    worker: ThreadWorker;
    /** 当前占用的任务 id，null 表示空闲 */
    id: number | null;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * 基于 worker_threads 的任务池。
 *
 * @example
 * const pool = new TaskPool({ worker: __filename, concurrency: cpus().length - 1 });
 * pool.on('progress', ({ done, total }) => console.log(`${done}/${total}`));
 * const { results, errors } = await pool.addTasks(tasks).run();
 */
export class TaskPool<R = any> extends EventEmitter {
    private readonly workerPath: string;
    private readonly concurrency: number;
    private readonly workerOption: WorkerOptions | undefined;
    private readonly taskTimeout: number;
    private readonly keepAlive: boolean;

    private queue: { id: number; data: any }[] = [];
    private slots: Slot[] = [];
    /** 已派发但未结算的任务：id -> 任务数据 */
    private readonly inflight = new Map<number, any>();
    /** 已结算的任务：id -> 结果 */
    private readonly outcomes = new Map<number, TaskOutcome<R>>();
    private nextId = 0;
    private total = 0;
    private done = 0;
    private running = false;
    private resolvers: ((result: TaskPoolResult<R>) => void)[] = [];

    constructor(options: TaskPoolOptions) {
        super();
        this.workerPath = options.worker;
        this.concurrency = options.concurrency && options.concurrency > 0 ? options.concurrency : 3;
        this.workerOption = options.workerOption;
        this.taskTimeout = options.taskTimeout && options.taskTimeout > 0 ? options.taskTimeout : 0;
        this.keepAlive = options.keepAlive === true;
    }

    /** 添加单个任务 */
    addTask(task: any): this {
        this.queue.push({ id: this.nextId++, data: task });
        this.total++;
        if (this.running) this.pump();
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
     * 单个任务失败（含超时、线程崩溃）不会中断整体，失败项收集在 errors 中，
     * 同时触发 'taskError' 事件。
     */
    run(): Promise<TaskPoolResult<R>> {
        return new Promise(resolve => {
            this.resolvers.push(resolve);
            if (!this.running) {
                this.running = true;
                this.pump();
            }
        });
    }

    /** 终止所有子线程并释放资源；未完成的任务按 disposed 记为失败，挂起的 run() 会以当前进度 resolve */
    async dispose(): Promise<void> {
        for (const item of this.queue) {
            this.record(item.id, item.data, false, { error: 'pool disposed', reason: 'disposed' });
        }
        this.queue = [];
        for (const slot of this.slots) {
            if (slot.id !== null) {
                this.settle(slot.id, false, { error: 'pool disposed', reason: 'disposed' });
            }
        }
        this.queue = [];
        await this.terminateAll();
        if (this.running) {
            this.finish();
        } else {
            this.outcomes.clear();
            this.inflight.clear();
            this.done = 0;
            this.total = 0;
        }
    }

    /** dispose() 的别名，保持旧版语义：终止所有线程，丢弃未完成任务 */
    destroy(): Promise<void> {
        return this.dispose();
    }

    /* -------------------------------------------------------------- */

    private pump(): void {
        while (this.queue.length > 0) {
            const idle = this.slots.find(slot => slot.id === null);
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
        const slot: Slot = { worker, id: null };

        worker.on('message', (msg: { id: number; ok: boolean; result?: R; error?: string; stack?: string }) => {
            this.onMessage(slot, msg);
        });
        worker.on('error', (err: Error) => this.onCrash(slot, err));
        // 某些崩溃（如 process.exit）只会触发 exit，不会触发 error
        worker.on('exit', (code: number) => {
            if (code !== 0) this.onCrash(slot, new Error(`worker exited with code ${code}`));
        });

        this.slots.push(slot);
    }

    private dispatch(slot: Slot): void {
        const item = this.queue.shift();
        if (!item) return;
        slot.id = item.id;
        this.inflight.set(item.id, item.data);
        if (this.taskTimeout > 0) {
            slot.timer = setTimeout(() => this.onTimeout(slot, item.id), this.taskTimeout);
        }
        slot.worker.postMessage({ id: item.id, data: item.data });
    }

    private onMessage(
        slot: Slot,
        msg: { id: number; ok: boolean; result?: R; error?: string; stack?: string }
    ): void {
        if (slot.timer) {
            clearTimeout(slot.timer);
            slot.timer = undefined;
        }
        // 超时/崩溃后已结算的任务可能迟到，slot.id 已被清空，直接丢弃
        if (slot.id === null || msg.id !== slot.id) return;

        const id = slot.id;
        slot.id = null;
        this.settle(id, msg.ok, { result: msg.result, error: msg.error, stack: msg.stack });
        this.pump();
    }

    /** 任务超时：只判该任务失败，并把这个卡住的线程换掉 */
    private onTimeout(slot: Slot, id: number): void {
        slot.timer = undefined;
        this.settle(id, false, { error: `task timeout after ${this.taskTimeout}ms`, reason: 'timeout' });
        slot.id = null;
        this.retire(slot);
        this.pump();
    }

    /** 线程崩溃：只影响派发给这个线程的那一个任务 */
    private onCrash(slot: Slot, err: Error): void {
        if (!this.slots.includes(slot)) return;
        const id = slot.id;
        slot.id = null;
        if (id !== null) {
            this.settle(id, false, { error: `thread crashed: ${err.message}`, stack: err.stack, reason: 'crash' });
        }
        this.retire(slot);
        this.pump();
    }

    private retire(slot: Slot): void {
        if (!this.slots.includes(slot)) return;
        this.slots = this.slots.filter(s => s !== slot);
        if (slot.timer) {
            clearTimeout(slot.timer);
            slot.timer = undefined;
        }
        slot.id = null;
        void slot.worker.terminate().catch(() => undefined);
    }

    private settle(
        id: number,
        ok: boolean,
        payload: { result?: R; error?: string; stack?: string; reason?: TaskFailureReason }
    ): void {
        // 已结算过（例如超时后线程又回了消息）
        if (!this.inflight.has(id)) return;
        const task = this.inflight.get(id);
        this.inflight.delete(id);
        this.record(id, task, ok, payload);
    }

    private record(
        id: number,
        task: any,
        ok: boolean,
        payload: { result?: R; error?: string; stack?: string; reason?: TaskFailureReason }
    ): void {
        if (this.outcomes.has(id)) return;
        const outcome: TaskOutcome<R> = ok
            ? { task, ok: true, result: payload.result }
            : {
                  task,
                  ok: false,
                  error: {
                      task,
                      error: payload.error ?? 'unknown error',
                      stack: payload.stack,
                      reason: payload.reason ?? 'task',
                  },
              };
        this.outcomes.set(id, outcome);
        this.done++;
        if (!ok) this.emit('taskError', outcome.error);
        this.emit('progress', { done: this.done, total: this.total });
    }

    private checkDone(): void {
        if (!this.running) return;
        if (this.done < this.total) return;
        if (this.queue.length > 0 || this.slots.some(slot => slot.id !== null)) return;
        this.finish();
    }

    private finish(): void {
        const items = [...this.outcomes.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, outcome]) => outcome);

        const result: TaskPoolResult<R> = {
            results: items.filter(item => item.ok).map(item => item.result as R),
            errors: items.filter(item => !item.ok).map(item => item.error as TaskError),
            items,
        };

        this.running = false;
        this.outcomes.clear();
        this.inflight.clear();
        this.done = 0;
        this.total = 0;

        const resolvers = this.resolvers;
        this.resolvers = [];

        if (this.keepAlive) {
            for (const resolve of resolvers) resolve(result);
        } else {
            void this.terminateAll().then(() => {
                for (const resolve of resolvers) resolve(result);
            });
        }
    }

    private async terminateAll(): Promise<void> {
        const slots = this.slots;
        this.slots = [];
        for (const slot of slots) {
            if (slot.timer) clearTimeout(slot.timer);
            slot.timer = undefined;
            slot.id = null;
            await slot.worker.terminate().catch(() => undefined);
        }
    }
}
