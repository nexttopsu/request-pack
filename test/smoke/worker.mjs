import { defineThreadTask } from 'request-pack';

/**
 * 运行时兼容性冒烟脚本的子线程任务。
 * 用普通 .mjs（而非 TS），这样 Node 18 不需要任何 loader 也能跑——
 * 用于验证发布产物在 engines 声明的下限版本上真的能用。
 */
export const task = defineThreadTask(async ({ n }) => {
    if (n === 13) throw new Error('unlucky');
    return n * 2;
});
