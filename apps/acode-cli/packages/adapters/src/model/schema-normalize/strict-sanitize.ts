// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// OpenAI strict 管线 · sanitize pass
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R3；
// omp CONSTRAINTS #1.1-#1.2 与「Edge cases the strict-mode normalizer handles」。

import { COMBINATOR_KEYS, NON_STRUCTURAL_SCHEMA_KEYS } from "./fields.js";
import { areJsonValuesEqual } from "./equality.js";
import { epochNext, once } from "./stamps.js";
import { inferStrictPrimitiveTypeFromEnumOrConst, narrowEnumToType } from "./strict-precheck.js";
import { parseLocalRefPointer } from "./ref-pointer.js";
import { isJsonObject, type JsonObject } from "./types.js";

/**
 * strict 准备的第一 pass。把 strict 模式禁止的一切改写成它接受的形状：
 *  - 剥非结构关键字（format、pattern、examples…）、const、nullable、
 *    additionalProperties（由 enforceStrictSchema 以 false 重新加上）。
 *  - type:[a,b] → anyOf:[{type:a,…},{type:b,…}]，每个变体只复制它能用的
 *    关键字（properties 只留在 object 变体上）。
 *  - const → 单成员 enum。
 *  - description 携带 `(default: X)` 后缀，让模型在 default 关键字被剥后
 *    仍看到文档化的默认值。
 *  - nullable:true 把整个节点包进 anyOf:[T,{type:"null"}]。
 *
 * 递归进 properties、items、prefixItems、combinator 与 $defs。cache WeakMap
 * 对共享子图去重；epoch 是循环守卫。
 */
export function sanitizeSchemaForStrictMode(
  schema: Record<string, unknown>,
  epoch: number = epochNext(),
  cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
  root: Record<string, unknown> = schema,
): Record<string, unknown> {
  const cached = cache.get(schema);
  if (cached) return cached;
  if (!once(schema, epoch)) return {};

  // 前置 pass：带兄弟键的 $ref 通过内联解析结果解开。
  // OpenAI strict 禁止 {$ref, description, ...}；SDK 会解析并合并，
  // 兄弟键压过被引用 def。
  // 依据：openai-python/src/openai/lib/_pydantic.py:96-110（_ensure_strict_json_schema）
  if (typeof schema.$ref === "string") {
    let hasSibling = false;
    for (const k in schema) {
      if (k !== "$ref" && Object.hasOwn(schema, k)) {
        hasSibling = true;
        break;
      }
    }
    if (hasSibling) {
      const resolved = resolveStrictRef(root, schema.$ref);
      if (resolved !== undefined) {
        // schema 上的兄弟键覆盖解析出的 def 的键。
        const merged: Record<string, unknown> = { ...resolved };
        for (const k in schema) {
          if (k === "$ref" || !Object.hasOwn(schema, k)) continue;
          merged[k] = schema[k];
        }
        const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
        cache.set(schema, result);
        return result;
      }
    }
  }

  // 前置 pass：单元素 allOf 通过内联唯一条目折叠。
  // SDK 语义：json_schema.update(ensured(all_of[0]))——内联条目的键**压过**
  // 原兄弟键，然后 allOf 被丢弃。
  // 依据：openai-python/src/openai/lib/_pydantic.py:79-83
  {
    const allOf = schema.allOf;
    if (Array.isArray(allOf) && allOf.length === 1 && isJsonObject(allOf[0])) {
      const merged: Record<string, unknown> = { ...schema };
      delete merged.allOf;
      const sole = allOf[0] as Record<string, unknown>;
      for (const k in sole) {
        if (Object.hasOwn(sole, k)) merged[k] = sole[k];
      }
      const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
      cache.set(schema, result);
      return result;
    }
  }

  const typeValue = schema.type;
  if (Array.isArray(typeValue)) {
    const typeVariants = typeValue.filter((entry): entry is string => typeof entry === "string");
    const schemaWithoutType = { ...schema };
    delete schemaWithoutType.type;

    const sanitizedWithoutType = sanitizeSchemaForStrictMode(schemaWithoutType, epoch, cache, root);
    if (typeVariants.length === 0) {
      cache.set(schema, sanitizedWithoutType);
      return sanitizedWithoutType;
    }
    // 每个 type 建一个变体 schema。每个变体只保留与其类型相关的关键字——
    // object 专属键留在 object 变体上，array 专属键留在 array 变体上，以此类推。
    //
    // description 是属于整个 union 的元数据而非任何单一类型变体，提升到包装
    // 节点让两个分支共享而不重复。对齐 enforceStrictSchema 的可选属性包装与
    // OpenAI strict 惯用的「description 在 union 上」形状。
    const { description, ...variantBase } = sanitizedWithoutType;
    const variants: Record<string, unknown>[] = [];
    for (const variantType of typeVariants) {
      const variantSchema: Record<string, unknown> = { ...variantBase, type: variantType };
      if (variantType !== "object") {
        delete variantSchema.properties;
        delete variantSchema.required;
        delete variantSchema.additionalProperties;
      }
      if (variantType !== "array") {
        delete variantSchema.items;
      }
      if (!narrowEnumToType(variantSchema, variantType)) continue;
      variants.push(sanitizeSchemaForStrictMode(variantSchema, epoch, cache, root));
    }

    if (variants.length === 0) {
      cache.set(schema, sanitizedWithoutType);
      return sanitizedWithoutType;
    }

    if (variants.length === 1) {
      const sole = variants[0] as Record<string, unknown>;
      if (description !== undefined && !Object.hasOwn(sole, "description")) {
        sole.description = description;
      }
      cache.set(schema, sole);
      return sole;
    }

    const result: JsonObject = { anyOf: variants };
    if (description !== undefined) result.description = description;
    cache.set(schema, result);
    return result;
  }
  // 标量 type：走键循环，按 strict 规则改写或剥离。

  const sanitized: Record<string, unknown> = {};
  cache.set(schema, sanitized);
  for (const key in schema) {
    const value = schema[key];
    if (key in NON_STRUCTURAL_SCHEMA_KEYS || key === "type" || key === "const" || key === "nullable") {
      continue;
    }
    // properties 映射——递归进每个属性 schema。
    if (key === "properties" && isJsonObject(value)) {
      const properties: Record<string, unknown> = {};
      for (const propertyName in value) {
        const propertySchema = value[propertyName];
        properties[propertyName] = isJsonObject(propertySchema)
          ? sanitizeSchemaForStrictMode(propertySchema, epoch, cache, root)
          : propertySchema;
      }
      sanitized.properties = properties;
      continue;
    }
    // items 可以是 schema、tuple 数组或标量布尔——按情形递归。
    if (key === "items") {
      if (isJsonObject(value)) {
        sanitized.items = sanitizeSchemaForStrictMode(value, epoch, cache, root);
      } else if (Array.isArray(value)) {
        sanitized.items = value.map((entry) =>
          isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
        );
      } else {
        sanitized.items = value;
      }
      continue;
    }
    // prefixItems 永远是 schema 数组（draft 2020-12）。
    if (key === "prefixItems" && Array.isArray(value)) {
      sanitized.prefixItems = value.map((entry) =>
        isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
      );
      continue;
    }
    // anyOf/oneOf/allOf 数组——递归进每个分支。
    if (COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]) && Array.isArray(value)) {
      sanitized[key] = value.map((entry) =>
        isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
      );
      continue;
    }
    // 定义映射——递归进每个命名 schema。
    if ((key === "$defs" || key === "definitions") && isJsonObject(value)) {
      const defs: Record<string, unknown> = {};
      for (const definitionName in value) {
        const definitionSchema = value[definitionName];
        defs[definitionName] = isJsonObject(definitionSchema)
          ? sanitizeSchemaForStrictMode(definitionSchema, epoch, cache, root)
          : definitionSchema;
      }
      sanitized[key] = defs;
      continue;
    }
    // additionalProperties 归 enforceStrictSchema 所有（置 false）。
    if (key === "additionalProperties") {
      continue;
    }

    if (key === "description" && typeof value === "string" && schema.default !== undefined) {
      // 为剥掉 default 关键字的 strict provider 保留默认值信息：
      // 以 (default: X) 文本内联进 description（与运行时占位默认值的约定一致）。
      const defaultVal = schema.default;
      const formatted = typeof defaultVal === "string" ? defaultVal : JSON.stringify(defaultVal);
      sanitized.description = value.includes("(default:") ? value : `${value} (default: ${formatted})`;
      continue;
    }

    sanitized[key] = value;
  }
  // 后置 pass：重新推导 type，把被剥关键字转成可表达形状。

  if (Object.hasOwn(schema, "const")) {
    const constVal = schema.const;
    const existingEnum = Array.isArray(sanitized.enum) ? sanitized.enum : [];
    if (!existingEnum.some((v) => areJsonValuesEqual(v, constVal))) {
      existingEnum.push(constVal);
    }
    sanitized.enum = existingEnum;
  }

  // 剥离-重建循环后保留原标量 type。
  if (typeof typeValue === "string") {
    sanitized.type = typeValue;
  }

  if (sanitized.type === undefined && isJsonObject(sanitized.properties)) {
    sanitized.type = "object";
  }

  if (sanitized.type === undefined && (sanitized.items !== undefined || sanitized.prefixItems !== undefined)) {
    sanitized.type = "array";
  }

  // 最后手段推断：裸 enum/const 且原始类型同质时补 type。
  if (sanitized.type === undefined) {
    const inferred = inferStrictPrimitiveTypeFromEnumOrConst(sanitized);
    if (inferred !== undefined) sanitized.type = inferred;
  }

  // nullable:true 在上面被剥——以 anyOf 包装重新引入。
  // description 提升到包装节点让两个分支共享而不重复——对齐
  // enforceStrictSchema 的可选属性包装与 strict「description 在 union 上」形状。
  if (schema.nullable === true) {
    const { nullable: _nullable, description, ...withoutNullable } = sanitized;
    const wrapper: JsonObject = { anyOf: [withoutNullable, { type: "null" }] };
    if (description !== undefined) wrapper.description = description;
    return wrapper;
  }

  return sanitized;
}

/**
 * 把 URI-fragment JSON Pointer 对根 schema 解析。每个段都必须解引用到字典，
 * 与 OpenAI SDK 的 resolve_ref helper 一致。
 */
export function resolveStrictRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  const pointer = parseLocalRefPointer(ref);
  if (pointer === undefined || pointer.length === 0) return undefined;
  let cursor: unknown = root;
  for (const segment of pointer) {
    if (!isJsonObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return isJsonObject(cursor) ? cursor : undefined;
}
