import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import iconv from 'iconv-lite';
import { delay } from './utils';

export interface ProxyConfig {
    /** 代理协议，默认 http */
    protocol?: 'http' | 'https';
    host: string;
    port: number;
    auth?: { username: string; password: string };
}

export interface RetryOptions {
    /** 重试次数（不含首次请求），默认 0 */
    retries?: number;
    /** 首次退避毫秒，默认 500 */
    delay?: number;
    /** 退避倍数，默认 2 */
    factor?: number;
    /** 单次退避上限毫秒，默认 10_000 */
    maxDelay?: number;
    /** 叠加随机抖动，避免多线程同时重试，默认 true */
    jitter?: boolean;
    /** 自定义重试判定；不传时按网络错误 / 408 / 425 / 429 / 500 / 502 / 503 / 504 判定 */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export interface HttpOptions extends AxiosRequestConfig {
    /** 代理配置。不传则直连，绝不偷偷挂代理 */
    proxy?: ProxyConfig;
    /** 失败重试。数字表示次数，对象可细调退避；默认不重试 */
    retry?: number | RetryOptions;
    /** 同一客户端两次请求的最小间隔（毫秒），用于限速。跨线程/跨进程不共享 */
    minInterval?: number;
    /** getText 的兜底编码，默认 'auto'：从响应头与 <meta charset> 推断，推断不出用 utf-8 */
    encoding?: string;
}

export interface Http {
    /** 底层 axios 实例，需要更细粒度控制时使用 */
    readonly instance: AxiosInstance;
    /** 通用入口，适合 PUT/DELETE/HEAD 或需要读响应头的场景 */
    request<T = any>(config: AxiosRequestConfig): Promise<T>;
    get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>;
    post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T>;
    /** 抓网页：按 charset 自动解码为字符串（GBK 等非 UTF-8 站点不会乱码） */
    getText(url: string, config?: AxiosRequestConfig): Promise<string>;
    /** 以 Buffer 拉取二进制内容（图片、文件等） */
    getBuffer(url: string, config?: AxiosRequestConfig): Promise<Buffer>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** responseType: 'arraybuffer' 在 Node 下拿到的常是 Buffer，避免再整块拷贝一次 */
function toBuffer(data: unknown): Buffer {
    return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBufferLike);
}

function defaultShouldRetry(error: any): boolean {
    const status: number | undefined = error?.response?.status;
    if (status !== undefined) return RETRYABLE_STATUS.has(status);
    // 没有响应 = 网络层失败（DNS、连接重置、超时等），值得重试
    return true;
}

/** 非负有限数，非法输入（NaN / -1 / undefined）回落到 fallback：retries 是 NaN 会导致无限重试 */
function nonNegative(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function normalizeRetry(retry: number | RetryOptions | undefined) {
    const base = {
        retries: 0,
        delay: 500,
        factor: 2,
        maxDelay: 10_000,
        jitter: true,
        shouldRetry: defaultShouldRetry as (error: unknown, attempt: number) => boolean,
    };
    if (typeof retry === 'number') return { ...base, retries: nonNegative(retry, base.retries) };
    if (!retry) return base;
    return {
        retries: nonNegative(retry.retries, base.retries),
        delay: nonNegative(retry.delay, base.delay),
        factor: nonNegative(retry.factor, base.factor),
        maxDelay: nonNegative(retry.maxDelay, base.maxDelay),
        jitter: retry.jitter ?? base.jitter,
        shouldRetry: retry.shouldRetry ?? base.shouldRetry,
    };
}

const CHARSET_ALIASES: Record<string, string> = {
    'gb2312': 'gbk',
    'gb_2312-80': 'gbk',
    'x-gbk': 'gbk',
    'utf8': 'utf-8',
    'latin1': 'latin1',
};

function normalizeCharset(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const name = raw.trim().toLowerCase().replace(/^["']|["']$/g, '');
    const alias = CHARSET_ALIASES[name] ?? name;
    return iconv.encodingExists(alias) ? alias : undefined;
}

/** 从响应头与 HTML 头部嗅探编码：Content-Type 优先，其次 <meta charset> */
export function detectCharset(headers: Record<string, any> | undefined, body: Buffer): string | undefined {
    const contentType = String(headers?.['content-type'] ?? '');
    const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
    const hit = normalizeCharset(fromHeader);
    if (hit) return hit;

    // meta 只可能出现在文档开头，取前 4KB 足够
    const head = body.subarray(0, 4096).toString('latin1');
    const fromMeta =
        /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ??
        /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head)?.[1];
    return normalizeCharset(fromMeta);
}

/**
 * 创建 HTTP 客户端。所有配置显式传入，无任何隐藏默认值。
 * 依赖官方 axios（>= 1.16.1 起原生支持 HTTPS 代理的 CONNECT 隧道）。
 *
 * @example
 * const http = createHttp({
 *     proxy: { host: '127.0.0.1', port: 1080 },
 *     retry: { retries: 3 },
 *     minInterval: 300,
 * });
 * const html = await http.getText('https://example.com');
 */
export function createHttp(options: HttpOptions = {}): Http {
    const { proxy, retry, minInterval = 0, encoding = 'auto', ...axiosConfig } = options;

    const instance = axios.create({
        timeout: 30 * 1000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        ...axiosConfig,
        // 不传代理就直连：显式关闭 axios 默认读取 HTTP_PROXY/HTTPS_PROXY 环境变量的行为
        ...(proxy === undefined ? { proxy: false as const } : { proxy }),
    });

    const retryPolicy = normalizeRetry(retry);

    // 限速：把请求的「发出时刻」串起来，保证相邻两次至少间隔 minInterval
    let gate: Promise<void> = Promise.resolve();
    let nextAt = 0;
    const throttle = async (): Promise<void> => {
        if (minInterval <= 0) return;
        const wait = gate.then(async () => {
            const gap = nextAt - Date.now();
            if (gap > 0) await delay(gap);
            nextAt = Date.now() + minInterval;
        });
        gate = wait.catch(() => undefined);
        await wait;
    };

    const backoff = (attempt: number, error: any): number => {
        const retryAfter = Number(error?.response?.headers?.['retry-after']);
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            return Math.min(retryAfter * 1000, retryPolicy.maxDelay);
        }
        const base = Math.min(retryPolicy.delay * retryPolicy.factor ** (attempt - 1), retryPolicy.maxDelay);
        return retryPolicy.jitter ? Math.round(base * (0.5 + Math.random() * 0.5)) : base;
    };

    const send = async <T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
        for (let attempt = 0; ; attempt++) {
            await throttle();
            try {
                return await instance.request<T>(config);
            } catch (error) {
                if (attempt >= retryPolicy.retries) throw error;
                if (!retryPolicy.shouldRetry(error, attempt + 1)) throw error;
                await delay(backoff(attempt + 1, error));
            }
        }
    };

    return {
        instance,
        request: <T = any>(config: AxiosRequestConfig = {}) =>
            send<T>(config).then(res => res.data),
        get: <T = any>(url: string, config: AxiosRequestConfig = {}) =>
            send<T>({ ...config, method: 'GET', url }).then(res => res.data),
        post: <T = any>(url: string, data?: any, config: AxiosRequestConfig = {}) =>
            send<T>({ ...config, method: 'POST', url, data }).then(res => res.data),
        getText: async (url: string, config: AxiosRequestConfig = {}) => {
            const res = await send<ArrayBuffer>({ ...config, method: 'GET', url, responseType: 'arraybuffer' });
            const buffer = toBuffer(res.data);
            const charset = detectCharset(res.headers as Record<string, any>, buffer)
                ?? (encoding !== 'auto' ? encoding : 'utf-8');
            return iconv.decode(buffer, charset);
        },
        getBuffer: (url: string, config: AxiosRequestConfig = {}) =>
            send<ArrayBuffer>({ ...config, method: 'GET', url, responseType: 'arraybuffer' }).then(res =>
                toBuffer(res.data)
            ),
    };
}
