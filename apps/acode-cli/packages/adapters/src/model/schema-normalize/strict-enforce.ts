// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// OpenAI strict 管线 · enforce pass 与 try 组合
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R3；omp CONSTRAINTS #1.3-#1.5。
// 解耦：omp 的 AIError.ValidationError → 本地 StrictSchemaEnforcementError
// （被 tryEnforceStrictSchema 捕获降级，不出内核）。

import { COMBINATOR_KEYS } from "./fields.js";
import { enter, exit, stamp } from "./stamps.js";
import { upgradeJsonSchemaTo202012 } from "./draft.js";
import { hasUnrepresentableStrictObjectMap, inferStrictPrimitiveTypeFromEnumOrConst } from "./strict-precheck.js";
import { sanitizeSchemaForStrictMode } from "./strict-sanitize.js";
import { isJsonObject } from "./types.js";

/** strict enforce 无法表达节点时的内部错误（try 组合捕获后降级非 strict）。 */
export class StrictSchemaEnforcementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictSchemaEnforcementError";
  }
}

/**
 * 唯一约束关键字是 anyOf 的节点（description 之类注解除外）。只有这种节点
 * 能并进外层 union 而不改语义：兄弟关键字（type、enum、properties…）与
 * anyOf 是合取关系，摊开非纯节点的分支会丢掉那些约束。
 */
export function isPureAnyOfNode(value: unknown): value is Record<string, unknown> & { anyOf: unknown[] } {
  if (!isJsonObject(value) || !Array.isArray(value.anyOf)) return false;
  for (const key in value) {
    if (key !== "anyOf" && key !== "description") return false;
  }
  return true;
}

/**
 * 递归强制 OpenAI/Codex strict 模式要求的 JSON Schema 约束：
 *   - 每个 object 节点 additionalProperties: false
 *   - properties 里每个键都出现在 required
 *
 * 不在原 required 数组里的属性是可选属性：改为可空
 * （anyOf: [T, { type: "null" }]），让模型以输出 null 而不是整键缺失来
 * 表达省略。
 *
 * @throws 节点没有 type、数组 combinator（anyOf/allOf/oneOf）、对象 combinator
 *   （not）或 $ref 时抛出——即节点在 strict 模式不可表达。优先用
 *   {@link tryEnforceStrictSchema}，它捕获异常并优雅降级。
 */
export function enforceStrictSchema(
  schema: Record<string, unknown>,
  cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
): Record<string, unknown> {
  if (!enter(schema)) {
    throw new StrictSchemaEnforcementError("Schema contains a circular object graph — cannot enforce strict mode");
  }
  try {
    const cached = cache.get(schema);
    if (cached) return cached;
    const result = { ...schema };
    cache.set(schema, result);
    return enforceStrictSchemaBody(result, cache);
  } finally {
    exit(schema);
  }
}

function enforceStrictSchemaBody(
  result: Record<string, unknown>,
  cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): Record<string, unknown> {
  const isObjectType = result.type === "object";
  if (isObjectType) {
    result.additionalProperties = false;
    const propertiesValue = result.properties;
    const props =
      propertiesValue != null && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
        ? (propertiesValue as Record<string, unknown>)
        : {};
    const originalRequired = new Set<string>(
      Array.isArray(result.required)
        ? result.required.filter((value): value is string => typeof value === "string")
        : [],
    );
    const strictProperties: Record<string, unknown> = {};
    for (const key in props) {
      const value = props[key];
      const processed =
        value != null && typeof value === "object" && !Array.isArray(value)
          ? enforceStrictSchema(value as Record<string, unknown>, cache)
          : value;
      // 可选属性——包成可空让 strict 模式接受
      if (!originalRequired.has(key)) {
        // 已可空则不重复包装
        if (
          isJsonObject(processed) &&
          Array.isArray(processed.anyOf) &&
          processed.anyOf.some((v) => isJsonObject(v) && v.type === "null")
        ) {
          strictProperties[key] = processed;
          continue;
        }
        if (isPureAnyOfNode(processed)) {
          strictProperties[key] = { ...processed, anyOf: [...processed.anyOf, { type: "null" }] };
          continue;
        }
        if (isJsonObject(processed) && typeof processed.description === "string") {
          const { description, ...withoutDescription } = processed;
          strictProperties[key] = { anyOf: [withoutDescription, { type: "null" }], description };
          continue;
        }
        strictProperties[key] = { anyOf: [processed, { type: "null" }] };
        continue;
      }
      strictProperties[key] = processed;
    }
    result.properties = strictProperties;
    result.required = Object.keys(strictProperties);
  }
  if (result.items != null && typeof result.items === "object") {
    if (Array.isArray(result.items)) {
      result.items = result.items.map((entry) =>
        entry != null && typeof entry === "object" && !Array.isArray(entry)
          ? enforceStrictSchema(entry as Record<string, unknown>, cache)
          : entry,
      );
    } else {
      result.items = enforceStrictSchema(result.items as Record<string, unknown>, cache);
    }
  }
  if (Array.isArray(result.prefixItems)) {
    result.prefixItems = result.prefixItems.map((entry) =>
      entry != null && typeof entry === "object" && !Array.isArray(entry)
        ? enforceStrictSchema(entry as Record<string, unknown>, cache)
        : entry,
    );
  }
  for (const key of COMBINATOR_KEYS) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as unknown[]).map((entry) =>
        entry != null && typeof entry === "object" && !Array.isArray(entry)
          ? enforceStrictSchema(entry as Record<string, unknown>, cache)
          : entry,
      );
    }
  }
  // 把嵌套纯 union 拼进父 anyOf：(A ∨ B) ∨ C ≡ A ∨ B ∨ C。
  // 部分 strict 校验器（如 OpenRouter 后面的 DeepSeek）拒绝不带 type 的 anyOf
  // 分支——嵌套 combinator 节点恰好长这样（omp #2270）。上面的分支递归已经
  // 自底向上展平了更深层级，单 pass 即可。
  if (Array.isArray(result.anyOf) && result.anyOf.some(isPureAnyOfNode)) {
    const flattened: unknown[] = [];
    for (const branch of result.anyOf) {
      if (!isPureAnyOfNode(branch)) {
        flattened.push(branch);
        continue;
      }
      flattened.push(...branch.anyOf);
      // 父节点无注解时保留内层注解。
      if (typeof branch.description === "string" && result.description === undefined) {
        result.description = branch.description;
      }
    }
    result.anyOf = flattened;
  }
  for (const defsKey of ["$defs", "definitions"] as const) {
    if (result[defsKey] != null && typeof result[defsKey] === "object" && !Array.isArray(result[defsKey])) {
      const defs = result[defsKey] as Record<string, unknown>;
      const nextDefs: Record<string, unknown> = {};
      for (const name in defs) {
        const def = defs[name];
        nextDefs[name] =
          def != null && typeof def === "object" && !Array.isArray(def)
            ? enforceStrictSchema(def as Record<string, unknown>, cache)
            : def;
      }
      result[defsKey] = nextDefs;
    }
  }
  // strict 要求每个节点声明具体 type（或 combinator/$ref/not）。type 缺失时
  // 从同质原始类型的 enum/const 推断，让直接调用 enforceStrictSchema
  // （绕过 sanitize 自己的推断 pass）也产出 wire 合法输出。
  if (result.type === undefined) {
    const inferred = inferStrictPrimitiveTypeFromEnumOrConst(result);
    if (inferred !== undefined) result.type = inferred;
  }
  // {}、{items:{}}、混合原始类型 enum、非原始 const 在 strict 模式不可表达——
  // enum/const 在这里不算 type 替身，因为上面没有推出单一类型。
  if (
    result.type === undefined &&
    result.$ref === undefined &&
    !COMBINATOR_KEYS.some((key) => Array.isArray(result[key])) &&
    !isJsonObject(result.not)
  ) {
    throw new StrictSchemaEnforcementError("Schema node has no type, combinator, or $ref — cannot enforce strict mode");
  }
  return result;
}

/**
 * tryEnforceStrictSchema 结果按输入 schema 对象 memoize 的侧表键：
 * 重复调用（不同 provider、重试、批量）复用同一计算结果，不再走树。
 */
const kStrictSchema = Symbol("acode.schema.strict");

/**
 * strict 管线组合入口：upgrade 2020-12 → 预检（开放 map/无约束分支直接
 * strict:false）→ sanitize → enforce。任何失败都返回 { strict:false,
 * schema:upgraded }（omp CONSTRAINTS #1.5：fail-open to non-strict，
 * 绝不发出半损坏的 strict schema）；调用方只在 strict:true 时发 strict 字段。
 */
export function tryEnforceStrictSchema(schema: Record<string, unknown>): {
  schema: Record<string, unknown>;
  strict: boolean;
} {
  return stamp(schema, kStrictSchema, (s) => {
    const upgraded = upgradeJsonSchemaTo202012(s) as Record<string, unknown>;
    if (hasUnrepresentableStrictObjectMap(upgraded)) {
      return { schema: upgraded, strict: false };
    }
    try {
      const sanitized = sanitizeSchemaForStrictMode(upgraded);
      return { schema: enforceStrictSchema(sanitized), strict: true };
    } catch {
      return { schema: upgraded, strict: false };
    }
  });
}
