// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/equality.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// JSON 深比较与 schema 合并原语
// ============================================================
// combiner 折叠（combiner-collapse.ts）与 CCA 混合类型合并的公共基础。

import { isJsonObject, type JsonObject } from "./types.js";

export function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!areJsonValuesEqual(left[i], right[i])) {
        return false;
      }
    }
    return true;
  }
  if (!isJsonObject(left) || !isJsonObject(right)) {
    return false;
  }
  let rightLen = 0;
  for (const _ in right) rightLen += 1;
  let leftLen = 0;
  for (const key in left) {
    leftLen += 1;
    if (!(key in right) || !areJsonValuesEqual(left[key], right[key])) return false;
  }
  return leftLen === rightLen;
}

/**
 * 合并两个「除 enum 成员外逐字段一致」的 enum schema：成员取并集（深比较去重）。
 * type 或任何非 enum 字段不一致 → 返回 null（调用方回退到不合并）。
 */
export function mergeCompatibleEnumSchemas(existing: unknown, incoming: unknown): JsonObject | null {
  if (!isJsonObject(existing) || !isJsonObject(incoming)) {
    return null;
  }
  const existingEnum = Array.isArray(existing.enum) ? existing.enum : null;
  const incomingEnum = Array.isArray(incoming.enum) ? incoming.enum : null;
  if (!existingEnum || !incomingEnum) {
    return null;
  }
  if (!areJsonValuesEqual(existing.type, incoming.type)) {
    return null;
  }
  let existingNonEnumCount = 0;
  for (const key in existing) {
    if (key !== "enum") existingNonEnumCount += 1;
  }
  let incomingNonEnumCount = 0;
  for (const key in incoming) {
    if (key !== "enum") incomingNonEnumCount += 1;
  }
  if (existingNonEnumCount !== incomingNonEnumCount) {
    return null;
  }
  for (const key in existing) {
    if (key === "enum") continue;
    if (!(key in incoming) || !areJsonValuesEqual(existing[key], incoming[key])) {
      return null;
    }
  }

  const mergedEnum = [...existingEnum];
  for (const enumValue of incomingEnum) {
    if (!mergedEnum.some((existingValue) => areJsonValuesEqual(existingValue, enumValue))) {
      mergedEnum.push(enumValue);
    }
  }
  return {
    ...existing,
    enum: mergedEnum,
  };
}

function getAnyOfVariants(schema: unknown): unknown[] {
  if (isJsonObject(schema) && Array.isArray(schema.anyOf)) {
    return schema.anyOf;
  }
  return [schema];
}

/**
 * 合并同一属性名的两个 schema（object combiner 合并用）：
 * 相等 → 原样；兼容 enum → 成员并集；否则合成 anyOf（变体去重）。
 */
export function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (areJsonValuesEqual(existing, incoming)) {
    return existing;
  }
  const mergedEnumSchema = mergeCompatibleEnumSchemas(existing, incoming);
  if (mergedEnumSchema !== null) {
    return mergedEnumSchema;
  }

  const mergedAnyOf = [...getAnyOfVariants(existing)];
  for (const variant of getAnyOfVariants(incoming)) {
    if (!mergedAnyOf.some((existingVariant) => areJsonValuesEqual(existingVariant, variant))) {
      mergedAnyOf.push(variant);
    }
  }
  return mergedAnyOf.length === 1 ? mergedAnyOf[0] : { anyOf: mergedAnyOf };
}
