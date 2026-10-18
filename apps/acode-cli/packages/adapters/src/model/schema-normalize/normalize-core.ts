// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 选项驱动的归一化 walker 核心
// ============================================================
// Google Schema proto、Cloud Code Assist Claude 桥、MCP/AJV 校验各自拒绝标准
// JSON Schema 的不同子集。本模块提供一个选项驱动核心 + 各目标方言钉死选项集的
// 薄分发器（dialect-*.ts）。
// 解耦说明：omp 在回退路径打 logger.debug；ACode 移植面保持纯函数（无日志），
// 回退行为由单测锚定（spec R4）。

import { dereferenceJsonSchema } from "./dereference.js";
import { upgradeJsonSchemaTo202012 } from "./draft.js";
import {
  collapseMixedTypeCombinerVariants,
  collapseSameTypeCombinerVariants,
  dropNonScalarEnumForMfjs,
  dropNonStringEnumForGoogle,
  foldOneOfIntoAnyOf,
  mergeObjectCombinerVariants,
  stripResidualCombiners,
} from "./combiner-collapse.js";
import { isValidJsonSchema } from "./meta-validator.js";
import {
  createResidualIncompatibilityChecks,
  hasResidualSchemaIncompatibilities,
  normalizeNullablePropertiesForCloudCodeAssist,
  type ResidualSchemaIncompatibility,
} from "./nullable-extraction.js";
import { enter, exit } from "./stamps.js";
import { classifySchemaChild, JSON_SCHEMA_COMBINERS } from "./walker-keys.js";
import {
  applyDescriptionSpill,
  applySnakeCaseRenames,
  dropForeignTypeKeywords,
  hasUnrepresentableGoogleEnumConstraint,
  inferJsonSchemaTypeFromValue,
  outHasOwn,
  preHandleNullFields,
  pushEnumValue,
  pushStrippedDescriptionEntry,
  splitTypeArrayIntoAnyOf,
  type SpillPolicy,
} from "./walker-rewrites.js";
import { isJsonObject, type JsonObject } from "./types.js";
import type { DescriptionSpillFormat } from "./spill.js";

export interface NormalizeSchemaOptions {
  /**
   * 布尔子 schema 折叠成对象形态。`standard` 用 not 保留 false 语义；
   * `permissive` 在 provider 表达不了不可能 schema 时用 {}。
   */
  coerceBooleanSubschemas?: "standard" | "permissive";
  unsupportedFields: (key: string) => boolean;
  normalizeFieldNames: boolean;
  collapseNullFields: boolean;
  /**
   * 目标只接受标量 type：["T","null"] 变成 T（+nullable），
   * 多类型数组变成每类型一个 anyOf 分支。
   */
  scalarizeTypeArrays: boolean;
  stripNullableKeyword: boolean;
  autoPropertyOrdering: boolean;
  ensureObjectProperties: boolean;
  liftStrippedToDescription:
    | false
    | {
        keys?: (key: string) => boolean;
        format?: DescriptionSpillFormat;
      };
  mergeObjectCombiners: boolean;
  collapseSameTypeCombiners: boolean;
  collapseMixedTypeCombiners: boolean;
  stripResidualCombinersFixpoint: boolean;
  extractNullableFromUnions: boolean;
  inferTypeForBareEnum: boolean;
  foldOneOfIntoAnyOf: boolean;
  dropNonScalarEnum: boolean;
  stringEnumsOnly?: boolean;
  rejectResidualIncompatibilities?: ReadonlyArray<ResidualSchemaIncompatibility>;
  validateAndFallback?: { fallback: unknown };
}

export interface NormalizeSchemaWalkOptions extends NormalizeSchemaOptions {
  insideSchemaMap: boolean;
  /**
   * 当前被走的值占据 JSON Schema **子 schema** 槽位（根、combiner 分支、items、
   * 属性值……）时为真。只有此时裸 true/false 才是需要折叠的布尔子 schema；
   * 在关键字槽位（nullable、enum 成员、additionalProperties）保持字面量。
   */
  booleanIsSubschema: boolean;
}

function normalizeSchemaNode(value: unknown, options: NormalizeSchemaWalkOptions): unknown {
  if (Array.isArray(value)) {
    if (!enter(value)) return [];
    try {
      return value.map((entry) => normalizeSchemaNode(entry, options));
    } finally {
      exit(value);
    }
  }
  if (typeof value === "boolean") {
    // 裸布尔只有在子 schema 槽位才是 JSON Schema 布尔子 schema。
    // 部分 provider wire 没有布尔 schema 表示：true 变 {}；false 在支持时用 not，
    // provider 表达不了不可能 schema 时走 permissive {} 回退。
    const mode = options.coerceBooleanSubschemas;
    if (!mode || !options.booleanIsSubschema) return value;
    return value || mode === "permissive" ? {} : { not: {} };
  }
  if (!isJsonObject(value)) {
    return value;
  }
  // enter/exit 是路径跟踪（不是 visited 集）：DAG 共享子树在每个出现点都归一，
  // 只有真循环短路成 {}。
  if (!enter(value)) return {};
  try {
    return normalizeSchemaObjectNode(value, options);
  } finally {
    exit(value);
  }
}

function normalizeSchemaObjectNode(value: JsonObject, options: NormalizeSchemaWalkOptions): unknown {
  let obj = options.normalizeFieldNames && !options.insideSchemaMap ? applySnakeCaseRenames(value) : value;
  if (options.scalarizeTypeArrays && !options.insideSchemaMap) {
    obj = splitTypeArrayIntoAnyOf(obj);
  }
  if (options.collapseNullFields && !options.insideSchemaMap) {
    obj = preHandleNullFields(obj);
  }
  const result: JsonObject = {};
  let spill: Array<[string, unknown]> | undefined;
  const lift: SpillPolicy | false = options.liftStrippedToDescription;
  for (const combiner of JSON_SCHEMA_COMBINERS) {
    if (!Array.isArray(obj[combiner])) continue;
    const variants = obj[combiner] as JsonObject[];
    const allHaveConst = variants.every((v) => isJsonObject(v) && "const" in v);
    if (!allHaveConst || variants.length === 0) continue;

    // 全 const 分支的 anyOf/oneOf：折成 typed enum（Google/MFJS 的 const 不支持面）。
    const dedupedEnum: unknown[] = [];
    for (const variant of variants) {
      pushEnumValue(dedupedEnum, variant.const);
    }
    result.enum = dedupedEnum;

    const explicitTypes = variants
      .map((variant) => variant.type)
      .filter((variantType): variantType is string => typeof variantType === "string");
    const allHaveSameExplicitType =
      explicitTypes.length === variants.length &&
      explicitTypes.every((variantType) => variantType === explicitTypes[0]);
    if (allHaveSameExplicitType && explicitTypes[0]) {
      result.type = explicitTypes[0];
    } else {
      const inferredTypes = dedupedEnum
        .map((enumValue) => inferJsonSchemaTypeFromValue(enumValue))
        .filter((inferredType): inferredType is string => inferredType !== undefined);
      const inferredTypeSet = new Set(inferredTypes);
      if (inferredTypeSet.size === 1) {
        result.type = inferredTypes[0];
      } else {
        const nonNullInferredTypes = inferredTypes.filter((inferredType) => inferredType !== "null");
        const nonNullTypeSet = new Set(nonNullInferredTypes);
        if (inferredTypes.includes("null") && nonNullTypeSet.size === 1) {
          result.type = nonNullInferredTypes[0];
          if (!options.stripNullableKeyword) {
            result.nullable = true;
          }
        }
      }
    }

    for (const key in obj) {
      if (!Object.hasOwn(obj, key) || key === combiner || outHasOwn(result, key)) continue;
      const entry = obj[key];
      if (!options.insideSchemaMap && options.unsupportedFields(key)) {
        spill = pushStrippedDescriptionEntry(spill, key, entry, lift);
        continue;
      }
      if (options.stripNullableKeyword && key === "nullable") continue;
      if (
        options.stringEnumsOnly &&
        !options.insideSchemaMap &&
        key === "not" &&
        hasUnrepresentableGoogleEnumConstraint(entry)
      ) {
        continue;
      }
      const childKind = classifySchemaChild(key, entry, options.insideSchemaMap);
      result[key] = childKind
        ? normalizeSchemaNode(entry, {
            ...options,
            insideSchemaMap: childKind === "map",
            booleanIsSubschema: childKind === "schema",
          })
        : entry;
    }
    applyDescriptionSpill(result, spill, lift);
    return applyNodePostProcessing(result, options);
  }

  let constValue: unknown;
  for (const key in obj) {
    if (!Object.hasOwn(obj, key)) continue;
    const entry = obj[key];
    if (!options.insideSchemaMap && options.unsupportedFields(key)) {
      spill = pushStrippedDescriptionEntry(spill, key, entry, lift);
      continue;
    }
    if (options.stripNullableKeyword && key === "nullable") continue;
    if (key === "const") {
      constValue = entry;
      continue;
    }
    if (
      options.stringEnumsOnly &&
      !options.insideSchemaMap &&
      key === "not" &&
      hasUnrepresentableGoogleEnumConstraint(entry)
    ) {
      continue;
    }
    const childKind = classifySchemaChild(key, entry, options.insideSchemaMap);
    result[key] = childKind
      ? normalizeSchemaNode(entry, {
          ...options,
          insideSchemaMap: childKind === "map",
          booleanIsSubschema: childKind === "schema",
        })
      : entry;
  }

  if (options.scalarizeTypeArrays && Array.isArray(result.type)) {
    const types = (result.type as unknown[]).filter((t): t is string => typeof t === "string");
    const nonNull = types.filter((t) => t !== "null");
    if (types.includes("null") && !options.stripNullableKeyword) {
      result.nullable = true;
    }
    result.type = nonNull[0] ?? types[0];
    if (typeof result.type === "string") dropForeignTypeKeywords(result, result.type);
  }
  if (constValue !== undefined) {
    const existingEnum = Array.isArray(result.enum) ? result.enum : [];
    pushEnumValue(existingEnum, constValue);
    result.enum = existingEnum;
    if (!result.type) {
      result.type = inferJsonSchemaTypeFromValue(constValue);
    }
  }

  if (
    options.inferTypeForBareEnum &&
    !result.type &&
    !Array.isArray(result.anyOf) &&
    !Array.isArray(result.oneOf) &&
    Array.isArray(result.enum) &&
    result.enum.length > 0
  ) {
    const enumTypes = (result.enum as unknown[]).map(inferJsonSchemaTypeFromValue);
    if (enumTypes.every((t): t is string => typeof t === "string") && new Set(enumTypes).size === 1) {
      result.type = enumTypes[0];
    }
  }

  if (options.collapseNullFields && result.type === "null") {
    delete result.type;
    if (!options.stripNullableKeyword) result.nullable = true;
  }

  if (
    options.autoPropertyOrdering &&
    result.type === "object" &&
    !outHasOwn(result, "propertyOrdering") &&
    isJsonObject(result.properties)
  ) {
    const props = result.properties;
    const keys: string[] = [];
    for (const k in props) {
      if (Object.hasOwn(props, k)) keys.push(k);
    }
    if (keys.length > 1) result.propertyOrdering = keys;
  }

  if (options.ensureObjectProperties && result.type === "object" && !outHasOwn(result, "properties")) {
    result.properties = {};
  }

  applyDescriptionSpill(result, spill, lift);
  return applyNodePostProcessing(result, options);
}

function applyNodePostProcessing(schema: JsonObject, options: NormalizeSchemaWalkOptions): JsonObject {
  let current = schema;
  for (const combiner of JSON_SCHEMA_COMBINERS) {
    if (options.mergeObjectCombiners) current = mergeObjectCombinerVariants(current, combiner);
    if (options.collapseMixedTypeCombiners) current = collapseMixedTypeCombinerVariants(current, combiner);
    if (options.collapseSameTypeCombiners) current = collapseSameTypeCombinerVariants(current, combiner);
  }
  if (options.foldOneOfIntoAnyOf) current = foldOneOfIntoAnyOf(current);
  if (options.dropNonScalarEnum) current = dropNonScalarEnumForMfjs(current);
  if (options.stringEnumsOnly && options.booleanIsSubschema) current = dropNonStringEnumForGoogle(current);
  return current;
}

/**
 * 通用归一化入口：升级 2020-12 → 解引用 → 按选项集走树 →（可选）残留 combiner
 * 定点剥除 →（可选）CCA nullable 提取 →（可选）残留不兼容硬停回退 →
 * （可选）结构校验回退。各方言分发器钉死选项集（dialect-*.ts）。
 */
export function normalizeSchema(value: unknown, options: NormalizeSchemaOptions): unknown {
  const upgraded = upgradeJsonSchemaTo202012(value);
  const dereferenced = dereferenceJsonSchema(upgraded);
  let normalized = normalizeSchemaNode(dereferenced, {
    ...options,
    insideSchemaMap: false,
    booleanIsSubschema: true,
  });
  if (options.stripResidualCombinersFixpoint) {
    normalized = stripResidualCombiners(normalized);
  }
  if (options.extractNullableFromUnions) {
    normalized = normalizeNullablePropertiesForCloudCodeAssist(normalized).schema;
  }
  const residualChecks = createResidualIncompatibilityChecks(options.rejectResidualIncompatibilities);
  if (residualChecks && hasResidualSchemaIncompatibilities(normalized, residualChecks)) {
    // 残留 provider 不兼容形状：有回退则每工具回退（omp CONSTRAINTS #3.6），无回退原样。
    return options.validateAndFallback?.fallback ?? normalized;
  }
  if (options.validateAndFallback && !isValidJsonSchema(normalized)) {
    return options.validateAndFallback.fallback;
  }
  return normalized;
}
