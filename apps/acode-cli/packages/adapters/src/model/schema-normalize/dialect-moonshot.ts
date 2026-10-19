// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// Moonshot MFJS 方言（spec R1 #4，requiresMfjsToolSchema 标志路由）
// ============================================================
// Moonshot Flavored JSON Schema（MFJS）——Moonshot/Kimi 原生宿主
// （api.moonshot.ai、api.kimi.com）对 tools.function.parameters 校验的更严子集。
// 标准 JSON Schema 里 OpenAI-compatible 宿主接受的构造它会以 HTTP 400
// `tools.function.parameters is not a valid moonshot flavored json schema` 拒绝。
// 本归一器调和的差异：
//
//  - `const`（含每个分支都是裸 const 的 anyOf/oneOf）被拒；折成带推断标量
//    type 的 enum。
//  - `oneOf` 不是 MFJS combinator（只认 anyOf）；残留 oneOf 折进 anyOf。
//  - `type` 必须是标量字符串；["T","null"] 归约为 T（null 成员丢弃——
//    nullable 不支持），多类型数组变成每类型一个带 type 的 anyOf 分支。
//  - 带 enum 的节点获得推断 type（MFJS 惯用形；裸 enum 也合法），
//    让 anyOf 分支永远携带 type。
//  - 校验/装饰关键字（minItems、maxItems、maxLength、pattern、format、title…）
//    与 tuple prefixItems 被拒并剥离，有人类可读价值的 spill 进兄弟
//    description。default 与 description 是 MFJS Meta Data 字段，保留。
//  - additionalProperties（布尔或 schema）与 type:"null"（含 anyOf 内）保留。
//  - 布尔子 schema 对象化折叠；MFJS 没有精确的 false schema，两个值都变成
//    permissive 空 schema，本地工具校验仍是权威。
//
// 范围外（内置工具面不存在、盲改写有歧义）：allOf 交集合并、外部/递归 $ref、
// 深度 10 限制。
//
// ACode 路由：properties.requiresMfjsToolSchema（配置驱动标志，GLM/Kimi 系）；
// 在 $ref hoist（#/properties/... → #/$defs/...）之后应用（spec R2.2）。

import { normalizeSchema } from "./normalize-core.js";
import { NON_STRUCTURAL_SCHEMA_KEYS } from "./fields.js";

function isMoonshotUnsupportedSchemaField(key: string): boolean {
  // default 是 MFJS Meta Data 字段（保留）；其余在此的都是 MFJS 拒绝的
  // 校验/装饰关键字或 tuple 形态。
  if (key === "default") return false;
  return Object.hasOwn(NON_STRUCTURAL_SCHEMA_KEYS, key) || key === "prefixItems";
}

export function normalizeSchemaForMoonshot(value: unknown): unknown {
  return normalizeSchema(value, {
    coerceBooleanSubschemas: "permissive",
    unsupportedFields: isMoonshotUnsupportedSchemaField,
    normalizeFieldNames: false,
    collapseNullFields: false,
    scalarizeTypeArrays: true,
    stripNullableKeyword: true,
    autoPropertyOrdering: false,
    ensureObjectProperties: false,
    liftStrippedToDescription: { format: "spill" },
    mergeObjectCombiners: false,
    collapseSameTypeCombiners: false,
    collapseMixedTypeCombiners: false,
    stripResidualCombinersFixpoint: false,
    extractNullableFromUnions: false,
    inferTypeForBareEnum: true,
    dropNonScalarEnum: true,
    foldOneOfIntoAnyOf: true,
  });
}
