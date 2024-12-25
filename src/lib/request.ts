import axios, { type AxiosRequestConfig } from 'axios-https-proxy-fix';

export const request_inst = axios.create({
    baseURL: '',
    timeout: 30 * 1000,
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    proxy: {
        host: "127.0.0.1",
        port: 1080
    }
});

export const request = (
    url: string,
    opts: AxiosRequestConfig = {},
    proxy = false
) => request_inst.get(url, proxy ? opts : { proxy: false, ...opts });

export const request_buffer = (
    url: string,
    opts: AxiosRequestConfig = {},
    proxy = false
) => request_inst.get(url, proxy ? { ...opts, responseType: 'arraybuffer' } : { proxy: false, ...opts, responseType: 'arraybuffer' });
