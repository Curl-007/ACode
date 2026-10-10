/* oxlint-disable eslint(max-lines) -- re-home 产物：旧协议消息/会话承重类型集中迁移，保持单文件契约面。 */
// re-home 迁移产物（为删除旧协议树铺路）。
// 本文件承载旧 ACode Protocol 中仍被存活栈（validation/background-task-notifications/
// v4 投影等）消费的承重类型与 schema：ACodeSessionInfo / ACodeMessageWithParts /
// ACodePermissionResponse / ACodeInteractionRequestOrigin 及其依赖闭包。
// 旧协议死亡（acode-protocol/index.ts 删除）后，这是该协议面的唯一幸存面。

import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

const nonEmptyString = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const timestampMsSchema = z.number().int().nonnegative();
export const acodeDeliveryKindSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);
export const acodeMessageVisibilitySchema = z.enum(["user-visible", "model-only"]);
export const acodeSyntheticUserMessageSourceSchema = z.enum([
  "background_task",
  "fork",
  "goal_state_change",
  "goal-continuation",
  // peer 消息镜像（specs/agent-peer-messaging.md R5）：兄弟间消息落共同父会话的
  // model-only 合成 notice；词表与 contracts SYNTHETIC_USER_MESSAGE_SOURCES 同步。
  "peer_message",
  "plugin_reference",
  "rewind",
  "selection_side_chat",
  "subagent",
  // child 回复会作为 model-only synthetic user message 持久化；
  // app/agent 共用的承重消息 schema 必须与 CLI contracts 使用同一来源词表。
  "subagent_message",
  "todo_reminder",
  // 中枢直接启动工作流的启动轮 source；与 contracts 的
  // SYNTHETIC_USER_MESSAGE_SOURCES 保持同一词表，否则 v3 mapper 收窄该 source 会 tsc 失败。
  "workflow_launch",
  "shared_context",
]);
export const acodeWorkspaceRefSchema = z
  .object({
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
  })
  .strict();
export const acodePermissionDecisionSchema = z.enum(["allow", "deny", "escalate", "modify"]);
export const acodePermissionRuleBehaviorSchema = z.enum(["allow", "deny", "ask"]);
/** Backward-compatible wire/storage key interpreted only for trusted official CUA tools. */
export const OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME = "acode:permission-capability:official_cua";
/**
 * workflow 运行确认窗第三选项「Refine」（拒绝并附修改意见）的稳定 optionId。
 * CLI 侧 v4 投影合成选项、broker 应答映射与 GUI 特判共用同一常量；
 * 该选项只在 v4 链路投放。
 */
export const WORKFLOW_REFINE_PERMISSION_OPTION_ID = "workflowRefine";
export const acodePermissionRuleValueSchema = z
  .object({
    toolName: nonEmptyString,
    ruleContent: z.string().optional(),
  })
  .strict();
export const acodePermissionUpdateSchema = z
  .object({
    type: z.literal("addRules"),
    behavior: acodePermissionRuleBehaviorSchema,
    rules: z.array(acodePermissionRuleValueSchema).min(1),
  })
  .strict();
export const acodePermissionResponseSchema = z
  .object({
    decision: acodePermissionDecisionSchema,
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    permissionUpdates: z.array(acodePermissionUpdateSchema).optional(),
  })
  .strict();
export type ACodePermissionResponse = z.infer<typeof acodePermissionResponseSchema>;
export const acodeSessionModeSchema = z.enum(["plan", "build", "edit", "yolo", "auto"]);
/**
 * 引擎权限模式联合（镜像 ZCode kernel:34720 dzi）。
 *
 * native(glm) 实际只用 build/edit/plan/yolo 子集。外部引擎槽位已下线
 * （spec: agent-engine-external-slots-removal.md），但联合保持取值上界不收窄：
 * bots 权限投影（含历史 bot 配置里的 default/acceptEdits 等档位文案）仍消费完整联合，
 * 引擎作用域的实际允许集见 getAgentEnginePermissionModes()。
 */
export const acodeEnginePermissionModeSchema = z.enum([
  "default",
  "yolo",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);
export type ACodeEnginePermissionMode = z.infer<typeof acodeEnginePermissionModeSchema>;
export const acodeSessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "paused",
  "completed",
  "error",
]);
export const acodeSessionKindSchema = z.enum([
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
]);
export const acodeSessionGoalSchema = z
  .object({
    sessionId: nonEmptyString,
    targetId: nonEmptyString,
    objective: nonEmptyString,
    // 旧版持久化 session target 不包含 summaryTitle。
    // 协议读取历史 snapshot 时补 null，避免老会话恢复失败。
    summaryTitle: z.string().min(1).nullable().default(null),
    status: z.enum(["active", "paused", "budget_limited", "complete"]),
    tokenBudget: z.number().int().positive().nullable(),
    tokensUsed: z.number().int().nonnegative(),
    timeUsedSeconds: z.number().int().nonnegative(),
    activeInputId: nonEmptyString.nullable().optional(),
    activeRunStartedAtMs: timestampMsSchema.nullable().optional(),
    activeRunLastSeenAtMs: timestampMsSchema.nullable().optional(),
    createdAt: timestampMsSchema,
    updatedAt: timestampMsSchema,
  })
  .strict();
export const acodeSessionGoalVerificationSchema = z
  .object({
    nextAction: z.string().nullable().optional(),
    passed: z.boolean(),
    reason: z.string(),
  })
  .strict();
export const acodeSessionGoalVerificationTimelineSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("synthetic"),
    type: z.literal("goal_verification"),
    display: z.literal("separator"),
    targetId: nonEmptyString,
    verificationId: nonEmptyString,
    status: z.enum(["started", "completed", "failed_closed", "cancelled"]),
    verification: acodeSessionGoalVerificationSchema.optional(),
    goalIteration: z.number().int().positive().optional(),
    anchorAssistantMessageId: nonEmptyString.optional(),
    anchorTurnId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema,
  })
  .strict();
export const acodeSessionInfoSchema = z
  .object({
    sessionId: nonEmptyString,
    workspace: acodeWorkspaceRefSchema,
    parentSessionId: nonEmptyString.optional(),
    traceId: nonEmptyString.optional(),
    sessionKind: acodeSessionKindSchema,
    title: z.string(),
    titleSource: z.enum(["default", "first_input", "generated", "custom"]).optional(),
    mode: acodeSessionModeSchema,
    status: acodeSessionStatusSchema,
    model: modelSelectionSchema.optional(),
    target: acodeSessionGoalSchema.nullable().optional(),
    createdAt: timestampMsSchema,
    updatedAt: timestampMsSchema,
    archivedAt: timestampMsSchema.optional(),
  })
  .strict();
export type ACodeSessionInfo = z.infer<typeof acodeSessionInfoSchema>;
// 编排方案 R5/R6（apps/acode-cli/specs/subagent-interaction-origin-lineage.md R4）：
// 祖先链条目与 CLI contracts 的 SubagentInteractionOriginAncestor 字段一一对应。
// additive 可选：只有 depth≥2（嵌套被显式解锁）的请求才携带，maxDepth 缺省 1 时
// 旧客户端永远遇不到带新字段的载荷——strict 校验的版本偏斜安全由此承担。
export const acodeInteractionOriginAncestorSchema = z
  .object({
    agentId: nonEmptyString,
    agentType: nonEmptyString,
    sessionId: nonEmptyString,
    parentSessionId: nonEmptyString,
    description: z.string().optional(),
    parentToolCallId: nonEmptyString.optional(),
    parentTurnId: nonEmptyString.optional(),
  })
  .strict();
export type ACodeInteractionOriginAncestor = z.infer<typeof acodeInteractionOriginAncestorSchema>;
export const acodeInteractionRequestOriginSchema = z
  .object({
    kind: z.literal("subagent"),
    agentId: nonEmptyString,
    agentType: nonEmptyString,
    childSessionId: nonEmptyString,
    childTurnId: nonEmptyString.optional(),
    description: z.string().optional(),
    parentSessionId: nonEmptyString,
    parentToolCallId: nonEmptyString.optional(),
    parentTurnId: nonEmptyString.optional(),
    // depth≥2：祖先链内→外 + 客户端可见根会话；depth 1 两字段缺席（历史载荷原样通过）。
    ancestors: z.array(acodeInteractionOriginAncestorSchema).optional(),
    rootSessionId: nonEmptyString.optional(),
  })
  .strict();
export type ACodeInteractionRequestOrigin = z.infer<typeof acodeInteractionRequestOriginSchema>;
const messageTimeSchema = z
  .object({
    created: timestampMsSchema,
    completed: timestampMsSchema.optional(),
  })
  .strict();
export const acodeTokenUsageSchema = z
  .object({
    total: z.number().int().nonnegative().optional(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    cache: z
      .object({
        read: z.number().int().nonnegative(),
        write: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const acodeMessageSemanticsSchema = z
  .object({
    origin: z.enum(["real_user", "agent_runtime", "system", "migration", "import"]),
    kind: z.enum([
      "user_prompt",
      "slash_command",
      "system_reminder",
      "background_notification",
      "subagent_notification",
      "todo_reminder",
      "rewind_notice",
      "fork_notice",
      "timeline_event",
      "compact_summary",
      "shared_context",
      "assistant_response",
    ]),
    source: z.string().optional(),
    commandName: z.string().optional(),
    uiVisibility: z.enum(["visible", "hidden", "debug"]),
    providerVisibility: z.enum(["visible", "hidden"]),
    transcriptVisibility: z.enum(["visible", "hidden"]),
  })
  .strict();
export const acodeUserMessageInfoSchema = z
  .object({
    messageId: nonEmptyString,
    sessionId: nonEmptyString,
    role: z.literal("user"),
    time: messageTimeSchema,
    agent: nonEmptyString,
    // 旧消息或未绑定会话的合成消息可能没有请求来源；不借默认模型补写。
    model: modelSelectionSchema.optional(),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    synthetic: z.boolean().optional(),
    source: acodeSyntheticUserMessageSourceSchema.optional(),
    visibility: acodeMessageVisibilitySchema.optional(),
    semantics: acodeMessageSemanticsSchema.optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();
export const acodeAssistantMessageInfoSchema = z
  .object({
    messageId: nonEmptyString,
    sessionId: nonEmptyString,
    role: z.literal("assistant"),
    time: messageTimeSchema,
    parentMessageId: nonEmptyString,
    agent: nonEmptyString,
    model: modelSelectionSchema.optional(),
    path: z
      .object({
        cwd: nonEmptyString,
        root: nonEmptyString,
      })
      .strict(),
    cost: z.number().nonnegative(),
    tokens: acodeTokenUsageSchema,
    finish: z.string().optional(),
    error: jsonObjectSchema.optional(),
    semantics: acodeMessageSemanticsSchema.optional(),
    structured: z.unknown().optional(),
  })
  .strict();
export const acodeMessageInfoSchema = z.discriminatedUnion("role", [
  acodeUserMessageInfoSchema,
  acodeAssistantMessageInfoSchema,
]);
export type ACodeMessageInfo = z.infer<typeof acodeMessageInfoSchema>;
const partBaseSchema = z.object({
  partId: nonEmptyString,
  sessionId: nonEmptyString,
  messageId: nonEmptyString,
});
export const acodeToolStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("pending"),
      input: jsonObjectSchema,
      raw: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("running"),
      input: jsonObjectSchema,
      title: z.string().optional(),
      metadata: jsonObjectSchema.optional(),
      startedAt: timestampMsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      input: jsonObjectSchema,
      output: z.string(),
      title: z.string(),
      metadata: jsonObjectSchema,
      startedAt: timestampMsSchema,
      completedAt: timestampMsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      input: jsonObjectSchema,
      error: z.string(),
      metadata: jsonObjectSchema.optional(),
      startedAt: timestampMsSchema,
      completedAt: timestampMsSchema,
    })
    .strict(),
]);
const acodeTimelineModelSelectionSchema = modelSelectionSchema.extend({
  label: z.string().optional(),
});
const acodeTimelinePartTimeSchema = z
  .object({
    start: timestampMsSchema.optional(),
    end: timestampMsSchema.optional(),
  })
  .strict();
export const acodeTimelinePartSchema = partBaseSchema
  .extend({
    type: z.literal("timeline"),
    timelineType: z.enum([
      "context_compaction",
      "goal_verification",
      "session_fork",
      "model_change",
    ]),
    display: z.enum(["separator", "worklog"]),
    status: z.string().optional(),
    anchorMessageId: nonEmptyString.optional(),
    anchorTurnId: nonEmptyString.optional(),
    time: acodeTimelinePartTimeSchema.optional(),
    operationId: z.string().optional(),
    trigger: z.enum(["manual", "auto", "partial", "reactive", "session_memory"]).optional(),
    phase: z.enum(["standalone_turn", "pre_request", "mid_turn", "reactive"]).optional(),
    compactReason: z.string().optional(),
    boundaryId: z.string().optional(),
    summaryMessageId: nonEmptyString.optional(),
    preCompactTokenCount: z.number().int().nonnegative().optional(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    attempt: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
    targetId: z.string().optional(),
    verificationId: z.string().optional(),
    goalIteration: z.number().int().nonnegative().optional(),
    verification: z
      .object({
        passed: z.boolean(),
        reason: z.string(),
        nextAction: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    parentSessionId: nonEmptyString.optional(),
    targetMessageId: nonEmptyString.optional(),
    targetCheckpointId: z.string().optional(),
    restoredFileCount: z.number().int().nonnegative().optional(),
    fromModel: acodeTimelineModelSelectionSchema.optional(),
    toModel: acodeTimelineModelSelectionSchema
      .extend({
        label: nonEmptyString,
      })
      .optional(),
  })
  .strict();
export const acodeMessagePartSchema = z.discriminatedUnion("type", [
  partBaseSchema
    .extend({
      type: z.literal("text"),
      text: z.string(),
      synthetic: z.boolean().optional(),
      ignored: z.boolean().optional(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("reasoning"),
      text: z.string(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("file"),
      mime: nonEmptyString,
      filename: z.string().optional(),
      url: nonEmptyString,
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("tool"),
      callId: nonEmptyString,
      tool: nonEmptyString,
      state: acodeToolStateSchema,
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({ type: z.literal("step-start"), snapshot: z.string().optional() })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("step-finish"),
      reason: z.string(),
      snapshot: z.string().optional(),
      cost: z.number().nonnegative(),
      tokens: acodeTokenUsageSchema,
    })
    .strict(),
  partBaseSchema.extend({ type: z.literal("snapshot"), snapshot: z.string() }).strict(),
  partBaseSchema
    .extend({
      type: z.literal("patch"),
      hash: nonEmptyString,
      files: z.array(z.string()),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("compaction"),
      auto: z.boolean(),
      reason: z.string().optional(),
      summaryMessageId: nonEmptyString.optional(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  acodeTimelinePartSchema,
  partBaseSchema
    .extend({
      type: z.literal("subagent"),
      prompt: z.string(),
      description: z.string(),
      agent: nonEmptyString,
      model: modelSelectionSchema.optional(),
      command: z.string().optional(),
    })
    .strict(),
  partBaseSchema.extend({ type: z.literal("agent"), name: nonEmptyString }).strict(),
  partBaseSchema
    .extend({
      type: z.literal("retry"),
      attempt: z.number().int().nonnegative(),
      error: jsonObjectSchema,
    })
    .strict(),
]);
export type ACodeMessagePart = z.infer<typeof acodeMessagePartSchema>;
export const acodeMessageWithPartsSchema = z
  .object({
    info: acodeMessageInfoSchema,
    parts: z.array(acodeMessagePartSchema),
  })
  .strict();
export type ACodeMessageWithParts = z.infer<typeof acodeMessageWithPartsSchema>;
export const acodeSessionApiRetryStatusSchema = z
  .object({
    kind: z.literal("api_retry"),
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    retryDelayMs: z.number().int().nonnegative(),
    errorStatus: z.number().int().nonnegative().nullable(),
    error: z.string(),
  })
  .strict();
export const acodeSessionContextCacheUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    latestHitRate: z.number().nonnegative().nullable().optional(),
    hitRateRequestCount: z.number().int().nonnegative().optional(),
    totalInputTokens: z.number().int().nonnegative().optional(),
    totalCacheReadTokens: z.number().int().nonnegative().optional(),
    totalCacheWriteTokens: z.number().int().nonnegative().optional(),
    hitRate: z.number().nonnegative().nullable(),
    // prompt-cache miss 归因计数快照（apps/acode-cli/specs/prompt-cache-diagnostics.md R4）。
    // 开放 record 不复刻 CLI 因集枚举——CLI 未来加因不需要再动本镜像（版本偏斜安全）；
    // 必须与 CLI 生产侧同一提交加宽，否则 v4 客户端 strict 校验整帧拒收。
    missCauses: z.record(z.string(), z.number().int().nonnegative()).optional(),
  })
  .strict();
export const acodeContextUsageBreakdownSourceSchema = z.enum([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
]);
export const acodeContextUsageBreakdownItemSchema = z
  .object({
    source: acodeContextUsageBreakdownSourceSchema,
    chars: z.number().int().nonnegative(),
  })
  .strict();
export type ACodeContextUsageBreakdownItem = z.infer<typeof acodeContextUsageBreakdownItemSchema>;
export const acodeContextUsageBreakdownSchema = z.array(acodeContextUsageBreakdownItemSchema);
export const acodeSessionContextUsageSchema = z
  .object({
    used: z.number().int().nonnegative(),
    size: z.number().int().positive(),
    cost: z
      .object({
        amount: z.number().nonnegative(),
        currency: nonEmptyString,
      })
      .strict()
      .nullable()
      .optional(),
    cache: acodeSessionContextCacheUsageSchema.optional(),
    breakdown: acodeContextUsageBreakdownSchema.optional(),
  })
  .strict();
export const acodeSessionRuntimeStateSchema = z
  .object({
    eventSeq: z.number().int().nonnegative(),
    stateRevision: z.number().int().nonnegative(),
    deliveryKind: acodeDeliveryKindSchema.optional(),
    activeTurnId: nonEmptyString.optional(),
    activeTurnKind: z.enum(["regular", "compact", "rewind"]).optional(),
    pendingRequestIds: z.array(nonEmptyString),
    apiRetry: acodeSessionApiRetryStatusSchema.nullable().optional(),
    contextUsage: acodeSessionContextUsageSchema.optional(),
    goalVerifications: z.array(acodeSessionGoalVerificationSchema).optional(),
    goalVerificationTimeline: z.array(acodeSessionGoalVerificationTimelineSchema).optional(),
  })
  .strict();
export type ACodeSessionRuntimeState = z.infer<typeof acodeSessionRuntimeStateSchema>;
export type ACodeSessionActiveTurnKind = NonNullable<ACodeSessionRuntimeState["activeTurnKind"]>;
export function textFromACodeMessageParts(parts: readonly ACodeMessagePart[]): string {
  return parts
    .filter((part): part is Extract<ACodeMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}
