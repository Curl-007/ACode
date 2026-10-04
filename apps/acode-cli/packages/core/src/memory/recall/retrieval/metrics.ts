// 召回度量账本（specs/memory-semantic-recall.md R8，J3-1 覆盖账本模式）：
// 命中/注入/抑制/丢弃分类计数落 JSONL，为 Phase C 开关决策供数。
// **`content`/`description` 全文绝不落盘**——事件结构里只有 id/hash/分类计数；
// 记忆内容进度量文件等于把不可信数据写到用户盘上（J3-2 R4 同款日志边界）。

import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { Logger } from "@acode/contracts";

import type { MemoryRecallSuppression } from "../pending.js";

/** 抑制原因（R5 三层 + R7 层 4）：字面直接复用注入协议的联合，不另抄一份。 */
export type RecallSuppressionReason = MemoryRecallSuppression;

/** 度量事件闭合集合（R8 表）。字段是分类计数与标识 hash，没有正文字段。 */
export type RecallMetricEvent =
  | {
      event: "retrieval";
      phaseMask: "A" | "AB" | "ABC";
      candidateCount: number;
      topK: number;
      durationMs: number;
    }
  | { event: "injected"; entryCount: number; queryHash: string }
  | { event: "suppressed"; reason: RecallSuppressionReason }
  | { event: "discarded"; reason: string }
  | { event: "embedding"; model?: string; backfilled?: number; rebuilt?: boolean; errorKind?: string };

export interface RecallMetricsLedger {
  /** 追加一行；度量是旁路，写失败只 debug 不上抛、不阻塞注入链路。 */
  record(event: RecallMetricEvent): Promise<void>;
}

/**
 * query 的可度量标识（R8）：sha256 前 16 位。只落 hash 不落 query 文本——
 * query 是用户输入原文，落盘等于把对话内容写进度量文件。
 */
export function recallQueryHash(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex").slice(0, 16);
}

/**
 * 创建度量账本。落地形态：`<metricsRoot>/recall-<YYYY-MM-DD>.jsonl`，追加写、按天滚动
 * （metricsRoot = 数据根目录下 `memories/metrics/`，由调用方从 cliStorageRoot 构造）。
 * 不持有文件句柄：召回每 turn 至多几条事件，追加打开的成本远低于常驻句柄的泄漏面。
 */
export function createRecallMetricsLedger(deps: {
  metricsRoot: string;
  logger?: Logger;
  now?: () => Date;
}): RecallMetricsLedger {
  const now = deps.now ?? ((): Date => new Date());
  return {
    async record(event) {
      try {
        // 按天滚动（UTC 日期）：一天一个文件，天然限定单文件增长，也便于按天聚合。
        const day = now().toISOString().slice(0, 10);
        await mkdir(deps.metricsRoot, { recursive: true });
        await appendFile(
          join(deps.metricsRoot, `recall-${day}.jsonl`),
          `${JSON.stringify({ ts: now().toISOString(), ...event })}\n`,
          "utf8",
        );
      } catch (error) {
        // 度量丢失不影响召回正确性；可恢复异常 → debug（AGENTS.md 日志分级）。
        deps.logger?.debug("Memory recall metrics append failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "memory.recall.metrics.append_failed",
          module: "core.memory",
        });
      }
    },
  };
}
