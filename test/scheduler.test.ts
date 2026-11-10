import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createTaskScheduler,
    TaskScheduler,
    type SchedulerLogger,
    type SchedulerOutcome,
    type SchedulerError,
} from '../src/index.ts';

/* 不用计时断言：用闸门精确控制 Promise 何时结算 */
function gate<T = void>() {
    let release!: (value?: T) => void;
    const promise = new Promise<T>(resolve => {
        release = resolve as (value?: T) => void;
    });
    return { promise, release };
}

/** 让出一次宏任务，等所有已排入的 microtask 结算完（不测量时间） */
const macrotask = () => new Promise<void>(resolve => setImmediate(resolve));

describe('TaskScheduler：单线程 Promise 并发调度', () => {
    it('结果按输入下标排序，与完成顺序无关', async () => {
        const gates = Array.from({ length: 5 }, () => gate<number>());
        const scheduler = createTaskScheduler([10, 20, 30, 40, 50], {
            concurrency: 5,
            handler: async (item, index) => gates[index].promise.then(() => item + index),
        });

        scheduler.start();
        // 逆序放行：完成顺序 4→3→2→1→0，结果仍须按 0..4 排
        for (let i = 4; i >= 0; i--) gates[i].release();
        const { results, errors } = await scheduler.wait();

        assert.deepEqual(errors, []);
        assert.deepEqual(results.map(r => r.index), [0, 1, 2, 3, 4]);
        assert.deepEqual(results.map(r => r.item), [10, 20, 30, 40, 50]);
        assert.deepEqual(results.map(r => r.value), [10, 21, 32, 43, 54]);
        // result 是 value 的别名，贴合「result[任务执行结果]」的取值方式
        assert.deepEqual(results.map(r => r.result), [10, 21, 32, 43, 54]);
        assert.ok(results.every(r => r.ok && r.status === 'success'));
    });

    it('并发数不超过配置上限（计数器断言，不用计时）', async () => {
        const block = gate();
        let active = 0;
        let peak = 0;
        const scheduler = createTaskScheduler(Array.from({ length: 10 }, (_, i) => i), {
            concurrency: 3,
            handler: async (_item, index) => {
                active++;
                peak = Math.max(peak, active);
                await block.promise;
                active--;
                return index;
            },
        });

        scheduler.start();
        await macrotask();
        assert.equal(peak, 3);
        assert.equal(active, 3);

        block.release();
        const { results } = await scheduler.wait();
        assert.equal(results.length, 10);
        assert.ok(results.every(r => r.ok));
    });

    it('concurrency: 1 严格串行', async () => {
        const block = gate();
        let active = 0;
        let peak = 0;
        const scheduler = createTaskScheduler([1, 2, 3, 4], {
            concurrency: 1,
            handler: async item => {
                active++;
                peak = Math.max(peak, active);
                await block.promise;
                active--;
                return item * 2;
            },
        });

        scheduler.start();
        await macrotask();
        assert.equal(peak, 1);

        block.release();
        const { results } = await scheduler.wait();
        assert.deepEqual(results.map(r => r.value), [2, 4, 6, 8]);
        assert.equal(peak, 1);
    });

    it('单个任务失败（含同步 throw）不中断整批，errors 结构完整', async () => {
        const cause = new Error('boom');
        const scheduler = createTaskScheduler(['a', 'b', 'c', 'd'], {
            concurrency: 2,
            handler: (_item, index) => {
                if (index === 1) throw cause;                       // 同步抛错
                if (index === 2) return Promise.reject('bad');       // 非 Error 的拒绝值
                return `v${index}`;                                  // 同步返回值
            },
        });

        let callbackArgs: [SchedulerOutcome<string, string>[], SchedulerError<string>[]] | undefined;
        scheduler.start().done((results, errors) => {
            callbackArgs = [results, errors];
        });
        const { results, errors } = await scheduler.wait();

        assert.deepEqual(results.map(r => r.status), ['success', 'failed', 'failed', 'success']);
        assert.equal(results[1].error, 'boom');
        assert.equal(results[2].error, 'bad');
        assert.equal(results[1].value, undefined);
        assert.deepEqual(errors.map(e => e.index), [1, 2]);
        assert.deepEqual(errors.map(e => e.item), ['b', 'c']);
        assert.deepEqual(errors.map(e => e.reason), ['task', 'task']);
        assert.equal(errors[0].cause, cause);
        assert.equal(errors[0].error, 'boom');
        assert.ok(callbackArgs, 'done 回调应被触发');
        assert.deepEqual(callbackArgs![0].map(r => r.index), [0, 1, 2, 3]);
        assert.equal(callbackArgs![1].length, 2);
    });

    it('start / done / stop / restart 全部可链式，返回同一实例', async () => {
        const scheduler = createTaskScheduler([1], { handler: async x => x });
        assert.equal(scheduler.start(), scheduler);
        assert.equal(scheduler.done(() => undefined), scheduler);
        assert.equal(scheduler.stop(), scheduler);
        assert.equal(scheduler.restart(), scheduler);
        assert.ok(scheduler instanceof TaskScheduler);
        // 等在途与重跑轮次全部结算完，避免把异步活动留给下一个用例
        await scheduler.wait();
    });

    it('done 可在 start 前或 start 后注册，async 回调抛错不影响调度', async () => {
        let before = 0;
        let after = 0;
        const a = createTaskScheduler([1], {
            handler: async x => x,
        }).done(async () => {
            before++;
        }).start();
        await a.wait();
        assert.equal(before, 1);

        const b = createTaskScheduler([2], { handler: async x => x })
            .start()
            .done(async () => {
                after++;
                throw new Error('回调里抛错也应被吞掉');
            });
        await b.wait();
        assert.equal(after, 1);
    });

    it('stop：在途任务跑完并结算，未派发项记为 cancelled', async () => {
        const block = gate();
        let calls = 0;
        const scheduler = createTaskScheduler([0, 1, 2, 3, 4, 5], {
            concurrency: 2,
            handler: async item => {
                calls++;
                await block.promise;
                return item * 10;
            },
        });

        let doneCount = 0;
        scheduler.start().done(() => {
            doneCount++;
        });
        await macrotask();
        assert.equal(calls, 2, '只应派发 2 个在途任务');
        assert.equal(scheduler.status, 'running');

        scheduler.stop();
        assert.deepEqual(scheduler.errors.map(e => e.index), [2, 3, 4, 5]);
        assert.ok(scheduler.errors.every(e => e.reason === 'cancelled'));
        assert.equal(doneCount, 0, '在途未结算前不应触发 done');

        block.release();
        await scheduler.wait();
        assert.equal(calls, 2, '被取消派发的任务不应执行');
        assert.deepEqual(scheduler.results.map(r => r.status), [
            'success', 'success', 'cancelled', 'cancelled', 'cancelled', 'cancelled',
        ]);
        assert.deepEqual(scheduler.results.slice(0, 2).map(r => r.value), [0, 10]);
        assert.equal(doneCount, 1, '本轮结束触发一次 done');
    });

    it('restart：只重跑错误项，成功结果保留，结果数组顺序不变', async () => {
        const calls = new Map<number, number>();
        let round = 1;
        const failOnFirstRound = new Set([1, 3]);
        const scheduler = createTaskScheduler(['a', 'b', 'c', 'd', 'e'], {
            concurrency: 2,
            handler: async (item, index) => {
                calls.set(index, (calls.get(index) ?? 0) + 1);
                // 用微任务让出，确保不是靠执行顺序碰巧成功
                await Promise.resolve();
                if (round === 1 && failOnFirstRound.has(index)) throw new Error(`失败 ${index}`);
                return `${item}!`;
            },
        });

        let doneCount = 0;
        scheduler.start().done(() => {
            doneCount++;
        });
        const first = await scheduler.wait();
        assert.deepEqual(first.errors.map(e => e.index), [1, 3]);
        assert.deepEqual(first.results.map(r => r.status), [
            'success', 'failed', 'success', 'failed', 'success',
        ]);

        round = 2;
        scheduler.restart();
        const second = await scheduler.wait();
        assert.deepEqual(second.errors, []);
        assert.deepEqual(second.results.map(r => r.status), Array(5).fill('success'));
        assert.deepEqual(second.results.map(r => r.index), [0, 1, 2, 3, 4]);
        assert.deepEqual(second.results.map(r => r.value), ['a!', 'b!', 'c!', 'd!', 'e!']);
        // 成功项没被重跑，错误项各多跑一次
        assert.deepEqual([...calls.entries()].sort((a, b) => a[0] - b[0]), [
            [0, 1], [1, 2], [2, 1], [3, 2], [4, 1],
        ]);
        assert.equal(doneCount, 2, 'restart 结束后应再次触发 done');
    });

    it('stop 之后 restart：cancelled 项也会被重跑', async () => {
        const block = gate();
        const calls = new Map<number, number>();
        const scheduler = createTaskScheduler([0, 1, 2, 3], {
            concurrency: 1,
            handler: async (item, index) => {
                calls.set(index, (calls.get(index) ?? 0) + 1);
                if (calls.get(index) === 1 && index === 0) await block.promise;
                return item;
            },
        });

        scheduler.start();
        await macrotask();
        scheduler.stop();
        block.release();
        await scheduler.wait();
        assert.deepEqual(scheduler.errors.map(e => e.index), [1, 2, 3]);

        scheduler.restart();
        const { results, errors } = await scheduler.wait();
        assert.deepEqual(errors, []);
        assert.deepEqual(results.map(r => r.value), [0, 1, 2, 3]);
        assert.equal(calls.get(0), 1, '已成功的 index=0 不重跑');
        assert.equal(calls.get(1), 1);
        assert.equal(calls.get(3), 1);
    });

    it('restart 在在途未结算时挂起，等在途跑完再开新一轮', async () => {
        const block = gate();
        const calls = new Map<number, number>();
        const scheduler = createTaskScheduler([0, 1, 2, 3, 4], {
            concurrency: 2,
            handler: async (item, index) => {
                calls.set(index, (calls.get(index) ?? 0) + 1);
                await block.promise;
                return item;
            },
        });

        let doneCount = 0;
        scheduler.start().done(() => {
            doneCount++;
        });
        await macrotask();

        scheduler.restart();
        assert.equal(scheduler.status, 'stopping');
        assert.equal(doneCount, 0, '挂起期间不触发旧轮次的 done');
        assert.equal(calls.size, 2, '尚未开始重跑');

        block.release();
        const { results, errors } = await scheduler.wait();
        assert.deepEqual(errors, []);
        assert.deepEqual(results.map(r => r.value), [0, 1, 2, 3, 4]);
        assert.equal(calls.get(0), 1);
        assert.equal(calls.get(4), 1, 'cancelled 的项重跑了一次');
        assert.equal(doneCount, 1, '重跑轮次结束时触发一次 done');
    });

    it('空任务列表也能正常 start / done，且 start 幂等', async () => {
        let doneCount = 0;
        const scheduler = createTaskScheduler([], {
            handler: async () => {
                throw new Error('不应执行');
            },
        }).done(() => {
            doneCount++;
        });

        scheduler.start();
        const { results, errors } = await scheduler.wait();
        assert.deepEqual(results, []);
        assert.deepEqual(errors, []);
        assert.equal(doneCount, 1);
        assert.equal(scheduler.status, 'done');
    });

    it('运行中重复 start 不会重复派发', async () => {
        const block = gate();
        let calls = 0;
        const scheduler = createTaskScheduler([1, 2, 3, 4], {
            concurrency: 2,
            handler: async item => {
                calls++;
                await block.promise;
                return item;
            },
        });

        scheduler.start().start();
        await macrotask();
        assert.equal(calls, 2);
        block.release();
        await scheduler.wait();
        assert.equal(calls, 4);
    });

    it('已完成实例上重复 start 不产生空轮次、不重复触发 done', async () => {
        let doneCount = 0;
        const scheduler = createTaskScheduler([1, 2], { handler: async x => x })
            .done(() => {
                doneCount++;
            })
            .start();
        await scheduler.wait();
        assert.equal(doneCount, 1);

        scheduler.start().start();
        await macrotask();
        assert.equal(doneCount, 1);
        // wait() 在已完成实例上仍返回当前快照
        assert.equal((await scheduler.wait()).results[0].value, 1);
    });

    it('results / errors 是快照，外部修改不影响内部状态', async () => {
        const scheduler = createTaskScheduler([1], { handler: async x => x })
            .start();
        await scheduler.wait();

        const snapshot = scheduler.results;
        snapshot[0].value = 999;
        snapshot.length = 0;
        assert.equal(scheduler.results[0].value, 1);
        assert.equal(scheduler.results.length, 1);
    });

    it('wait() 在已完成实例上立即返回当前快照', async () => {
        const scheduler = createTaskScheduler([7], { handler: async x => x * 2 }).start();
        const first = await scheduler.wait();
        const again = await scheduler.wait();
        assert.equal(again.results[0].value, 14);
        assert.deepEqual(again.errors, []);
        assert.equal(first.results[0].value, 14);
    });

    it('配置校验：非法参数在创建时明确抛错', () => {
        assert.throws(() => createTaskScheduler('not-array' as any, { handler: async x => x }), TypeError);
        assert.throws(() => createTaskScheduler([1], { handler: null as any }), TypeError);
        for (const value of [0, -1, 1.5, NaN, Infinity]) {
            assert.throws(
                () => createTaskScheduler([1], { concurrency: value, handler: async x => x }),
                RangeError
            );
        }
        assert.throws(
            () => createTaskScheduler([1], { logging: 'yes' as any, handler: async x => x }),
            TypeError
        );
        assert.throws(() => createTaskScheduler([1], { handler: async x => x }).done(null as any), TypeError);
    });

    it('logging：自定义 logger 收到轮次与失败信息，默认静默', async () => {
        const messages: { level: string; text: string }[] = [];
        const logger: SchedulerLogger = {
            info: text => messages.push({ level: 'info', text }),
            warn: text => messages.push({ level: 'warn', text }),
            error: text => messages.push({ level: 'error', text }),
        };
        const scheduler = createTaskScheduler([1, 2], {
            concurrency: 1,
            logging: logger,
            handler: async (_item, index) => {
                if (index === 1) throw new Error('oops');
                return index;
            },
        }).start();
        await scheduler.wait();

        assert.ok(messages.some(m => m.level === 'info' && m.text.includes('派发 2 个任务')));
        assert.ok(messages.some(m => m.level === 'info' && m.text.includes('本轮结束')));
        assert.ok(messages.some(m => m.level === 'warn' && m.text.includes('oops')));

        // 不传 logging 时不抛错、不依赖 console
        const quiet = createTaskScheduler([1], { handler: async x => x }).start();
        assert.equal((await quiet.wait()).results[0].value, 1);
    });

    it('同步抛错的 done 回调与自身抛错的 logger 都不影响调度', async () => {
        const errors: string[] = [];
        const logger: SchedulerLogger = {
            info: () => {
                throw new Error('logger 坏了');
            },
            error: text => errors.push(text),
        };
        const scheduler = createTaskScheduler([1, 2], {
            logging: logger,
            handler: async x => x * 3,
        }).done(() => {
            throw new Error('回调坏了');
        }).start();

        const { results } = await scheduler.wait();
        assert.deepEqual(results.map(r => r.value), [3, 6]);
        assert.ok(errors.some(text => text.includes('done 回调抛错')));
    });
});
