// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// Google（Gemini/Vertex）与 Cloud Code Assist Claude 方言
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R1 #5/#6。
// 本波在 ACode 无消费者（未接 Google wire）：纯入册，懒加载 + 单测锚定
// （omp CONSTRAINTS #2/#3 语义逐条保留）。

import { normalizeSchema } from "./normalize-core.js";
import { UNSUPPORTED_SCHEMA_FIELDS } from "./fields.js";

export function isGoogleUnsupportedSchemaField(key: string): boolean {
  return Object.hasOwn(UNSUPPORTED_SCHEMA_FIELDS, key);
}

const CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA = {
  type: "object",
  properties: {},
} as const;

/** Gemini / Vertex / Gemini CLI：剥离 + 可空折叠 + 字符串 enum 限定 + 属性排序。 */
export function normalizeSchemaForGoogle(value: unknown): unknown {
  return normalizeSchema(value, {
    coerceBooleanSubschemas: "standard",
    unsupportedFields: isGoogleUnsupportedSchemaField,
    normalizeFieldNames: true,
    collapseNullFields: true,
    scalarizeTypeArrays: true,
    stripNullableKeyword: false,
    autoPropertyOrdering: true,
    ensureObjectProperties: true,
    liftStrippedToDescription: { format: "spill" },
    mergeObjectCombiners: false,
    collapseSameTypeCombiners: false,
    collapseMixedTypeCombiners: false,
    stripResidualCombinersFixpoint: false,
    extractNullableFromUnions: false,
    inferTypeForBareEnum: true,
    dropNonScalarEnum: false,
    stringEnumsOnly: true,
    foldOneOfIntoAnyOf: false,
  });
}

/**
 * Cloud Code Assist Claude（Antigravity + GCA）：Google 剥离基础上叠加
 * combiner 合并/折叠、nullable 属性摘出 required、残留不兼容硬停 +
 * 每工具回退 {type:"object",properties:{}}（omp CONSTRAINTS #3.5/#3.6）。
 * Gemini CLI / Antigravity 必须走完整管线，不能只跑第一遍关键字剥离（#6 平价条款）。
 */
export function normalizeSchemaForCCA(value: unknown): unknown {
  return normalizeSchema(value, {
    coerceBooleanSubschemas: "standard",
    unsupportedFields: isGoogleUnsupportedSchemaField,
    normalizeFieldNames: true,
    collapseNullFields: false,
    scalarizeTypeArrays: true,
    stripNullableKeyword: true,
    autoPropertyOrdering: false,
    ensureObjectProperties: true,
    liftStrippedToDescription: { format: "spill" },
    mergeObjectCombiners: true,
    collapseSameTypeCombiners: true,
    collapseMixedTypeCombiners: true,
    stripResidualCombinersFixpoint: true,
    extractNullableFromUnions: true,
    inferTypeForBareEnum: true,
    dropNonScalarEnum: false,
    foldOneOfIntoAnyOf: false,
    rejectResidualIncompatibilities: ["type-array", "type-null", "nullable", "combiners", "not"],
    validateAndFallback: { fallback: CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA },
  });
}
