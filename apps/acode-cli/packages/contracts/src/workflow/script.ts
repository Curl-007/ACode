import { z } from "zod";
import type { SessionId } from "../interfaces/shared.js";

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

/**
 * `workflow_run.status` 的**物理**词汇——受建表 CHECK 约束，不迁移。
 *
 * ⚠ 这不是逻辑词汇。「宿主进程在 run 结算前退出」这件事**没有**自己的物理词，它落成
 * `cancelled` + `failure_json` 里的结构化 code（见 bootstrap 的 script-workflow-run-status.ts）。
 * 这与 dwf 逐字同构：`dwf_run.status` 的 CHECK 集同样不含 `stopped`，dwf 把逻辑态
 * `stopped{reason}` 编码成物理 `cancelled` + `{"stopReason": …}` 信封，映射只活在
 * `dwf-journal-codecs.ts` 一个文件里。
 *
 * 曾经试图往这里加一个 `interrupted`：CHECK 约束当场拒写（`CHECK constraint failed: status in`），
 * 而假 store 的单测撞不到它——只有对着真实库跑一遍才暴露。放宽约束要重建整张表
 * （三张表外键引用它），代价与风险都远大于按既有模式编码。
 */
export const SCRIPT_WORKFLOW_RUN_STATUSES = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ScriptWorkflowRunStatus = (typeof SCRIPT_WORKFLOW_RUN_STATUSES)[number];

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
  scriptHash: string;
  scriptPath?: string;
  startedAt?: number;
  stats?: ScriptWorkflowRunStats;
  status: ScriptWorkflowRunStatus;
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
}

export interface UpdateScriptWorkflowRunInput {
  budgetSpent?: number;
  completedAt?: number | null;
  currentPhase?: string | null;
  failure?: unknown;
  id: string;
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
  }): Promise<ScriptWorkflowRunRecord[]>;
  upsertScriptWorkflowDefinition(
    input: UpsertScriptWorkflowDefinitionInput,
  ): Promise<ScriptWorkflowDefinitionRecord>;
  updateScriptWorkflowActivity(
    input: UpdateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord>;
  updateScriptWorkflowRun(input: UpdateScriptWorkflowRunInput): Promise<ScriptWorkflowRunRecord>;
}
