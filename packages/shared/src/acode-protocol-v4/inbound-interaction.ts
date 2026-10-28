// M2-4 inbound 交互面七法的 v4 wire schema（spec apps/acode-cli/specs/m2-4-inbound-interaction.md）。
//
// 迁移依据：这七个方法是 agent/CLI → host 方向（六反向请求 + 两通知；第八点取消通知与
// providerRuntimeHeaders 请求成对）。wire 形态与 legacy acode-protocol barrel 逐字一致——
// 本批只换方法名/通知名（transport.ts V4_METHODS/V4_NOTIFICATIONS 登记），不换载荷，
// 偏斜期（新 CLI+旧 host / 旧 CLI+新 host）两形态共存时语义逐点等价。
//
// 边界纪律：本文件不得 import legacy barrel（acode-protocol 目录的 index 聚合件）。
// - 幸存符号（permissionResponse/interactionRequestOrigin/workspaceRef）经
//   scripts/architecture/protocol-boundary.mjs 白名单既有条目导入（无新增登记）；
// - 中立面（browser 词汇 / modelSelection / accountAccess / officialMcp 失败原因）直导中立叶；
// - 其余形态在本叶逐字重声明（legacy 私有件 nonEmptyString/jsonObjectSchema/timestampMsSchema
//   同形重声明于下）。
//
// computerUseOperationEvent 属 packages/acode-cua fail-closed 面——迁不删：本叶的
// v4CuaOperationEventSchema 与 legacy discriminatedUnion("kind") 六变体逐点等价（保守默认，
// 零功能变化）；strict parse 失败丢弃 + warn 的宿主纪律在 services 分支执行，不在 schema 面。
import { z } from "zod";
import {
  acodeInteractionRequestOriginSchema,
  acodePermissionResponseSchema,
  acodeWorkspaceRefSchema,
} from "../acode-protocol-legacy-types.js";
import { acodeProviderAccountAccessSchema } from "../account-access-types.js";
import { browserBackendListResultSchema, browserSessionContextKindSchema } from "../browser-use/backend.js";
import { browserClientModeSchema, browserCommandSchema } from "../browser-use/commands.js";
import { browserCommandResultSchema } from "../browser-use/result.js";
import { modelSelectionSchema } from "../model-selection.js";
import { OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS } from "../official-mcp-auth.js";

// 与 legacy barrel 本地件逐字同形（:103-105）。
const nonEmptyString = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const timestampMsSchema = z.number().int().nonnegative();

// ── announce + immediate ack 的公共回执（§2.2）──
// permission/userInput 的 v4 请求是 announce：host parse+镜像+emitSessionEvent 后立刻回 {}，
// 真正应答走既有 v4 resolveInteraction command（不进本回执）。空严格对象 = 无载荷承诺。
export const v4InteractionRequestAckSchema = z.object({}).strict();
export type V4InteractionRequestAck = z.infer<typeof v4InteractionRequestAckSchema>;

// ── interaction/requestPermission（announce）──
// parity legacy acodePermissionOptionSchema（:622）：选项的 response 内嵌 legacy 应答形态，
// 旧桌面回传 response 原文的语义在偏斜期必须保留。
export const v4PermissionOptionSchema = z
  .object({
    optionId: nonEmptyString,
    kind: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    response: acodePermissionResponseSchema,
  })
  .strict();
export type V4PermissionOption = z.infer<typeof v4PermissionOptionSchema>;

// parity legacy acodePermissionRequestParamsSchema（:2204）。
export const v4InteractionRequestPermissionParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown(),
    origin: acodeInteractionRequestOriginSchema.optional(),
    options: z.array(v4PermissionOptionSchema).min(1),
  })
  .strict();
export type V4InteractionRequestPermissionParams = z.infer<
  typeof v4InteractionRequestPermissionParamsSchema
>;

// ── interaction/requestUserInput（announce）──
// parity legacy acodeUserInputOptionSchema / acodeUserInputQuestionSchema（:2263-2280）。
export const v4UserInputOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict();
export type V4UserInputOption = z.infer<typeof v4UserInputOptionSchema>;

export const v4UserInputQuestionSchema = z
  .object({
    question: nonEmptyString,
    header: nonEmptyString,
    options: z.array(v4UserInputOptionSchema).min(1),
    multiSelect: z.boolean().optional(),
  })
  .strict();
export type V4UserInputQuestion = z.infer<typeof v4UserInputQuestionSchema>;

// parity legacy acodeUserInputRequestParamsSchema（:2281）。
export const v4InteractionRequestUserInputParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    prompt: z.string().optional(),
    questions: z.array(v4UserInputQuestionSchema).min(1).optional(),
    input: z.unknown().optional(),
    origin: acodeInteractionRequestOriginSchema.optional(),
    schema: z.unknown().optional(),
  })
  .strict();
export type V4InteractionRequestUserInputParams = z.infer<
  typeof v4InteractionRequestUserInputParamsSchema
>;

// parity legacy acodeUserInputResponseSchema（:2297）。v4 announce 路径不用它收口（应答走
// resolveInteraction），-32601 回落的 legacy 反向 RPC 仍按它校验。
export const v4UserInputResponseSchema = z
  .object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: jsonObjectSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();
export type V4UserInputResponse = z.infer<typeof v4UserInputResponseSchema>;

// ── interaction/requestProviderRuntimeHeaders（真 RPC）+ 成对取消通知（第八点）──
// parity legacy acodeProviderRuntimeHeadersRequestReasonSchema（:2307）。
export const v4ProviderRuntimeHeadersRequestReasonSchema = z.enum(["model-request"]);
export type V4ProviderRuntimeHeadersRequestReason = z.infer<
  typeof v4ProviderRuntimeHeadersRequestReasonSchema
>;

// parity legacy acodeProviderRuntimeHeadersRequestParamsSchema（:2308-2320）。
export const v4InteractionRequestProviderRuntimeHeadersParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspace: acodeWorkspaceRefSchema,
    modelSelection: modelSelectionSchema,
    providerId: nonEmptyString,
    accountAccess: acodeProviderAccountAccessSchema.optional(),
    reason: v4ProviderRuntimeHeadersRequestReasonSchema,
  })
  .strict();
export type V4InteractionRequestProviderRuntimeHeadersParams = z.infer<
  typeof v4InteractionRequestProviderRuntimeHeadersParamsSchema
>;

// parity legacy acodeProviderRuntimeHeadersCancelledSchema（:2322-2328）。请求取消只作用于同
// workspace/session 的这一轮凭据刷新；通知形态绑定其触发请求的形态（spec §2.3）。
export const v4ProviderRuntimeHeadersCancelledSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    workspace: acodeWorkspaceRefSchema,
  })
  .strict();
export type V4ProviderRuntimeHeadersCancelled = z.infer<typeof v4ProviderRuntimeHeadersCancelledSchema>;

// parity legacy acodeProviderRuntimeHeadersResponseSchema（:2335-2358）：成功必须携带当前请求的
// 鉴权材料，不依赖旧 Registry 已被写入。
export const v4ProviderRuntimeHeadersResponseSchema = z.discriminatedUnion("headersApplied", [
  z
    .object({
      headersApplied: z.literal(true),
      requestAuth: z
        .object({
          apiKey: nonEmptyString.optional(),
          headers: z.record(nonEmptyString, nonEmptyString).optional(),
        })
        .strict(),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      headersApplied: z.literal(false),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
]);
export type V4ProviderRuntimeHeadersResponse = z.infer<typeof v4ProviderRuntimeHeadersResponseSchema>;

// ── interaction/requestOfficialMcpAuthHeaders（真 RPC）──
// Agent 进程不是用户身份权威：把 (pluginId, mcpKey, targetOrigin) 报给 host，由 host 解析当前
// Coding Plan 凭证并回传本次请求的身份头。请求侧不含任何秘密。
// parity legacy acodeOfficialMcpAuthHeadersRequestParamsSchema（:2364-2371）。
export const v4InteractionRequestOfficialMcpAuthHeadersParamsSchema = z
  .object({
    requestId: nonEmptyString,
    workspace: acodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    mcpKey: nonEmptyString,
    targetOrigin: nonEmptyString,
  })
  .strict();
export type V4InteractionRequestOfficialMcpAuthHeadersParams = z.infer<
  typeof v4InteractionRequestOfficialMcpAuthHeadersParamsSchema
>;

// 失败原因可枚举（调用方不按文本分流，响应不含 errorMessage）。parity legacy
// acodeOfficialMcpAuthFailureReasonSchema（:2388）。
export const v4OfficialMcpAuthFailureReasonSchema = z.enum(OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS);
export type V4OfficialMcpAuthFailureReason = z.infer<typeof v4OfficialMcpAuthFailureReasonSchema>;

// parity legacy acodeOfficialMcpAuthHeadersResponseSchema（:2391-2402）。
export const v4OfficialMcpAuthHeadersResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      headers: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: v4OfficialMcpAuthFailureReasonSchema,
    })
    .strict(),
]);
export type V4OfficialMcpAuthHeadersResponse = z.infer<typeof v4OfficialMcpAuthHeadersResponseSchema>;

// ── interaction/browserList / interaction/browserExecute（真 RPC）──
// parity legacy acodeBrowserListParamsSchema（:2221-2234）。Agent 请求 app 枚举当前
// workspace/session 可达且已完成握手的 browser backend。
export const v4InteractionBrowserListParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema,
    sessionContext: browserSessionContextKindSchema,
  })
  .strict();
export type V4InteractionBrowserListParams = z.infer<typeof v4InteractionBrowserListParamsSchema>;

// result 面本就中立（browser-use 叶），直接重导出——不重声明。
export const v4InteractionBrowserListResultSchema = browserBackendListResultSchema;
export type V4InteractionBrowserListResult = z.infer<typeof v4InteractionBrowserListResultSchema>;

// parity legacy acodeBrowserExecuteParamsSchema（:2240-2258）：Agent 把一条 browser-use 命令
// 发送给 app 执行。workspace 三字段在 host 侧回退连接 workspace（既有 spread 缺省）。
export const v4InteractionBrowserExecuteParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    browserId: nonEmptyString.optional(),
    browserGeneration: z.number().int().nonnegative().optional(),
    workspaceKey: nonEmptyString.optional(),
    workspacePath: nonEmptyString.optional(),
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema.optional(),
    sessionContext: browserSessionContextKindSchema.optional(),
    command: browserCommandSchema,
  })
  .strict();
export type V4InteractionBrowserExecuteParams = z.infer<typeof v4InteractionBrowserExecuteParamsSchema>;

// duplicate_request_id 用于在真正维护 pending/running 生命周期的边界拒绝 correlation key 冲突，
// 不能依赖上游 UUID 概率保证（legacy 同注释）。
export const v4InteractionBrowserExecuteResultSchema = browserCommandResultSchema;
export type V4InteractionBrowserExecuteResult = z.infer<typeof v4InteractionBrowserExecuteResultSchema>;

// ── computer-use/operation-event 通知（fail-closed 迁不删，逐点等价）──
// parity legacy acodeComputerUseOperationEventBaseSchema + 六变体（:983-1034）。
// scheduled 的 computerUse 只表达布尔事实（旧 operationAction 靠模型源码抽动作名，SDK 面一变就失配）。
const v4CuaOperationEventBaseSchema = z
  .object({
    eventId: nonEmptyString,
    sequenceNumber: z.number().int().nonnegative(),
    sessionId: nonEmptyString,
    timestamp: timestampMsSchema,
  })
  .strict();

const v4CuaTurnStartedEventSchema = v4CuaOperationEventBaseSchema.extend({
  kind: z.literal("turn-started"),
  turnId: nonEmptyString,
});
const v4CuaTurnCompletedEventSchema = v4CuaOperationEventBaseSchema.extend({
  kind: z.literal("turn-completed"),
  turnId: nonEmptyString,
});
const v4CuaTurnFailedEventSchema = v4CuaOperationEventBaseSchema.extend({
  kind: z.literal("turn-failed"),
  turnId: nonEmptyString,
});
const v4CuaToolScheduledEventSchema = v4CuaOperationEventBaseSchema.extend({
  kind: z.literal("tool-scheduled"),
  turnId: nonEmptyString,
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  computerUse: z.literal(true).optional(),
});
const v4CuaToolStartedEventSchema = v4CuaOperationEventBaseSchema.extend({
  kind: z.literal("tool-started"),
  turnId: nonEmptyString.optional(),
  toolCallId: nonEmptyString,
  toolName: nonEmptyString.optional(),
});
const v4CuaSessionClosedEventSchema = v4CuaOperationEventBaseSchema.extend({
  kind: z.literal("session-closed"),
});

export const v4CuaOperationEventSchema = z.discriminatedUnion("kind", [
  v4CuaTurnStartedEventSchema,
  v4CuaTurnCompletedEventSchema,
  v4CuaTurnFailedEventSchema,
  v4CuaToolScheduledEventSchema,
  v4CuaToolStartedEventSchema,
  v4CuaSessionClosedEventSchema,
]);
export type V4CuaOperationEvent = z.infer<typeof v4CuaOperationEventSchema>;
