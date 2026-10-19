// Mechanism ported from oh-my-pi (MIT) packages/mnemopi — core/weibull.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs。自撰 TypeScript 实现：
// omp 的 21 档参数表按语义映射到 ACode 四类记忆类型 + general 兜底；
// 检索侧乘权位置与下限混合见 specs/memory-semantic-recall.md R10。

import type { MemoryRecallType } from "./recall/types.js";

export interface WeibullParams {
  /** 形状参数：k 越小长尾保留越多（早期衰得慢）。 */
  readonly k: number;
  /** 尺度参数（小时）：eta 越大衰减越慢。 */
  readonly eta: number;
}

/**
 * 按记忆类型的 Weibull 参数表（specs/memory-semantic-recall.md R10）。
 * omp 21 档 → ACode 四类的映射取语义最近档位：
 * - user    ← preference（k=0.4, eta=4380h）：用户画像/偏好长期稳定；
 * - feedback← instruction（k=0.9, eta=480h）：工作方式指引，半衰约 3 周；
 * - project ← project（k=0.85, eta=1080h）：项目约束中等寿命；
 * - reference← artifact（k=0.75, eta=2160h）：外部资源中等偏长；
 * - type 缺失/未知 ← general（k=1.0, eta=168h，omp DEFAULT_HALFLIFE_HOURS 同值）。
 * 参数是可调常量：改这里即改协议（spec 常量表同源），不要在调用点内联数值。
 */
export const WEIBULL_PARAMS: Readonly<
  Record<MemoryRecallType | "general", WeibullParams>
> = Object.freeze({
  user: { k: 0.4, eta: 4380.0 },
  feedback: { k: 0.9, eta: 480.0 },
  project: { k: 0.85, eta: 1080.0 },
  reference: { k: 0.75, eta: 2160.0 },
  general: { k: 1.0, eta: 168.0 },
});

/**
 * 时间衰减下限混合（omp recall.ts 的 `score * (0.7 + 0.3 * decay)` 同款）：
 * 完全陈旧的条目仍保留 floor 比例的检索权重——长尾相关条目可经强 BM25 命中上浮，
 * 与 R4「无硬阈值」同一立场；衰减只压排序位次，不清零召回。
 */
export const DECAY_SCORE_FLOOR = 0.7;

/**
 * 按记忆类型的 Weibull 衰减因子（omp weibullDecayFactor 同式）：
 * `decay = exp(-((ageHours / eta) ** k))`。
 * - `ageHours <= 0`（未来 mtime / 时钟偏差）→ 1.0（不衰减，omp weibullBoost 同语义）；
 * - `eta <= 0`（配置错误）→ 0.0（fail-toward-zero：错误配置不应让条目永生）；
 * - `memoryType` 缺失/未知 → general 兜底参数。
 */
export function weibullDecayFactor(
  ageHours: number,
  memoryType?: MemoryRecallType,
): number {
  if (!Number.isFinite(ageHours) || ageHours <= 0) return 1.0;

  const params = WEIBULL_PARAMS[memoryType ?? "general"] ?? WEIBULL_PARAMS.general;
  if (params.eta <= 0) return 0.0;
  return Math.exp(-((ageHours / params.eta) ** params.k));
}

/**
 * 把衰减因子按 floor 混合进检索分（R10）：`score * (floor + (1 - floor) * decay)`。
 * decay 取值应在 [0, 1]；越界值先夹紧，防御上游给出的病态因子污染排序。
 */
export function blendDecayIntoScore(score: number, decay: number): number {
  const clamped = Math.min(1, Math.max(0, decay));
  return score * (DECAY_SCORE_FLOOR + (1 - DECAY_SCORE_FLOOR) * clamped);
}

/** 由 mtime 计算记忆年龄（小时）；mtime 缺失按 0（不衰减——缺数据不做惩罚）。 */
export function memoryAgeHours(mtimeMs: number | undefined, nowMs: number): number {
  if (mtimeMs === undefined) return 0;
  return (nowMs - mtimeMs) / 3_600_000;
}
