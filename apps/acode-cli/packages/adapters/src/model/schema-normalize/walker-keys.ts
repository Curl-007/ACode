// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// walker 键分类：哪些子值是 schema、哪些是字面载荷
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md。
// 从 omp normalize.ts 拆出的键分类面：walker、残留 combiner 剥除、CCA nullable
// 提取、Cursor 投影共用同一套「schema 值子节点」判定，避免各遍历器漂移。

import { isJsonObject, type JsonObject } from "./types.js";

export const SNAKE_TO_CAMEL_RENAMES = new Map<string, string>([
  ["additional_properties", "additionalProperties"],
  ["any_of", "anyOf"],
  ["prefix_items", "prefixItems"],
  ["property_ordering", "propertyOrdering"],
]);

export const JSON_SCHEMA_COMBINERS = ["anyOf", "oneOf"] as const;
/** JSON Schema 三个组合关键字：anyOf、oneOf、allOf。 */
export const SCHEMA_COMPOSITION_COMBINERS = ["allOf", "anyOf", "oneOf"] as const;
export type SchemaCombiner = (typeof SCHEMA_COMPOSITION_COMBINERS)[number];

/**
 * 值为单个子 schema 的关键字（draft 2020-12）。这些槽位上的裸 true/false
 * 是要折叠的布尔子 schema（omp issue #5604）。
 */
export const SUBSCHEMA_VALUE_KEYS: Record<string, true> = {
  items: true,
  additionalItems: true,
  unevaluatedItems: true,
  not: true,
  if: true,
  // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema 关键字
  then: true,
  else: true,
  contains: true,
  propertyNames: true,
  contentSchema: true,
};

/**
 * 值为「布尔关键字值或对象子 schema」的关键字：对象值必须走 walker，
 * 裸布尔保持字面量。
 */
export const BOOLEAN_OR_SCHEMA_VALUE_KEYS: Record<string, true> = {
  additionalProperties: true,
  unevaluatedProperties: true,
};

/** 值为子 schema 数组的关键字。 */
export const SUBSCHEMA_ARRAY_KEYS: Record<string, true> = {
  anyOf: true,
  oneOf: true,
  allOf: true,
  prefixItems: true,
};

/** 对象值把任意名字映射到子 schema 的关键字。 */
export const SUBSCHEMA_MAP_KEYS: Record<string, true> = {
  properties: true,
  patternProperties: true,
  dependencies: true,
  dependentSchemas: true,
  $defs: true,
  definitions: true,
};

export type SchemaChildKind = "schema" | "map";

/** 只分类 JSON Schema 值的子节点；实例载荷（enum/const/default…）保持不透明。 */
export function classifySchemaChild(
  key: string,
  value: unknown,
  insideSchemaMap: boolean,
): SchemaChildKind | undefined {
  if (insideSchemaMap) return "schema";
  const normalizedKey = SNAKE_TO_CAMEL_RENAMES.get(key) ?? key;
  if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, normalizedKey)) return "map";
  if (Object.hasOwn(SUBSCHEMA_VALUE_KEYS, normalizedKey) || Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, normalizedKey)) {
    return "schema";
  }
  if (Object.hasOwn(BOOLEAN_OR_SCHEMA_VALUE_KEYS, normalizedKey) && isJsonObject(value)) return "schema";
  return undefined;
}

/** 复制 schema 上除指定 combinator 键外的全部键。 */
export function copySchemaWithout(schema: JsonObject, combiner: string): JsonObject {
  const { [combiner]: _, ...rest } = schema;
  return rest;
}
