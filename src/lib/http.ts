import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

export interface ProxyConfig {
    /** 代理协议，默认 http */
    protocol?: 'http' | 'https';
    host: string;
    port: number;
    auth?: { username: string; password: string };
}

export interface HttpOptions extends AxiosRequestConfig {
    /** 代理配置。不传则直连，绝不偷偷挂代理 */
    proxy?: ProxyConfig;
}

export interface Http {
    /** 底层 axios 实例，需要更细粒度控制时使用 */
    readonly instance: AxiosInstance;
    get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>;
    post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T>;
    /** 以 Buffer 拉取二进制内容（图片、文件等） */
    getBuffer(url: string, config?: AxiosRequestConfig): Promise<Buffer>;
}

/**
 * 创建 HTTP 客户端。所有配置显式传入，无任何隐藏默认值。
 * 依赖官方 axios（>= 1.16.1 起原生支持 HTTPS 代理的 CONNECT 隧道）。
 *
 * @example
 * const http = createHttp({ proxy: { host: '127.0.0.1', port: 1080 } });
 * const data = await http.get('https://example.com');
 * const buf  = await http.getBuffer('https://example.com/a.png');
 */
export function createHttp(options: HttpOptions = {}): Http {
    const { proxy, ...axiosConfig } = options;
    const instance = axios.create({
        timeout: 30 * 1000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        ...axiosConfig,
        ...(proxy === undefined ? {} : { proxy }),
    });

    return {
        instance,
        get: <T = any>(url: string, config: AxiosRequestConfig = {}) =>
            instance.get<T>(url, config).then(res => res.data as T),
        post: <T = any>(url: string, data?: any, config: AxiosRequestConfig = {}) =>
            instance.post<T>(url, data, config).then(res => res.data as T),
        getBuffer: (url: string, config: AxiosRequestConfig = {}) =>
            instance
                .get<Buffer>(url, { ...config, responseType: 'arraybuffer' })
                .then(res => res.data as Buffer),
    };
}
