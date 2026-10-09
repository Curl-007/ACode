import { z } from "zod";

// 架构断环（specs/architecture-contracts-module.md）：ScriptWorkflowRunStats 与其 schema
// 从 script.ts 下沉到本文件——本文件的 RecordScriptWorkflowActivityUsageInput 引用该类型，
// 定义留在 script.ts 即成 script ↔ script-usage 文件级 import 环。script.ts 原样再导出，
// 经 workflow/index 的导出面逐名不变。本文件保持叶子地位：只依赖 zod。

export interface ScriptWorkflowRunStats {
  agentCalls: number;
  cachedAgentCalls: number;
  failedAgentCalls: number;
  toolCalls: number;
  tokens: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    reasoning: number;
    total: number;
  };
}

export const ScriptWorkflowRunStatsSchema = z
  .object({
    agentCalls: z.number().int().nonnegative(),
    cachedAgentCalls: z.number().int().nonnegative(),
    failedAgentCalls: z.number().int().nonnegative(),
    tokens: z
      .object({
        cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(),
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        reasoning: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    toolCalls: z.number().int().nonnegative(),
  })
  .strict();

/** Atomic, idempotent settlement of one child activity's usage into its run. */
export interface RecordScriptWorkflowActivityUsageInput {
  activityId: string;
  delta: ScriptWorkflowRunStats;
  eventId: string;
  runId: string;
  ownerGeneration?: number;
  ownerToken?: string;
}
