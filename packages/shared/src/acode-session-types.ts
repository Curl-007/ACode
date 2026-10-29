// session 核心 wire 类型（goal/info/mode/status/kind/workspaceRef 等）。M4 从 acode-protocol-legacy-types.ts 中立迁移。

import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

const nonEmptyString = z.string().trim().min(1);
const timestampMsSchema = z.number().int().nonnegative();

export const acodeDeliveryKindSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);

export type ACodeDeliveryKind = z.infer<typeof acodeDeliveryKindSchema>;

export const acodeWorkspaceRefSchema = z
  .object({
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
  })
  .strict();

export type ACodeWorkspaceRef = z.infer<typeof acodeWorkspaceRefSchema>;

export const acodeSessionModeSchema = z.enum(["plan", "build", "edit", "yolo", "auto", "dontAsk"]);

export type ACodeSessionMode = z.infer<typeof acodeSessionModeSchema>;

export const acodeSessionKindSchema = z.enum([
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
]);

export type ACodeSessionKind = z.infer<typeof acodeSessionKindSchema>;

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

export type ACodeSessionGoal = z.infer<typeof acodeSessionGoalSchema>;

export const acodeSessionGoalVerificationSchema = z
  .object({
    nextAction: z.string().nullable().optional(),
    passed: z.boolean(),
    reason: z.string(),
  })
  .strict();

export type ACodeSessionGoalVerification = z.infer<typeof acodeSessionGoalVerificationSchema>;

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

export type ACodeSessionGoalVerificationTimeline = z.infer<
  typeof acodeSessionGoalVerificationTimelineSchema
>;

export const acodeMessageVisibilitySchema = z.enum(["user-visible", "model-only"]);

export const acodeSyntheticUserMessageSourceSchema = z.enum([
  // 跨回合 auto-resume（apps/acode-cli/specs/turn-auto-resume.md）：runtime 退避后注入的
  // model-only 继续指令；词表与 contracts SYNTHETIC_USER_MESSAGE_SOURCES 同步。
  "auto_resume",
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
  // 工具按需检索公告（apps/acode-cli/specs/tool-search.md R9/R10）：model-only
  // synthetic notice；词表与 contracts SYNTHETIC_USER_MESSAGE_SOURCES 同步。
  "tool_search_announcement",
  // 中枢直接启动工作流的启动轮 source；与 contracts 的
  // SYNTHETIC_USER_MESSAGE_SOURCES 保持同一词表，否则 v3 mapper 收窄该 source 会 tsc 失败。
  "workflow_launch",
  "shared_context",
]);

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
