// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/dereference.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 本地 $ref/$defs 内联（解引用）
// ============================================================
// 让每个消费方不需要解析器就能看到完整定义。处理：
// - 本地 $ref 指针（#/$defs/Foo、#/definitions/Foo）
// - 嵌套 $defs/definitions 块
// - 循环引用（发 `{}` 断环）
// 解引用后根上的 $defs/definitions 被剥除。
// 注意：只解析 `$defs`/`definitions` 两段指针；`#/properties/...` 等其他本地
// 引用形态留给发送点的 MFJS hoist（spec R2.2），两条机制职责不重叠。

import { parseLocalRefPointer } from "./ref-pointer.js";
import { isJsonObject, type JsonObject } from "./types.js";

// 只有 schema 值关键字可能含引用；JSON 字面载荷是不透明数据。
const SCHEMA_MAP_KEYS: Record<string, true> = {
  properties: true,
  patternProperties: true,
  dependencies: true,
  dependentSchemas: true,
};
const SCHEMA_ARRAY_KEYS: Record<string, true> = { anyOf: true, oneOf: true, allOf: true, prefixItems: true };
const SCHEMA_VALUE_KEYS: Record<string, true> = {
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
  additionalProperties: true,
  unevaluatedItems: true,
  unevaluatedProperties: true,
};

function dereferenceKeyword(key: string, value: unknown, root: JsonObject, visiting: Set<string>): unknown {
  if (Object.hasOwn(SCHEMA_MAP_KEYS, key) && isJsonObject(value)) {
    const result: JsonObject = {};
    for (const name in value) result[name] = dereferenceNode(value[name], root, visiting);
    return result;
  }
  if ((Object.hasOwn(SCHEMA_ARRAY_KEYS, key) || key === "items") && Array.isArray(value)) {
    return value.map((item) => dereferenceNode(item, root, visiting));
  }
  if (Object.hasOwn(SCHEMA_VALUE_KEYS, key)) return dereferenceNode(value, root, visiting);
  return value;
}

/**
 * 把 JSON-pointer 形态的 $ref 对根 schema 的 $defs/definitions 块解析。
 * 外部引用或不可解析引用返回 undefined。
 */
function resolveLocalRef(ref: string, root: JsonObject): JsonObject | undefined {
  // 只处理本地引用：#/$defs/Name 或 #/definitions/Name
  const pointer = parseLocalRefPointer(ref);
  if (pointer === undefined || pointer.length !== 2) return undefined;
  const defsKey = pointer[0];
  if (defsKey !== "$defs" && defsKey !== "definitions") return undefined;
  const defs = root[defsKey];
  if (!isJsonObject(defs)) return undefined;
  const resolved = defs[pointer[1]!];
  return isJsonObject(resolved) ? resolved : undefined;
}

/** 递归解引用一个 JSON Schema 节点，内联全部本地 $ref 指针。 */
function dereferenceNode(node: unknown, root: JsonObject, visiting: Set<string>): unknown {
  if (!isJsonObject(node)) return node;

  const ref = node.$ref;
  if (typeof ref === "string") {
    // 断循环引用
    if (visiting.has(ref)) return {};
    const resolved = resolveLocalRef(ref, root);
    if (!resolved) return node; // 外部引用——原样保留
    visiting.add(ref);
    const inlined = dereferenceNode(resolved, root, visiting);
    visiting.delete(ref);

    // 合并引用节点上的兄弟关键字（如 description、default）：
    // draft 2020-12 里它们与 $ref 并存合法。
    let hasSiblings = false;
    for (const k in node) {
      if (k !== "$ref" && k !== "$defs" && k !== "definitions") {
        hasSiblings = true;
        break;
      }
    }
    if (!hasSiblings || !isJsonObject(inlined)) return inlined;
    const merged: JsonObject = { ...inlined };
    for (const key in node) {
      if (key === "$ref" || key === "$defs" || key === "definitions") continue;
      merged[key] = dereferenceKeyword(key, node[key], root, visiting);
    }
    return merged;
  }

  const result: JsonObject = {};
  for (const key in node) {
    const value = node[key];
    // 跳过 $defs/definitions——它们被内联进消费方
    if (key === "$defs" || key === "definitions") continue;

    result[key] = dereferenceKeyword(key, value, root, visiting);
  }
  return result;
}

/**
 * 解引用 JSON Schema 中的全部本地 $ref 指针，从 $defs/definitions 内联定义。
 * 输出剥除 $defs 块。非本地引用（如 http://...）原样保留；循环引用发 {} 断开。
 *
 * @returns 全部本地引用已内联的新 schema 对象；输入非对象或没有
 *          $defs/definitions 时原样返回输入（引用相等直通）。
 */
export function dereferenceJsonSchema(schema: unknown): unknown {
  if (!isJsonObject(schema)) return schema;

  // 快速路径：无物可解
  const hasDefs = schema.$defs !== undefined || schema.definitions !== undefined;
  if (!hasDefs) return schema;

  return dereferenceNode(schema, schema, new Set());
}
