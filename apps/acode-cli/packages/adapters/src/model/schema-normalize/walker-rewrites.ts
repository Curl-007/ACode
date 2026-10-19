// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// walker 节点级改写原语
// ============================================================
// 从 omp normalize.ts 拆出：snake_case 改名、null 折叠预处理、type 数组分支化、
// 异型关键字剔除、enum 类型推断与 spill 收集。normalize-core 与 combiner-collapse
// 共用。

import {
  ALL_CCA_TYPE_SPECIFIC_KEYS,
  CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS,
  LIFTABLE_TO_DESCRIPTION_FIELDS,
} from "./fields.js";
import { type DescriptionSpillFormat, spillToDescription } from "./spill.js";
import { areJsonValuesEqual } from "./equality.js";
import { classifySchemaChild, SNAKE_TO_CAMEL_RENAMES } from "./walker-keys.js";
import { isJsonObject, type JsonObject } from "./types.js";

/** walker 每节点的 spill 收集选项（liftStrippedToDescription 的解析形态）。 */
export interface SpillPolicy {
  readonly keys?: (key: string) => boolean;
  readonly format?: DescriptionSpillFormat;
}

export function outHasOwn(obj: JsonObject, key: string): boolean {
  return Object.hasOwn(obj, key);
}

/**
 * 无可改名键时原样返回 obj；否则返回 snake_case 键已改写的浅拷贝。
 * 碰撞规则与上游一致（pop(from) → set(to)）：snake_case 压过既有 camelCase
 * 条目（对齐 python-genai/_transformers.py:751）。
 */
export function applySnakeCaseRenames(obj: JsonObject): JsonObject {
  let needsRename = false;
  for (const k in obj) {
    if (!Object.hasOwn(obj, k)) continue;
    if (SNAKE_TO_CAMEL_RENAMES.has(k)) {
      needsRename = true;
      break;
    }
  }
  if (!needsRename) return obj;
  const out: JsonObject = {};
  for (const k in obj) {
    if (!Object.hasOwn(obj, k)) continue;
    const renamed = SNAKE_TO_CAMEL_RENAMES.get(k);
    if (renamed !== undefined) {
      out[renamed] = obj[k];
    } else if (!outHasOwn(out, k)) {
      out[k] = obj[k];
    }
  }
  return out;
}

/**
 * python-genai 的 handle_null_fields（_transformers.py:584-640），在父级、
 * 子递归**之前**应用——对齐上游 process_schema:768 的调用顺序。
 * 有变化时返回新对象，否则返回原引用（零分配快速路径）。
 */
export function preHandleNullFields(obj: JsonObject): JsonObject {
  if (obj.type === "null") {
    const out: JsonObject = {};
    for (const k in obj) {
      if (!Object.hasOwn(obj, k) || k === "type") continue;
      out[k] = obj[k];
    }
    out.nullable = true;
    return out;
  }
  if (!Array.isArray(obj.anyOf)) return obj;
  const variants = obj.anyOf as unknown[];
  let sawNull = false;
  const kept: unknown[] = [];
  for (const v of variants) {
    if (isJsonObject(v) && v.type === "null") {
      sawNull = true;
      continue;
    }
    kept.push(v);
  }
  if (!sawNull) return obj;
  const out: JsonObject = {};
  for (const k in obj) {
    if (Object.hasOwn(obj, k)) out[k] = obj[k];
  }
  out.nullable = true;
  if (kept.length === 0) {
    delete out.anyOf;
  } else if (kept.length === 1 && isJsonObject(kept[0])) {
    delete out.anyOf;
    const only = kept[0];
    for (const k in only) {
      if (Object.hasOwn(only, k) && !outHasOwn(out, k)) out[k] = only[k];
    }
  } else {
    out.anyOf = kept;
  }
  return out;
}

/**
 * 把多类型 type 数组（["string","array"]）改写为每个非 null 类型一个 anyOf 分支，
 * 每个分支只携带约束其类型的关键字。折叠到首个类型会收窄工具接受面、并搁浅其他
 * 类型的关键字：Gemini 对 type:"string" 旁的 items 直接 HTTP 400。null 成员变成
 * nullable:true（与标量折叠一致）。非 null 类型少于两个、或已带 anyOf 时返回原对象。
 */
export function splitTypeArrayIntoAnyOf(obj: JsonObject): JsonObject {
  if (!Array.isArray(obj.type) || Array.isArray(obj.anyOf)) return obj;
  const types: string[] = [];
  for (const type of obj.type) {
    if (typeof type === "string" && type !== "null" && !types.includes(type)) types.push(type);
  }
  if (types.length < 2) return obj;
  const branches = types.map((type) => {
    const schema: JsonObject = { type };
    return { schema, keys: CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[type] ?? {} };
  });
  const out: JsonObject = {};
  for (const key in obj) {
    if (!Object.hasOwn(obj, key) || key === "type") continue;
    const value = obj[key];
    if (!Object.hasOwn(ALL_CCA_TYPE_SPECIFIC_KEYS, key)) {
      out[key] = value;
      continue;
    }
    for (const branch of branches) {
      if (Object.hasOwn(branch.keys, key)) branch.schema[key] = value;
    }
  }
  if ((obj.type as unknown[]).includes("null")) out.nullable = true;
  out.anyOf = branches.map((branch) => branch.schema);
  return out;
}

/** 删除约束其他 JSON 类型的关键字，例如 string 节点上的 items。 */
export function dropForeignTypeKeywords(schema: JsonObject, type: string): void {
  const allowed = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[type] ?? {};
  for (const key in schema) {
    if (Object.hasOwn(ALL_CCA_TYPE_SPECIFIC_KEYS, key) && !Object.hasOwn(allowed, key)) delete schema[key];
  }
}

export function inferJsonSchemaTypeFromValue(value: unknown): string | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return undefined;
  }
}

export function pushEnumValue(values: unknown[], value: unknown): void {
  if (!values.some((existing) => areJsonValuesEqual(existing, value))) {
    values.push(value);
  }
}

export function pushStrippedDescriptionEntry(
  spill: Array<[string, unknown]> | undefined,
  key: string,
  value: unknown,
  lift: SpillPolicy | false,
): Array<[string, unknown]> | undefined {
  if (!lift) return spill;
  const isLiftable = lift.keys ?? isDefaultLiftableToDescriptionField;
  if (!isLiftable(key)) return spill;
  const next = spill ?? [];
  next.push([key, value]);
  return next;
}

export function applyDescriptionSpill(
  result: JsonObject,
  spill: Array<[string, unknown]> | undefined,
  lift: SpillPolicy | false,
): void {
  if (!lift || spill === undefined) return;
  spillToDescription(result, spill, lift.format ?? "spill");
}

function isDefaultLiftableToDescriptionField(key: string): boolean {
  return Object.hasOwn(LIFTABLE_TO_DESCRIPTION_FIELDS, key);
}

/**
 * Google 的 enum 字段只接受字符串值：子树里存在「空 enum、含非字符串成员的 enum、
 * 或非字符串 const」时为真——stringEnumsOnly 方言据此丢弃承载它的 not 约束
 * （丢掉否定约束只会放宽接受面，永不收窄）。
 */
export function hasUnrepresentableGoogleEnumConstraint(
  value: unknown,
  insideSchemaMap = false,
  seen = new Set<object>(),
): boolean {
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((entry) => hasUnrepresentableGoogleEnumConstraint(entry, false, seen));
  }
  if (!isJsonObject(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (insideSchemaMap) {
    for (const key in value) {
      if (Object.hasOwn(value, key) && hasUnrepresentableGoogleEnumConstraint(value[key], false, seen)) {
        return true;
      }
    }
    return false;
  }

  if (
    Array.isArray(value.enum) &&
    (value.enum.length === 0 || value.enum.some((enumValue) => typeof enumValue !== "string"))
  ) {
    return true;
  }
  if (Object.hasOwn(value, "const") && typeof value.const !== "string") return true;

  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const childKind = classifySchemaChild(key, value[key], false);
    if (childKind && hasUnrepresentableGoogleEnumConstraint(value[key], childKind === "map", seen)) {
      return true;
    }
  }
  return false;
}
