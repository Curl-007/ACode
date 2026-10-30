// session 投影 wire 类型（snapshot/settings/todo/pendingPermission/activeToolCall）。M4 从 legacy barrel 中立迁移，形状不变。v4 conversationSnapshot 的身份字段缺口归 M4b。

import { z } from "zod";
import { acodeAgentEngineIdSchema } from "./acode-agent-registry.js";
import { acodeProtocolMcpServerSchema } from "./acode-protocol-shared.js";
import { errorAttributionSchema } from "./acode-protocol-v4/snapshot.js";
import { modelSelectionSchema } from "./model-selection.js";
import { ACODE_PROTOCOL_NAME, ACODE_PROTOCOL_VERSION } from "./acode-protocol-envelope.js";
import { acodeInteractionRequestOriginSchema, acodePermissionOptionSchema } from "./acode-interaction-types.js";
import { acodeMessageWithPartsSchema } from "./acode-message-types.js";
import { acodeModelOptionSchema, acodeThoughtLevelOptionSchema } from "./acode-model-options.js";
import { acodeSessionRuntimeStateSchema } from "./acode-session-runtime-types.js";
import { acodeSessionGoalSchema, acodeSessionInfoSchema, acodeSessionModeSchema, acodeSessionStatusSchema, acodeWorkspaceRefSchema } from "./acode-session-types.js";

const nonEmptyString = z.string().trim().min(1);
const timestampMsSchema = z.number().int().nonnegative();
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const acodeSessionPersistenceSchema = z.enum(["immediate", "deferred"]);

export const acodeSessionImportMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: timestampMsSchema.optional(),
  })
  .strict();

export type ACodeSessionImportMessage = z.infer<typeof acodeSessionImportMessageSchema>;

export const acodeSessionImportHistorySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("claudeCode"),
      title: z.string().optional(),
      createdAt: timestampMsSchema.optional(),
      updatedAt: timestampMsSchema.optional(),
      messages: z.array(acodeSessionImportMessageSchema).min(1),
    })
    .strict(),
]);

export type ACodeSessionImportHistory = z.infer<typeof acodeSessionImportHistorySchema>;

export const acodeSessionTodoItemSchema = z
  .object({
    content: nonEmptyString,
    status: z.enum(["pending", "in_progress", "completed"]),
    priority: z.enum(["high", "medium", "low"]),
    // D4 todo 依赖字段最小加宽（apps/acode-cli/specs/todo-dependency-fields.md R5/R7）：
    // 与 CLI 侧 TodoItemSchema 同批新增的三个可选成员；保持 .strict()，未知键仍拒绝。
    id: nonEmptyString.optional(),
    blockedBy: z.array(nonEmptyString).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const acodeSessionGoalStatsSchema = z
  .object({
    timeUsedSeconds: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().nullable(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    iterationCount: z.number().int().nonnegative(),
  })
  .strict();

export type ACodeSessionGoalStats = z.infer<typeof acodeSessionGoalStatsSchema>;

export const acodeSessionTodoGroupSchema = z
  .object({
    id: nonEmptyString,
    source: z.enum(["goal_iteration", "session"]),
    goalIteration: z.number().int().positive().optional(),
    targetId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema.optional(),
    todos: z.array(acodeSessionTodoItemSchema),
  })
  .strict();

export type ACodeSessionTodoGroup = z.infer<typeof acodeSessionTodoGroupSchema>;

export const acodeSessionSettingsStateSchema = z
  .object({
    model: z
      .object({
        // 未绑定是合法恢复状态；不能为满足协议而伪造模型或阻断历史读取。
        current: modelSelectionSchema.optional(),
        available: z.array(acodeModelOptionSchema),
        lastUsed: modelSelectionSchema.optional(),
      })
      .strict(),
    thoughtLevel: z
      .object({
        enabled: z.boolean(),
        current: nonEmptyString.optional(),
        defaultLevel: nonEmptyString.optional(),
        available: z.array(acodeThoughtLevelOptionSchema),
      })
      .strict(),
    mode: z
      .object({
        current: acodeSessionModeSchema,
      })
      .strict(),
    permission: z
      .object({
        mode: acodeSessionModeSchema.optional(),
        rulesRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ACodeSessionSettingsState = z.infer<typeof acodeSessionSettingsStateSchema>;

export const acodePendingPermissionSchema = z
  .object({
    requestId: nonEmptyString,
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown().optional(),
    origin: acodeInteractionRequestOriginSchema.optional(),
    options: z.array(acodePermissionOptionSchema).min(1),
    requestedAt: timestampMsSchema,
  })
  .strict();

export type ACodePendingPermission = z.infer<typeof acodePendingPermissionSchema>;

export const acodeActiveToolCallSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    status: z.enum(["pending", "running", "completed", "failed", "denied"]),
    startedAt: timestampMsSchema.optional(),
  })
  .strict();

export type ACodeActiveToolCall = z.infer<typeof acodeActiveToolCallSchema>;

export const acodeSessionProjectionSchema = z
  .object({
    sessionId: nonEmptyString,
    status: acodeSessionStatusSchema,
    mode: acodeSessionModeSchema,
    turnCount: z.number().int().nonnegative(),
    totalTokenCount: z.number().int().nonnegative(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    currentTurnId: nonEmptyString.optional(),
    pendingPermissions: z.array(acodePendingPermissionSchema),
    activeToolCalls: z.array(acodeActiveToolCallSchema),
    backgroundJobs: z.array(jsonObjectSchema),
    target: acodeSessionGoalSchema.nullable().optional(),
    lastError: z
      .object({
        type: nonEmptyString,
        code: nonEmptyString.optional(),
        message: nonEmptyString,
        detail: z.string().optional(),
        attribution: errorAttributionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ACodeSessionProjection = z.infer<typeof acodeSessionProjectionSchema>;

export const acodeSlashCommandSchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    inputHint: z.string().optional(),
    source: z.enum(["builtin", "custom"]).optional(),
  })
  .strict();

export const acodeSessionStateSnapshotSchema = z
  .object({
    protocol: z
      .object({
        name: z.literal(ACODE_PROTOCOL_NAME),
        version: z.literal(ACODE_PROTOCOL_VERSION),
      })
      .strict(),
    session: acodeSessionInfoSchema,
    settings: acodeSessionSettingsStateSchema,
    projection: acodeSessionProjectionSchema,
    runtime: acodeSessionRuntimeStateSchema,
    messages: z.array(acodeMessageWithPartsSchema),
    goalStats: acodeSessionGoalStatsSchema.optional(),
    todos: z.array(acodeSessionTodoItemSchema).optional(),
    todoGroups: z.array(acodeSessionTodoGroupSchema).optional(),
    slashCommands: z.array(acodeSlashCommandSchema).optional(),
  })
  .strict();

export type ACodeSessionStateSnapshot = z.infer<typeof acodeSessionStateSnapshotSchema>;

export const acodeSessionCreateParamsSchema = z
  .object({
    sessionId: nonEmptyString.optional(),
    workspace: acodeWorkspaceRefSchema,
    parentSessionId: nonEmptyString.optional(),
    mode: acodeSessionModeSchema.optional(),
    // 选择本次 session 由哪个 agent 引擎驱动。缺省 = native(glm)，旧 host/agent 不带此字段时
    // 行为不变。外部引擎不说 ACode Protocol，此字段只决定走哪条 spawn 路径，native 路径不受影响。
    engine: acodeAgentEngineIdSchema.optional(),
    model: modelSelectionSchema.optional(),
    persistence: acodeSessionPersistenceSchema.optional(),
    thoughtLevel: nonEmptyString.optional(),
    titleGenerationEnabled: z.boolean().optional(),
    mcpServers: z.array(acodeProtocolMcpServerSchema).optional(),
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    importedHistory: acodeSessionImportHistorySchema.optional(),
    // host 只按本地服务装配/远程/端形态决定是否注册工具，不读取灰度；
    // 缺省不下发 = 不注册；灰度与套餐准入在实际创建的 Host handler 校验。
    offPeakToolEnabled: z.boolean().optional(),
    // 动态工作流灰度：与 offPeakToolEnabled 同一
    // 模式——host 裁决后下发，缺省不下发 = 不注册工作流工具簇（fail-closed）。
    dynamicWorkflowEnabled: z.boolean().optional(),
  })
  .strict();

export type ACodeSessionCreateParams = z.infer<typeof acodeSessionCreateParamsSchema>;

export const acodeSessionListParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema.optional(),
    // 显式身份查询包含隐藏会话；普通列表仍只返回主任务，避免索引修复激活 runtime。
    sessionIds: z.array(nonEmptyString).min(1).max(64).optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const acodeTaskTokenUsageParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();

export const acodeTaskTokenUsageResultSchema = z
  .object({
    sessionId: nonEmptyString,
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    modelRequestCount: z.number().int().nonnegative(),
    modelErrorCount: z.number().int().nonnegative(),
    inputBaselineBySource: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export type ACodeTaskTokenUsageResult = z.infer<typeof acodeTaskTokenUsageResultSchema>;

export const acodeSessionCompactResultSchema = z
  .object({
    response: z.string(),
    snapshot: acodeSessionStateSnapshotSchema,
    compact: z
      .object({
        state: z.enum(["accepted", "already_running"]),
        inputId: nonEmptyString.optional(),
        operationId: nonEmptyString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ACodeSessionCompactResult = z.infer<typeof acodeSessionCompactResultSchema>;

export const acodeSessionGoalActionSchema = z.enum([
  "show",
  "set",
  "replace",
  "pause",
  "resume",
  "clear",
]);

export type ACodeSessionGoalAction = z.infer<typeof acodeSessionGoalActionSchema>;

export const acodeSessionGoalResultSchema = z
  .object({
    response: z.string(),
    snapshot: acodeSessionStateSnapshotSchema,
    startedTurn: z.boolean().optional(),
  })
  .strict();

export type ACodeSessionGoalResult = z.infer<typeof acodeSessionGoalResultSchema>;
