// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// combiner 折叠：object 合并 / 同型折叠 / 混合类型有损折叠 / 残留剥除
// ============================================================
// CCA 与 Cursor 方言的组合关键字消去原语。全部折叠只允许「加宽接受面」或
// 语义等价，不允许收窄（omp CONSTRAINTS #3.3）。

import { areJsonValuesEqual, mergeCompatibleEnumSchemas, mergePropertySchemas } from "./equality.js";
import { CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS } from "./fields.js";
import { epochNext, once } from "./stamps.js";
import {
  classifySchemaChild,
  copySchemaWithout,
  JSON_SCHEMA_COMBINERS,
  type SchemaCombiner,
} from "./walker-keys.js";
import { dropForeignTypeKeywords } from "./walker-rewrites.js";
import { isJsonObject, type JsonObject } from "./types.js";

function outHasOwn(obj: JsonObject, key: string): boolean {
  return Object.hasOwn(obj, key);
}

export function mergeObjectCombinerVariants(schema: JsonObject, combiner: SchemaCombiner): JsonObject {
  const variantsRaw = schema[combiner];
  if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
    return schema;
  }

  const variants: JsonObject[] = [];
  for (const entry of variantsRaw) {
    if (!isJsonObject(entry)) {
      return schema;
    }
    const variantType = entry.type;
    const hasObjectShape =
      isJsonObject(entry.properties) ||
      Array.isArray(entry.required) ||
      Object.hasOwn(entry, "additionalProperties");
    if (variantType === undefined && !hasObjectShape) {
      return schema;
    }
    if (variantType !== undefined && variantType !== "object") {
      return schema;
    }
    if (entry.properties !== undefined && !isJsonObject(entry.properties)) {
      return schema;
    }
    if (entry.required !== undefined && !Array.isArray(entry.required)) {
      return schema;
    }
    variants.push(entry);
  }

  const mergedProperties: JsonObject = {};
  const ownProperties = isJsonObject(schema.properties) ? schema.properties : {};
  for (const name in ownProperties) {
    if (Object.hasOwn(ownProperties, name)) mergedProperties[name] = ownProperties[name];
  }

  for (const variant of variants) {
    const properties = isJsonObject(variant.properties) ? variant.properties : {};
    for (const name in properties) {
      if (!Object.hasOwn(properties, name)) continue;
      const propertySchema = properties[name];
      const existingSchema = mergedProperties[name];
      mergedProperties[name] =
        existingSchema === undefined ? propertySchema : mergePropertySchemas(existingSchema, propertySchema);
    }
  }

  const nextSchema = copySchemaWithout(schema, combiner);
  nextSchema.type = "object";
  nextSchema.properties = mergedProperties;

  const branchRequired = variants.map((variant) =>
    Array.isArray(variant.required) ? variant.required.filter((r): r is string => typeof r === "string") : [],
  );
  let combinedRequired: string[];
  if (combiner === "allOf") {
    // allOf 要求每个分支都成立，规范 required 是各分支要求的并集——
    // 携带并集不会收窄接受面。
    const union = new Set<string>();
    for (const required of branchRequired) {
      for (const name of required) union.add(name);
    }
    combinedRequired = [...union];
  } else {
    // anyOf/oneOf 接受任一分支，加宽投影里只有每个分支都要求的字段保持 required。
    let intersection: string[] | undefined;
    for (const required of branchRequired) {
      if (intersection === undefined) {
        intersection = [...required];
      } else {
        const reqSet = new Set(required);
        intersection = intersection.filter((r) => reqSet.has(r));
      }
    }
    combinedRequired = intersection ?? [];
  }
  const parentRequired = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
  const safeRequired = new Set<string>();
  for (const name of combinedRequired) {
    if (Object.hasOwn(mergedProperties, name)) safeRequired.add(name);
  }
  for (const name of parentRequired) {
    if (Object.hasOwn(ownProperties, name) && Object.hasOwn(mergedProperties, name)) {
      safeRequired.add(name);
    }
  }
  const requiredInPropertyOrder: string[] = [];
  for (const name in mergedProperties) {
    if (Object.hasOwn(mergedProperties, name) && safeRequired.has(name)) requiredInPropertyOrder.push(name);
  }
  if (requiredInPropertyOrder.length > 0) {
    nextSchema.required = requiredInPropertyOrder;
  } else {
    delete nextSchema.required;
  }

  return nextSchema;
}

export function collapseMixedTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
  const variantsRaw = schema[combiner];
  if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
    return schema;
  }

  const seenTypes = new Set<string>();
  const variantTypes: string[] = [];
  const mergedVariantFields: JsonObject = {};
  for (const entry of variantsRaw) {
    if (!isJsonObject(entry) || typeof entry.type !== "string") {
      return schema;
    }

    const variantType = entry.type;
    if (seenTypes.has(variantType)) {
      return schema;
    }

    const allowedKeys = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[variantType];
    if (!allowedKeys) {
      return schema;
    }

    for (const key in entry) {
      if (!Object.hasOwn(entry, key)) continue;
      const variantValue = entry[key];
      if (key === "type") continue;
      if (!Object.hasOwn(allowedKeys, key) && !Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)) {
        return schema;
      }

      const existingValue = mergedVariantFields[key];
      if (existingValue !== undefined && !areJsonValuesEqual(existingValue, variantValue)) {
        if (key !== "description") return schema;
        // description 是注解：分支各自的 spill 文本合并，而不是当结构不兼容处理。
        mergedVariantFields[key] = mergeSchemaDescriptions(existingValue, variantValue);
        continue;
      }
      mergedVariantFields[key] = variantValue;
    }

    seenTypes.add(variantType);
    variantTypes.push(variantType);
  }

  if (variantTypes.length < 2 || variantTypes.every((type) => type === "object")) {
    return schema;
  }
  const nextSchema = copySchemaWithout(schema, combiner);
  const nonNullTypes = variantTypes.filter((t) => t !== "null");
  const chosenType: string = nonNullTypes[0] ?? variantTypes[0];
  nextSchema.type = chosenType;
  const chosenTypeAllowedKeys = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[chosenType] ?? {};
  // 从父节点复制来的兄弟键可能属于另一个类型。
  dropForeignTypeKeywords(nextSchema, chosenType);

  for (const key in mergedVariantFields) {
    if (!Object.hasOwn(mergedVariantFields, key)) continue;
    // 丢弃不属于选定类型的类型专属键
    if (!Object.hasOwn(chosenTypeAllowedKeys, key) && !Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)) {
      continue;
    }
    const value = mergedVariantFields[key];
    const existingValue = nextSchema[key];
    if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
      if (key !== "description") return schema;
      nextSchema[key] = mergeSchemaDescriptions(existingValue, value);
      continue;
    }
    if (existingValue === undefined) {
      nextSchema[key] = value;
    }
  }
  return nextSchema;
}

export function mergeSchemaDescriptions(existing: unknown, incoming: unknown): string {
  if (typeof existing !== "string") return typeof incoming === "string" ? incoming : "";
  if (typeof incoming !== "string" || incoming.length === 0 || existing === incoming) return existing;
  if (existing.length === 0) return incoming;
  return `${existing}\n\n${incoming}`;
}

export function collapseSameTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
  const variantsRaw = schema[combiner];
  if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) return schema;
  let commonType: string | undefined;
  const variants: JsonObject[] = [];
  for (const entry of variantsRaw) {
    if (!isJsonObject(entry) || typeof entry.type !== "string") return schema;
    if (commonType === undefined) commonType = entry.type;
    else if (entry.type !== commonType) return schema;
    variants.push(entry);
  }
  const firstEntry = variants[0];
  if (!firstEntry) return schema;

  // 同型折叠若只保留首变体的键，会静默丢掉其他分支的 enum 成员
  // （例如两个字符串 enum 的 anyOf 折成只剩第一个）。
  const enumVariantCount = variants.reduce((n, variant) => n + (Array.isArray(variant.enum) ? 1 : 0), 0);

  let collapsed: JsonObject;
  if (enumVariantCount === variants.length) {
    // 每个分支都是 enum schema：用 mergeCompatibleEnumSchemas 折叠——
    // 仅当分支在 type 与所有非 enum 字段上一致时取成员并集，否则返回 null。
    // 任何不一致都回退到未触碰的 schema，交给残留 combiner 兜底而不是错标。
    let merged: JsonObject | null = firstEntry;
    for (let i = 1; i < variants.length && merged !== null; i++) {
      merged = mergeCompatibleEnumSchemas(merged, variants[i]);
    }
    if (merged === null) return schema;
    collapsed = merged;
  } else if (enumVariantCount > 0) {
    // 混合分支：至少一个不受 enum 约束、因此更宽。折叠到首个这样的分支，
    // 结果保留其（更宽的）键——绝不收窄到 enum 分支的成员或泄漏其元数据。
    collapsed = variants.find((variant) => !Array.isArray(variant.enum)) ?? firstEntry;
  } else {
    // 无 enum 分支：保持原有 first-wins 行为。
    collapsed = firstEntry;
  }

  const nextSchema = copySchemaWithout(schema, combiner);
  for (const key in collapsed) {
    if (Object.hasOwn(collapsed, key) && !outHasOwn(nextSchema, key)) nextSchema[key] = collapsed[key];
  }
  return nextSchema;
}

/** MFJS 只认识 anyOf：残留 oneOf 折进去（两者并存时合并）。 */
export function foldOneOfIntoAnyOf(schema: JsonObject): JsonObject {
  if (!Array.isArray(schema.oneOf)) return schema;
  const rest = copySchemaWithout(schema, "oneOf");
  const existing = Array.isArray(rest.anyOf) ? (rest.anyOf as unknown[]) : [];
  rest.anyOf = [...existing, ...(schema.oneOf as unknown[])];
  return rest;
}

/** MFJS enum 只接受字符串/数字字面量：带其他类型的 enum 整体丢弃，保留推断出的 type。 */
export function dropNonScalarEnumForMfjs(schema: JsonObject): JsonObject {
  if (!Array.isArray(schema.enum)) return schema;
  const allScalar = (schema.enum as unknown[]).every((v) => typeof v === "string" || typeof v === "number");
  if (allScalar) return schema;
  return copySchemaWithout(schema, "enum");
}

/** Google Schema 的 enum 字段只接受字符串值：不支持的 enum 省略，但不丢节点的 type。 */
export function dropNonStringEnumForGoogle(schema: JsonObject): JsonObject {
  if (!Array.isArray(schema.enum)) return schema;
  const isStringEnum = schema.enum.length > 0 && schema.enum.every((value) => typeof value === "string");
  return isStringEnum ? schema : copySchemaWithout(schema, "enum");
}

/**
 * 递归剥除同型/混合折叠能处理的残留 anyOf/oneOf。必要原因：object combiner
 * 合并可能在子节点归一已完成后，在合并出的子树里合成新的 anyOf。
 */
export function stripResidualCombiners(value: unknown, epoch: number = epochNext()): unknown {
  return stripResidualCombinersNode(value, epoch, false);
}

function stripResidualCombinersNode(value: unknown, epoch: number, insideSchemaMap: boolean): unknown {
  if (Array.isArray(value)) {
    if (!once(value, epoch)) return [];
    return value.map((entry) => stripResidualCombinersNode(entry, epoch, false));
  }
  if (!isJsonObject(value)) return value;
  if (!once(value, epoch)) return {};
  const result: JsonObject = {};
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    const childKind = classifySchemaChild(key, entry, insideSchemaMap);
    result[key] = childKind ? stripResidualCombinersNode(entry, epoch, childKind === "map") : entry;
  }
  if (insideSchemaMap) return result;

  let current: JsonObject = result;
  let changed = true;
  while (changed) {
    changed = false;
    for (const combiner of JSON_SCHEMA_COMBINERS) {
      const sameType = collapseSameTypeCombinerVariants(current, combiner);
      if (sameType !== current) {
        current = sameType;
        changed = true;
      }
      const mixed = collapseMixedTypeCombinerVariants(current, combiner);
      if (mixed !== current) {
        current = mixed;
        changed = true;
      }
    }
  }
  return current;
}
