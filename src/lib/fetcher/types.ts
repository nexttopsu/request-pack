import type { AxiosRequestConfig } from 'axios';
import type { z } from 'zod';
import type { ProxyConfig } from '../http';
import type { Schema, ParsedResult } from '../parser';
import type { FetcherError } from './errors';

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

/** 只接收日志对象，不内置 console，也不读环境变量 */
export interface Logger {
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
}

export const NOOP_LOGGER: Logger = Object.freeze({});

/* ------------------------------------------------------------------ */
/* 结果加工函数（取代插件系统）                                         */
/* ------------------------------------------------------------------ */

export type FetcherTransport = 'axios' | 'browser';
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

/** 加工函数的只读上下文 */
export interface ResultParserContext {
    readonly url: string;
    readonly finalUrl: string;
    readonly status: number;
    readonly html: string;
    readonly transport: FetcherTransport;
}

/**
 * 处理「已通过输出校验」的结构化结果。
 * 返回新结果或 Promise<新结果>；返回 undefined 表示沿用上一步结果（允许就地修改）。
 * 数组按声明顺序串行 await 执行，全部跑完后再用同一个 outputSchema 复验。
 */
export type ResultParser<S extends Schema> = (
    data: ParsedResult<S>,
    ctx: Readonly<ResultParserContext>
) => ParsedResult<S> | void | Promise<ParsedResult<S> | void>;

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

export interface CommonFetcherOptions<S extends Schema> {
    /** 重试次数（只覆盖 fetch 阶段），0–10，默认 0 */
    readonly retries?: number;
    /** 单次请求总时限（毫秒），100–300000，默认 20_000 */
    readonly timeoutMs?: number;
    /** 形状与 ProxyConfig 完全一致；不传即直连 */
    readonly proxy?: ProxyConfig;
    readonly headers?: Readonly<Record<string, string>>;
    /** 其余 axios 配置透传；timeout / proxy / headers 以显式配置键为准 */
    readonly http?: AxiosRequestConfig;
    /** false / 省略 → noop；对象 → 使用该 Logger；true → 仅打开日志开关（默认 logger 仍是 noop） */
    readonly logging?: boolean | Logger;
    /** 组合器 schema，创建时一次性校验并编译 */
    readonly schema: S;
    /** 结果加工函数，或按顺序串行执行的函数数组（支持 async） */
    readonly parser?: ResultParser<S> | readonly ResultParser<S>[];
    /** html2object 的第三个参数：解析前先移除干扰节点 */
    readonly removeSelector?: readonly string[];
}

export interface AxiosFetcherOptions<S extends Schema> extends CommonFetcherOptions<S> {
    readonly type: 'axios';
    /** browser 专属键在 axios 分支编译期即被拒绝（never），运行时由 strict 校验兜底 */
    readonly headless?: never;
    readonly waitUntil?: never;
    readonly blockResources?: never;
    readonly viewport?: never;
}

export interface BrowserFetcherOptions<S extends Schema> extends CommonFetcherOptions<S> {
    readonly type: 'browser';
    readonly headless?: boolean;
    readonly waitUntil?: WaitUntil;
    readonly blockResources?: readonly string[];
    readonly viewport?: { readonly width: number; readonly height: number };
}

/** 顶层按 type 判别联合，同时保持调用形态扁平 */
export type FetcherOptions<S extends Schema> = AxiosFetcherOptions<S> | BrowserFetcherOptions<S>;

/** 请求级只允许这些覆盖项；schema 明确设为 never，禁止运行时切换 */
export interface RequestOverrides {
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly proxy?: ProxyConfig;
    readonly http?: AxiosRequestConfig;
    /** 要换字段请改用 request.with({ schema }) */
    readonly schema?: never;
}

/** with() 可覆盖的字段：换 schema 必须用泛型重载派生新实例 */
export type FetcherWithOverrides<S extends Schema> =
    Partial<Omit<CommonFetcherOptions<S>, 'schema'>> & {
        readonly schema?: S;
        readonly headless?: boolean;
        readonly waitUntil?: WaitUntil;
        readonly blockResources?: readonly string[];
        readonly viewport?: { readonly width: number; readonly height: number };
    };

/** 校验并补齐默认值之后的实例配置，只在闭包里流转 */
export interface FetcherConfig<S extends Schema> {
    readonly type: FetcherTransport;
    readonly retries: number;
    readonly timeoutMs: number;
    readonly proxy?: ProxyConfig;
    readonly headers: Record<string, string>;
    readonly http?: AxiosRequestConfig;
    readonly logging: boolean;
    readonly logger: Logger;
    readonly schema: S;
    readonly parser: readonly ResultParser<S>[];
    readonly removeSelector?: string[];
    readonly headless: boolean;
    readonly waitUntil: WaitUntil;
    readonly blockResources: string[];
    readonly viewport?: { width: number; height: number };
}

/* ------------------------------------------------------------------ */
/* 返回值                                                              */
/* ------------------------------------------------------------------ */

export interface FetcherMeta {
    readonly finalUrl: string;
    readonly status: number;
    readonly elapsedMs: number;
    readonly transport: FetcherTransport;
}

export type SafeResult<S extends Schema> =
    | { readonly ok: true; readonly data: ParsedResult<S>; readonly meta: FetcherMeta }
    | { readonly ok: false; readonly error: FetcherError; readonly meta: FetcherMeta };

/** 可调用的函数对象 */
export interface Fetcher<S extends Schema> {
    (url: string, overrides?: RequestOverrides): Promise<ParsedResult<S>>;
    /** 不抛错，失败时返回 { ok:false, error, meta } */
    safe(url: string, overrides?: RequestOverrides): Promise<SafeResult<S>>;
    /** 返回原始 HTML，跳过解析 / 校验 / 加工 */
    raw(url: string, overrides?: RequestOverrides): Promise<string>;
    /** 释放连接池与浏览器；幂等 */
    close(): Promise<void>;
    /** 换 schema 派生新实例，重新走完整校验与编译 */
    with<S2 extends Schema>(overrides: { readonly schema: S2 } & Omit<FetcherWithOverrides<S2>, 'schema'>): Fetcher<S2>;
    with(overrides: FetcherWithOverrides<S>): Fetcher<S>;
    /** 编译后的输出 schema，创建时缓存，全实例复用 */
    readonly outputSchema: z.ZodType<ParsedResult<S>>;
}

/* ------------------------------------------------------------------ */
/* transport 内部协议                                                  */
/* ------------------------------------------------------------------ */

export interface FetchContext {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly proxy?: ProxyConfig;
    readonly http?: AxiosRequestConfig;
}

export interface FetchOutcome {
    readonly html: string;
    readonly status: number;
    readonly finalUrl: string;
}

export interface Transport {
    readonly kind: FetcherTransport;
    fetch(ctx: FetchContext): Promise<FetchOutcome>;
    close(): Promise<void>;
}
