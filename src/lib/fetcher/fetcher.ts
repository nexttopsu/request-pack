import type { z } from 'zod';
import { html2object, type ParsedResult, type Schema } from '../parser';
import { compileFieldTree } from './compiler';
import { asFetcherError, FetcherError } from './errors';
import { formatPath, validateOptions, validateOverrides, validateUrl } from './schema';
import { composeSignals } from './signals';
import { runResultParsers } from './transform';
import { createAxiosTransport, createBrowserTransport } from './transport';
import type {
    FetchContext,
    Fetcher,
    FetcherConfig,
    FetcherMeta,
    FetcherOptions,
    FetcherWithOverrides,
    RequestOverrides,
    ResultParserContext,
    SafeResult,
    Transport,
} from './types';

/** 仅供内部测试注入编译 / transport spy，不属于公开 API */
export interface FetcherDeps {
    compile?: <S extends Schema>(schema: S) => z.ZodType<ParsedResult<S>>;
    createTransport?: <S extends Schema>(cfg: FetcherConfig<S>) => Transport;
}

interface RequestOutcome<S extends Schema> {
    value?: ParsedResult<S> | string;
    error?: FetcherError;
    meta: FetcherMeta;
}

/**
 * 把「请求 → html2object → 输出校验 → parser 加工函数 → 复验」串成一次调用。
 *
 * - schema 只在创建时校验并编译，outputSchema 缓存进闭包，全实例复用；
 * - 任何失败（配置 / 抓取 / 解析 / 校验 / 加工 / 超时）都抛 FetcherError，不返回 partial 数据；
 * - timeoutMs 是单次请求总时限，cheerio 解析是同步 CPU 操作，只能在阶段边界检查 aborted。
 */
export function createFetcherCore<S extends Schema>(
    options: FetcherOptions<S>,
    deps: FetcherDeps = {}
): Fetcher<S> {
    const cfg = validateOptions(options);
    // 一次编译、两处使用：解析后校验 + parser 加工后复验
    const outputSchema = deps.compile ? deps.compile(cfg.schema) : compileFieldTree(cfg.schema);
    const transport = deps.createTransport
        ? deps.createTransport(cfg)
        : cfg.type === 'browser'
            ? createBrowserTransport(cfg)
            : createAxiosTransport(cfg);

    const baseOptions = { ...options } as FetcherOptions<any>;
    let closed = false;
    let closePromise: Promise<void> | undefined;

    /** 用同一个 outputSchema 校验；失败抛 phase:'validate'，错误信息带字段路径 */
    const validateOutput = (value: unknown, url: string): ParsedResult<S> => {
        const parsed = outputSchema.safeParse(value);
        if (parsed.success) return parsed.data;
        const paths = parsed.error.issues.map(issue => formatPath(issue.path) || '<root>');
        const details = parsed.error.issues
            .slice(0, 5)
            .map((issue, index) => `${paths[index]}: ${issue.message}`)
            .join('；');
        throw new FetcherError(`输出校验失败：${details}`, {
            code: 'VALIDATE_FAILED', phase: 'validate', fieldPath: paths[0], url,
        });
    };

    const runRequest = async (
        url: string,
        overrides: RequestOverrides | undefined,
        mode: 'full' | 'raw'
    ): Promise<RequestOutcome<S>> => {
        const started = Date.now();
        let meta: FetcherMeta = {
            finalUrl: typeof url === 'string' ? url : '',
            status: 0,
            elapsedMs: 0,
            transport: cfg.type,
        };
        let composed: ReturnType<typeof composeSignals> | undefined;

        try {
            validateUrl(url);
            if (closed) {
                throw new FetcherError('createFetcher 实例已 close()，请用 with() 派生新实例', {
                    code: 'CLOSED', phase: 'fetch', url,
                });
            }
            const ov = validateOverrides(overrides);
            const timeoutMs = ov.timeoutMs ?? cfg.timeoutMs;
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            composed = composeSignals(timeoutSignal, ov.signal);
            const signal = composed.signal;

            /** cheerio 同步解析不可中断，只能在阶段边界检查 */
            const throwIfAborted = (): void => {
                if (timeoutSignal.aborted) {
                    throw new FetcherError(`请求超过总时限 ${timeoutMs}ms`, {
                        code: 'TIMEOUT', phase: 'timeout', url, cause: timeoutSignal.reason,
                    });
                }
                if (ov.signal?.aborted) {
                    throw new FetcherError('请求被外部 signal 取消', {
                        code: 'ABORTED', phase: 'fetch', url, cause: ov.signal.reason,
                    });
                }
            };

            const wrapFetchError = (error: unknown): FetcherError => {
                if (timeoutSignal.aborted) {
                    return new FetcherError(`请求超过总时限 ${timeoutMs}ms`, {
                        code: 'TIMEOUT', phase: 'timeout', url, cause: timeoutSignal.reason,
                    });
                }
                if (ov.signal?.aborted) {
                    return new FetcherError('请求被外部 signal 取消', {
                        code: 'ABORTED', phase: 'fetch', url, cause: ov.signal.reason,
                    });
                }
                return asFetcherError(error, {
                    code: cfg.type === 'browser' ? 'BROWSER_FAILED' : 'FETCH_FAILED',
                    phase: cfg.type === 'browser' ? 'browser' : 'fetch',
                    url,
                });
            };

            const fetchContext: FetchContext = {
                url,
                headers: { ...cfg.headers, ...(ov.headers ?? {}) },
                signal,
                timeoutMs,
                proxy: ov.proxy ?? cfg.proxy,
                http: ov.http ?? cfg.http,
            };

            // ① fetch：retries 由 createHttp / browserTransport 内部实现，只覆盖这一步
            let outcome;
            try {
                outcome = await transport.fetch(fetchContext);
            } catch (error) {
                throw wrapFetchError(error);
            }
            meta = { ...meta, finalUrl: outcome.finalUrl || url, status: outcome.status };
            throwIfAborted();

            // raw 跳过解析 / 校验 / 加工
            if (mode === 'raw') {
                return { value: outcome.html, meta: { ...meta, elapsedMs: Date.now() - started } };
            }

            // ② html2object：best-effort 的 '' / [] / null 由下一步的 outputSchema 兜住
            let parsed: unknown;
            try {
                parsed = html2object(outcome.html, cfg.schema, cfg.removeSelector);
            } catch (error) {
                // html2object 抛的是普通 Error，原 message 里的字段路径原样保留
                const message = error instanceof Error ? error.message : String(error);
                throw new FetcherError(`解析失败：${message}`, {
                    code: 'PARSE_FAILED', phase: 'parse', url, cause: error,
                });
            }
            throwIfAborted();

            // ③ 输出校验
            let data = validateOutput(parsed, url);
            throwIfAborted();

            // ④ parser 加工函数链（数组串行 await，支持 Promise）
            const parserContext: ResultParserContext = {
                url,
                finalUrl: meta.finalUrl,
                status: meta.status,
                html: outcome.html,
                transport: cfg.type,
            };
            const transformed = await runResultParsers(data, cfg.parser, parserContext);
            throwIfAborted();

            // ⑤ 用同一个 outputSchema 复验：类型与「输出一致」的保证不能靠加工函数自觉
            data = validateOutput(transformed, url);
            throwIfAborted();

            if (cfg.logging) cfg.logger.info?.('createFetcher 请求完成', { url, meta });
            return { value: data, meta: { ...meta, elapsedMs: Date.now() - started } };
        } catch (error) {
            const failure = asFetcherError(error, { code: 'UNEXPECTED', phase: 'fetch', url });
            if (cfg.logging) cfg.logger.error?.('createFetcher 请求失败', { url, code: failure.code, phase: failure.phase });
            return { error: failure, meta: { ...meta, elapsedMs: Date.now() - started } };
        } finally {
            // 移除各 signal 上的 abort 监听，避免长生命周期外部 signal 泄漏监听器
            composed?.dispose();
        }
    };

    const call = async (url: string, overrides?: RequestOverrides): Promise<ParsedResult<S>> => {
        const result = await runRequest(url, overrides, 'full');
        if (result.error) throw result.error;
        return result.value as ParsedResult<S>;
    };

    const safe = async (url: string, overrides?: RequestOverrides): Promise<SafeResult<S>> => {
        const result = await runRequest(url, overrides, 'full');
        return result.error
            ? { ok: false, error: result.error, meta: result.meta }
            : { ok: true, data: result.value as ParsedResult<S>, meta: result.meta };
    };

    const raw = async (url: string, overrides?: RequestOverrides): Promise<string> => {
        const result = await runRequest(url, overrides, 'raw');
        if (result.error) throw result.error;
        return result.value as string;
    };

    const close = (): Promise<void> => {
        if (!closePromise) {
            closed = true;
            closePromise = transport.close();
        }
        return closePromise;
    };

    /**
     * 派生新实例：换 schema 时重新走完整校验与编译；请求级 overrides 永远不接受 schema。
     *
     * parser 加工函数是按「旧 schema 的结果形状」写的，换字段后继续沿用会访问不存在的
     * 字段而抛错。因此只要传了新 schema 且没有显式提供 parser，就丢弃旧加工链；
     * 显式传 parser（含空数组）时以传入为准。不换 schema 的 with() 仍照常继承全部配置。
     */
    const withOverrides = (overrides: FetcherWithOverrides<any>): Fetcher<any> => {
        const merged = { ...baseOptions, ...overrides } as FetcherOptions<any>;
        // 显式置空而不是 delete（配置属性是 readonly）；validateOptions 会把 undefined 归为 []
        if (overrides.schema !== undefined && !('parser' in overrides)) {
            return createFetcherCore({ ...merged, parser: undefined } as FetcherOptions<any>, deps);
        }
        return createFetcherCore(merged, deps);
    };

    const fetcher = Object.assign(call, {
        safe,
        raw,
        close,
        with: withOverrides,
        outputSchema,
    }) as unknown as Fetcher<S>;

    // Node 18.17 没有 Symbol.asyncDispose：先做特性检测，存在时才挂 close，避免类型 / 运行期报错
    const asyncDispose = (Symbol as any).asyncDispose as symbol | undefined;
    if (asyncDispose) (fetcher as any)[asyncDispose] = close;

    return fetcher;
}

/** 创建 fetcher；公开签名只有一个参数 */
export function createFetcher<S extends Schema>(options: FetcherOptions<S>): Fetcher<S> {
    return createFetcherCore(options);
}
