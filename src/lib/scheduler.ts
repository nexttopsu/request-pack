/**
 * 单线程任务调度器：在**当前事件循环**里用 Promise 控制并发，不创建 worker_threads、
 * 不复制请求逻辑、不引入任何外部依赖。
 *
 * 与 `TaskPool` 的区别：`TaskPool` 派生子线程跑 CPU 密集任务；这里只在主线程 concurrently
 * 调用一个返回 Promise 的处理函数（典型场景：一组受控并发的 HTTP 请求）。
 *
 * 设计约定：
 * - 结果数组长度恒等于任务列表长度，且按**输入下标**排序（与完成顺序无关）。
 * - 单个任务失败不中断整批，失败项进 `errors`；要重跑用 `restart()`。
 * - Promise 一旦启动无法撤销：`stop()` 只停止派发新任务，在途任务照常跑完并结算。
 * - `start / done / stop / restart` 全部返回实例本身，可任意链式调用。
 */

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

/** 与 createFetcher 的 Logger 同形状；不传或传 false 时完全静默 */
export interface SchedulerLogger {
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
}

const NOOP_LOGGER: SchedulerLogger = Object.freeze({});

/** 只有显式传 `logging: true` 才绑定 console，业务代码里不散落 console 调用 */
const CONSOLE_LOGGER: SchedulerLogger = Object.freeze({
    info: (message: string, ...args: unknown[]) => console.info(message, ...args),
    warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
    error: (message: string, ...args: unknown[]) => console.error(message, ...args),
});

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type SchedulerStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
export type SchedulerFailureReason = 'task' | 'cancelled';
export type SchedulerPhase = 'idle' | 'running' | 'stopping' | 'done';

/** `errors` 里的单项：错误信息 + 原始任务 + 原始下标 */
export interface SchedulerError<T = any> {
    /** 错误信息（字符串） */
    error: string;
    /** 原始任务数据 */
    item: T;
    /** 在任务列表里的下标，从 0 开始 */
    index: number;
    /** 失败分类：handler 抛错 / 被 stop() 取消派发 */
    reason: SchedulerFailureReason;
    /** handler 抛出的原始异常（仅 reason === 'task' 时存在） */
    cause?: unknown;
}

/** `results` 里的单项，与输入一一对应 */
export interface SchedulerOutcome<T = any, R = any> {
    /** 仅 status === 'success' 时为 true */
    ok: boolean;
    status: SchedulerStatus;
    /** 处理函数返回值；失败 / 未结算时为 undefined */
    value: R | undefined;
    /** `value` 的别名，便于按 `result[i].result` 取「任务执行结果」 */
    result: R | undefined;
    /** 失败时的错误信息 */
    error?: string;
    /** 原始任务数据 */
    item: T;
    /** 在任务列表里的下标 */
    index: number;
}

/** `done()` 回调与 `wait()` 拿到的快照 */
export interface SchedulerRunResult<T = any, R = any> {
    /** 按输入下标排序的完整结果数组 */
    results: SchedulerOutcome<T, R>[];
    /** 失败项，按输入下标排序 */
    errors: SchedulerError<T>[];
}

export type SchedulerDoneCallback<T = any, R = any> = (
    results: SchedulerOutcome<T, R>[],
    errors: SchedulerError<T>[]
) => void | Promise<void>;

export interface SchedulerOptions<T = any, R = any> {
    /** 最大并发数，默认 3；设为 1 即严格串行。必须是正整数 */
    concurrency?: number;
    /** false / 省略 → 静默；true → console；对象 → 自定义 logger */
    logging?: boolean | SchedulerLogger;
    /** 单个任务的处理函数，可返回 Promise 或同步值；(item, index) 与任务列表对齐 */
    handler: (item: T, index: number) => Promise<R> | R;
}

/* ------------------------------------------------------------------ */
/* 内部批次                                                            */
/* ------------------------------------------------------------------ */

interface Run {
    id: number;
    /** 待派发的输入下标，按升序 */
    queue: number[];
    /** 已派发但未结算的下标 */
    inflight: Set<number>;
    /** stop() 之后不再派发新任务 */
    stopped: boolean;
    /** 本轮是否还在结算 */
    active: boolean;
}

const messageOf = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

const pendingOutcome = <T, R>(item: T, index: number): SchedulerOutcome<T, R> => ({
    ok: false,
    status: 'pending',
    value: undefined,
    result: undefined,
    item,
    index,
});

/* ------------------------------------------------------------------ */
/* 调度器                                                              */
/* ------------------------------------------------------------------ */

/**
 * @example
 * const task = createTaskScheduler(urls, {
 *     concurrency: 3,
 *     logging: true,
 *     handler: async (url, index) => (await fetch(url)).text(),
 * });
 *
 * task.start().done((results, errors) => {
 *     for (const r of results) console.log(r.index, r.item, r.result, r.error);
 * });
 * task.stop();      // 停止派发，在途跑完
 * task.restart();   // 只重跑 errors 里的任务
 * const snapshot = await task.wait();
 */
export class TaskScheduler<T = any, R = any> {
    private readonly items: readonly T[];
    private readonly handler: (item: T, index: number) => Promise<R> | R;
    private readonly concurrency: number;
    private readonly logger: SchedulerLogger;

    /** 长度恒等于 items.length，按下标存放 */
    private readonly outcomes: SchedulerOutcome<T, R>[];
    /** handler 抛出的原始异常，按 index 存，供 errors.cause 使用 */
    private readonly causes = new Map<number, unknown>();
    /** done 回调及其已通知到的轮次编号 */
    private readonly callbacks: { cb: SchedulerDoneCallback<T, R>; lastId: number }[] = [];

    private run: Run | null = null;
    private runSeq = 0;
    /** 完成的轮次编号，用于避免同一个回调对同一轮结果重复触发 */
    private completionId = 0;
    private emitScheduled = false;
    private startedOnce = false;
    /** restart() 在在途任务未跑完时挂起，等在途结算后再开新一轮 */
    private pendingRestart = false;

    constructor(items: readonly T[], options: SchedulerOptions<T, R>) {
        if (!Array.isArray(items)) {
            throw new TypeError('createTaskScheduler: 第一个参数必须是任务列表数组');
        }
        if (!options || typeof options.handler !== 'function') {
            throw new TypeError('createTaskScheduler: options.handler 必须是函数');
        }

        const concurrency = options.concurrency ?? 3;
        if (!Number.isInteger(concurrency) || concurrency < 1) {
            throw new RangeError(`createTaskScheduler: concurrency 必须是正整数，收到 ${String(concurrency)}`);
        }
        if (options.logging !== undefined && typeof options.logging !== 'boolean' && typeof options.logging !== 'object') {
            throw new TypeError('createTaskScheduler: logging 必须是 boolean 或 Logger 对象');
        }

        this.items = items.slice();
        this.handler = options.handler;
        this.concurrency = concurrency;
        this.logger =
            options.logging === true
                ? CONSOLE_LOGGER
                : options.logging && typeof options.logging === 'object'
                  ? options.logging
                  : NOOP_LOGGER;
        this.outcomes = this.items.map((item, index) => pendingOutcome<T, R>(item, index));
    }

    /* ---------------------- 只读快照 ---------------------- */

    /** 按输入下标排序的完整结果数组（返回拷贝，外部修改不影响内部状态） */
    get results(): SchedulerOutcome<T, R>[] {
        return this.outcomes.map(outcome => ({ ...outcome }));
    }

    /** 错误任务：[{ error, item, index, reason, cause? }]，按输入下标排序 */
    get errors(): SchedulerError<T>[] {
        const list: SchedulerError<T>[] = [];
        for (const outcome of this.outcomes) {
            if (outcome.status !== 'failed' && outcome.status !== 'cancelled') continue;
            const cancelled = outcome.status === 'cancelled';
            const error: SchedulerError<T> = {
                error: outcome.error ?? 'unknown error',
                item: outcome.item,
                index: outcome.index,
                reason: cancelled ? 'cancelled' : 'task',
            };
            if (!cancelled && this.causes.has(outcome.index)) {
                error.cause = this.causes.get(outcome.index);
            }
            list.push(error);
        }
        return list;
    }

    /** 当前调度状态 */
    get status(): SchedulerPhase {
        if (!this.startedOnce && !this.pendingRestart) return 'idle';
        if (this.pendingRestart) return 'stopping';
        if (this.run?.active) return this.run.stopped ? 'stopping' : 'running';
        return 'done';
    }

    /* ---------------------- 链式 API ---------------------- */

    /**
     * 启动：只派发 status 为 pending 的任务。运行中重复调用是幂等的（不会重复执行）。
     * 已在跑的任务不受影响；失败 / cancelled 的任务要用 restart() 重跑。
     */
    start(): this {
        if (this.run?.active) return this;
        this.pendingRestart = false;
        const indexes: number[] = [];
        for (let index = 0; index < this.outcomes.length; index++) {
            if (this.outcomes[index].status === 'pending') indexes.push(index);
        }
        // 已完成过且没有 pending 项时不制造空轮次，避免重复 start 多触发一次 done。
        // 此时新注册的 done() / wait() 仍会拿到当前快照。
        if (indexes.length === 0 && this.completionId > 0) return this;
        this.beginRun(indexes, 'start');
        return this;
    }

    /**
     * 注册完成回调 `(results, errors)`。每轮结束（start / stop / restart 收尾）触发一次；
     * 注册在已完成的实例上也会立即异步拿到当前快照。支持 async 回调，回调抛错只记日志。
     */
    done(cb: SchedulerDoneCallback<T, R>): this {
        if (typeof cb !== 'function') {
            throw new TypeError('TaskScheduler.done: 参数必须是函数');
        }
        // lastId = completionId - 1：让新回调能收到「当前这一轮」的结果，
        // 而已经通知过的旧回调不会因新注册动作被重复调用。
        this.callbacks.push({ cb, lastId: this.completionId - 1 });
        this.scheduleEmit();
        return this;
    }

    /**
     * 停止派发新任务。未派发的项记为 `cancelled` 并进入 errors；
     * 已派发的 Promise 无法撤销，会照常跑完并结算，之后本轮结束并触发 done。
     */
    stop(): this {
        const run = this.run;
        if (!run?.active) return this;
        run.stopped = true;
        const skipped = run.queue.splice(0);
        for (const index of skipped) {
            this.outcomes[index] = {
                ok: false,
                status: 'cancelled',
                value: undefined,
                result: undefined,
                error: '任务被 stop() 取消派发',
                item: this.items[index],
                index,
            };
            this.causes.delete(index);
            this.log('warn', `[scheduler] 取消派发 index=${index}`);
        }
        this.log('info', `[scheduler] 已停止派发，在途 ${run.inflight.size} 个任务继续跑完`);
        this.pump(run);
        return this;
    }

    /**
     * 重新执行发生错误的任务（failed + cancelled），成功结果原样保留。
     * 若在途任务还没跑完，会先停止派发、等在途结算完，再自动开新一轮，避免旧结果覆盖新结果。
     * 新一轮结束后再次触发 done；没有错误项时也会触发一次（结果不变）。
     */
    restart(): this {
        this.pendingRestart = true;
        const run = this.run;
        if (run?.active) {
            run.stopped = true;
            const skipped = run.queue.splice(0);
            for (const index of skipped) {
                this.outcomes[index] = {
                    ok: false,
                    status: 'cancelled',
                    value: undefined,
                    result: undefined,
                    error: '任务被 stop() 取消派发',
                    item: this.items[index],
                    index,
                };
                this.causes.delete(index);
            }
            // 在途任务结算后由 pump → finishRound 接管；此刻若已无在途则直接收尾
            if (run.inflight.size === 0) this.finishRound();
        } else {
            this.beginRestart();
        }
        return this;
    }

    /**
     * 以 Promise 形式等待轮次结束，等价于注册一次性 done；实例已完成时立即返回当前快照。
     * 需先调用 start() / restart()；未启动时不隐式启动，避免意外发请求。
     */
    wait(): Promise<SchedulerRunResult<T, R>> {
        return new Promise(resolve => {
            this.callbacks.push({
                cb: (results, errors) => {
                    resolve({ results, errors });
                },
                lastId: this.completionId - 1,
            });
            this.scheduleEmit();
        });
    }

    /* ---------------------- 内部实现 ---------------------- */

    private beginRun(indexes: number[], label: string): void {
        const run: Run = {
            id: ++this.runSeq,
            queue: indexes.slice(),
            inflight: new Set<number>(),
            stopped: false,
            active: true,
        };
        this.run = run;
        this.startedOnce = true;
        this.log('info', `[scheduler] ${label}：派发 ${indexes.length} 个任务，并发 ${this.concurrency}`);
        this.pump(run);
    }

    /** 派发到并发上限；inflight 清零且没有待派发项时收尾 */
    private pump(run: Run): void {
        if (this.run !== run || !run.active) return;

        while (!run.stopped && run.queue.length > 0 && run.inflight.size < this.concurrency) {
            const index = run.queue.shift()!;
            run.inflight.add(index);
            this.outcomes[index] = {
                ...pendingOutcome<T, R>(this.items[index], index),
                status: 'running',
            };
            this.causes.delete(index);

            // Promise.resolve().then 同时兜住同步 throw 和 rejected Promise。
            // 不新开线程：handler 就在当前事件循环里被调用。
            Promise.resolve()
                .then(() => this.handler(this.items[index], index))
                .then(
                    value => this.settle(run, index, true, value),
                    err => this.settle(run, index, false, err)
                );
        }

        if (run.inflight.size === 0 && (run.stopped || run.queue.length === 0)) {
            this.finishRound();
        }
    }

    private settle(run: Run, index: number, ok: boolean, payload: R | unknown): void {
        if (this.run !== run || !run.active) return;
        run.inflight.delete(index);

        if (ok) {
            const value = payload as R;
            this.outcomes[index] = {
                ok: true,
                status: 'success',
                value,
                result: value,
                item: this.items[index],
                index,
            };
            this.log('info', `[scheduler] ✓ index=${index}`);
        } else {
            const message = messageOf(payload);
            this.outcomes[index] = {
                ok: false,
                status: 'failed',
                value: undefined,
                result: undefined,
                error: message,
                item: this.items[index],
                index,
            };
            this.causes.set(index, payload);
            this.log('warn', `[scheduler] ✗ index=${index}: ${message}`);
        }
        this.pump(run);
    }

    private finishRound(): void {
        const run = this.run;
        if (run) run.active = false;
        this.run = null;

        // restart() 等在途结算：旧轮次不发 done，由新一轮统一通知
        if (this.pendingRestart) {
            this.log('info', '[scheduler] 在途任务已结算，开始重跑错误项');
            this.beginRestart();
            return;
        }

        this.completionId += 1;
        const errors = this.errors.length;
        const success = this.outcomes.filter(outcome => outcome.status === 'success').length;
        this.log('info', `[scheduler] 本轮结束：成功 ${success} / 错误 ${errors} / 共 ${this.outcomes.length}`);
        this.scheduleEmit();
    }

    private beginRestart(): void {
        this.pendingRestart = false;
        const indexes = this.errors.map(error => error.index);
        for (const index of indexes) {
            this.outcomes[index] = pendingOutcome<T, R>(this.items[index], index);
            this.causes.delete(index);
        }
        this.log('info', `[scheduler] restart：重跑 ${indexes.length} 个错误任务`);
        this.beginRun(indexes, 'restart');
    }

    /** 同一 microtask 批次内只排一次通知，并且绝不在轮次未结束时提前通知 */
    private scheduleEmit(): void {
        if (this.emitScheduled) return;
        this.emitScheduled = true;
        queueMicrotask(() => {
            this.emitScheduled = false;
            if (this.run?.active || this.pendingRestart) return;
            this.notify();
        });
    }

    private notify(): void {
        if (this.completionId === 0) return;
        const id = this.completionId;
        const results = this.results;
        const errors = this.errors;
        for (const entry of this.callbacks.slice()) {
            if (entry.lastId >= id) continue;
            entry.lastId = id;
            try {
                const ret = entry.cb(results, errors);
                if (ret && typeof (ret as Promise<void>).catch === 'function') {
                    void (ret as Promise<void>).catch(err => this.log('error', '[scheduler] done 回调抛错:', err));
                }
            } catch (err) {
                this.log('error', '[scheduler] done 回调抛错:', err);
            }
        }
    }

    /** 日志本身出错不能影响调度 */
    private log(level: 'info' | 'warn' | 'error', message: string, ...args: unknown[]): void {
        try {
            this.logger[level]?.(message, ...args);
        } catch {
            /* 忽略 logger 自身异常 */
        }
    }
}

/** 工厂写法（与 createHttp / createFetcher 一致）；也可用 `new TaskScheduler(items, options)` */
export const createTaskScheduler = <T, R>(
    items: readonly T[],
    options: SchedulerOptions<T, R>
): TaskScheduler<T, R> => new TaskScheduler(items, options);
