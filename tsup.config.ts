import { defineConfig } from 'tsup';

/**
 * 构建配置
 * - 同时输出 CJS（.cjs）与 ESM（.mjs），各配一份类型声明
 * - target 与 package.json 的 engines 保持一致（Node 18）
 * - 压缩但保留类名/函数名，错误信息与堆栈才不会变成单字母，便于排查
 * - 保留 node: 协议前缀，避免运行时解析差异
 */
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    keepNames: true,
    clean: true,
    target: 'node18',
    sourcemap: false,
    removeNodeProtocol: false,
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' })
});
