// 脚本工作流管理面（运行历史 / 已持久化脚本清单）的**纯投影**：store 行 → v4 协议条目。
// 依据：apps/acode-cli/specs/script-workflow-management-surface.md §4.1/§4.2。
//
// 为什么落在 cli-workflow 而不是 bootstrap facade：physical→logical→stopReason 的全词表
// 投影是本包 script-workflow-run-status.ts 那份「全仓唯一映射」的下游，放在这里离映射
// 最近、测试也落在本层（spec §10 cli-workflow 行）；facade 只负责取数、分页与 IO。
// 本文件保持纯函数：不碰 store、不做 IO（usageIncomplete 由调用方经 store 的
// hasScriptWorkflowUsageIncomplete 存在性读面查出后传入——P2 修复前这里曾有一个
// 按 run 全行拉取 activity 的 IO 帮手，与文件头的纯函数承诺相抵，已移除）。

import type { ScriptWorkflowDefinitionRecord, ScriptWorkflowRunRecord } from "@acode/contracts";
import type {
  ScriptWorkflowDefinitionEntry,
  ScriptWorkflowLogicalStatus,
  ScriptWorkflowRunEntry,
} from "@acode/shared/acode-protocol-v4";
import { logicalScriptWorkflowStatus } from "./script-workflow-run-status.js";

/**
 * stop_reason 的唯一派生（spec §4.1）：`cancelled` 且无 interrupted code → "user"；
 * `interrupted`（= cancelled + code）→ "processExited"；其余终态不携带。
 * 配对保证来自 logicalScriptWorkflowStatus（都只认 failure 上的结构化 code，
 * 绝不解析 message 文本）：能到达 interrupted 分支的输入必然带着命中 code 的 failure。
 */
export function scriptWorkflowStopReasonOf(
  logicalStatus: ScriptWorkflowLogicalStatus,
): "user" | "processExited" | undefined {
  if (logicalStatus === "cancelled") return "user";
  if (logicalStatus === "interrupted") return "processExited";
  return undefined;
}

/** 一行 `workflow_run` → 管理面运行历史条目。stats 展平为显式键；usageIncomplete 由调用方传入。 */
export function toScriptWorkflowManagementRunEntry(
  row: ScriptWorkflowRunRecord,
  usageIncomplete: boolean,
): ScriptWorkflowRunEntry {
  const logicalStatus = logicalScriptWorkflowStatus(row);
  const stats = row.stats;
  const stopReason = scriptWorkflowStopReasonOf(logicalStatus);
  return {
    runId: row.id,
    name: row.name,
    logicalStatus,
    // 其余终态不携带 stopReason（协议 schema 的 superRefine 也在协议层强制同一配对）。
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(row.scriptPath === undefined ? {} : { scriptPath: row.scriptPath }),
    cwd: row.cwd,
    ...(row.workspaceIdentity === undefined ? {} : { workspaceIdentity: row.workspaceIdentity }),
    ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    budgetSpent: row.budgetSpent,
    ...(row.budgetTotal === undefined ? {} : { budgetTotal: row.budgetTotal }),
    stats: {
      agentCalls: stats?.agentCalls ?? 0,
      cachedAgentCalls: stats?.cachedAgentCalls ?? 0,
      failedAgentCalls: stats?.failedAgentCalls ?? 0,
      toolCalls: stats?.toolCalls ?? 0,
      tokensTotal: stats?.tokens.total ?? 0,
      // 存量行 stats 缺席时 tokensTotal=0 且 usageIncomplete 如实照传——
      // 不把「读不到的账本」伪装成「零账本的完整读数」。
      usageIncomplete,
    },
    createdAt: row.createdAt,
    ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
    ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
    updatedAt: row.updatedAt,
  };
}

/**
 * 一行 `workflow_definition` → 管理面脚本清单条目。可见性过滤（builtin 恒可见、
 * 其余 scope 要求有实体脚本路径）在这里给出纯函数实现，facade 直接套用。
 */
export function isVisibleScriptWorkflowDefinition(record: ScriptWorkflowDefinitionRecord): boolean {
  return (
    record.source === "builtin" || (record.scope !== "builtin" && record.scriptPath !== undefined)
  );
}

export function toScriptWorkflowManagementDefinitionEntry(
  record: ScriptWorkflowDefinitionRecord,
): ScriptWorkflowDefinitionEntry {
  return {
    id: record.id,
    name: record.name,
    description: record.meta.description,
    phaseTitles: record.meta.phases.map((phase) => phase.title),
    scope: record.scope,
    ...(record.scriptPath === undefined ? {} : { scriptPath: record.scriptPath }),
    scriptHash: record.scriptHash,
    enabled: record.enabled,
    trusted: record.trusted,
    timeCreated: record.timeCreated,
    timeUpdated: record.timeUpdated,
    // lastRunAt（该 definition 最近一次 run 的联查）首版不回，schema 已留位。
  };
}
