/* ------------------------------------------------------------------ */
/* createFetcher 的统一错误类型                                         */
/* ------------------------------------------------------------------ */

/** 失败所处阶段。plugin 保留为「结果加工函数（parser）阶段」使用，枚举值本身不变 */
export type FetcherPhase = 'config' | 'fetch' | 'parse' | 'validate' | 'plugin' | 'timeout' | 'browser';

export type FetcherErrorCode =
    | 'INVALID_CONFIG'
    | 'INVALID_SCHEMA'
    | 'CLOSED'
    | 'FETCH_FAILED'
    | 'ABORTED'
    | 'TIMEOUT'
    | 'PARSE_FAILED'
    | 'VALIDATE_FAILED'
    | 'TRANSFORM_FAILED'
    | 'BROWSER_MISSING'
    | 'BROWSER_FAILED'
    | 'UNEXPECTED';

export interface FetcherErrorOptions {
    code: FetcherErrorCode;
    phase: FetcherPhase;
    /** 出错字段路径，如 list[0].href / schema.tags[0].selector */
    fieldPath?: string;
    /** 出错的 parser 加工函数描述（保留 §5 的 plugin 字段名） */
    plugin?: string;
    url?: string;
    cause?: unknown;
}

/**
 * 所有失败都抛这个类型：配置非法、抓取失败、解析失败、输出不符 schema、加工函数抛错、超时。
 * 不返回 partial 数据、不填空、不 coerce。
 */
export class FetcherError extends Error {
    readonly code: FetcherErrorCode;
    readonly phase: FetcherPhase;
    readonly fieldPath?: string;
    readonly plugin?: string;
    readonly url?: string;

    constructor(message: string, options: FetcherErrorOptions) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'FetcherError';
        this.code = options.code;
        this.phase = options.phase;
        this.fieldPath = options.fieldPath;
        this.plugin = options.plugin;
        this.url = options.url;
    }
}

export const isFetcherError = (value: unknown): value is FetcherError => value instanceof FetcherError;

/** 把未知异常兜底成 FetcherError；已是 FetcherError 的原样返回，保留 phase 与字段路径 */
export function asFetcherError(error: unknown, fallback: FetcherErrorOptions): FetcherError {
    if (isFetcherError(error)) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new FetcherError(message || '未知错误', { ...fallback, cause: error });
}
