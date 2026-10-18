// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/fields.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 各方言的关键字分类集合
// ============================================================
// 每个集合服务不同 provider 的需要，刻意允许重叠——放在一起让重叠可见、可维护。
// 键集都是静态小表（≤ ~40 项），用 `Record<string, true>` 字面量承载：
// `k in REC` 走隐藏类内联缓存，没有 Set.has 的每调用哈希成本。
// 注：omp 的 CCA_UNSUPPORTED_SCHEMA_FIELDS 在本仓无消费者（CCA 方言走
// UNSUPPORTED_SCHEMA_FIELDS），按「只搬被消费面」纪律不移植。

/**
 * Google Generative AI 不支持的 schema 字段。
 * normalizeSchemaForGoogle / normalizeSchemaForCCA 剥离时用。
 */
export const UNSUPPORTED_SCHEMA_FIELDS: Record<string, true> = {
  $schema: true,
  $id: true,
  $anchor: true,
  $ref: true,
  $defs: true,
  $dynamicRef: true,
  $dynamicAnchor: true,
  examples: true,
  prefixItems: true,
  unevaluatedProperties: true,
  unevaluatedItems: true,
  patternProperties: true,
  additionalProperties: true,
  propertyNames: true,
  minItems: true,
  maxItems: true,
  uniqueItems: true,
  contains: true,
  minContains: true,
  maxContains: true,
  additionalItems: true,
  minLength: true,
  maxLength: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  multipleOf: true,
  pattern: true,
  format: true,
  contentEncoding: true,
  contentMediaType: true,
  contentSchema: true,
  dependencies: true,
  dependentSchemas: true,
  dependentRequired: true,
  // MCP 2026-07-28 传输注解（Streamable HTTP 上把参数镜像进 Mcp-Param-* 头）；
  // 不是 JSON Schema 关键字，Google CCA 对未知字段名直接 400，剥掉。
  // MCP 传输/执行读的是原始 tool schema，不受影响。
  "x-mcp-header": true,
  // JSON Schema 注解关键字：Google/CCA wire schema 没有对应字段的纯元数据。
  // protojson 对未知字段直接拒绝（"Cannot find field"），MCP server 给参数标注
  // deprecated/readOnly/writeOnly 曾让整个请求 400。
  deprecated: true,
  readOnly: true,
  writeOnly: true,
  $comment: true,
};

/**
 * 有人类可读价值的校验/装饰关键字：provider 专属归一器把它们从 wire schema
 * 剥掉时，可以保留进兄弟 description。
 */
export const LIFTABLE_TO_DESCRIPTION_FIELDS: Record<string, true> = {
  pattern: true,
  format: true,
  minLength: true,
  maxLength: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  multipleOf: true,
  minItems: true,
  maxItems: true,
  uniqueItems: true,
  minProperties: true,
  maxProperties: true,
  default: true,
  examples: true,
};

/**
 * OpenAI strict 模式 sanitize 时剥离的非结构关键字：
 * 不影响 strict 强制的结构形状的装饰/纯校验关键字。
 */
export const NON_STRUCTURAL_SCHEMA_KEYS: Record<string, true> = {
  format: true,
  pattern: true,
  minLength: true,
  maxLength: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  minItems: true,
  maxItems: true,
  uniqueItems: true,
  multipleOf: true,
  $schema: true,
  examples: true,
  default: true,
  title: true,
  $comment: true,
  if: true,
  // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema 关键字
  then: true,
  else: true,
  not: true,
  unevaluatedProperties: true,
  unevaluatedItems: true,
  patternProperties: true,
  propertyNames: true,
  contains: true,
  minContains: true,
  maxContains: true,
  dependentRequired: true,
  dependentSchemas: true,
  contentEncoding: true,
  contentMediaType: true,
  contentSchema: true,
  deprecated: true,
  readOnly: true,
  writeOnly: true,
  minProperties: true,
  maxProperties: true,
  $dynamicRef: true,
  $dynamicAnchor: true,
};

/**
 * Cloud Code Assist 按 JSON Schema type 允许的类型专属键。
 * CCA Claude 混合类型 combiner 折叠时用。
 */
export const CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS: Record<string, Record<string, true>> = {
  array: {
    items: true,
    prefixItems: true,
    contains: true,
    minContains: true,
    maxContains: true,
    minItems: true,
    maxItems: true,
    uniqueItems: true,
    unevaluatedItems: true,
  },
  object: {
    properties: true,
    required: true,
    additionalProperties: true,
    patternProperties: true,
    propertyNames: true,
    minProperties: true,
    maxProperties: true,
    dependentRequired: true,
    dependentSchemas: true,
    unevaluatedProperties: true,
  },
  string: {
    minLength: true,
    maxLength: true,
    pattern: true,
    format: true,
    contentEncoding: true,
    contentMediaType: true,
  },
  number: { minimum: true, maximum: true, exclusiveMinimum: true, exclusiveMaximum: true, multipleOf: true },
  integer: { minimum: true, maximum: true, exclusiveMinimum: true, exclusiveMaximum: true, multipleOf: true },
  boolean: {},
  null: {},
};

/** 所有 CCA 类型的类型专属键的扁平集合：混合类型折叠时识别需要过滤的兄弟键。 */
export const ALL_CCA_TYPE_SPECIFIC_KEYS: Record<string, true> = buildAllCcaTypeSpecificKeys();

function buildAllCcaTypeSpecificKeys(): Record<string, true> {
  const all: Record<string, true> = {};
  for (const typeKeys of Object.values(CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS)) {
    for (const key in typeKeys) {
      all[key] = true;
    }
  }
  return all;
}

/** CCA 任意 type 上都允许的共享键（与类型专属键表配套用于 combiner 折叠）。 */
export const CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS: Record<string, true> = {
  title: true,
  description: true,
  default: true,
  examples: true,
};

/** schema 归一化各模块共用的 combinator 键（唯一定义点，避免漂移）。 */
export const COMBINATOR_KEYS = ["anyOf", "allOf", "oneOf"] as const;
