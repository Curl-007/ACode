// ============================================================
// 脚本工作流管理面：listScriptWorkflowRuns / listScriptWorkflowDefinitions
// ============================================================
// apps/acode-cli/specs/script-workflow-management-surface.md §4。两个纯只读查询命令：
// 不写任何行、不触发孤儿收敛、不碰 owner lease；幂等由存储层天然保证。
//
// 锚会话只是路由键（requireRecord），数据本身是 workspace 级——`workflow_run` 按 cwd
// 精确匹配过滤（与 ScriptWorkflowRuntime.list 同一口径），不按 workspaceIdentity 过滤：
// identity 是身份隔离键，不承担「按项目枚举」的职责；同一项目目录的 runs 就是同一
// 项目的 runs（§4.1）。
//
// 与 dwf 的 ListWorkflowRuns/GetWorkflowRun 无关：那四个工具取数底座是 dwf_run 表，
// 这里读的是脚本工作流的 workflow_run / workflow_definition 表。物理表、状态词表、
// owner 语义都不同，两套 journal 刻意不混在同一列表里（§2.2）。

import { z } from "zod";
import { acodeWorkspaceRefSchema } from "../acode-session-types.js";

/**
 * 逻辑状态词表 = 物理六词 + interrupted（孤儿收敛投影）。
 * 与 CLI 侧 contracts 的 SCRIPT_WORKFLOW_RUN_STATUSES（物理词表，受 CHECK 约束）和
 * script-workflow-run-status.ts 的 logicalScriptWorkflowStatus（唯一映射）保持同一口径；
 * shared 不引 apps 包，这里独立声明，测试钉住两侧词表一致。
 */
export const scriptWorkflowLogicalStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ScriptWorkflowLogicalStatus = z.infer<typeof scriptWorkflowLogicalStatusSchema>;

export const listScriptWorkflowRunsPayloadSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    /** 缺省 50，上限 200；截断确定性：同一排序键（time_updated desc, id desc）+ 同一 limit → 同一前缀。 */
    limit: z.number().int().min(1).max(200).optional(),
    /** 缺省不过滤；过滤下推到 store 侧 SQL（逻辑态闭集展开为参数化查询，interrupted 以 cancelled + failure code 表达）；truncated = 还有更多匹配行。 */
    statuses: z.array(scriptWorkflowLogicalStatusSchema).optional(),
  })
  .strict();
export type ListScriptWorkflowRunsPayload = z.infer<typeof listScriptWorkflowRunsPayloadSchema>;

/**
 * run 行的 `ScriptWorkflowRunStats`（contracts/src/workflow/script-usage.ts），字段名在
 * 协议层展平为显式键（不透传 JSON blob），保证 schema 可校验。`usageIncomplete` 对应
 * 用量账本不完整标记——UI 显示「tokens: ≥K（账本不完整）」，不把不完整账本伪装成零。
 */
export const scriptWorkflowRunStatsSchema = z
  .object({
    agentCalls: z.number().int().nonnegative(),
    cachedAgentCalls: z.number().int().nonnegative(),
    failedAgentCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    tokensTotal: z.number().int().nonnegative(),
    usageIncomplete: z.boolean(),
  })
  .strict();
export type ScriptWorkflowRunStatsSummary = z.infer<typeof scriptWorkflowRunStatsSchema>;

export const scriptWorkflowRunEntrySchema = z
  .object({
    runId: z.string().min(1),
    name: z.string(),
    logicalStatus: scriptWorkflowLogicalStatusSchema,
    /**
     * 仅 cancelled/interrupted 行携带（stop_reason 唯一映射）：
     * `cancelled` 且无 interrupted code → "user"；`interrupted`（= cancelled + code）→
     * "processExited"；其余终态不携带。协议收枚举而不收 failure JSON——failure 原文
     * 可能含任意错误对象，不进管理面列表。
     */
    stopReason: z.enum(["user", "processExited"]).optional(),
    scriptPath: z.string().optional(),
    cwd: z.string().min(1),
    workspaceIdentity: z.string().optional(),
    parentSessionId: z.string().optional(),
    /** 「查看发起会话」深链的联接键；存量行（migration 0027 之前）缺席。 */
    toolCallId: z.string().optional(),
    budgetSpent: z.number().nonnegative(),
    budgetTotal: z.number().nonnegative().optional(),
    stats: scriptWorkflowRunStatsSchema,
    createdAt: z.number(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    updatedAt: z.number(),
  })
  .strict()
  // stop_reason 唯一映射在 schema 层强制（spec §4.1）：只有 cancelled/interrupted 携带，
  // 且一一配对（cancelled→user、interrupted→processExited）。投影方（CLI）与渲染方（UI）
  // 共用这条校验，配对漂移在协议层当场暴露。
  .superRefine((entry, context) => {
    if (entry.stopReason === undefined) return;
    const expected: "user" | "processExited" | undefined =
      entry.logicalStatus === "cancelled"
        ? "user"
        : entry.logicalStatus === "interrupted"
          ? "processExited"
          : undefined;
    if (entry.stopReason !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `stopReason "${entry.stopReason}" is only valid for logicalStatus "cancelled" (user) / "interrupted" (processExited), got logicalStatus "${entry.logicalStatus}"`,
        path: ["stopReason"],
      });
    }
  });
export type ScriptWorkflowRunEntry = z.infer<typeof scriptWorkflowRunEntrySchema>;

export const listScriptWorkflowRunsResultSchema = z
  .object({
    type: z.literal("listScriptWorkflowRuns"),
    runs: z.array(scriptWorkflowRunEntrySchema),
    /** 命中 limit 上限时 true，UI 显示「仅显示最近 N 条」。 */
    truncated: z.boolean(),
  })
  .strict();
export type ListScriptWorkflowRunsResult = z.infer<typeof listScriptWorkflowRunsResultSchema>;

export const listScriptWorkflowDefinitionsPayloadSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
  })
  .strict();
export type ListScriptWorkflowDefinitionsPayload = z.infer<
  typeof listScriptWorkflowDefinitionsPayloadSchema
>;

export const scriptWorkflowDefinitionEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    /** meta.description。 */
    description: z.string(),
    /** meta.phases[].title（顺序即脚本声明顺序）。 */
    phaseTitles: z.array(z.string()),
    scope: z.enum(["builtin", "explicit", "project", "user"]),
    scriptPath: z.string().optional(),
    scriptHash: z.string().min(1),
    enabled: z.boolean(),
    trusted: z.boolean(),
    timeCreated: z.number(),
    timeUpdated: z.number(),
    /** 该 definition 最近一次 run 的 time_updated（联查，可选优化）；首版不回，schema 先留位。 */
    lastRunAt: z.number().optional(),
  })
  .strict();
export type ScriptWorkflowDefinitionEntry = z.infer<typeof scriptWorkflowDefinitionEntrySchema>;

export const listScriptWorkflowDefinitionsResultSchema = z
  .object({
    type: z.literal("listScriptWorkflowDefinitions"),
    definitions: z.array(scriptWorkflowDefinitionEntrySchema),
  })
  .strict();
export type ListScriptWorkflowDefinitionsResult = z.infer<
  typeof listScriptWorkflowDefinitionsResultSchema
>;
