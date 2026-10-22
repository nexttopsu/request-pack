import { load, type CheerioAPI } from 'cheerio';

/* ------------------------------------------------------------------ */
/* Schema 组合器                                                       */
/* ------------------------------------------------------------------ */

export interface TextField {
    type: 'text';
    /** 元素选择器，空字符串表示当前节点自身 */
    selector: string;
}
export interface HtmlField {
    type: 'html';
    selector: string;
}
export interface AttrField {
    type: 'attr';
    /** 属性名 */
    name: string;
    /** 可选的元素选择器，缺省时取当前节点自身的属性 */
    selector?: string;
}
export interface LoopField<S extends Schema = Schema> {
    type: 'loop';
    /** 列表元素选择器 */
    selector: string;
    /** 每个元素内部继续应用的 schema */
    schema: S;
}

export type Field = TextField | HtmlField | AttrField | LoopField;
export type Schema = Record<string, Field>;

/** 提取文本 */
export const text = (selector: string): TextField => ({ type: 'text', selector });
/** 提取 innerHTML */
export const html = (selector: string): HtmlField => ({ type: 'html', selector });
/** 提取属性 */
export const attr = (name: string, selector?: string): AttrField => ({ type: 'attr', name, selector });
/** 遍历列表，每个元素按子 schema 解析为对象 */
export const loop = <S extends Schema>(selector: string, schema: S): LoopField<S> =>
    ({ type: 'loop', selector, schema });

/* ------------------------------------------------------------------ */
/* 结果类型推导                                                         */
/* ------------------------------------------------------------------ */

type FieldResult<F extends Field> =
    F extends LoopField<infer S> ? ParsedResult<S>[] : string;

export type ParsedResult<S extends Schema> = {
    [K in keyof S]: FieldResult<S[K]>;
};

/* ------------------------------------------------------------------ */
/* 解析实现                                                             */
/* ------------------------------------------------------------------ */

function assertField(key: string, field: any): void {
    if (!field || typeof field !== 'object' || typeof field.type !== 'string') {
        throw new Error(`html2object: 字段 "${key}" 不是合法的 schema 字段（请使用 text/html/attr/loop 组合器构造）`);
    }
    switch (field.type) {
        case 'text':
        case 'html':
            if (typeof field.selector !== 'string') {
                throw new Error(`html2object: 字段 "${key}" 缺少 selector`);
            }
            break;
        case 'attr':
            if (typeof field.name !== 'string') {
                throw new Error(`html2object: 字段 "${key}" 缺少属性名 name`);
            }
            break;
        case 'loop':
            if (typeof field.selector !== 'string' || !field.schema || typeof field.schema !== 'object') {
                throw new Error(`html2object: 字段 "${key}" 缺少 selector 或子 schema`);
            }
            break;
        default:
            throw new Error(`html2object: 字段 "${key}" 的 type 未知: ${field.type}`);
    }
}

function applySchema<S extends Schema>($: CheerioAPI, root: any, schema: S): ParsedResult<S> {
    const result: Record<string, any> = {};

    for (const key of Object.keys(schema)) {
        const field = schema[key];
        assertField(key, field);

        switch (field.type) {
            case 'text': {
                const el = field.selector ? root.find(field.selector) : root;
                result[key] = (el.text() || '').trim();
                break;
            }
            case 'html': {
                const el = field.selector ? root.find(field.selector) : root;
                result[key] = (el.html() || '').trim();
                break;
            }
            case 'attr': {
                const el = field.selector ? root.find(field.selector) : root;
                result[key] = (el.attr(field.name) || '').trim();
                break;
            }
            case 'loop': {
                const list: any[] = [];
                root.find(field.selector).each((_: number, el: any) => {
                    list.push(applySchema($, $(el), field.schema));
                });
                result[key] = list;
                break;
            }
        }
    }

    return result as ParsedResult<S>;
}

/**
 * 将 HTML 按 schema 解析为结构化对象，结果类型可自动推导。
 *
 * @example
 * const schema = {
 *     title: text('title'),
 *     h1:    html('h1.todo'),
 *     list:  loop('#list li', {
 *         href: attr('data-href'),
 *         name: text('span'),
 *     }),
 * };
 * const data = html2object(html, schema);
 * // => { title: '标题', h1: '<span>Todo</span>', list: [{ href: '/1', name: '1' }, ...] }
 */
export function html2object<S extends Schema>(
    htmlStr: string,
    schema: S,
    removeSelector?: string[]
): ParsedResult<S> {
    const $ = load(htmlStr || '');

    if (Array.isArray(removeSelector) && removeSelector.length > 0) {
        $(removeSelector.join(', ')).remove();
    }

    return applySchema($, $.root(), schema);
}
