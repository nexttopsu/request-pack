import { load, type CheerioAPI } from 'cheerio';

/* ------------------------------------------------------------------ */
/* Schema 组合器                                                       */
/* ------------------------------------------------------------------ */

export interface QueryOptions {
    /** 只取第一个匹配元素 */
    first?: boolean;
    /** 取第 N 个匹配元素（从 0 开始） */
    index?: number;
}

export interface TextField extends QueryOptions {
    type: 'text';
    /** 元素选择器，空字符串表示当前节点自身 */
    selector: string;
    /** 未匹配时返回 null 而不是空字符串（用 nullable() 包一层） */
    nullable?: boolean;
}
export interface HtmlField extends QueryOptions {
    type: 'html';
    selector: string;
    nullable?: boolean;
}
export interface AttrField {
    type: 'attr';
    /** 属性名 */
    name: string;
    /** 可选的元素选择器，缺省时取当前节点自身的属性 */
    selector?: string;
    /** 取第 N 个匹配元素（从 0 开始） */
    index?: number;
    nullable?: boolean;
}
export interface JsonField {
    type: 'json';
    /** 选择器，通常指向 <script type="application/ld+json"> */
    selector: string;
}
export interface LoopField<S extends Schema | Field = Schema> {
    type: 'loop';
    /** 列表元素选择器 */
    selector: string;
    /** 单条模版：对象 schema → 对象数组；单个字段 → 标量数组 */
    schema: S;
}
export interface ObjectField<S extends Schema = Schema> {
    type: 'object';
    /** 作用域选择器，缺省时在当前节点内查找 */
    selector?: string;
    schema: S;
}

export type Field = TextField | HtmlField | AttrField | JsonField | LoopField<Schema | Field> | ObjectField;
export type Schema = Record<string, Field>;

/** 提取文本 */
export const text = (selector: string, options: QueryOptions = {}): TextField =>
    ({ type: 'text', selector, ...options });
/** 提取 innerHTML */
export const html = (selector: string, options: QueryOptions = {}): HtmlField =>
    ({ type: 'html', selector, ...options });
/** 提取属性 */
export const attr = (name: string, selector?: string, options: QueryOptions = {}): AttrField =>
    ({ type: 'attr', name, selector, ...options });
/** 把元素文本当 JSON 解析（如 <script type="application/ld+json">） */
export const json = (selector: string): JsonField => ({ type: 'json', selector });
/** 遍历列表，每个元素按子 schema 解析为对象；schema 传单个字段时解析为标量数组 */
export const loop = <S extends Schema | Field>(selector: string, schema: S): LoopField<S> =>
    ({ type: 'loop', selector, schema });

/** 在某个子树内解析，产出嵌套对象 */
export function object<S extends Schema>(schema: S): ObjectField<S>;
export function object<S extends Schema>(selector: string, schema: S): ObjectField<S>;
export function object(a: any, b?: any): ObjectField {
    return typeof a === 'string'
        ? ({ type: 'object', selector: a, schema: b } as ObjectField)
        : ({ type: 'object', schema: a } as ObjectField);
}

/** 让字段在未匹配时返回 null（类型同步变为 string | null） */
export const nullable = <F extends Field>(field: F): F & { nullable: true } =>
    ({ ...field, nullable: true }) as F & { nullable: true };

/* ------------------------------------------------------------------ */
/* 结果类型推导                                                         */
/* ------------------------------------------------------------------ */

type Nullable<F> = F extends { nullable: true } ? string | null : string;

type FieldResult<F> =
    F extends LoopField<infer S>
        ? Array<S extends Schema ? ParsedResult<S> : Nullable<S>>
        : F extends ObjectField<infer S>
            ? ParsedResult<S>
            : F extends JsonField
                ? any
                : Nullable<F>;

export type ParsedResult<S extends Schema> = {
    [K in keyof S]: FieldResult<S[K]>;
};

/* ------------------------------------------------------------------ */
/* 解析实现                                                             */
/* ------------------------------------------------------------------ */

const FIELD_TYPES = new Set(['text', 'html', 'attr', 'json', 'loop', 'object']);

const isFieldShape = (value: any): boolean =>
    !!value && typeof value === 'object' && FIELD_TYPES.has(value.type);

function validateField(path: string, field: any): Field {
    if (!field || typeof field !== 'object' || typeof field.type !== 'string') {
        throw new Error(`html2object: 字段 "${path}" 不是合法的 schema 字段（请使用 text/html/attr/json/loop/object 组合器构造）`);
    }
    switch (field.type) {
        case 'text':
        case 'html':
        case 'json':
            if (typeof field.selector !== 'string') {
                throw new Error(`html2object: 字段 "${path}" 缺少 selector（元素选择器）`);
            }
            break;
        case 'attr':
            if (typeof field.name !== 'string') {
                throw new Error(`html2object: 字段 "${path}" 缺少属性名 name`);
            }
            break;
        case 'loop':
            if (typeof field.selector !== 'string' || !field.schema || typeof field.schema !== 'object') {
                throw new Error(`html2object: 字段 "${path}" 缺少 selector 或子 schema`);
            }
            break;
        case 'object':
            if (!field.schema || typeof field.schema !== 'object') {
                throw new Error(`html2object: 字段 "${path}" 缺少子 schema`);
            }
            break;
        default:
            throw new Error(`html2object: 字段 "${path}" 的 type 未知: ${field.type}`);
    }
    return field as Field;
}

function select(root: any, selector: string | undefined, options: QueryOptions): any {
    if (!selector) return root;
    const found = root.find(selector);
    if (options.first) return found.first();
    if (typeof options.index === 'number') return found.eq(options.index);
    return found;
}

function extract($: CheerioAPI, root: any, field: Field, path: string): any {
    switch (field.type) {
        case 'text': {
            const el = select(root, field.selector, field);
            const value = (el.text() || '').trim();
            if (field.nullable && field.selector && el.length === 0) return null;
            return value;
        }
        case 'html': {
            const el = select(root, field.selector, field);
            const value = (el.html() || '').trim();
            if (field.nullable && field.selector && el.length === 0) return null;
            return value;
        }
        case 'attr': {
            const el = select(root, field.selector, { index: field.index });
            const value = el.attr(field.name);
            if (value === undefined) return field.nullable ? null : '';
            return value.trim();
        }
        case 'json': {
            const el = select(root, field.selector, {});
            const raw = (el.text() || '').trim();
            if (!raw) return null;
            try {
                return JSON.parse(raw);
            } catch (err) {
                throw new Error(`html2object: 字段 "${path}" 的内容不是合法 JSON：${(err as Error).message}`);
            }
        }
        case 'object': {
            const scope = select(root, field.selector, {});
            return applySchema($, scope, field.schema, path);
        }
        case 'loop': {
            const list: any[] = [];
            const itemSchema: any = field.schema;
            const scalar = isFieldShape(itemSchema);
            select(root, field.selector, {}).each((i: number, el: any) => {
                const node = $(el);
                const itemPath = `${path}[${i}]`;
                list.push(
                    scalar
                        ? extract($, node, itemSchema as Field, itemPath)
                        : applySchema($, node, itemSchema as Schema, itemPath)
                );
            });
            return list;
        }
        default:
            throw new Error(`html2object: 字段 "${path}" 的 type 未知: ${(field as any).type}`);
    }
}

function applySchema<S extends Schema>($: CheerioAPI, root: any, schema: S, path: string): ParsedResult<S> {
    const result: Record<string, any> = {};
    for (const key of Object.keys(schema)) {
        const fieldPath = path ? `${path}.${key}` : key;
        const field = validateField(fieldPath, schema[key]);
        result[key] = extract($, root, field, fieldPath);
    }
    return result as ParsedResult<S>;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 将 HTML 按 schema 解析为结构化对象，结果类型可自动推导。
 *
 * @example
 * const schema = {
 *     title: text('title'),
 *     h1:    html('h1.todo'),
 *     price: nullable(text('.price')),                       // 未匹配 → null
 *     first: text('li', { first: true }),                    // 只取第一个
 *     card:  object('.card', { name: text('h2') }),          // 子树内取多个字段
 *     ld:    json('script[type="application/ld+json"]'),     // JSON-LD
 *     list:  loop('#list li', {
 *         href: attr('data-href'),
 *         name: text('span'),
 *     }),
 * };
 * const data = html2object(html, schema);
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

    return applySchema($, $.root(), schema, '');
}
