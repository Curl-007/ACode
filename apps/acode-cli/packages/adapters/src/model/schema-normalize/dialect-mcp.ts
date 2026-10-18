// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/normalize.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// MCP ingest 方言（统一入口，spec R2.1）
// ============================================================
// MCP inputSchema 进注册/发送面前的统一归一：omp 的 tool-bridge 对每个 MCP
// inputSchema 跑本分发器。语义 = 温和归一：升级 2020-12、内联本地 $defs 引用、
// 剥 $schema 与 nullable；校验关键字、additionalProperties、combiner 全部保留，
// description 不改写。ACode 消费点：adapters/src/mcp/descriptor.ts 物化边界。

import { normalizeSchema } from "./normalize-core.js";

function isMcpUnsupportedSchemaField(key: string): boolean {
  return key === "$schema";
}

export function normalizeSchemaForMCP(value: unknown): unknown {
  return normalizeSchema(value, {
    unsupportedFields: isMcpUnsupportedSchemaField,
    normalizeFieldNames: false,
    collapseNullFields: false,
    scalarizeTypeArrays: false,
    foldOneOfIntoAnyOf: false,
    stripNullableKeyword: true,
    autoPropertyOrdering: false,
    ensureObjectProperties: false,
    liftStrippedToDescription: false,
    mergeObjectCombiners: false,
    collapseSameTypeCombiners: false,
    collapseMixedTypeCombiners: false,
    stripResidualCombinersFixpoint: false,
    extractNullableFromUnions: false,
    inferTypeForBareEnum: false,
    dropNonScalarEnum: false,
  });
}
