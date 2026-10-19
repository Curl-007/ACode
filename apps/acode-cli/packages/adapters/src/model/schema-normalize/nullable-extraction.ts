// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// CCA nullable 提取 + 残留不兼容检查
// ============================================================
// Cloud Code Assist Claude 方言的两条后处理：属性级可空性 → 非 required 语义
// （omp CONSTRAINTS #3.4），以及归一后残留不兼容形状的硬停门（#3.5）。
// containsSchemaCombiner 同时被 Cursor 投影消费。

import { areJsonValuesEqual } from "./equality.js";
import { epochNext, once } from "./stamps.js";
import {
  classifySchemaChild,
  copySchemaWithout,
  JSON_SCHEMA_COMBINERS,
  SCHEMA_COMPOSITION_COMBINERS,
} from "./walker-keys.js";
import { isJsonObject, type JsonObject } from "./types.js";

export type ResidualSchemaIncompatibility = "type-array" | "type-null" | "nullable" | "combiners" | "not";

interface NullableExtractionResult {
  schema: unknown;
  nullable: boolean;
}

export function extractNullableUnionSchema(schema: unknown): NullableExtractionResult {
  if (!isJsonObject(schema)) {
    return { schema, nullable: false };
  }

  if (schema.nullable === true) {
    const nextSchema = { ...schema };
    delete nextSchema.nullable;
    return { schema: nextSchema, nullable: true };
  }

  if (Array.isArray(schema.type)) {
    const typeVariants = schema.type.filter((entry): entry is string => typeof entry === "string");
    const nonNullTypes = typeVariants.filter((entry) => entry !== "null");
    if (typeVariants.includes("null") && nonNullTypes.length === 1) {
      const nextSchema = { ...schema, type: nonNullTypes[0] };
      return { schema: nextSchema, nullable: true };
    }
  }

  for (const combiner of JSON_SCHEMA_COMBINERS) {
    const variantsRaw = schema[combiner];
    if (!Array.isArray(variantsRaw)) continue;

    let hasNullVariant = false;
    const nonNullVariants: unknown[] = [];
    for (const variant of variantsRaw) {
      if (isJsonObject(variant) && variant.type === "null") {
        let keyCount = 0;
        for (const k in variant) {
          if (!Object.hasOwn(variant, k)) continue;
          keyCount += 1;
          if (keyCount > 1) break;
        }
        if (keyCount === 1) {
          hasNullVariant = true;
          continue;
        }
      }
      nonNullVariants.push(variant);
    }

    if (!hasNullVariant || nonNullVariants.length !== 1 || !isJsonObject(nonNullVariants[0])) {
      continue;
    }

    const nextSchema = copySchemaWithout(schema, combiner);
    const nonNullVariant = nonNullVariants[0];
    for (const key in nonNullVariant) {
      if (!Object.hasOwn(nonNullVariant, key)) continue;
      const value = nonNullVariant[key];
      const existingValue = nextSchema[key];
      if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
        return { schema, nullable: false };
      }
      if (existingValue === undefined) {
        nextSchema[key] = value;
      }
    }
    return { schema: nextSchema, nullable: true };
  }

  return { schema, nullable: false };
}

interface NullableNormalizationResult {
  schema: unknown;
  nullable: boolean;
}

/**
 * CCA 属性可空性归一：属性 schema 检测到可空（nullable:true / type 含 null 的
 * 二元 union / 单 null 分支 combiner）→ 该属性从 required 摘除，可空标记剥掉。
 */
export function normalizeNullablePropertiesForCloudCodeAssist(
  value: unknown,
  isPropertySchema = false,
  epoch: number = epochNext(),
  insideSchemaMap = false,
): NullableNormalizationResult {
  if (Array.isArray(value)) {
    if (!once(value, epoch)) {
      return { schema: [], nullable: false };
    }
    return {
      schema: value.map((entry) => normalizeNullablePropertiesForCloudCodeAssist(entry, false, epoch).schema),
      nullable: false,
    };
  }
  if (!isJsonObject(value)) {
    return { schema: value, nullable: false };
  }
  if (!once(value, epoch)) {
    return { schema: {}, nullable: false };
  }

  const normalized: JsonObject = {};
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    const childKind = classifySchemaChild(key, entry, insideSchemaMap);
    normalized[key] = childKind
      ? normalizeNullablePropertiesForCloudCodeAssist(entry, false, epoch, childKind === "map").schema
      : entry;
  }
  if (insideSchemaMap) return { schema: normalized, nullable: false };

  if (isJsonObject(normalized.properties)) {
    const properties = normalized.properties;
    const required = new Set(
      Array.isArray(normalized.required)
        ? normalized.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    const nextProperties: JsonObject = {};
    for (const name in properties) {
      if (!Object.hasOwn(properties, name)) continue;
      const normalizedProperty = normalizeNullablePropertiesForCloudCodeAssist(properties[name], true, epoch);
      nextProperties[name] = normalizedProperty.schema;
      if (normalizedProperty.nullable) {
        required.delete(name);
      }
    }
    normalized.properties = nextProperties;
    if (Array.isArray(normalized.required)) {
      normalized.required = Array.from(required);
    }
  }

  if (!isPropertySchema) {
    return { schema: normalized, nullable: false };
  }

  return extractNullableUnionSchema(normalized);
}

interface ResidualIncompatibilityChecks {
  typeArray: boolean;
  typeNull: boolean;
  nullable: boolean;
  combiners: boolean;
  not: boolean;
}

export function createResidualIncompatibilityChecks(
  checks: ReadonlyArray<ResidualSchemaIncompatibility> | undefined,
): ResidualIncompatibilityChecks | undefined {
  if (!checks || checks.length === 0) return undefined;
  const result: ResidualIncompatibilityChecks = {
    typeArray: false,
    typeNull: false,
    nullable: false,
    combiners: false,
    not: false,
  };
  for (const check of checks) {
    switch (check) {
      case "type-array":
        result.typeArray = true;
        break;
      case "type-null":
        result.typeNull = true;
        break;
      case "nullable":
        result.nullable = true;
        break;
      case "not":
        result.not = true;
        break;
      case "combiners":
        result.combiners = true;
        break;
    }
  }
  return result;
}

export function hasResidualSchemaIncompatibilities(
  value: unknown,
  checks: ResidualIncompatibilityChecks,
  epoch: number = epochNext(),
  insideSchemaMap = false,
): boolean {
  if (Array.isArray(value)) {
    if (!once(value, epoch)) return false;
    return value.some((entry) => hasResidualSchemaIncompatibilities(entry, checks, epoch, false));
  }
  if (!isJsonObject(value)) {
    return false;
  }
  if (!once(value, epoch)) {
    return false;
  }

  if (!insideSchemaMap) {
    if (checks.typeArray && Array.isArray(value.type)) return true;
    if (checks.typeNull && value.type === "null") return true;
    if (checks.nullable && Object.hasOwn(value, "nullable")) return true;
    if (checks.not && Object.hasOwn(value, "not")) return true;
    if (checks.combiners) {
      for (const combiner of SCHEMA_COMPOSITION_COMBINERS) {
        if (Array.isArray(value[combiner])) return true;
      }
    }
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    const childKind = classifySchemaChild(key, entry, insideSchemaMap);
    if (childKind && hasResidualSchemaIncompatibilities(entry, checks, epoch, childKind === "map")) {
      return true;
    }
  }
  return false;
}

/**
 * JSON Schema 子树在 schema 位置携带任何组合关键字（anyOf/oneOf/allOf）时为真。
 * 恰好等于 combinator 关键字的属性**名**（住在 properties/patternProperties 下）
 * 不是 combinator，不计入。
 */
export function containsSchemaCombiner(value: unknown, insideSchemaMap: boolean, epoch: number): boolean {
  if (Array.isArray(value)) {
    if (!once(value, epoch)) return false;
    return value.some((entry) => containsSchemaCombiner(entry, false, epoch));
  }
  if (!isJsonObject(value)) return false;
  if (!once(value, epoch)) return false;
  if (!insideSchemaMap) {
    for (const combiner of SCHEMA_COMPOSITION_COMBINERS) {
      if (Array.isArray(value[combiner])) return true;
    }
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const childKind = classifySchemaChild(key, value[key], insideSchemaMap);
    if (childKind && containsSchemaCombiner(value[key], childKind === "map", epoch)) return true;
  }
  return false;
}
