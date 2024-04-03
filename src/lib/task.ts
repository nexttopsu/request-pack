import axios, { type AxiosRequestConfig } from 'axios-https-proxy-fix'
import { html2object as hto, type HtmlObjectParsers } from './html2object'
import iconv from 'iconv-lite'


export default class Task {
    static defaults = {
        request: axios.create({
            baseURL: '',
            timeout: 30 * 1000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        }),
        proxy: {
            host: '127.0.0.1',
            port: 1080
        }
    };

    result: any = null;
    tasks: any[] = [];
    param: any;

    constructor(param?: any) {
        this.param = param;
    }

    first(fn: any) {
        this.tasks.unshift(this._task(fn));
        return this;
    }

    add(fn: any) {
        this.tasks.push(this._task(fn));
        return this;
    }

    parse(parser: HtmlObjectParsers, removeSelector?: string[]) {
        this.tasks.push((_: any, html: any) => {
            if( typeof html === 'string' ) {
                return hto( html, parser, removeSelector)
            }
            else {
                return html;
            }
        });
        return this;
    }

    delay(ms: number) {
        this.tasks.push(() => new Promise(resolve => setTimeout(resolve, ms)));
        return this;
    }

    fetch(url: string, option:RequestInit={}, isBuffer=false) {
        this.tasks.push(async () => {
            const res = await fetch(url, {...option });
            const response = isBuffer ? await res.arrayBuffer() : await res.text();
            return response;
        });
        return this
    }

    request(url: string, option:AxiosRequestConfig={}) {
        this.tasks.push(async () => {
            let res = await Task.defaults.request.get(url, {...option });
            return res.data;
        });
        return this;
    }

    requestProxy(url: string, option:AxiosRequestConfig={}) {
        return this.request(url, { proxy: Task.defaults.proxy, ...option });
    }

    requestBuffer(url: string, option:AxiosRequestConfig={}) {
        return this.request(url, { responseType:'arraybuffer', ...option });
    }

    requestBufferProxy(url: string, option:AxiosRequestConfig={}) {
        return this.requestProxy(url, { responseType:'arraybuffer', ...option });
    }

    decode(code: 'UTF-8' | 'GBK' | 'GB2312' | 'BIG5' | 'EUC-JP' | 'EUC-KR' | 'ISO-8859-1') {
        this.tasks.push((_: any, buff: any) => {
            if( Buffer.isBuffer(buff) && code ) {
                return iconv.decode(buff, code);
            };
        })

        return this;
    }

    _task(fn: any) {
        return async (...args: any) => {
            if( typeof fn !== 'function' ) {
                return fn;
            }
            return await fn.call(this, ...args);
        }
    }

    async run() {
        let tasks = this.tasks;
        for(let i=0; i<tasks.length; i++) {
            let task = tasks[i];
            if( typeof task === 'function' ) {
                let res = await task(this.param, this.result);
                if( res )
                {
                    this.result = res;
                }
            }
        }

        return {
            param: this.param,
            result: this.result
        }
    }
}
