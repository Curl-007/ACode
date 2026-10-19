// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/meta-validator.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 手写 JSON Schema 结构元校验器
// ============================================================
// 用小型结构校验器替代请求热路径上的 AJV 元 schema 检查，只覆盖本仓发射/转发
// 的 JSON Schema 子集。未知关键字为前向兼容放行；已知关键字逐一检查，让畸形的
// provider 载荷走回退而不是被发出。CCA 方言的 validateAndFallback 门消费本模块。
// 解耦：omp 的 isRecord（pi-utils）→ 本地 isJsonObject；无日志依赖（纯谓词）。

import { areJsonValuesEqual } from "./equality.js";
import { epochNext, once } from "./stamps.js";
import { isJsonObject } from "./types.js";

type Json = unknown;

const TYPE_NAMES: Record<string, true> = {
  string: true,
  number: true,
  integer: true,
  boolean: true,
  object: true,
  array: true,
  null: true,
};

function isNonNegativeInteger(value: Json): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasUniqueJsonValues(values: readonly unknown[]): boolean {
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      if (areJsonValuesEqual(values[i], values[j])) return false;
    }
  }
  return true;
}

function checkTypeKeyword(value: Json): boolean {
  if (typeof value === "string") return value in TYPE_NAMES;
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !(entry in TYPE_NAMES) || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function checkSchemaArray(value: Json, epoch: number): boolean {
  return Array.isArray(value) && value.every((entry) => checkNode(entry, epoch));
}

function checkSchemaMap(value: Json, epoch: number): boolean {
  if (!isJsonObject(value)) return false;
  for (const k in value) {
    if (!checkNode(value[k], epoch)) return false;
  }
  return true;
}

/** 校验单个子 schema 节点。 */
function checkNode(node: Json, epoch: number): boolean {
  // 布尔 schema（true/false）是合法 JSON Schema。
  if (node === true || node === false) return true;
  if (!isJsonObject(node)) return false;
  if (!once(node, epoch)) return true;

  if ("type" in node && !checkTypeKeyword(node.type)) return false;

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (key in node && !checkSchemaArray(node[key], epoch)) return false;
  }
  if ("not" in node && !checkNode(node.not, epoch)) return false;
  for (const key of ["if", "then", "else"] as const) {
    if (key in node && !checkNode(node[key], epoch)) return false;
  }

  for (const key of ["properties", "patternProperties", "$defs", "definitions"] as const) {
    if (key in node && !checkSchemaMap(node[key], epoch)) return false;
  }

  if ("propertyNames" in node && !checkNode(node.propertyNames, epoch)) return false;
  if ("contains" in node && !checkNode(node.contains, epoch)) return false;

  if ("required" in node) {
    const value = node.required;
    if (!Array.isArray(value)) return false;
    const seenRequired = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string" || seenRequired.has(entry)) return false;
      seenRequired.add(entry);
    }
  }

  if ("items" in node) {
    const items = node.items;
    if (Array.isArray(items)) return false;
    if (!checkNode(items, epoch)) return false;
  }
  if ("prefixItems" in node && !checkSchemaArray(node.prefixItems, epoch)) return false;
  // 废弃的 tuple/dependency 关键字在我们发射/转发的 2020-12 形状里不合法。
  if ("additionalItems" in node || "dependencies" in node) return false;

  for (const key of ["additionalProperties", "unevaluatedProperties", "unevaluatedItems"] as const) {
    if (!(key in node)) continue;
    const value = node[key];
    if (typeof value !== "boolean" && !checkNode(value, epoch)) return false;
  }

  if ("dependentSchemas" in node && !checkSchemaMap(node.dependentSchemas, epoch)) return false;
  if ("dependentRequired" in node) {
    const value = node.dependentRequired;
    if (!isJsonObject(value)) return false;
    for (const k in value) {
      const entry = value[k];
      if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) return false;
    }
  }

  if ("enum" in node) {
    if (!Array.isArray(node.enum) || node.enum.length === 0 || !hasUniqueJsonValues(node.enum)) return false;
  }

  for (const key of ["minimum", "maximum", "multipleOf"] as const) {
    if (key in node && typeof node[key] !== "number") return false;
  }
  if (node.multipleOf !== undefined && typeof node.multipleOf === "number" && node.multipleOf <= 0) return false;
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (key in node && typeof node[key] !== "number" && typeof node[key] !== "boolean") return false;
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"] as const) {
    if (key in node && !isNonNegativeInteger(node[key])) return false;
  }
  for (const key of ["minContains", "maxContains"] as const) {
    if (key in node && !isNonNegativeInteger(node[key])) return false;
  }
  if ("uniqueItems" in node && typeof node.uniqueItems !== "boolean") return false;
  if ("pattern" in node) {
    if (typeof node.pattern !== "string") return false;
    try {
      new RegExp(node.pattern);
    } catch {
      return false;
    }
  }
  if ("format" in node && typeof node.format !== "string") return false;
  if ("nullable" in node && typeof node.nullable !== "boolean") return false;
  if ("readOnly" in node && typeof node.readOnly !== "boolean") return false;
  if ("writeOnly" in node && typeof node.writeOnly !== "boolean") return false;
  if ("deprecated" in node && typeof node.deprecated !== "boolean") return false;

  return true;
}

/** schema 在结构上是否为（子集意义上的）合法 JSON Schema。 */
export function isValidJsonSchema(schema: unknown): boolean {
  try {
    return checkNode(schema, epochNext());
  } catch {
    return false;
  }
}
