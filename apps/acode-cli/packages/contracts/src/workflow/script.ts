import { z } from "zod";
import type { SessionId } from "../interfaces/shared.js";
// 架构断环（specs/architecture-contracts-module.md）：ScriptWorkflowRunStats 与其 schema
// 下沉到 ./script-usage.js（该文件引用此类型，定义留在本文件即成文件级 import 环）；
// 此处 import 供本文件使用 + 原样再导出，导出面逐名不变。
import type {
  RecordScriptWorkflowActivityUsageInput,
  ScriptWorkflowRunStats,
} from "./script-usage.js";

export type {
  RecordScriptWorkflowActivityUsageInput,
  ScriptWorkflowRunStats,
} from "./script-usage.js";
export { ScriptWorkflowRunStatsSchema } from "./script-usage.js";

const MAX_WORKFLOW_AGENT_TOOLS = 128;
const MAX_WORKFLOW_AGENT_SKILLS = 64;
const MAX_WORKFLOW_AGENT_TIMEOUT_MS = 86_400_000;

export const WorkflowScriptPhaseMetaSchema = z
  .object({
    detail: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    title: z.string().min(1),
  })
  .strict();
export type WorkflowScriptPhaseMeta = z.infer<typeof WorkflowScriptPhaseMetaSchema>;

export const WorkflowScriptMetaSchema = z
  .object({
    description: z.string().min(1),
    name: z.string().min(1),
    phases: z.array(WorkflowScriptPhaseMetaSchema).default([]),
    whenToUse: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((meta, context) => {
    const seen = new Set<string>();
    for (const [index, phase] of meta.phases.entries()) {
      if (!seen.has(phase.title)) {
        seen.add(phase.title);
        continue;
      }
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate workflow phase title: ${phase.title}`,
        path: ["phases", index, "title"],
      });
    }
  });
export type WorkflowScriptMeta = z.infer<typeof WorkflowScriptMetaSchema>;

export const WorkflowAgentIsolationSchema = z.enum(["worktree"]);
export type WorkflowAgentIsolation = z.infer<typeof WorkflowAgentIsolationSchema>;

export const WorkflowAgentOptionsSchema = z
  .object({
    agentType: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    isolation: WorkflowAgentIsolationSchema.optional(),
    label: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    schema: z.record(z.unknown()).optional(),
    skills: z.array(z.string().min(1)).max(MAX_WORKFLOW_AGENT_SKILLS).optional(),
    systemPrompt: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(MAX_WORKFLOW_AGENT_TIMEOUT_MS).optional(),
    tools: z.array(z.string().min(1)).max(MAX_WORKFLOW_AGENT_TOOLS).optional(),
  })
  .strict();
export type WorkflowAgentOptions = z.infer<typeof WorkflowAgentOptionsSchema>;

export const WorkflowAgentCallInputSchema = z
  .object({
    callPath: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    opts: WorkflowAgentOptionsSchema.optional(),
    prompt: z.string().min(1),
  })
  .strict();
export type WorkflowAgentCallInput = z.infer<typeof WorkflowAgentCallInputSchema>;

// 状态词汇组（物理词表 / interrupted code / 管理面逻辑态）内聚拆到 ./script-status.js：
// 2026-10-18 script.ts 顶过 managed 模块 400 行硬上限，整块**纯移动**过去；同
// ./script-usage.js 先例，原样再导出，导出面与消费方导入路径（@acode/contracts）逐名不变。
import type { ScriptWorkflowLogicalRunStatus, ScriptWorkflowRunStatus } from "./script-status.js";

export type { ScriptWorkflowLogicalRunStatus, ScriptWorkflowRunStatus } from "./script-status.js";
export { SCRIPT_WORKFLOW_INTERRUPTED_CODE, SCRIPT_WORKFLOW_RUN_STATUSES } from "./script-status.js";

export const SCRIPT_WORKFLOW_ACTIVITY_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "cached",
  "lost",
] as const;
export type ScriptWorkflowActivityStatus = (typeof SCRIPT_WORKFLOW_ACTIVITY_STATUSES)[number];

export type ScriptWorkflowSource = "builtin" | "user";
export const SCRIPT_WORKFLOW_DEFINITION_SCOPES = [
  "builtin",
  "explicit",
  "project",
  "user",
] as const;
export type ScriptWorkflowDefinitionScope = (typeof SCRIPT_WORKFLOW_DEFINITION_SCOPES)[number];

export interface ScriptWorkflowDefinitionRecord {
  enabled: boolean;
  id: string;
  meta: WorkflowScriptMeta;
  name: string;
  scope: ScriptWorkflowDefinitionScope;
  scriptHash: string;
  scriptPath?: string;
  source: ScriptWorkflowSource;
  timeCreated: number;
  timeUpdated: number;
  trusted: boolean;
}

export interface ScriptWorkflowRunRecord {
  args?: unknown;
  argsHash?: string;
  budgetSpent: number;
  budgetTotal?: number;
  completedAt?: number;
  createdAt: number;
  currentPhase?: string;
  cwd: string;
  definitionId?: string;
  failure?: unknown;
  id: string;
  kind: "script";
  name: string;
  parentSessionId?: SessionId;
  /** Owner identity captured when the run was created; legacy rows may omit it. */
  remoteSessionId?: string;
  /** Durable process owner facts; legacy rows may omit them. */
  ownerGeneration?: number;
  ownerToken?: string;
  /** Top-level script result; undefined means no result was committed. */
  result?: unknown;
  scriptHash: string;
  scriptPath?: string;
  startedAt?: number;
  stats?: ScriptWorkflowRunStats;
  status: ScriptWorkflowRunStatus;
  /** Stable workspace identity captured when the run was created; legacy rows may omit it. */
  workspaceIdentity?: string;
  /** 发起这次 run 的工具调用 id；存量行（migration 0027 之前）缺席。见 CreateScriptWorkflowRunInput。 */
  toolCallId?: string;
  updatedAt: number;
}

export interface ScriptWorkflowActivityRecord {
  attempt: number;
  callIndex: number;
  callPath: string;
  childSessionId?: SessionId;
  completedAt?: number;
  createdAt: number;
  error?: unknown;
  id: string;
  inputHash: string;
  label?: string;
  opts?: WorkflowAgentOptions;
  parentActivityId?: string;
  phase?: string;
  prompt?: string;
  result?: unknown;
  runId: string;
  startedAt?: number;
  status: ScriptWorkflowActivityStatus;
  type: "agent" | "workflow" | "log" | "phase";
  updatedAt: number;
}

export interface ScriptWorkflowEventRecord {
  activityId?: string;
  createdAt: number;
  id: string;
  payload?: unknown;
  phase?: string;
  runId: string;
  sequence: number;
  type: string;
}

export interface SessionTaskLinkRecord {
  activityId?: string;
  agentType?: string;
  childSessionId: SessionId;
  createdAt: number;
  depth: number;
  id: string;
  label?: string;
  model?: string;
  parentLinkId?: string;
  parentSessionId?: SessionId;
  path: string;
  phase?: string;
  role: string;
  rootWorkflowRunId?: string;
  status: string;
  updatedAt: number;
}

export interface UpsertScriptWorkflowDefinitionInput {
  enabled?: boolean;
  id: string;
  meta: WorkflowScriptMeta;
  name: string;
  scope?: ScriptWorkflowDefinitionScope;
  scriptHash: string;
  scriptPath?: string;
  source: ScriptWorkflowSource;
  trusted?: boolean;
}

export interface CreateScriptWorkflowRunInput {
  args?: unknown;
  argsHash?: string;
  budgetTotal?: number;
  cwd: string;
  definitionId?: string;
  id: string;
  name: string;
  parentSessionId?: SessionId;
  ownerGeneration?: number;
  ownerToken?: string;
  ownerTakeover?: boolean;
  /** Owner identity captured when the run was created; legacy rows may omit it. */
  remoteSessionId?: string;
  scriptHash: string;
  scriptPath?: string;
  stats?: ScriptWorkflowRunStats;
  status?: ScriptWorkflowRunStatus;
  /**
   * 发起这次 run 的工具调用 id。
   *
   * 它是两条联接的键：run 目录页把缺它的摘要**整条剔除**（`workflow-run` tab 与聊天里的
   * 工具卡都按 toolCallId 找发起行），冷恢复的 run 也靠它联回发起它的那一行工具调用。
   * 缺席只对存量行成立（migration 0027 之前没有记这个事实）。
   */
  toolCallId?: string;
  /** Stable workspace identity; local callers use workspace path as fallback. */
  workspaceIdentity?: string;
}

export interface UpdateScriptWorkflowRunInput {
  budgetSpent?: number;
  completedAt?: number | null;
  currentPhase?: string | null;
  failure?: unknown;
  id: string;
  ownerGeneration?: number;
  ownerToken?: string;
  /** Allow a verified current session owner to attach a newly claimed owner to this run. */
  ownerTakeover?: boolean;
  result?: unknown;
  startedAt?: number | null;
  stats?: ScriptWorkflowRunStats;
  status?: ScriptWorkflowRunStatus;
}

export interface CreateScriptWorkflowActivityInput {
  callIndex: number;
  callPath: string;
  id: string;
  inputHash: string;
  label?: string;
  opts?: WorkflowAgentOptions;
  parentActivityId?: string;
  phase?: string;
  prompt?: string;
  runId: string;
  status?: ScriptWorkflowActivityStatus;
  type: ScriptWorkflowActivityRecord["type"];
}

export interface UpdateScriptWorkflowActivityInput {
  childSessionId?: SessionId | null;
  completedAt?: number | null;
  error?: unknown;
  id: string;
  result?: unknown;
  startedAt?: number | null;
  status?: ScriptWorkflowActivityStatus;
}

export interface CreateSessionTaskLinkInput {
  activityId?: string;
  agentType?: string;
  childSessionId: SessionId;
  depth?: number;
  id: string;
  label?: string;
  model?: string;
  parentLinkId?: string;
  parentSessionId?: SessionId;
  path: string;
  phase?: string;
  role: string;
  rootWorkflowRunId?: string;
  status: string;
}

export interface ScriptWorkflowStorePort {
  appendScriptWorkflowEvent(input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  }): Promise<ScriptWorkflowEventRecord>;
  createScriptWorkflowActivity(
    input: CreateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord>;
  createScriptWorkflowRun(input: CreateScriptWorkflowRunInput): Promise<ScriptWorkflowRunRecord>;
  createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<SessionTaskLinkRecord>;
  findCachedScriptWorkflowActivity(input: {
    callPath: string;
    inputHash: string;
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord | null>;
  getScriptWorkflowRun(runId: string): Promise<ScriptWorkflowRunRecord | null>;
  /**
   * 管理面 usageIncomplete 的存在性读面（spec script-workflow-management-surface.md §4.1）：
   * `runId` 名下任一 activity 的 result 带账本不完整标记（`usageAccounting.status ===
   * "incomplete"`）即为 true。判据唯一所有者是 cli-workflow script-workflow-format.ts 的
   * `scriptWorkflowActivityUsageIncomplete`；SQL 只是把同一判据下推成 `exists` 索引探测，
   * 一致性由 store 测试互钉——管理面列表页对每行 run 都要这个布尔，不能为它全行拉取
   * activity（payload/result 大字段）。
   */
  hasScriptWorkflowUsageIncomplete(input: { runId: string }): Promise<boolean>;
  listScriptWorkflowActivities(input: { runId: string }): Promise<ScriptWorkflowActivityRecord[]>;
  listScriptWorkflowEvents(input: {
    limit?: number;
    runId: string;
  }): Promise<ScriptWorkflowEventRecord[]>;
  listScriptWorkflowRuns(input?: {
    cwd?: string;
    limit?: number;
    /**
     * 按发起会话过滤。冷回放必须是会话作用域的（`workflowRuns` 投影按会话物化），
     * 而一个项目目录会被许多会话共用，所以 `cwd` 顶不掉这个作用域。
     */
    parentSessionId?: string;
    statuses?: readonly ScriptWorkflowRunStatus[];
    /**
     * 管理面的**逻辑态**过滤（物理六词 + `interrupted`，spec §4.1）。在 SQL 层展开：
     * 物理词直接进 `status in (...)`；`cancelled`/`interrupted` 同一物理词，按
     * `failure_json.code` 是否命中 SCRIPT_WORKFLOW_INTERRUPTED_CODE（见 ./script-status.js）
     * 分流
     * （两词同时请求 = 不分流，整段 `status = 'cancelled'`）。与 `statuses` 同时给时
     * 两个过滤按 SQL 语义取交集；展开与唯一映射（logicalScriptWorkflowStatus）的一致性
     * 由 store 测试逐行互钉。
     */
    logicalStatuses?: readonly ScriptWorkflowLogicalRunStatus[];
  }): Promise<ScriptWorkflowRunRecord[]>;
  /**
   * 管理面「已持久化脚本清单」的唯一读面（spec script-workflow-management-surface.md §4.2）：
   * 全量回、`time_updated desc` 排序（行数量级 = 用户迭代过的脚本数，全量回可行）。
   * 过滤（scope / script_path 非空）是投影层的事，store 只回事实行。
   */
  listScriptWorkflowDefinitions(input?: {
    limit?: number;
  }): Promise<ScriptWorkflowDefinitionRecord[]>;
  /** 同一事务提交累计值及 activity 用量事件；重复 activityId 不再次累计。 */
  recordScriptWorkflowActivityUsage(
    input: RecordScriptWorkflowActivityUsageInput,
  ): Promise<ScriptWorkflowRunRecord>;
  upsertScriptWorkflowDefinition(
    input: UpsertScriptWorkflowDefinitionInput,
  ): Promise<ScriptWorkflowDefinitionRecord>;
  updateScriptWorkflowActivity(
    input: UpdateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord>;
  updateScriptWorkflowRun(input: UpdateScriptWorkflowRunInput): Promise<ScriptWorkflowRunRecord>;
}
