// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// Cursor 投影方言
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R1 #9。本波无消费者
// （Cursor 非 ACode provider）：纯入册，懒加载 + 单测锚定。
// Cursor 的 MCP 工具目录在任何广告 schema 携带组合关键字时对整个请求回
// provider 400（omp issue #10432）。本投影在各处消去 anyOf/oneOf/allOf，
// 保留可表达的引导信息，且**只加宽接受面**——规范 schema 接受的每个输入
// 在广告投影上仍被接受。执行期参数校验用的规范 schema 永不被改动。

import { mergeObjectCombinerVariants } from "./combiner-collapse.js";
import { mergePropertySchemas } from "./equality.js";
import { containsSchemaCombiner } from "./nullable-extraction.js";
import { dereferenceJsonSchema } from "./dereference.js";
import { enter, epochNext, exit } from "./stamps.js";
import { classifySchemaChild, copySchemaWithout, SCHEMA_COMPOSITION_COMBINERS } from "./walker-keys.js";
import { isJsonObject, type JsonObject } from "./types.js";

/**
 * 把一个已完成子节点投影的节点上的全部组合关键字折掉，且始终只加宽接受面。
 * 对象形状的 anyOf/oneOf/allOf 分支经 mergeObjectCombinerVariants 并进节点自身
 * properties（属性并集、combiner 语义对应的 required）；分支不全是对象形状的
 * combiner——尤其是标量 union——整体丢弃，让节点加宽为全接受而不是收窄到
 * 单个分支。合并本身可能在共享属性里合成新 anyOf（见 mergePropertySchemas），
 * 因此属性值被反复重投影直到节点无 combiner。
 */
function projectNodeCombinersForCursor(node: JsonObject): JsonObject {
  let current = node;
  let changed = true;
  while (changed) {
    changed = false;
    for (const combiner of SCHEMA_COMPOSITION_COMBINERS) {
      if (!Array.isArray(current[combiner])) continue;
      const source = current;
      const merged = mergeObjectCombinerVariants(current, combiner);
      if (merged !== current) {
        current = merged;
        const properties = current.properties;
        if (isJsonObject(properties)) {
          if (combiner !== "allOf") {
            const sourceProperties = isJsonObject(source.properties) ? source.properties : {};
            const sourceVariants = source[combiner] as JsonObject[];
            for (const name in properties) {
              if (!Object.hasOwn(properties, name)) continue;
              if (Object.hasOwn(sourceProperties, name)) {
                properties[name] = sourceProperties[name];
                continue;
              }
              let widenedProperty: unknown;
              for (const variant of sourceVariants) {
                const variantProperties = isJsonObject(variant.properties) ? variant.properties : {};
                let constraint: unknown;
                if (Object.hasOwn(variantProperties, name)) {
                  constraint = variantProperties[name];
                } else if (variant.additionalProperties === false) {
                  continue;
                } else if (isJsonObject(variant.additionalProperties)) {
                  constraint = variant.additionalProperties;
                } else {
                  constraint = {};
                }
                widenedProperty =
                  widenedProperty === undefined
                    ? constraint
                    : mergePropertySchemas(widenedProperty, constraint);
              }
              properties[name] = widenedProperty ?? {};
            }
          }
          for (const name in properties) {
            if (Object.hasOwn(properties, name)) {
              properties[name] = projectSchemaForCursor(properties[name], false);
            }
          }
        }
      } else {
        current = copySchemaWithout(current, combiner);
      }
      changed = true;
    }
  }
  return current;
}

function projectSchemaForCursor(value: unknown, insideSchemaMap: boolean): unknown {
  if (Array.isArray(value)) {
    if (!enter(value)) return [];
    try {
      return value.map((entry) => projectSchemaForCursor(entry, false));
    } finally {
      exit(value);
    }
  }
  if (!isJsonObject(value)) return value;
  if (!enter(value)) return {};
  try {
    const result: JsonObject = {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const entry = value[key];
      // not 子 schema 是否定约束：加宽其内容会让否定拒绝规范 schema 的超集。
      // Cursor 携带不了该 combiner，也不存在忠实加宽，因此整个否定丢弃——
      // 永远可靠，因为移除限制只会扩大接受面（修 `not: {}` 反转，omp issue #10432）。
      if (!insideSchemaMap && key === "not" && containsSchemaCombiner(entry, false, epochNext())) {
        continue;
      }
      const childKind = classifySchemaChild(key, entry, insideSchemaMap);
      result[key] = childKind ? projectSchemaForCursor(entry, childKind === "map") : entry;
    }
    return insideSchemaMap ? result : projectNodeCombinersForCursor(result);
  } finally {
    exit(value);
  }
}

/** 把工具的 wire schema 投影到 Cursor MCP 工具目录接受的子集（先解引用）。 */
export function sanitizeSchemaForCursor(schema: JsonObject): JsonObject {
  return projectSchemaForCursor(dereferenceJsonSchema(schema), false) as JsonObject;
}
