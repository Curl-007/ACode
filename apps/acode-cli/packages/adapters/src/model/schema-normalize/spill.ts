// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/spill.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 被剥离关键字 → description 的 spill 格式化器
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R5#4（omp spill.ts 的真实语义
// 就是本文件：把 wire schema 剥掉的约束降级为自然语言，模型仍读得到；
// 与"超大 schema 外置"无关——那是 omp 消息侧 blob 外置，另一域）。

import type { JsonObject } from "./types.js";

export type DescriptionSpillFormat = "spill" | "paren";

function formatSpillValue(value: unknown): string {
  return JSON.stringify(value);
}

function formatParenValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * 把被剥离的 JSON Schema 关键字降级进节点的 `description`，
 * 让模型在 wire schema 丢掉约束后仍以自然语言收到它。
 */
export function spillToDescription(
  node: JsonObject,
  entries: ReadonlyArray<readonly [string, unknown]>,
  format: DescriptionSpillFormat = "spill",
): void {
  let spilled: Array<readonly [string, unknown]> | undefined;
  for (const entry of entries) {
    if (entry[1] === undefined) continue;
    if (spilled === undefined) spilled = [];
    spilled.push(entry);
  }
  if (spilled === undefined || spilled.length === 0) return;

  const existing = typeof node.description === "string" ? node.description : "";
  if (format === "paren") {
    let suffix = "";
    for (const [key, value] of spilled) {
      suffix += ` (${key}: ${formatParenValue(value)})`;
    }
    node.description = `${existing}${suffix}`;
    return;
  }

  const formatted = `{${spilled.map(([key, value]) => `${key}: ${formatSpillValue(value)}`).join(", ")}}`;
  node.description = existing ? `${existing}\n\n${formatted}` : formatted;
}
