import { z } from 'zod';
import { isFieldShape, type Field, type FieldConstraints, type LoopOptions, type ParsedResult, type Schema } from '../parser';

/**
 * 把组合器 schema 编译成输出校验用的 zod schema。
 *
 * 映射严格对齐 html2object 的运行时行为（src/lib/parser.ts）：
 * - text/html/attr → string（约束 → min/max/regex；最后才 nullable）
 * - json → unknown（可选覆盖为传入的 zod schema）
 * - loop + Schema 对象 → array(object(...))；loop + 单个 Field → array(compileField(...))
 * - object → object(...)
 *
 * 编译结果由 createFetcher 缓存进闭包，一次编译、两处使用：
 * 解析后校验 + parser 加工函数跑完后的复验。
 */
export function compileFieldTree<S extends Schema>(schema: S): z.ZodType<ParsedResult<S>> {
    return z.object(compileSchema(schema)) as unknown as z.ZodType<ParsedResult<S>>;
}

export function compileSchema(schema: Schema): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const key of Object.keys(schema)) {
        shape[key] = compileField(schema[key]);
    }
    return shape;
}

export function compileField(field: Field): z.ZodTypeAny {
    switch (field.type) {
        case 'text':
        case 'html':
        case 'attr': {
            const options = field as unknown as FieldConstraints;
            let node: z.ZodString = z.string();
            if (options.required) node = node.min(1);
            if (typeof options.min === 'number') node = node.min(options.min);
            if (typeof options.max === 'number') node = node.max(options.max);
            if (options.pattern !== undefined) {
                node = node.regex(typeof options.pattern === 'string' ? new RegExp(options.pattern) : options.pattern);
            }
            // nullable 必须最后加：Nullable<F> 只在 text/html/attr 三个分支生效
            return (field as unknown as { nullable?: boolean }).nullable === true ? node.nullable() : node;
        }
        case 'json': {
            // 运行时可能是 null / 数字 / 对象，静态类型是 any，统一按 unknown 处理
            const custom = (field as { schema?: z.ZodTypeAny }).schema;
            return custom ?? z.unknown();
        }
        case 'loop': {
            const options = field as LoopOptions;
            const child: any = field.schema;
            // 与 isFieldShape() 完全同构：对象且 type 在 FIELD_TYPES 里才算单个 Field
            const item = isFieldShape(child)
                ? compileField(child as Field)
                : z.object(compileSchema(child as Schema));
            let node = z.array(item);
            if (typeof options.minItems === 'number') node = node.min(options.minItems);
            if (typeof options.maxItems === 'number') node = node.max(options.maxItems);
            return node;
        }
        case 'object':
            return z.object(compileSchema(field.schema as Schema));
        default: {
            // 创建时已由 zod 判别联合拦下，这里只做保守兜底
            const unknown = field as unknown as { type: string };
            throw new Error(`无法编译未知字段类型: ${unknown.type}`);
        }
    }
}
