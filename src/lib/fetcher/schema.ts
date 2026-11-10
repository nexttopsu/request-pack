import { z } from 'zod';
import type { AxiosRequestConfig } from 'axios';
import { isFieldShape, type Field, type Schema } from '../parser';
import { FetcherError, asFetcherError } from './errors';
import { NOOP_LOGGER, type FetcherConfig, type FetcherOptions, type Logger, type RequestOverrides, type ResultParser } from './types';

/* ------------------------------------------------------------------ */
/* 通用校验片段                                                        */
/* ------------------------------------------------------------------ */

export const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** RFC 7230 token，header 名不允许分隔字符 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_DEPTH = 8;
const DEFAULTS = {
    retries: 0,
    timeoutMs: 20_000,
    headless: true,
    waitUntil: 'load' as const,
};

const fieldName = z.string().regex(FIELD_NAME_RE, '字段名必须匹配 /^[A-Za-z_][A-Za-z0-9_]{0,63}$/');
const selector = z.string().max(500, 'selector 长度不能超过 500（空串合法，表示当前节点自身）');
const headerName = z.string().regex(HEADER_NAME_RE, 'header 名不是合法的 RFC 7230 token');
const headerValue = z.string().refine(value => !/[\r\n]/.test(value), 'header 值不能包含 CR / LF');
const headersShape = z.record(headerName, headerValue);
const fnShape = z.custom<(...args: any[]) => any>(value => typeof value === 'function', '必须是函数');
const axiosConfigShape = z.custom<AxiosRequestConfig>(
    value => !!value && typeof value === 'object' && !Array.isArray(value),
    'http 必须是 axios 配置对象'
);

/** 与 src/lib/http.ts 的 ProxyConfig 形状一致（运行时无法复用 TS 接口，这里逐字段对齐） */
const proxyShape = z.object({
    protocol: z.enum(['http', 'https']).optional(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    auth: z.object({ username: z.string(), password: z.string() }).strict().optional(),
}).strict();

const loggerShape = z.object({
    info: fnShape.optional(),
    warn: fnShape.optional(),
    error: fnShape.optional(),
}).strict();

const parserFnShape = z.custom<ResultParser<any>>(value => typeof value === 'function', 'parser 必须是函数');
const parserShape = z.union([parserFnShape, z.array(parserFnShape)]);

/* ------------------------------------------------------------------ */
/* Field 树：判别联合 + z.lazy 递归                                     */
/* ------------------------------------------------------------------ */

const optionalBoolean = z.boolean().optional();
const optionalIndex = z.number().int().min(0).optional();
/** 输出约束：只挂在 Field 上，html2object 不消费，由 compiler 编译成 zod 校验 */
const constraints = {
    required: optionalBoolean,
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    pattern: z.union([z.instanceof(RegExp), z.string().min(1)], { error: 'pattern 必须是 RegExp 或非空字符串' }).optional(),
};
const queryOptions = { first: optionalBoolean, index: optionalIndex };
const jsonSchemaLike = z.custom(
    value => !!value && typeof value === 'object' && typeof (value as any).parse === 'function',
    'json() 的第二个参数必须是带 parse() 的 zod schema'
);

const textField = z.object({
    type: z.literal('text'), selector, nullable: optionalBoolean, ...queryOptions, ...constraints,
}).strict();
const htmlField = z.object({
    type: z.literal('html'), selector, nullable: optionalBoolean, ...queryOptions, ...constraints,
}).strict();
const attrField = z.object({
    type: z.literal('attr'), name: z.string().min(1, 'attr 必须有 name'),
    selector: selector.optional(), nullable: optionalBoolean, ...queryOptions, ...constraints,
}).strict();
const jsonField = z.object({
    type: z.literal('json'), selector, schema: jsonSchemaLike.optional(), nullable: optionalBoolean,
}).strict();

// loopField / objectField 是递归的 ZodLazy，TS 无法静态证明它们「可判别」；
// 运行时 zod 的 discriminatedUnion 能正确展开 lazy 选项（见 compiler 的同构判据），此处只需绕过类型证明。
const fieldSchema: z.ZodTypeAny = z.lazy(() =>
    z.discriminatedUnion('type', [textField, htmlField, attrField, jsonField, loopField, objectField] as any)
);
const schemaRecord: z.ZodTypeAny = z.lazy(() => z.record(fieldName, fieldSchema));
const loopField: z.ZodTypeAny = z.lazy(() => z.object({
    type: z.literal('loop'),
    selector,
    schema: z.union([fieldSchema, schemaRecord]),
    minItems: z.number().int().min(0).optional(),
    maxItems: z.number().int().min(0).optional(),
    nullable: optionalBoolean,
}).strict());
const objectField: z.ZodTypeAny = z.lazy(() => z.object({
    type: z.literal('object'),
    selector: selector.optional(),
    schema: schemaRecord,
    nullable: optionalBoolean,
}).strict());

/* ------------------------------------------------------------------ */
/* 顶层配置：按 type 判别联合 + strict（拒绝串台的 browser 专属键）     */
/* ------------------------------------------------------------------ */

const baseShape = {
    retries: z.number().int().min(0).max(10, 'retries 必须是 0–10 的整数').optional(),
    timeoutMs: z.number().int().min(100).max(300000, 'timeoutMs 必须在 100–300000 之间').optional(),
    proxy: proxyShape.optional(),
    headers: headersShape.optional(),
    http: axiosConfigShape.optional(),
    logging: z.union([z.boolean(), loggerShape]).optional(),
    schema: schemaRecord,
    parser: parserShape.optional(),
    removeSelector: z.array(selector).optional(),
};

const axiosOptions = z.object({
    ...baseShape,
    type: z.literal('axios'),
}).strict();

const browserOptions = z.object({
    ...baseShape,
    type: z.literal('browser'),
    headless: z.boolean().optional(),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
    blockResources: z.array(z.string()).optional(),
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
}).strict();

const optionsSchema = z.discriminatedUnion('type', [axiosOptions, browserOptions]);

const overridesSchema = z.object({
    headers: headersShape.optional(),
    signal: z.custom<AbortSignal>(
        value => !!value && typeof value === 'object' && typeof (value as any).addEventListener === 'function',
        'signal 必须是 AbortSignal'
    ).optional(),
    timeoutMs: z.number().int().min(100).max(300000).optional(),
    proxy: proxyShape.optional(),
    http: axiosConfigShape.optional(),
}).strict();

/* ------------------------------------------------------------------ */
/* 路径格式化                                                          */
/* ------------------------------------------------------------------ */

/** 通用路径：['list', 0, 'href'] → list[0].href */
export function formatPath(path: readonly PropertyKey[]): string {
    return path.reduce<string>((acc, segment) => {
        const key = typeof segment === 'symbol' ? segment.toString() : String(segment);
        const numeric = typeof segment === 'number' || /^\d+$/.test(key);
        if (numeric) return `${acc}[${key}]`;
        return acc ? `${acc}.${key}` : key;
    }, '');
}

/**
 * 把配置校验的原始 zod 路径翻译成解析器同款字段路径：
 * loop 的子 schema 用 [0] 表示首条，object 的子 schema 直接展开。
 * 例：['schema','tags','schema','href','selector'] → schema.tags[0].href.selector
 */
function translateSchemaPath(path: readonly PropertyKey[], schema: Schema): string {
    if (path[0] !== 'schema') return formatPath(path);
    let out = 'schema';
    let cursor: any = schema;

    for (let i = 1; i < path.length; i++) {
        const segment = path[i];
        const key = typeof segment === 'symbol' ? segment.toString() : String(segment);
        const numeric = typeof segment === 'number' || /^\d+$/.test(key);
        const append = () => { out += numeric ? `[${key}]` : `.${key}`; };

        if (!isFieldShape(cursor)) {
            append();
            cursor = cursor?.[key];
            continue;
        }
        const field = cursor as Field;
        if (key === 'schema' && (field.type === 'loop' || field.type === 'object')) {
            if (field.type === 'loop') out += '[0]';
            cursor = field.schema;
        } else {
            append();
        }
    }
    return out;
}

/** Field 树嵌套深度 ≤ 8；超出时错误信息带最深字段路径 */
function assertDepth(schema: Schema): void {
    const walkField = (field: Field, depth: number, path: string): void => {
        if (depth > MAX_DEPTH) {
            throw new FetcherError(`createFetcher 配置非法：${path} 的 Field 树嵌套深度超过 ${MAX_DEPTH}`, {
                code: 'INVALID_SCHEMA', phase: 'config', fieldPath: path,
            });
        }
        if (field.type === 'loop') {
            const child: any = field.schema;
            if (isFieldShape(child)) {
                walkField(child as Field, depth + 1, `${path}[0]`);
            } else {
                for (const key of Object.keys(child ?? {})) {
                    walkField(child[key], depth + 1, `${path}[0].${key}`);
                }
            }
        } else if (field.type === 'object') {
            for (const key of Object.keys(field.schema ?? {})) {
                walkField(field.schema[key], depth + 1, `${path}.${key}`);
            }
        }
    };

    for (const key of Object.keys(schema)) {
        walkField(schema[key], 1, `schema.${key}`);
    }
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

/** 创建时一次性校验 Options 与整棵 Field 树，失败一律抛 phase:'config' 的 FetcherError */
export function validateOptions<S extends Schema>(options: FetcherOptions<S>): FetcherConfig<S> {
    if (!options || typeof options !== 'object') {
        throw new FetcherError('createFetcher 配置非法：options 必须是对象', {
            code: 'INVALID_CONFIG', phase: 'config',
        });
    }
    const schema = (options as FetcherOptions<S>).schema as unknown as Schema;
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
        const issues = parsed.error.issues.map(issue => {
            const path = issue.path.length > 0 ? translateSchemaPath(issue.path, schema ?? {}) : '<root>';
            const keys = issue.code === 'unrecognized_keys' && 'keys' in issue
                ? `（未知键：${(issue.keys as string[]).join(', ')}）` : '';
            return `${path}: ${issue.message}${keys}`;
        });
        const firstPath = parsed.error.issues[0]?.path.length
            ? translateSchemaPath(parsed.error.issues[0].path, schema ?? {})
            : undefined;
        const isSchemaIssue = parsed.error.issues.some(issue => issue.path[0] === 'schema');
        throw new FetcherError(`createFetcher 配置非法：${issues.join('；')}`, {
            code: isSchemaIssue ? 'INVALID_SCHEMA' : 'INVALID_CONFIG',
            phase: 'config',
            fieldPath: firstPath,
        });
    }

    assertDepth(schema);

    const raw = parsed.data;
    const source = options as FetcherOptions<S>;
    const loggingValue = source.logging;
    const logger: Logger = loggingValue && typeof loggingValue === 'object' ? loggingValue : NOOP_LOGGER;
    const parserValue = source.parser as ResultParser<S> | readonly ResultParser<S>[] | undefined;
    const parser = parserValue === undefined
        ? []
        : Array.isArray(parserValue)
            ? [...parserValue]
            : [parserValue];
    const removeSelector = source.removeSelector?.length ? [...source.removeSelector] : undefined;
    const browserOnly = raw.type === 'browser' ? raw : undefined;

    return {
        type: raw.type,
        retries: raw.retries ?? DEFAULTS.retries,
        timeoutMs: raw.timeoutMs ?? DEFAULTS.timeoutMs,
        proxy: source.proxy,
        headers: { ...(source.headers ?? {}) },
        http: source.http,
        logging: loggingValue === true || (!!loggingValue && typeof loggingValue === 'object'),
        logger,
        schema: source.schema,
        parser,
        removeSelector,
        headless: browserOnly?.headless ?? DEFAULTS.headless,
        waitUntil: browserOnly?.waitUntil ?? DEFAULTS.waitUntil,
        blockResources: [...(browserOnly?.blockResources ?? [])],
        viewport: browserOnly?.viewport ? { ...browserOnly.viewport } : undefined,
    };
}

/** 请求级 overrides 校验；schema 在类型与运行时都被拒绝 */
export function validateOverrides(overrides: RequestOverrides | undefined): RequestOverrides {
    if (overrides === undefined) return {};
    if (!overrides || typeof overrides !== 'object' || 'schema' in overrides) {
        throw new FetcherError('请求级 overrides 不允许传 schema；请用 request.with({ schema }) 派生新实例', {
            code: 'INVALID_CONFIG', phase: 'config', fieldPath: 'schema',
        });
    }
    const parsed = overridesSchema.safeParse(overrides);
    if (!parsed.success) {
        const issues = parsed.error.issues.map(issue => `${formatPath(issue.path) || '<root>'}: ${issue.message}`);
        throw new FetcherError(`请求级 overrides 非法：${issues.join('；')}`, {
            code: 'INVALID_CONFIG', phase: 'config',
            fieldPath: formatPath(parsed.error.issues[0]?.path ?? []),
        });
    }
    return parsed.data as RequestOverrides;
}

export function validateUrl(url: string): void {
    if (typeof url !== 'string' || url.length === 0) {
        throw new FetcherError('url 必须是非空字符串', { code: 'INVALID_CONFIG', phase: 'config' });
    }
}

/** 兜底：任何未预料异常都不以裸 Error 面目逃出请求 */
export function toFetcherError(error: unknown): FetcherError {
    return asFetcherError(error, { code: 'UNEXPECTED', phase: 'fetch' });
}
