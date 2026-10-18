// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/draft.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// draft-07 → JSON Schema 2020-12 升级
// ============================================================
// 让扩展/MCP/zod 旧形状 schema 与「拒绝 draft-07 tuple 与 dependencies 关键字」的
// provider 工具校验器兼容。所有归一方言的统一前置步骤（normalize-core / adapt）。

import { formatLocalRefPointer, parseLocalRefPointer } from "./ref-pointer.js";
import { areJsonValuesEqual } from "./equality.js";
import { epochNext, once } from "./stamps.js";
import { isJsonObject, type JsonObject } from "./types.js";

export const JSON_SCHEMA_DRAFT_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";

/** 识别为需要升级的 draft-07 schema URI。尾部 `#` 是规范形，但 provider（和 zod）两种都发。 */
const DRAFT_07_SCHEMA_URIS: Record<string, true> = {
  "http://json-schema.org/draft-07/schema#": true,
  "https://json-schema.org/draft-07/schema#": true,
  "http://json-schema.org/draft-07/schema": true,
  "https://json-schema.org/draft-07/schema": true,
};

/**
 * 值为「属性名 → schema」映射的键。递归进映射的每个条目而不是映射对象本身，
 * 让属性 schema 内部的 legacy `definitions` 形态引用也被改写。
 */
const SCHEMA_MAP_KEYS: Record<string, true> = { properties: true, patternProperties: true, dependentSchemas: true };
/**
 * 值是 JSON 字面量而非嵌套 schema 的键。升级 walker **不得**下降进去——
 * `type: ["string","null"]` 不是 schema，递归会腐蚀 enum/const/default 载荷。
 */
const NON_SCHEMA_VALUE_KEYS: Record<string, true> = {
  const: true,
  default: true,
  enum: true,
  example: true,
  examples: true,
  required: true,
  dependentRequired: true,
  type: true,
};

/**
 * 把 draft-07 的 `#/definitions/Foo` 引用形态改写为 2020-12 的 `#/$defs/Foo`，
 * 先用共享 pointer 解析器解码 `#%2Fdefinitions%2Ffoo` 之类的 URI-fragment 拼写。
 * 外部引用（`http://…`）直通。
 */
function convertRef(value: string): string {
  const pointer = parseLocalRefPointer(value);
  if (pointer === undefined || pointer[0] !== "definitions") return value;
  return formatLocalRefPointer(["$defs", ...pointer.slice(1)]);
}

/** 取或建 `target[key]` 上的子对象映射：转换期惰性搭建 $defs/dependentRequired/dependentSchemas。 */
function getObjectMap(target: JsonObject, key: string): JsonObject {
  const existing = target[key];
  if (isJsonObject(existing)) return existing;
  const next: JsonObject = {};
  target[key] = next;
  return next;
}

/** 递归升级 schema-map（如 properties）的每个条目并合并进 target[key]。 */
function mergeSchemaMap(target: JsonObject, key: string, value: JsonObject, cache: WeakMap<object, unknown>): void {
  const map = getObjectMap(target, key);
  for (const name in value) {
    map[name] = upgradeJsonSchemaTo202012Impl(value[name], cache);
  }
}

/** 带升级地复制 schema-map 字段；非对象值原样直通。 */
function copySchemaMap(target: JsonObject, key: string, value: unknown, cache: WeakMap<object, unknown>): void {
  if (!isJsonObject(value)) {
    target[key] = value;
    return;
  }
  mergeSchemaMap(target, key, value, cache);
}

/**
 * 求两个 schema 的交（draft-07 dependencies 映射键互相冲突、或与既有
 * dependentSchemas 条目冲突时用）。
 * - `true`/undefined 是单位元（匹配一切）。
 * - `false` 是零元（什么都不匹配）。
 * - 相等 schema 折叠；否则包 allOf 让两者都继续生效。
 */
function combineSchemas(left: unknown, right: unknown): unknown {
  if (left === undefined || left === true) return right;
  if (right === undefined || right === true) return left;
  if (left === false || right === false) return false;
  if (areJsonValuesEqual(left, right)) return left;
  return { allOf: [left, right] };
}

/** 两个 JSON 值数组求并（深比较去重）：合并 dependentRequired 数组用。 */
function mergeArrayValues(left: unknown[], right: unknown[]): unknown[] {
  const merged = [...left];
  for (const value of right) {
    if (!merged.some((existing) => areJsonValuesEqual(existing, value))) {
      merged.push(value);
    }
  }
  return merged;
}

/**
 * 把转换后的 tuple items 合并进既有 prefixItems 数组。同一索引已有 schema
 * （例如先前经 cache 的递归 pass 写入）时求交，让两个约束都存活。
 */
function mergePrefixItems(existing: unknown, convertedItems: unknown[]): unknown[] {
  if (!Array.isArray(existing)) return convertedItems;
  const merged = [...existing];
  for (let index = 0; index < convertedItems.length; index += 1) {
    merged[index] = index in merged ? combineSchemas(merged[index], convertedItems[index]) : convertedItems[index];
  }
  return merged;
}

/** 把 `key → deps` 记入 dependentRequired，与既有条目求并。 */
function mergeDependentRequired(target: JsonObject, key: string, deps: unknown[]): void {
  const dependentRequired = getObjectMap(target, "dependentRequired");
  const existing = dependentRequired[key];
  if (existing === undefined) {
    dependentRequired[key] = deps;
    return;
  }
  if (Array.isArray(existing)) {
    dependentRequired[key] = mergeArrayValues(existing, deps);
  }
}

/** 把 `key → schema` 记入 dependentSchemas，与既有条目求交。 */
function mergeDependentSchema(target: JsonObject, key: string, schema: unknown): void {
  const dependentSchemas = getObjectMap(target, "dependentSchemas");
  dependentSchemas[key] = combineSchemas(dependentSchemas[key], schema);
}

/**
 * 把 draft-07 的 dependencies 关键字（数组依赖与 schema 依赖混在一个键下）
 * 转换为 2020-12 的拆分形态：数组值 → dependentRequired；schema 值 → dependentSchemas。
 */
function convertDependencies(source: JsonObject, target: JsonObject, cache: WeakMap<object, unknown>): void {
  const dependencies = source.dependencies;
  if (!isJsonObject(dependencies)) return;
  for (const key in dependencies) {
    const dependency = dependencies[key];
    const converted = upgradeJsonSchemaTo202012Impl(dependency, cache);
    if (Array.isArray(converted)) {
      mergeDependentRequired(target, key, converted);
    } else {
      mergeDependentSchema(target, key, converted);
    }
  }
}

/** type 是 "null" 或包含 "null" 的数组时为真。 */
function hasNullType(type: unknown): boolean {
  return type === "null" || (Array.isArray(type) && type.includes("null"));
}

/** anyOf 中已有（仅）null type 变体时为真：避免重复追加 {type:"null"}。 */
function hasNullVariant(variants: unknown[]): boolean {
  return variants.some((variant) => isJsonObject(variant) && hasNullType(variant.type));
}

/**
 * 原地修改 schema 使其接受 null。策略取决于现有形状：
 *   - 标量 type → 扩为 [type, "null"]。
 *   - type 数组 → 缺 "null" 则追加。
 *   - 既有 anyOf → 缺 null 分支则追加 {type:"null"}。
 *   - 其他 → 整个 schema 包进 anyOf:[schema, {type:"null"}]。
 * 返回结果对象（可能是新包装）。
 */
function makeNullable(schema: JsonObject): JsonObject {
  const type = schema.type;
  if (typeof type === "string") {
    if (type !== "null") schema.type = [type, "null"];
    return schema;
  }
  if (Array.isArray(type)) {
    if (!type.includes("null")) schema.type = [...type, "null"];
    return schema;
  }
  if (Array.isArray(schema.anyOf)) {
    if (!hasNullVariant(schema.anyOf)) schema.anyOf = [...schema.anyOf, { type: "null" }];
    return schema;
  }
  return { anyOf: [schema, { type: "null" }] };
}

/** schema-map 任一条目需要升级即为真：pre-check 期跳过完整克隆的捷径。 */
function schemaMapNeedsDraft202012Upgrade(value: unknown, epoch: number): boolean {
  if (!isJsonObject(value)) return false;
  for (const k in value) {
    if (schemaNeedsDraft202012UpgradeImpl(value[k], epoch)) return true;
  }
  return false;
}

/**
 * 便宜的前置检查：走一遍 schema 找升级 pass 必须改写的键/值，
 * 让公开入口在无事可做时短路、按引用原样返回输入。
 * 用 once(value, epoch) 断环，不做每调用集合分配。
 */
function schemaNeedsDraft202012UpgradeImpl(value: unknown, epoch: number): boolean {
  if (Array.isArray(value)) {
    if (!once(value, epoch)) return false;
    return value.some((entry) => schemaNeedsDraft202012UpgradeImpl(entry, epoch));
  }
  if (!isJsonObject(value)) return false;
  if (!once(value, epoch)) return false;

  for (const key in value) {
    const entry = value[key];
    if (key === "$schema") {
      if (typeof entry === "string" && entry in DRAFT_07_SCHEMA_URIS) return true;
      continue;
    }
    if (key === "definitions" || key === "dependencies" || key === "additionalItems" || key === "nullable") {
      return true;
    }
    if (key === "$ref") {
      if (typeof entry === "string" && entry.startsWith("#/definitions/")) return true;
      continue;
    }
    if (key === "items" && Array.isArray(entry)) return true;
    if (key === "$defs" || key in SCHEMA_MAP_KEYS) {
      if (schemaMapNeedsDraft202012Upgrade(entry, epoch)) return true;
      continue;
    }
    if (key in NON_SCHEMA_VALUE_KEYS) continue;
    if (schemaNeedsDraft202012UpgradeImpl(entry, epoch)) return true;
  }

  return false;
}

/**
 * 递归升级核心。cache WeakMap 把输入对象键控到转换输出，共享子图只转换一次、
 * 循环图可终止——在递归**之前**把空结果插入 cache，回边解析到（稍后填充的）
 * 引用而不是无限循环。
 */
function upgradeJsonSchemaTo202012Impl(value: unknown, cache: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const result: unknown[] = [];
    cache.set(value, result);
    for (const entry of value) {
      result.push(upgradeJsonSchemaTo202012Impl(entry, cache));
    }
    return result;
  }
  if (!isJsonObject(value)) return value;

  const cached = cache.get(value);
  if (cached !== undefined) return cached;

  const result: JsonObject = {};
  // 递归前先种 cache，让循环图的回边解析成打结引用。
  cache.set(value, result);
  for (const key in value) {
    const entry = value[key];
    // definitions 是 draft-07 名；统一合并到规范名 $defs 下。
    // $defs 可能已预升级——仍要走条目升级其内部。
    if (key === "definitions" || key === "$defs") {
      if (isJsonObject(entry)) mergeSchemaMap(result, "$defs", entry, cache);
      continue;
    }
    // 逐条目递归；映射形状本身保留。
    if (key in SCHEMA_MAP_KEYS) {
      copySchemaMap(result, key, entry, cache);
      continue;
    }
    // JSON 字面量值关键字——原样复制。
    if (key in NON_SCHEMA_VALUE_KEYS) {
      result[key] = entry;
      continue;
    }
    // draft-07 独有、2020-12 无拼写的关键字——整体丢弃。
    // items 数组在下面经 prefixItems 转换处理。
    if (key === "dependencies" || key === "additionalItems" || key === "nullable") {
      continue;
    }
    // $schema URI 改写为 2020-12 形态；非 draft-07 URI 直通。
    if (key === "$schema") {
      result.$schema =
        typeof entry === "string" && entry in DRAFT_07_SCHEMA_URIS ? JSON_SCHEMA_DRAFT_2020_12_URI : entry;
      continue;
    }
    // `#/definitions/Foo` → `#/$defs/Foo`。
    if (key === "$ref" && typeof entry === "string") {
      result.$ref = convertRef(entry);
      continue;
    }
    // 数组值 items 是 draft-07 tuple 形态——循环后统一处理。
    if (key === "items" && Array.isArray(entry)) {
      continue;
    }
    result[key] = upgradeJsonSchemaTo202012Impl(entry, cache);
  }

  // draft-07 tuple：items:[a,b]（+可选 additionalItems）变成
  // 2020-12 的 prefixItems:[a,b]（+可选 items 承载其余）。
  if (Array.isArray(value.items)) {
    const convertedItems = upgradeJsonSchemaTo202012Impl(value.items, cache) as unknown[];
    result.prefixItems = mergePrefixItems(result.prefixItems, convertedItems);
    if (value.additionalItems !== undefined && value.additionalItems !== true) {
      result.items = upgradeJsonSchemaTo202012Impl(value.additionalItems, cache);
    } else {
      // draft-07 的 additionalItems:true（或缺省）== 2020-12 的无 items。
      delete result.items;
    }
  }

  convertDependencies(value, result, cache);

  // OpenAPI 3.0 nullable:true → 2020-12 可空性。makeNullable 可能返回全新包装
  // 对象，此时更新 cache，让指向同一输入的调用方看到包装而非内层结果。
  if (value.nullable === true) {
    const nullable = makeNullable(result);
    if (nullable !== result) cache.set(value, nullable);
    return nullable;
  }

  return result;
}

/** 前置检查入口：暴露给调用方决定是否走升级路径。 */
export function schemaNeedsDraft202012Upgrade(schema: unknown): boolean {
  return schemaNeedsDraft202012UpgradeImpl(schema, epochNext());
}

/**
 * 把 legacy JSON Schema 形状升级为 zod 发射的 draft 2020-12 形态。
 * WeakMap cache 是刻意的：每调用一次新建、且在递归**前**种入
 * （见 upgradeJsonSchemaTo202012Impl 的 cache.set），循环图解析成打结引用。
 * symbol stamp 要么跨调用缓存（输入被改后不安全），要么需要 epoch 间接层。
 */
export function upgradeJsonSchemaTo202012(schema: unknown): unknown {
  if (!schemaNeedsDraft202012Upgrade(schema)) return schema;
  return upgradeJsonSchemaTo202012Impl(schema, new WeakMap<object, unknown>());
}
