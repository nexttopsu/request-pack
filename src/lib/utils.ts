import iconv from 'iconv-lite'

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

export function decode(buff: Buffer, encoding: string) {
    return iconv.decode(buff, encoding);
}

export {
    iconv
}
