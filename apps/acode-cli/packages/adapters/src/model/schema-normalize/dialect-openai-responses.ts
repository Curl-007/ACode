// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// OpenAI Responses 方言（spec R1 #2，必做路径）
// ============================================================
// OpenAI Responses 即使关闭 strict 也拒绝工具 schema 里的 oneOf，且要求每个
// type:"object" 节点带 properties 成员。只归一 schema 值位置，enum/const/
// default/examples 下的字面载荷保持不变。
// 引用保持：无改写时按原引用返回，调用方可用引用相等去重（strict 缓存保温）。
// 节点同时有 oneOf 与 anyOf 时两者拼接（wire 载荷只接受单个 union；
// 同时保留活不下来）。

import { isJsonObject, isJsonObjectEmpty, type JsonObject } from "./types.js";

const OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const OPENAI_RESPONSES_SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  // dependencies 是 Draft-04..07 的 schema 值形态；老 MCP server 仍会发
  // { dependencies: { foo: { type: "object" } } }。字符串数组分支在
  // normalizeOpenAIResponsesSchemaNode 里原样通过（非对象直接返回）。
  "dependencies",
  "dependentSchemas",
  "$defs",
  "definitions",
]);
const OPENAI_RESPONSES_SCHEMA_VALUE_KEYS = new Set([
  "items",
  "additionalItems",
  "contains",
  "contentSchema",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS = new Set(["=", "!", "<=", "<!"]);
const OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK = ".*";

export function sanitizeSchemaForOpenAIResponses(schema: JsonObject): JsonObject {
  return normalizeOpenAIResponsesSchemaNode(schema, new WeakMap()) as JsonObject;
}

/** 与 normalizeSchemaFor* 分发器命名对齐的别名。 */
export const normalizeSchemaForOpenAIResponses: (schema: JsonObject) => JsonObject =
  sanitizeSchemaForOpenAIResponses;

function hasOpenAIUnsupportedRegexLookaround(pattern: string): boolean {
  let groupStart = pattern.indexOf("(?");
  while (groupStart !== -1) {
    let escapes = 0;
    for (let i = groupStart - 1; i >= 0 && pattern[i] === "\\"; i--) escapes += 1;
    if (escapes % 2 === 0) {
      const operator =
        pattern[groupStart + 2] === "<" ? pattern.slice(groupStart + 2, groupStart + 4) : pattern[groupStart + 2];
      if (OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS.has(operator)) return true;
    }
    groupStart = pattern.indexOf("(?", groupStart + 2);
  }
  return false;
}

function normalizeOpenAIResponsesSchemaNode(value: unknown, cache: WeakMap<JsonObject, unknown>): unknown {
  if (!isJsonObject(value)) return value;

  // {}（空 JSON Schema）≡ true（draft 2020-12 §4.3.1）。grammar 约束采样器
  // （llama.cpp 等）把对象形态当「生成一个空对象」而不是「任意 JSON 值」
  // （omp issue #1179）。ACode 没有 toolWireSchema 的 normalizeEmptySchemas
  // 上游步骤，本守卫因此是发送面的唯一安全网（spec 已知限制）。
  if (isJsonObjectEmpty(value)) return true;

  const cached = cache.get(value);
  if (cached) return cached;

  // 递归**前**用进行中的 output 种 cache：子节点在遍历中途重入本节点时拿到
  // 半成品而不是触发无限递归。循环命中种入条目会强制下方 changed = true
  // （cache 的半成品与 value 引用不同），因此最终的 cache.set(value, result)
  // 不会在循环输入上把种子静默覆盖回 value。
  const output: JsonObject = {};
  cache.set(value, output);

  let changed = false;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    // 只丢弃形状良好的 oneOf 数组；循环后以 anyOf 重新发射，让相邻 anyOf
    // 条目可以拼接。非数组 oneOf 对 wire 是畸形的，但原样保留，让调用方
    // 看到原始载荷而不是被静默吞掉。
    if (key === "oneOf" && Array.isArray(value.oneOf)) {
      changed = true;
      continue;
    }
    if (
      key === "pattern" &&
      typeof value.pattern === "string" &&
      hasOpenAIUnsupportedRegexLookaround(value.pattern)
    ) {
      changed = true;
      continue;
    }

    const child = value[key];
    let next: unknown = child;
    if (key === "patternProperties" && isJsonObject(child)) {
      next = normalizeOpenAIResponsesSchemaMap(child, cache, true);
    } else if (OPENAI_RESPONSES_SCHEMA_MAP_KEYS.has(key) && isJsonObject(child)) {
      next = normalizeOpenAIResponsesSchemaMap(child, cache, false);
    } else if (OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      next = normalizeOpenAIResponsesSchemaArray(child, cache);
    } else if (OPENAI_RESPONSES_SCHEMA_VALUE_KEYS.has(key) && isJsonObject(child)) {
      next = normalizeOpenAIResponsesSchemaNode(child, cache);
    }

    if (next !== child) changed = true;
    output[key] = next;
  }

  if (Array.isArray(value.oneOf)) {
    const rewrittenOneOf = normalizeOpenAIResponsesSchemaArray(value.oneOf, cache);
    const existingAnyOf = output.anyOf;
    output.anyOf = Array.isArray(existingAnyOf)
      ? [...existingAnyOf, ...(rewrittenOneOf as unknown[])]
      : rewrittenOneOf;
  }

  // draft 2020-12 允许 type 是数组（如 ["object","null"]）；任何包含 "object"
  // 的变体都按对象位置处理 properties 补齐要求。
  if (declaresObjectType(value.type) && !Object.hasOwn(value, "properties")) {
    output.properties = {};
    changed = true;
  }

  // 覆盖种子是安全的：上面的循环重入已观察到种入的半成品并为该节点置
  // changed = true，因此以 changed === false 结束的节点可证无环且与输入引用相等。
  const result = changed ? (isJsonObjectEmpty(output) ? true : output) : value;
  cache.set(value, result);
  return result;
}

function declaresObjectType(type: unknown): boolean {
  if (type === "object") return true;
  if (!Array.isArray(type)) return false;
  for (const variant of type) {
    if (variant === "object") return true;
  }
  return false;
}

function normalizeOpenAIResponsesSchemaArray(value: unknown[], cache: WeakMap<JsonObject, unknown>): unknown[] {
  let changed = false;
  const output = value.map((item) => {
    const next = normalizeOpenAIResponsesSchemaNode(item, cache);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? output : value;
}

function normalizeOpenAIResponsesSchemaMap(
  schemaMap: JsonObject,
  cache: WeakMap<JsonObject, unknown>,
  stripUnsupportedRegexKeys: boolean,
): JsonObject {
  let changed = false;
  const output: JsonObject = {};
  for (const key in schemaMap) {
    if (!Object.hasOwn(schemaMap, key)) continue;
    const child = schemaMap[key];
    const next = normalizeOpenAIResponsesSchemaNode(child, cache);
    if (next !== child) changed = true;
    if (stripUnsupportedRegexKeys && hasOpenAIUnsupportedRegexLookaround(key)) {
      changed = true;
      appendOpenAIResponsesFallbackPatternProperty(output, next);
      continue;
    }
    output[key] = next;
  }
  return changed ? output : schemaMap;
}

/** lookaround 正则键被剥后，其子 schema 并进 ".*" 回退键（多个时 anyOf 聚合）。 */
function appendOpenAIResponsesFallbackPatternProperty(output: JsonObject, schema: unknown): void {
  const existing = output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK];
  if (existing === undefined) {
    output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK] = schema;
    return;
  }
  if (isJsonObject(existing) && Array.isArray(existing.anyOf) && Object.keys(existing).length === 1) {
    existing.anyOf = [...existing.anyOf, schema];
    return;
  }
  output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK] = { anyOf: [existing, schema] };
}
