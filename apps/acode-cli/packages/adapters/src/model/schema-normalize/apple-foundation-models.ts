// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/foundation-models.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// Apple Foundation Models lowering 方言
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R1 #10。本波无消费者
// （apple-fm provider 未接）：纯入册，懒加载 + 单测锚定。
//
// 把工具 JSON Schema 降级进 Apple GenerationSchema 的 Codable 解码器接受的方言。
// 解码器很严格：每个 object 需要 title、x-order（同时决定生成的属性）、required、
// additionalProperties:false；anyOf 需要 title；节点必须携带 type、const、$ref 或
// anyOf 之一。表达不了的构造——自由 map、开放 {} 子 schema、tuple、混合类型 enum、
// allOf——改为生成 JSON 编码字符串，decodeFoundationModelsArguments 再把它们解析
// 回来，让工具收到其 schema 描述的参数。

import { dereferenceJsonSchema } from "./dereference.js";
import { isJsonObject, type JsonObject } from "./types.js";

/** Foundation Models GenerationSchema 方言的工具参数。 */
export interface FoundationModelsSchema {
  /** GenerationSchema 解码器接受的根对象 schema。 */
  schema: JsonObject;
  /** 模型以 JSON 编码字符串发射值的参数路径；"*" 匹配每个数组元素。 */
  encodedPaths: string[][];
}

const ENCODED_SUFFIX = "(JSON-encoded value)";

/** 把工具的 wire JSON Schema 转换进 Foundation Models 方言。 */
export function toFoundationModelsSchema(schema: unknown, name: string): FoundationModelsSchema {
  const encodedPaths: string[][] = [];
  const root = dereferenceJsonSchema(schema);
  const lowered = lower(root, titleOf(name), [], encodedPaths);
  if (lowered?.type === "object") return { schema: lowered, encodedPaths };
  // 只有对象是合法工具参数；开放根表示不接参数。
  return { schema: object(titleOf(name), {}, [], describe(root)), encodedPaths: [] };
}

/** 解析 encodedPaths 对应位置上模型产出的 JSON 编码参数字符串。 */
export function decodeFoundationModelsArguments(
  args: Record<string, unknown>,
  encodedPaths: readonly string[][],
): Record<string, unknown> {
  for (const path of encodedPaths) decodeAt(args, path, 0);
  return args;
}

function decodeAt(container: unknown, path: readonly string[], index: number): void {
  const key = path[index];
  const last = index === path.length - 1;
  if (key === "*") {
    if (!Array.isArray(container)) return;
    for (let i = 0; i < container.length; i++) {
      if (last) container[i] = parseEncoded(container[i]);
      else decodeAt(container[i], path, index + 1);
    }
    return;
  }
  if (!isJsonObject(container) || !Object.hasOwn(container, key)) return;
  if (last) container[key] = parseEncoded(container[key]);
  else decodeAt(container[key], path, index + 1);
}

function parseEncoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 降级一个子 schema。节点不可表达时返回 undefined；调用方随后在 encoded
 * 非 null 时把它编码为 JSON 字符串，或（在 anyOf 内部，编码分支会让解码
 * 有歧义）向上传播失败。
 */
function lower(node: unknown, title: string, path: string[], encoded: string[][] | null): JsonObject | undefined {
  if (!isJsonObject(node)) return undefined;
  const description = describe(node);
  const lowered = lowerShape(node, title, path, encoded);
  if (lowered && description !== undefined && lowered.description === undefined) {
    lowered.description = description;
  }
  return lowered;
}

function lowerShape(
  node: JsonObject,
  title: string,
  path: string[],
  encoded: string[][] | null,
): JsonObject | undefined {
  if (Object.hasOwn(node, "const")) {
    return typeof node.const === "string" ? { const: node.const } : undefined;
  }
  if (Array.isArray(node.enum)) {
    return node.enum.length > 0 && node.enum.every((value) => typeof value === "string")
      ? { type: "string", enum: node.enum }
      : undefined;
  }
  const branches = [
    ...(Array.isArray(node.anyOf) ? node.anyOf : []),
    ...(Array.isArray(node.oneOf) ? node.oneOf : []),
  ];
  if (branches.length > 0) return lowerUnion(node, branches, title, path, encoded);
  if (Array.isArray(node.allOf)) {
    if (node.allOf.length !== 1 || !isJsonObject(node.allOf[0])) return undefined;
    const { allOf: _allOf, ...rest } = node;
    return lower({ ...rest, ...node.allOf[0] }, title, path, encoded);
  }
  if (Array.isArray(node.type)) {
    const types = [...new Set(node.type.filter((type) => type !== "null"))];
    if (types.length === 0) return { type: "null" };
    if (types.length === 1) return lowerShape({ ...node, type: types[0] }, title, path, encoded);
    return lowerUnion(
      node,
      types.map((type) => ({ ...node, type })),
      title,
      path,
      encoded,
    );
  }
  const type = node.type ?? (isJsonObject(node.properties) ? "object" : undefined);
  switch (type) {
    case "string":
    case "boolean":
    case "null":
      return { type };
    case "integer":
    case "number": {
      const out: JsonObject = { type };
      if (typeof node.minimum === "number") out.minimum = node.minimum;
      if (typeof node.maximum === "number") out.maximum = node.maximum;
      return out;
    }
    case "array":
      return lowerArray(node, title, path, encoded);
    case "object":
      return lowerObject(node, title, path, encoded);
    default:
      return undefined;
  }
}

function lowerUnion(
  node: JsonObject,
  branches: unknown[],
  title: string,
  path: string[],
  encoded: string[][] | null,
): JsonObject | undefined {
  const { anyOf: _anyOf, oneOf: _oneOf, type: _type, ...shared } = node;
  const options = branches.filter((branch) => !(isJsonObject(branch) && branch.type === "null"));
  if (options.length === 0) return { type: "null" };
  if (options.length === 1) {
    return isJsonObject(options[0]) ? lower({ ...shared, ...options[0] }, title, path, encoded) : undefined;
  }
  const literals = options.flatMap((option) => stringLiterals(option) ?? [null]);
  if (!literals.includes(null)) return { type: "string", enum: [...new Set(literals as string[])] };
  const anyOf: JsonObject[] = [];
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const lowered = lower(isJsonObject(option) ? { ...shared, ...option } : option, `${title}_${i}`, path, null);
    if (!lowered) return undefined;
    delete lowered.description;
    anyOf.push(lowered);
  }
  return { title, anyOf };
}

function stringLiterals(node: unknown): string[] | undefined {
  if (!isJsonObject(node)) return undefined;
  if (typeof node.const === "string") return [node.const];
  if (Array.isArray(node.enum) && node.enum.every((value) => typeof value === "string")) {
    return node.enum as string[];
  }
  return undefined;
}

function lowerArray(
  node: JsonObject,
  title: string,
  path: string[],
  encoded: string[][] | null,
): JsonObject | undefined {
  if (Array.isArray(node.items) || Array.isArray(node.prefixItems)) return undefined;
  const items = child(node.items ?? true, `${title}_item`, [...path, "*"], encoded);
  if (!items) return undefined;
  const out: JsonObject = { type: "array", items };
  if (typeof node.minItems === "number") out.minItems = node.minItems;
  if (typeof node.maxItems === "number") out.maxItems = node.maxItems;
  return out;
}

function lowerObject(
  node: JsonObject,
  title: string,
  path: string[],
  encoded: string[][] | null,
): JsonObject | undefined {
  const properties = isJsonObject(node.properties) ? node.properties : {};
  const keys = Object.keys(properties);
  // 无属性且未显式闭合的对象是自由 map——GenerationSchema 表达不了。
  if (keys.length === 0 && node.additionalProperties !== false) return undefined;
  const lowered: JsonObject = {};
  for (const key of keys) {
    const property = child(properties[key], `${title}_${titleOf(key)}`, [...path, key], encoded);
    if (!property) return undefined;
    lowered[key] = property;
  }
  const required = Array.isArray(node.required)
    ? node.required.filter((key): key is string => typeof key === "string" && Object.hasOwn(lowered, key))
    : [];
  return object(title, lowered, required, undefined);
}

/** 降级嵌套子 schema；不允许时回退为 JSON 编码字符串。 */
function child(node: unknown, title: string, path: string[], encoded: string[][] | null): JsonObject | undefined {
  const lowered = lower(node, title, path, encoded);
  if (lowered || !encoded) return lowered;
  encoded.push(path);
  const description = isJsonObject(node) ? describe(node) : undefined;
  return { type: "string", description: description ? `${description} ${ENCODED_SUFFIX}` : ENCODED_SUFFIX };
}

function object(
  title: string,
  properties: JsonObject,
  required: string[],
  description: string | undefined,
): JsonObject {
  const out: JsonObject = {
    type: "object",
    title,
    properties,
    required,
    "x-order": Object.keys(properties),
    additionalProperties: false,
  };
  if (description !== undefined) out.description = description;
  return out;
}

function describe(node: unknown): string | undefined {
  return isJsonObject(node) && typeof node.description === "string" ? node.description : undefined;
}

function titleOf(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}
