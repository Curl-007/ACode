// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// Ollama 与 grammar（llama.cpp/LM Studio/vLLM）方言
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R1 #7/#8。本波无消费者
// （本地推理后端未接）：纯入册，懒加载 + 单测锚定。
// 注意：omp 里两个方言消费 toolWireSchema 产物（空 schema 已归一为布尔 true）；
// ACode 无该上游步骤，布尔加宽因此是防御性路径（spec 已知限制）。

import { SUBSCHEMA_ARRAY_KEYS, SUBSCHEMA_MAP_KEYS } from "./walker-keys.js";
import { isJsonObject, type JsonObject } from "./types.js";

const OLLAMA_SCHEMA_VALUE_KEYS = new Set([
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

/**
 * wire 无法编码裸布尔子 schema 的后端上，`true`/`{}` 开放子 schema 的加宽替身。
 * 两个后端都会在裸布尔上噎住：Ollama 的 Go 工具解析器无法把它 unmarshal 进
 * 对象形状的 Schema struct；llama.cpp 的 JSON-schema→GBNF 转换器没有布尔 schema
 * 分支（omp issue #5914）。两个 sanitizer 都把开放子 schema 替换为全部原始 JSON
 * 类型的显式 union——wire 上没有布尔子 schema，grammar 采样器看到的是真实的值
 * union 而不是封闭空对象。
 */
const OPEN_SUBSCHEMA_WIDENING = Object.freeze({
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "object" },
    { type: "array" },
    { type: "null" },
  ],
});

/**
 * 改写 Ollama 的 Go `/api/chat` 工具解析器无法 unmarshal 进对象形状 Schema
 * struct 的标准 JSON Schema 形态：布尔子 schema、type 数组、布尔对象开放度关键字。
 */
export function sanitizeSchemaForOllama(schema: JsonObject): JsonObject {
  const normalizeNode = (value: unknown): unknown => {
    if (value === true) return OPEN_SUBSCHEMA_WIDENING;
    if (value === false) return { not: OPEN_SUBSCHEMA_WIDENING };
    if (!isJsonObject(value)) {
      if (!Array.isArray(value)) return value;
      let changed = false;
      const output = value.map((item) => {
        const next = normalizeNode(item);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? output : value;
    }

    let changed = false;
    const output: JsonObject = {};
    let typeAlternatives: JsonObject[] | undefined;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const child = value[key];
      if ((key === "additionalProperties" || key === "unevaluatedProperties") && typeof child === "boolean") {
        changed = true;
        continue;
      }
      if (key === "type" && Array.isArray(child)) {
        const variants = child.filter((entry): entry is string => typeof entry === "string");
        const uniqueVariants = [...new Set(variants)];
        const nonNull = uniqueVariants.filter((entry) => entry !== "null");
        if (nonNull.length <= 1) {
          output.type = nonNull[0] ?? uniqueVariants[0] ?? child[0];
        } else {
          typeAlternatives = uniqueVariants.map((entry) => ({ type: entry }));
        }
        changed = true;
        continue;
      }

      let next = child;
      if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, key) && isJsonObject(child)) {
        let mapChanged = false;
        const mapOutput: JsonObject = {};
        for (const childKey in child) {
          if (!Object.hasOwn(child, childKey)) continue;
          const mapChild = child[childKey];
          const normalizedChild = normalizeNode(mapChild);
          if (normalizedChild !== mapChild) mapChanged = true;
          mapOutput[childKey] = normalizedChild;
        }
        next = mapChanged ? mapOutput : child;
      } else if (Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, key) && Array.isArray(child)) {
        let arrayChanged = false;
        const arrayOutput = child.map((item) => {
          const normalizedItem = normalizeNode(item);
          if (normalizedItem !== item) arrayChanged = true;
          return normalizedItem;
        });
        next = arrayChanged ? arrayOutput : child;
      } else if (OLLAMA_SCHEMA_VALUE_KEYS.has(key)) {
        next = normalizeNode(child);
      }
      if (next !== child) changed = true;
      output[key] = next;
    }

    if (typeAlternatives) {
      const existingAllOf = output.allOf;
      const typeUnion = { anyOf: typeAlternatives };
      output.allOf = Array.isArray(existingAllOf) ? [typeUnion, ...existingAllOf] : [typeUnion];
    }

    return changed ? output : value;
  };
  return normalizeNode(schema) as JsonObject;
}

/**
 * 需要为 grammar 约束后端加宽裸布尔值的 schema 值关键字。
 * 排除 additionalProperties 与 unevaluatedProperties：llama.cpp 的
 * _build_object_rule 把它们的布尔形态读作有意义的闭合/开放对象语义，
 * 而 additionalProperties:false 恰是严格对象形状的锚点。
 */
const GRAMMAR_SCHEMA_VALUE_KEYS: Record<string, true> = {
  items: true,
  additionalItems: true,
  contains: true,
  contentSchema: true,
  propertyNames: true,
  if: true,
  // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema 关键字
  then: true,
  else: true,
  not: true,
  unevaluatedItems: true,
};

/**
 * 改写 grammar 约束 OpenAI-compatible 后端（llama.cpp、LM Studio、vLLM）
 * 无法编译成 GBNF 的唯一 JSON Schema 形态：裸布尔子 schema。llama.cpp 的
 * json-schema-to-grammar.cpp visit() 没有布尔 schema 分支，会抛
 * `Unrecognized schema: true` → 模型被咨询前就 HTTP 400（omp issue #5914）。
 *
 * 比 sanitizeSchemaForOllama 更窄：只加宽真正的子 schema 槽位。布尔
 * additionalProperties/unevaluatedProperties 保持原样——转换器把它们读作
 * 闭合/开放对象的 grammar 语义，丢掉 additionalProperties:false 会静默
 * 重新打开每个已声明对象。
 */
export function sanitizeSchemaForGrammar(schema: JsonObject): JsonObject {
  const normalizeNode = (value: unknown, isSubschema: boolean): unknown => {
    if (value === true) return isSubschema ? OPEN_SUBSCHEMA_WIDENING : value;
    if (value === false) return isSubschema ? { not: OPEN_SUBSCHEMA_WIDENING } : value;
    if (Array.isArray(value)) {
      let changed = false;
      const output = value.map((item) => {
        const next = normalizeNode(item, isSubschema);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? output : value;
    }
    if (!isJsonObject(value)) return value;

    let changed = false;
    const output: JsonObject = {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const child = value[key];
      let next = child;
      if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, key) && isJsonObject(child)) {
        let mapChanged = false;
        const mapOutput: JsonObject = {};
        for (const childKey in child) {
          if (!Object.hasOwn(child, childKey)) continue;
          const mapChild = child[childKey];
          const normalizedChild = normalizeNode(mapChild, true);
          if (normalizedChild !== mapChild) mapChanged = true;
          mapOutput[childKey] = normalizedChild;
        }
        next = mapChanged ? mapOutput : child;
      } else if (Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, key) && Array.isArray(child)) {
        let arrayChanged = false;
        const arrayOutput = child.map((item) => {
          const normalizedItem = normalizeNode(item, true);
          if (normalizedItem !== item) arrayChanged = true;
          return normalizedItem;
        });
        next = arrayChanged ? arrayOutput : child;
      } else if (Object.hasOwn(GRAMMAR_SCHEMA_VALUE_KEYS, key)) {
        next = normalizeNode(child, true);
      } else if ((key === "additionalProperties" || key === "unevaluatedProperties") && typeof child !== "boolean") {
        // 布尔形态是有意义的闭合/开放对象 grammar 语义，保持原样；
        // 对象形态是真正的子 schema，内部仍可能藏裸布尔。
        next = normalizeNode(child, true);
      }
      if (next !== child) changed = true;
      output[key] = next;
    }
    return changed ? output : value;
  };
  return normalizeNode(schema, true) as JsonObject;
}
