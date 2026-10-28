// M2-3 session 读写面八方法的 v4 wire schema（spec apps/acode-cli/specs/m2-3-session-readwrite.md）。
//
// 字段值域与 legacy acode-protocol barrel 逐字 parity（read/resume/list/messages/events/
// subscribe 六 params + runtimePreferences 推送载荷 + createSession 命令 parity 字段形状）。
// 事件词汇 26 变体与 snapshot 闭合不复制（services 侧继续用 barrel result schema 校验，
// wire 形态本就逐字一致；schema 居所 consolidation 归 M4，见 spec §2.6）。
//
// 边界纪律：本文件不得 import legacy barrel（acode-protocol 目录的 index 聚合件）；
// legacy-types 幸存符号（deliveryKind/sessionMode/sessionInfo/messageWithParts/
// workspaceRef）经 scripts/architecture/protocol-boundary.mjs 白名单 M2-3 显式登记。
import { z } from "zod";
import { acodeProtocolMcpServerSchema } from "../acode-protocol-shared.js";
import {
  acodeDeliveryKindSchema,
  acodeSessionInfoSchema,
  acodeSessionModeSchema,
  acodeWorkspaceRefSchema,
} from "../acode-protocol-legacy-types.js";
import { modelSelectionSchema } from "../model-selection.js";
import { integratedTerminalShellSelectionSchema } from "../validationAppSettings.js";

const nonEmptyString = z.string().trim().min(1);
// 与 legacy barrel 本地 timestampMsSchema 同形（epoch ms，非负整数）。
const timestampMsSchema = z.number().int().nonnegative();

// ── params：六 query + 一推送（逐字 parity legacy barrel 对应 params schema）──

// v4/session/read：parity legacy acodeSessionReadParamsSchema（deliveryKind 写入 record
// 的副作用承载 legacy live 转发的投递画像，CLI op 直通保留）。
export const v4SessionReadParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: acodeDeliveryKindSchema.optional(),
    messageLimit: z.number().int().positive().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
export type V4SessionReadParams = z.infer<typeof v4SessionReadParamsSchema>;

// v4/session/resume：parity legacy acodeSessionResumeParamsSchema（冷恢复重建 runtime 的
// 工具面/灰度透传语义逐字保留）。
export const v4SessionResumeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    workspace: acodeWorkspaceRefSchema.optional(),
    thoughtLevel: nonEmptyString.optional(),
    mcpServers: z.array(acodeProtocolMcpServerSchema).optional(),
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    offPeakToolEnabled: z.boolean().optional(),
    dynamicWorkflowEnabled: z.boolean().optional(),
  })
  .strict();
export type V4SessionResumeParams = z.infer<typeof v4SessionResumeParamsSchema>;

// v4/sessions/list：parity legacy acodeSessionListParamsSchema（显式身份查询含隐藏会话、
// includeArchived 缺省 false，均原样承载）。
export const v4SessionsListParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema.optional(),
    sessionIds: z.array(nonEmptyString).min(1).max(64).optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type V4SessionsListParams = z.infer<typeof v4SessionsListParamsSchema>;

// v4/session/messages：parity legacy acodeSessionMessagesParamsSchema
// （afterMessageId = 严格其后；limit = 尾部 N 条，语义由 CLI op 承载）。
export const v4SessionMessagesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterMessageId: nonEmptyString.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type V4SessionMessagesParams = z.infer<typeof v4SessionMessagesParamsSchema>;

// v4/session/events：parity legacy acodeSessionEventsParamsSchema（裁决：独立事件日志查询，
// 不并入 conversation frame）。
export const v4SessionEventsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type V4SessionEventsParams = z.infer<typeof v4SessionEventsParamsSchema>;

// v4/session/subscribe：parity legacy acodeSessionSubscribeParamsSchema
// （换名承载 legacy 语义；eventSeq+events+snapshot 同一水位原子返回，spec §6.2）。
export const v4SessionSubscribeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: acodeDeliveryKindSchema,
    afterSeq: z.number().int().nonnegative().optional(),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export type V4SessionSubscribeParams = z.infer<typeof v4SessionSubscribeParamsSchema>;

// ── runtimePreferences 推送（host→CLI；parity legacy result 形态，两 scope 合并后全量）──

// 值域逐字 parity legacy acodeSessionRuntimePreferencesResultSchema 的五键；推送恒携带
// 解析后全量（不含 legacy 的 .default 兼容件——两端皆新，无 skew）。
export const v4SessionRuntimePreferencesSchema = z
  .object({
    nativeSearchEnhancementsEnabled: z.boolean(),
    memoryEnabled: z.boolean(),
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
    modelContextBudgetStrategy: nonEmptyString.optional(),
  })
  .strict();
export type V4SessionRuntimePreferences = z.infer<typeof v4SessionRuntimePreferencesSchema>;

export const v4SessionRuntimePreferencesPushParamsSchema = z
  .object({
    preferences: v4SessionRuntimePreferencesSchema,
  })
  .strict();
export type V4SessionRuntimePreferencesPushParams = z.infer<
  typeof v4SessionRuntimePreferencesPushParamsSchema
>;

/** 推送面是无返回值的承载：CLI handler 落缓存后回 `{}`。 */
export const v4SessionRuntimePreferencesResultSchema = z.object({}).strict();
export type V4SessionRuntimePreferencesResult = z.infer<
  typeof v4SessionRuntimePreferencesResultSchema
>;

// ── result：白名单可达词汇的 result schema 在本叶承载 ──

// v4/sessions/list result：parity legacy acodeSessionListResultSchema。
export const v4SessionsListResultSchema = z
  .object({
    sessions: z.array(acodeSessionInfoSchema),
  })
  .strict();
export type V4SessionsListResult = z.infer<typeof v4SessionsListResultSchema>;

// v4/session/messages 刻意不自立 result schema：op 直通 raw opencode MessageWithParts
// （info.id 词汇，server-operations.ts readMessages），legacy services 对 barrel 的
// acodeSessionMessagesResultSchema 仅是孤儿 import 从不校验——迁移逐字 parity 即
// 「不校验」。normalized messageWithParts 词汇只存在于 session/read snapshot 的
// mapMessageWithParts 路径（spec m2-3-session-readwrite.md §6 登记）。

// ── createSession 命令 parity 字段（command.ts payload 以 spread 引用，实体留本叶）──

// 值域逐字 parity legacy acodeSessionImportMessageSchema / acodeSessionImportHistorySchema
// （discriminatedUnion source，现仅 claudeCode 变体；messages min 1）。
export const v4SessionImportMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: timestampMsSchema.optional(),
  })
  .strict();
export type V4SessionImportMessage = z.infer<typeof v4SessionImportMessageSchema>;

export const v4SessionImportHistorySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("claudeCode"),
      title: nonEmptyString.optional(),
      createdAt: timestampMsSchema.optional(),
      updatedAt: timestampMsSchema.optional(),
      messages: z.array(v4SessionImportMessageSchema).min(1),
    })
    .strict(),
]);
export type V4SessionImportHistory = z.infer<typeof v4SessionImportHistorySchema>;

// 值域逐字 parity legacy acodeSessionPersistenceSchema（barrel 词，v4 侧自立；
// command.ts 的 closeSession expectedPersistence 同款先例）。
export const v4SessionPersistenceSchema = z.enum(["immediate", "deferred"]);
export type V4SessionPersistence = z.infer<typeof v4SessionPersistenceSchema>;

// M2-3 parity 字段形状（plain shape，command.ts 的 commandPayloadSchemas.createSession
// 以 `...v4SessionCreateParityFieldShapes` 引用——command.ts 受 max-file-lines 例外
// 冻结纪律，字段实体不内联）。全部 optional、additive：v4 payload 非 strict，旧 CLI
// 静默丢键 fail-closed。parentSessionId/engine 刻意不带（全仓无生产者，spec §2.1）。
export const v4SessionCreateParityFieldShapes = {
  sessionId: nonEmptyString.optional(),
  persistence: v4SessionPersistenceSchema.optional(),
  titleGenerationEnabled: z.boolean().optional(),
  toolAllowlist: z.array(nonEmptyString).optional(),
  toolDenylist: z.array(nonEmptyString).optional(),
  importedHistory: v4SessionImportHistorySchema.optional(),
  mode: acodeSessionModeSchema.optional(),
  model: modelSelectionSchema.optional(),
  thoughtLevel: nonEmptyString.optional(),
} as const;
