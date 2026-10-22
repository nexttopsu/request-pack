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
        assert.deepEqual(results.sort(), [
            'done: t0', 'done: t1', 'done: t2', 'done: t3', 'done: t4', 'done: t5',
        ]);
    });

    it('并发不超过 concurrency', async () => {
        const pool = new TaskPool<string>({ worker: workerPath, concurrency: 3 });
        const tasks = Array.from({ length: 6 }, (_, i) => ({ ms: 60, name: `t${i}` }));

        const start = Date.now();
        await pool.addTasks(tasks).run();
        const elapsed = Date.now() - start;

        // 6 个任务 × 60ms，3 并发约 2 轮 ≈ 130ms（含线程启动开销）；串行则 ≥400ms
        assert.ok(elapsed < 300, `并发未生效，耗时 ${elapsed}ms`);
        assert.ok(elapsed >= 100, `耗时异常偏短: ${elapsed}ms`);
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

        assert.deepEqual(results.sort(), ['done: ok1', 'done: ok2']);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].error, 'boom: bad1');
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

describe('defineThreadTask', () => {
    it('主线程调用时仅原样返回处理器，不产生副作用', () => {
        const handler = async (x: number) => x * 2;
        const wrapped = defineThreadTask(handler);
        assert.equal(wrapped, handler);
    });
});
