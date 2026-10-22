import iconv from 'iconv-lite';

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

export function decode(buff: Buffer, encoding: string): string {
    return iconv.decode(buff, encoding);
}

/** 把可能相对的链接解析为绝对地址；无法解析时原样返回 */
export function resolveUrl(href: string, base?: string): string {
    try {
        return base ? new URL(href, base).href : new URL(href).href;
    } catch {
        return href;
    }
}

/** 取文档里的 <base href>，没有则返回 undefined */
export function getBaseHref(html: string): string | undefined {
    const match = /<base\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html || '');
    return match?.[1];
}

/**
 * 计算文档的基准地址：优先 <base href>（相对页面地址解析），否则用页面地址本身。
 * 抓取页面后用它把相对链接转成绝对链接。
 */
export function getDocumentBase(html: string, pageUrl: string): string {
    const base = getBaseHref(html);
    return base ? resolveUrl(base, pageUrl) : pageUrl;
}

export { iconv };
