import { load } from 'cheerio';

export interface Html2ObjectParser {
    target: string;
    type: string;
    attr?: string;
    list?: Html2ObjectParser[];
}

export interface HtmlObjectParsers {
    [key: string]: any;
}

function strIntoObjects(parser: string): Html2ObjectParser | null {
    const match = parser.match(/\/\w+\(/)
    if (!match) {
        throw new Error('parser error')
    }
    const type = match[0] as (keyof typeof methods);
    const fns = parser.split(type);

    const target = fns[0];
    let fn2 = fns[1];

    fn2 = fn2.slice(0, -1);

    const methods = {
        '/text(': () => ({ target, type: 'text' }),
        '/html(': () => ({ target, type: 'html' }),
        '/attr(': () => ({ target, type: 'attr', attr: fn2 }),
        '/loop(': () => ({ target, type: 'loop', list: fn2.split(',').map(item => strIntoObjects((item).trim())) }),
    }

    return methods[type] ? methods[type]() : null;
}

function strAllIntoObjects(parser: HtmlObjectParsers): HtmlObjectParsers {
    const result:any = {};
    Object.keys(parser).forEach(key => {
        if (parser[key]) {
            try {
                result[key] = strIntoObjects(parser[key]);
            } catch (e) {
                console.error(`parser error: ${key}`);
            }
        }
    });

    return result;
}

function formatText(parent:any, parser: Html2ObjectParser): string {
    const target = parser.target
    const self = !target ? parent : parent.find(target);

    switch (parser.type) {
        case 'text':
            return (self.text() || '').trim();
        case 'html':
            return (self.html() || '').trim();
        case 'attr':
            return (self.attr(parser.attr) || '').trim();
        default:
            return '';
    }
}

export function html2object(html: string, parser: HtmlObjectParsers, removeSelector?: string[]): HtmlObjectParsers {
    if (typeof parser !== 'object')
    {
        throw Error('argument parser It\'s an object');
    }

    const $ = load(html || '');
    const parser_match = strAllIntoObjects(parser);
    const result: HtmlObjectParsers = {};

    if (Array.isArray(removeSelector) && removeSelector.length > 0) {
        $(removeSelector.join(', ')).remove();
    }

    Object.keys(parser_match).forEach(key => {
        const item = parser_match[key];
        if (item) {
            if (item.type == 'loop') {
                const list: any[] = [];
                $(item.target).each((_, item2) => {
                    list.push(item.list?.map((self: any) => formatText($(item2), self)));
                });
                result[key] = list;
            } else {
                result[key] = formatText($('html'), item);
            }
        }
    });

    return result;
}
