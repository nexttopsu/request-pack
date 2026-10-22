import { defineThreadTask } from '../../src/lib/pool.ts';

/**
 * 任务 fixture：走真实的 defineThreadTask 注册流程（不是手工模拟协议），
 * 这样 defineThreadTask 在子线程里的注册、结果回传、错误回传都被覆盖。
 *
 * 入参：{ ms, name, fail?, crash?, counter? }
 * - fail: true    抛错，验证错误消息与堆栈回传
 * - crash: true   直接退出进程，验证崩溃只影响手上那一个任务
 * - counter: SAB  共享计数器（Int32Array 视图：[0] 当前并发数，[1] 峰值并发数），
 *                 用于确定性地验证并发上限，不依赖计时
 */
export const task = defineThreadTask(
    async (data: { ms?: number; name?: string; fail?: boolean; crash?: boolean; counter?: SharedArrayBuffer }) => {
        if (data.crash) process.exit(1);

        if (data.counter) {
            const counter = new Int32Array(data.counter);
            const current = Atomics.add(counter, 0, 1) + 1;
            // 记录峰值：CAS 循环，避免并发写入互相覆盖
            let peak = Atomics.load(counter, 1);
            while (current > peak && Atomics.compareExchange(counter, 1, peak, current) !== peak) {
                peak = Atomics.load(counter, 1);
            }
            await new Promise(resolve => setTimeout(resolve, data.ms ?? 0));
            Atomics.sub(counter, 0, 1);
        } else {
            await new Promise(resolve => setTimeout(resolve, data.ms ?? 0));
        }

        if (data.fail) throw new Error(`boom: ${data.name}`);
        return `done: ${data.name}`;
    }
);
