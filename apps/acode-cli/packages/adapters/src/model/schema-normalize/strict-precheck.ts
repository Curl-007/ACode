// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// OpenAI strict 管线 · 预检与类型推断原语
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R3。
// tryEnforceStrictSchema 在 sanitize 之前用本模块拒绝 strict 模式**无法表达**
// 的形状（开放 map、无约束布尔/空子 schema），而不是静默闭合它们。

import { COMBINATOR_KEYS } from "./fields.js";
import { epochNext, once } from "./stamps.js";
import { isJsonObject, isJsonObjectEmpty } from "./types.js";

/**
 * 单一原始 JSON Schema type 关键字。strict 模式把这些标量类型视为足够具体；
 * 聚合形状（object、array）不包含在内——它们无法从单个 enum/const 值推出。
 */
export type StrictPrimitiveType = "null" | "string" | "number" | "boolean";

export function primitiveJsonTypeOf(value: unknown): StrictPrimitiveType | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
}

export function jsonSchemaTypeAcceptsValue(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isJsonObject(value);
    default:
      return true;
  }
}

/** 把 enum 成员收窄到指定 type；收窄后为空返回 false（该 type 分支不可发）。 */
export function narrowEnumToType(schema: Record<string, unknown>, type: string): boolean {
  const enumValues = schema.enum;
  if (!Array.isArray(enumValues)) return true;

  const narrowed = enumValues.filter((value) => jsonSchemaTypeAcceptsValue(type, value));
  if (narrowed.length === 0) return false;
  if (narrowed.length !== enumValues.length) schema.enum = narrowed;
  return true;
}

/**
 * 返回完整描述本节点 enum（或 const）约束的原始 type 关键字；约束无法归约为
 * 单一原始类型时返回 undefined。
 *
 * strict 模式要求每个 schema 节点声明具体 type。作者写了 {enum:[...]} 或
 * {const:X} 而无 type 时可以推断——但仅当每个值都归约到同一原始类型。
 * 混合原始类型 enum（[1,"two",null]）、含非原始值的 enum（[{a:1}]）、
 * 非原始 const（{a:1}、[1,2,3]）都返回 undefined：这些形状无法用单个 type
 * 关键字描述，strict 模式表达不了，调用方必须回退（发无 type 的 schema
 * 只会在 wire 上被 OpenAI 拒绝）。
 */
export function inferStrictPrimitiveTypeFromEnumOrConst(
  node: Record<string, unknown>,
): StrictPrimitiveType | undefined {
  const values: unknown[] = Array.isArray(node.enum) ? node.enum : Object.hasOwn(node, "const") ? [node.const] : [];
  if (values.length === 0) return undefined;
  let inferred: StrictPrimitiveType | undefined;
  for (const value of values) {
    const t = primitiveJsonTypeOf(value);
    if (t === undefined) return undefined; // 非原始（object/array）——strict 表达不了
    if (inferred === undefined) inferred = t;
    else if (inferred !== t) return undefined; // 混合原始类型
  }
  return inferred;
}

/**
 * 布尔 schema（true/false）或空对象 schema {}：无声明 type 的无约束分支。
 * strict provider（OpenAI/Codex）拒绝它们，且 enforceStrictSchema 会把非对象
 * 分支当 strict:true 放行，因此它们无论坐在 combinator 还是 items/prefixItems
 * 位置都让整个 schema 丧失 strict 资格。
 */
export function isUnrepresentableStrictBranch(value: unknown): boolean {
  return typeof value === "boolean" || (isJsonObject(value) && isJsonObjectEmpty(value));
}

/**
 * 检测 strict 模式**无法表达**的 schema。
 *
 * strict 要求闭合对象形状——每个属性都声明在 properties 且列入 required。
 * 与之不兼容的有：
 *  - patternProperties（正则匹配的开放键集），
 *  - additionalProperties: true 或 schema（开放键集，可带进一步约束），
 *  - anyOf/oneOf/allOf/items/prefixItems 里的布尔 schema——strict provider
 *    拒绝无约束分支，而 enforceStrictSchema 会把非对象分支当 strict:true 放行
 *    （`T | undefined` → `anyOf: [<T>, {}]` → `[<T>, true]` 编码是惯犯）。
 *
 * 检查递归进子 schema 可能居住的每个位置（properties、items/prefixItems、
 * combinator 分支、$defs），树深处单个违例即让整个 schema 丧失资格。
 * 用于 tryEnforceStrictSchema 的提前 fail-open，而不是在 enforce 中途抛。
 */
export function hasUnrepresentableStrictObjectMap(schema: Record<string, unknown>, epoch: number = epochNext()): boolean {
  if (!once(schema, epoch)) return false;

  let hasPatternProperties = false;
  if (isJsonObject(schema.patternProperties)) {
    for (const _ in schema.patternProperties) {
      hasPatternProperties = true;
      break;
    }
  }
  const additionalPropertiesValue = schema.additionalProperties;
  const hasSchemaAdditionalProperties = additionalPropertiesValue === true || isJsonObject(additionalPropertiesValue);
  if (hasPatternProperties || hasSchemaAdditionalProperties) {
    return true;
  }

  if (isJsonObject(schema.properties)) {
    const properties = schema.properties;
    for (const k in properties) {
      const propertySchema = properties[k];
      if (isUnrepresentableStrictBranch(propertySchema)) return true;
      if (isJsonObject(propertySchema) && hasUnrepresentableStrictObjectMap(propertySchema, epoch)) {
        return true;
      }
    }
  }

  if (isUnrepresentableStrictBranch(schema.items)) {
    return true;
  }
  if (isJsonObject(schema.items)) {
    if (hasUnrepresentableStrictObjectMap(schema.items, epoch)) {
      return true;
    }
  } else if (Array.isArray(schema.items)) {
    for (const itemSchema of schema.items) {
      if (isUnrepresentableStrictBranch(itemSchema)) return true;
      if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
        return true;
      }
    }
  }
  if (Array.isArray(schema.prefixItems)) {
    for (const itemSchema of schema.prefixItems) {
      if (isUnrepresentableStrictBranch(itemSchema)) return true;
      if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
        return true;
      }
    }
  }

  for (const key of COMBINATOR_KEYS) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (isUnrepresentableStrictBranch(variant)) return true;
      if (isJsonObject(variant) && hasUnrepresentableStrictObjectMap(variant, epoch)) {
        return true;
      }
    }
  }

  for (const defsKey of ["$defs", "definitions"] as const) {
    const defs = schema[defsKey];
    if (!isJsonObject(defs)) continue;
    for (const k in defs) {
      const defSchema = defs[k];
      if (isUnrepresentableStrictBranch(defSchema)) return true;
      if (isJsonObject(defSchema) && hasUnrepresentableStrictObjectMap(defSchema, epoch)) {
        return true;
      }
    }
  }

  return false;
}
