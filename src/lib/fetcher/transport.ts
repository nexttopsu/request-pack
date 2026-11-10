import { createRequire } from 'node:module';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { resolve as resolvePath } from 'node:path';
import type { AxiosRequestConfig } from 'axios';
import { createHttp } from '../http';
import { delay } from '../utils';
import { FetcherError } from './errors';
import type { FetchContext, FetchOutcome, FetcherConfig, Transport } from './types';
import type { Schema } from '../parser';

const PLAYWRIGHT_HINT = '未安装 playwright：请执行 npm i playwright && npx playwright install chromium';

/**
 * esbuild 在 CJS 产物里会把 await import('playwright') 降级成 require('playwright')，
 * 破坏懒加载与 ESM-only 兼容。用运行时构造的 import 保证两种格式都是真动态 import。
 */
const dynamicImport = new Function('s', 'return import(s)') as (specifier: string) => Promise<any>;

/** 同步探测 playwright 是否可解析（不加载、不启动 Chromium），用于创建时给出可操作提示 */
export function playwrightResolvable(): boolean {
    const anchors = [process.argv[1], resolvePath(process.cwd(), 'index.js')];
    for (const anchor of anchors) {
        if (!anchor) continue;
        try {
            createRequire(resolvePath(anchor)).resolve('playwright');
            return true;
        } catch (error) {
            // 解析成功但模块自身报错（例如 exports 条件不匹配）不当作「未安装」，交给动态 import 决定
            if ((error as NodeJS.ErrnoException)?.code !== 'MODULE_NOT_FOUND') return true;
        }
    }
    return false;
}

export function assertPlaywrightAvailable(): void {
    if (!playwrightResolvable()) {
        throw new FetcherError(PLAYWRIGHT_HINT, { code: 'BROWSER_MISSING', phase: 'browser' });
    }
}

async function loadPlaywright(): Promise<any> {
    try {
        return await dynamicImport('playwright');
    } catch (error) {
        throw new FetcherError(PLAYWRIGHT_HINT, {
            code: 'BROWSER_MISSING', phase: 'browser', cause: error,
        });
    }
}

/* ------------------------------------------------------------------ */
/* axios：重试 / 编码 / 代理全部复用 createHttp                          */
/* ------------------------------------------------------------------ */

export function createAxiosTransport<S extends Schema>(cfg: FetcherConfig<S>): Transport {
    // 自建 keepAlive:false 的 Agent，close() 时不留残余连接；用户通过 http 传入自己的 Agent 时不接管
    const ownHttpAgent = cfg.http?.httpAgent ? undefined : new HttpAgent({ keepAlive: false });
    const ownHttpsAgent = cfg.http?.httpsAgent ? undefined : new HttpsAgent({ keepAlive: false });

    const http = createHttp({
        ...cfg.http,
        headers: { ...cfg.headers, ...(cfg.http?.headers as Record<string, string> | undefined) },
        retry: { retries: cfg.retries },
        timeout: cfg.timeoutMs,
        proxy: cfg.proxy,
        httpAgent: cfg.http?.httpAgent ?? ownHttpAgent,
        httpsAgent: cfg.http?.httpsAgent ?? ownHttpsAgent,
    });

    // 用请求 config 上的自定义 id 记录 status / finalUrl，避免并发请求之间串台
    const metas = new Map<string, { status: number; finalUrl: string }>();
    const record = (config: any, status: number, response: any): void => {
        const id = config?.__requestPackMetaId;
        if (!id) return;
        const finalUrl = response?.request?.res?.responseUrl ?? config?.url ?? '';
        metas.set(id, { status, finalUrl });
    };
    http.instance.interceptors.response.use(
        response => { record(response.config, response.status, response); return response; },
        error => {
            if (error?.response) record(error.config ?? error.response.config, error.response.status, error.response);
            return Promise.reject(error);
        }
    );

    let seq = 0;
    let closed = false;

    return {
        kind: 'axios',
        async fetch(ctx: FetchContext): Promise<FetchOutcome> {
            const id = `rp-${++seq}`;
            const requestConfig = {
                ...(ctx.http ?? {}),
                headers: ctx.headers,
                signal: ctx.signal,
                timeout: ctx.timeoutMs,
                ...(ctx.proxy ? { proxy: ctx.proxy } : {}),
                __requestPackMetaId: id,
            } as AxiosRequestConfig;

            try {
                // getText 已处理 GBK / <meta charset>；createHttp 的重试只包住这一步
                const html = await http.getText(ctx.url, requestConfig);
                const meta = metas.get(id) ?? { status: 200, finalUrl: ctx.url };
                return { html, status: meta.status, finalUrl: meta.finalUrl || ctx.url };
            } finally {
                metas.delete(id);
            }
        },
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            ownHttpAgent?.destroy();
            ownHttpsAgent?.destroy();
            metas.clear();
        },
    };
}

/* ------------------------------------------------------------------ */
/* browser：懒启动 + 实例内复用，重试只包住 goto + content              */
/* ------------------------------------------------------------------ */

export function createBrowserTransport<S extends Schema>(cfg: FetcherConfig<S>): Transport {
    assertPlaywrightAvailable();

    let launch: Promise<any> | undefined;

    const ensureBrowser = (): Promise<any> => {
        if (!launch) {
            launch = (async () => {
                const playwright = await loadPlaywright();
                try {
                    return await playwright.chromium.launch({
                        headless: cfg.headless,
                        ...(cfg.proxy ? {
                            proxy: {
                                server: `${cfg.proxy.protocol ?? 'http'}://${cfg.proxy.host}:${cfg.proxy.port}`,
                                ...(cfg.proxy.auth ? {
                                    username: cfg.proxy.auth.username,
                                    password: cfg.proxy.auth.password,
                                } : {}),
                            },
                        } : {}),
                    });
                } catch (error) {
                    throw new FetcherError(`${PLAYWRIGHT_HINT}（或 Chromium 启动失败）`, {
                        code: 'BROWSER_FAILED', phase: 'browser', cause: error,
                    });
                }
            })().catch(error => { launch = undefined; throw error; });
        }
        return launch;
    };

    const fetchOnce = async (ctx: FetchContext): Promise<FetchOutcome> => {
        const browser = await ensureBrowser();
        const page = await browser.newPage(cfg.viewport ? { viewport: cfg.viewport } : {});
        const onAbort = () => { void page.close().catch(() => undefined); };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        try {
            if (Object.keys(ctx.headers).length > 0) await page.setExtraHTTPHeaders(ctx.headers);
            if (cfg.blockResources.length > 0) {
                const blocked = new Set(cfg.blockResources);
                await page.route('**/*', (route: any) =>
                    blocked.has(route.request().resourceType()) ? route.abort() : route.continue()
                );
            }
            const response = await page.goto(ctx.url, { waitUntil: cfg.waitUntil, timeout: ctx.timeoutMs });
            const html = await page.content();
            return { html, status: response?.status() ?? 0, finalUrl: page.url() };
        } finally {
            ctx.signal.removeEventListener('abort', onAbort);
            await page.close().catch(() => undefined);
        }
    };

    return {
        kind: 'browser',
        async fetch(ctx: FetchContext): Promise<FetchOutcome> {
            // 与 createHttp 的重试边界一致：只覆盖 fetch 步骤，不覆盖解析 / 校验
            for (let attempt = 0; ; attempt++) {
                try {
                    return await fetchOnce(ctx);
                } catch (error) {
                    if (ctx.signal.aborted || attempt >= cfg.retries) throw error;
                    const base = Math.min(500 * 2 ** attempt, 10_000);
                    await delay(Math.round(base * (0.5 + Math.random() * 0.5)));
                }
            }
        },
        async close(): Promise<void> {
            const pending = launch;
            launch = undefined;
            if (!pending) return;
            const browser = await pending.catch(() => undefined);
            if (browser) await browser.close().catch(() => undefined);
        },
    };
}
