import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TaskPool, defineThreadTask } from '../src/lib/pool.ts';

// 测试从项目根目录运行，fixture 路径按 cwd 解析，避免 ESM/CJS 下的 __dirname / import.meta 差异
const workerPath = path.resolve(process.cwd(), 'test/fixtures/worker.mjs');

describe('TaskPool', () => {
    it('收集所有任务结果', async () => {
        const pool = new TaskPool<string>({ worker: workerPath, concurrency: 3 });
        const tasks = Array.from({ length: 6 }, (_, i) => ({ ms: 10, name: `t${i}` }));
        const { results, errors } = await pool.addTasks(tasks).run();

        assert.equal(errors.length, 0);
        assert.deepEqual(results, [
            'done: t0', 'done: t1', 'done: t2', 'done: t3', 'done: t4', 'done: t5',
        ]);
    });

    it('并发不超过 concurrency', async () => {
        const tasks = Array.from({ length: 6 }, (_, i) => ({ ms: 50, name: `t${i}` }));

        // 用「串行 vs 3 并发」对比，避开线程冷启动的绝对耗时差异
        const serialStart = Date.now();
        await new TaskPool<string>({ worker: workerPath, concurrency: 1 }).addTasks(tasks).run();
        const serial = Date.now() - serialStart;

        const parallelStart = Date.now();
        await new TaskPool<string>({ worker: workerPath, concurrency: 3 }).addTasks(tasks).run();
        const parallel = Date.now() - parallelStart;

        assert.ok(parallel < serial * 0.75, `并发未生效：串行 ${serial}ms，3 并发 ${parallel}ms`);
    });

    it('单个任务失败不中断整体，错误被收集并触发事件', async () => {
        const pool = new TaskPool<string>({ worker: workerPath, concurrency: 2 });
        const errorEvents: any[] = [];
        pool.on('taskError', err => errorEvents.push(err));

        const { results, errors } = await pool
            .addTasks([
                { ms: 5, name: 'ok1' },
                { ms: 5, name: 'bad1', fail: true },
                { ms: 5, name: 'ok2' },
            ])
            .run();

        assert.deepEqual(results, ['done: ok1', 'done: ok2']);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].error, 'boom: bad1');
        assert.equal(errors[0].reason, 'task');
        assert.deepEqual(errors[0].task, { ms: 5, name: 'bad1', fail: true });
        assert.equal(errorEvents.length, 1);
    });

    it('run 返回的 Promise 可重复 await（多次调用共享同一批结果）', async () => {
        const pool = new TaskPool<string>({ worker: workerPath, concurrency: 2 });
        const p1 = pool.addTask({ ms: 5, name: 'a' }).run();
        const p2 = pool.run();
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.deepEqual(r1.results, r2.results);
        assert.deepEqual(r1.results, ['done: a']);
    });
});

describe('TaskPool · 顺序与对齐', () => {
    it('results 按提交顺序而不是完成顺序排列', async () => {
        const pool = new TaskPool<string>({ worker: workerPath, concurrency: 4 });
        const tasks = [
            { ms: 60, name: 'slow' },
            { ms: 5, name: 'fast1' },
            { ms: 25, name: 'mid' },
            { ms: 1, name: 'fast2' },
        ];

        const { results, items } = await pool.addTasks(tasks).run();

        assert.deepEqual(results, ['done: slow', 'done: fast1', 'done: mid', 'done: fast2']);
        assert.deepEqual(items.map(item => item.task.name), ['slow', 'fast1', 'mid', 'fast2']);
        assert.ok(items.every(item => item.ok));
    });
});

describe('TaskPool · 超时与崩溃', () => {
    it('任务超时记为 timeout，并换掉卡住的线程继续跑后面的任务', async () => {
        // 超时从派发开始计时，含线程冷启动，所以留足余量
        const pool = new TaskPool<string>({ worker: workerPath, concurrency: 1, taskTimeout: 500 });
        const start = Date.now();

        const { results, errors } = await pool
            .addTasks([
                { ms: 2000, name: 'stuck' },
                { ms: 5, name: 'after' },
            ])
            .run();

        assert.deepEqual(results, ['done: after']);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].reason, 'timeout');
        assert.match(errors[0].error, /timeout after 500ms/);
        assert.ok(Date.now() - start < 1500, '超时后应立即放弃该任务');
    });

    it('线程崩溃只影响该线程手上的任务，其余任务正常完成', async () => {
        const pool = new TaskPool<string>({ worker: workerPath, concurrency: 1 });
        const { results, errors } = await pool
            .addTasks([
                { name: 'boom', crash: true },
                { ms: 5, name: 'ok' },
            ])
            .run();

        assert.deepEqual(results, ['done: ok']);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].reason, 'crash');
        assert.deepEqual(errors[0].task, { name: 'boom', crash: true });
    });
});

describe('TaskPool · 线程复用', () => {
    it('keepAlive 下多批任务复用线程，dispose 释放', async () => {
        const pool = new TaskPool<string>({ worker: workerPath, concurrency: 2, keepAlive: true });

        const first = await pool.addTasks([{ ms: 5, name: 'a' }]).run();
        const second = await pool.addTasks([{ ms: 5, name: 'b' }]).run();

        assert.deepEqual(first.results, ['done: a']);
        assert.deepEqual(second.results, ['done: b']);

        await pool.dispose();
    });

    it('dispose 会把未完成任务标记为 disposed', async () => {
        const pool = new TaskPool<string>({ worker: workerPath, concurrency: 1, keepAlive: true });
        const running = pool.addTasks([{ ms: 200, name: 'long' }]).run();

        await pool.dispose();
        const { errors } = await running;

        assert.equal(errors.length, 1);
        assert.equal(errors[0].reason, 'disposed');
    });
});

describe('defineThreadTask', () => {
    it('主线程调用时仅原样返回处理器，不产生副作用', () => {
        const handler = async (x: number) => x * 2;
        const wrapped = defineThreadTask(handler);
        assert.equal(wrapped, handler);
    });
});
