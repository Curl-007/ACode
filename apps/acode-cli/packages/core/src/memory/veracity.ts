// Mechanism ported from oh-my-pi (MIT) packages/mnemopi — core/beam/recall.ts
// （veracity 查表乘权，recall.ts:746-753）与 config.ts VERACITY_WEIGHT_DEFAULTS，
// Copyright (c) 2025 Mario Zechner & Stencil Labs。档位与权重按 ACode 口径重定
// （specs/memory-semantic-recall.md R11）：unknown 为中性 1.0，存量无字段照常工作。

/**
 * 记忆可信度四档（frontmatter `veracity` 字段）：
 * - `user_stated`：用户显式要求记住的内容；
 * - `tool_observed`：工具实跑输出直接印证的事实；
 * - `extracted`：Extraction 子代理从对话归纳/推断（机械缺省档）；
 * - `unknown`：字段缺失或无法解析（中性档，向后兼容存量）。
 */
export const MEMORY_VERACITY_LEVELS = [
  "user_stated",
  "tool_observed",
  "extracted",
  "unknown",
] as const;

export type MemoryVeracity = (typeof MEMORY_VERACITY_LEVELS)[number];

/**
 * 检索侧按档乘权表（R11，可调常量；spec 常量表同源）。
 * 与 omp VERACITY_WEIGHT_DEFAULTS（stated 1.0 / inferred 0.7 / tool 0.5 /
 * imported 0.6 / unknown 0.8）的偏差及理由：
 * - 任务口径钉住「存量无该字段按 unknown 中性权重」→ unknown = 1.0 为基线；
 * - extracted 同为 1.0：新产出不因打标降权，否则所有新记忆都排在存量之后；
 * - omp 把 tool 排最低反映其 working_memory 语境（工具输出噪声大）；ACode 的
 *   `tool_observed` 语义是「实跑输出印证的事实」，比推断硬，排在 extracted 之上。
 * 非 unknown 档只上浮不下压，回归风险单侧化。
 */
export const VERACITY_WEIGHTS: Readonly<Record<MemoryVeracity, number>> = Object.freeze({
  user_stated: 1.1,
  tool_observed: 1.05,
  extracted: 1.0,
  unknown: 1.0,
});

/** 解析 veracity 档位：未知/无法解析的值按 `unknown`（omp `|| "unknown"` 回退同语义）。 */
export function parseMemoryVeracity(value: unknown): MemoryVeracity {
  if (typeof value === "string" && (MEMORY_VERACITY_LEVELS as readonly string[]).includes(value)) {
    return value as MemoryVeracity;
  }
  return "unknown";
}

/** 检索乘权：档位 → 权重（R11）；非法/缺失值一律按 unknown 档（中性 1.0）。 */
export function veracityWeightFor(veracity: MemoryVeracity | undefined): number {
  return VERACITY_WEIGHTS[parseMemoryVeracity(veracity)];
}

/**
 * 合并方向的 veracity 判定（omp store.ts 的
 * `veracity = CASE WHEN ? != 'unknown' THEN ? ELSE veracity END` 同语义）：
 * 新写值存在且非 unknown → 取新写；否则保留既有。
 */
export function mergeVeracity(
  existing: MemoryVeracity | undefined,
  incoming: MemoryVeracity | undefined,
): MemoryVeracity | undefined {
  if (incoming !== undefined && incoming !== "unknown") return incoming;
  return existing;
}
