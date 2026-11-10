import type { ParsedResult, Schema } from '../parser';
import { asFetcherError } from './errors';
import type { ResultParser, ResultParserContext } from './types';

/**
 * 取代插件系统的结果加工链：函数数组按顺序串行 await 执行。
 * 上下文对象冻结（只读），函数之间只能通过「上一步的返回值」传递结果，没有任何模块级状态。
 */
export async function runResultParsers<S extends Schema>(
    data: ParsedResult<S>,
    parsers: readonly ResultParser<S>[],
    ctx: ResultParserContext
): Promise<ParsedResult<S>> {
    if (parsers.length === 0) return data;
    const frozenCtx: Readonly<ResultParserContext> = Object.freeze({ ...ctx });
    let current = data;

    for (let i = 0; i < parsers.length; i++) {
        const parser = parsers[i];
        let next: ParsedResult<S> | void;
        try {
            next = await parser(current, frozenCtx);
        } catch (error) {
            const label = parser.name || `parser[${i}]`;
            throw asFetcherError(error, {
                code: 'TRANSFORM_FAILED', phase: 'plugin', plugin: label, url: ctx.url,
            });
        }
        // 返回 undefined 表示沿用上一步结果（允许就地修改后继续）
        if (next !== undefined) current = next;
    }
    return current;
}
