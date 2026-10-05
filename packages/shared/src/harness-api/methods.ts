// Harness API v1 方法面（R2 最小稳定集，刻意小于内部协议）。
// 参照 jcode (MIT) harness-api 的方法分类（会话/驱动/事件/权限/配置/文件/工具控制），
// 自撰 schema；所有类型独立于 acode-protocol v4——投影层有自己的类型，翻译层负责映射。
//
// v1 明确不含：仓库级管理、多 workspace 并发编排、provider 凭据管理写操作（只读 get_models）。
// services 层暂缺的能力（rewind/search_text/configure_tools 等）方法保留在面上、
// 由翻译桥返回 `not_supported` 错误（结构化降级，见 spec 附录映射表），不发明不存在的调用。

import { z } from "zod";

const nonEmptyString = z.string().min(1);

/** 模型选择（与内部 ModelSelection 同形，但类型独立——投影层不 import 内部类型）。 */
export const harnessModelSelectionSchema = z
  .object({
    providerId: nonEmptyString,
    modelId: nonEmptyString,
    options: z
      .object({
        reasoningLevel: nonEmptyString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HarnessModelSelection = z.infer<typeof harnessModelSelectionSchema>;

const workspaceTarget = {
  workspacePath: nonEmptyString,
  workspaceIdentity: z.string().optional(),
} as const;

const sessionTarget = {
  ...workspaceTarget,
  sessionId: nonEmptyString,
} as const;

// ── 会话 ──

export const listSessionsParamsSchema = z
  .object({
    ...workspaceTarget,
    includeArchived: z.boolean().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();
export type ListSessionsParams = z.infer<typeof listSessionsParamsSchema>;

export const harnessSessionSummarySchema = z
  .object({
    sessionId: nonEmptyString,
    parentSessionId: z.string().optional(),
    title: z.string().optional(),
    mode: z.string().optional(),
    status: z.string().optional(),
    model: harnessModelSelectionSchema.optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  })
  .strict();
export type HarnessSessionSummary = z.infer<typeof harnessSessionSummarySchema>;

export const listSessionsResultSchema = z
  .object({ sessions: z.array(harnessSessionSummarySchema) })
  .strict();
export type ListSessionsResult = z.infer<typeof listSessionsResultSchema>;

export const createSessionParamsSchema = z
  .object({
    ...workspaceTarget,
    /** 预分配 sessionId（fork/导入场景）；缺省由引擎分配。 */
    sessionId: z.string().optional(),
    /** fork 来源会话。 */
    parentSessionId: z.string().optional(),
    mode: z.string().optional(),
    model: harnessModelSelectionSchema.optional(),
    /** 会话级工具禁用清单（映射内部 create/resume 的 toolDenylist）。 */
    toolDenylist: z.array(nonEmptyString).optional(),
    /**
     * 自定义 system prompt：services 层 createSession 无此入参，
     * 提供时翻译桥返回 not_supported（如实降级，不静默忽略）。
     */
    systemPrompt: z.string().optional(),
  })
  .strict();
export type CreateSessionParams = z.infer<typeof createSessionParamsSchema>;

export const createSessionResultSchema = z
  .object({
    sessionId: nonEmptyString,
    status: z.string().optional(),
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CreateSessionResult = z.infer<typeof createSessionResultSchema>;

export const attachSessionParamsSchema = z.object({ ...sessionTarget }).strict();
export type AttachSessionParams = z.infer<typeof attachSessionParamsSchema>;

export type AttachSessionResult = CreateSessionResult;

export const detachSessionParamsSchema = z.object({ ...sessionTarget }).strict();
export type DetachSessionParams = z.infer<typeof detachSessionParamsSchema>;

export const detachSessionResultSchema = z.object({ detached: z.boolean() }).strict();
export type DetachSessionResult = z.infer<typeof detachSessionResultSchema>;

export const forkSessionParamsSchema = z.object({ ...sessionTarget }).strict();
export type ForkSessionParams = z.infer<typeof forkSessionParamsSchema>;
export type ForkSessionResult = CreateSessionResult;

export const rewindSessionParamsSchema = z
  .object({
    ...sessionTarget,
    /** 回退目标（turn 索引 / 消息 id）；v1 schema 预留，翻译桥当前返回 not_supported。 */
    target: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("turn"), turnIndex: z.number().int().nonnegative() }).strict(),
        z.object({ kind: z.literal("message"), messageId: nonEmptyString }).strict(),
      ])
      .optional(),
  })
  .strict();
export type RewindSessionParams = z.infer<typeof rewindSessionParamsSchema>;
export const rewindSessionResultSchema = z.object({ rewound: z.boolean() }).strict();
export type RewindSessionResult = z.infer<typeof rewindSessionResultSchema>;

// ── 驱动 ──

export const sendMessageParamsSchema = z
  .object({
    ...sessionTarget,
    content: nonEmptyString,
    model: harnessModelSelectionSchema.optional(),
    /** 本 turn 额外禁用的工具（与创建时 toolDenylist 合并）。 */
    toolDenylist: z.array(nonEmptyString).optional(),
  })
  .strict();
export type SendMessageParams = z.infer<typeof sendMessageParamsSchema>;

export const sendMessageResultSchema = z
  .object({
    accepted: z.literal(true),
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>;

export const cancelTurnParamsSchema = z.object({ ...sessionTarget }).strict();
export type CancelTurnParams = z.infer<typeof cancelTurnParamsSchema>;
export const cancelTurnResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type CancelTurnResult = z.infer<typeof cancelTurnResultSchema>;

/** run = send_message + 服务端等待 TurnResult 的便捷合并；轮询内部事件面直到终态。 */
export const runParamsSchema = sendMessageParamsSchema;
export type RunParams = SendMessageParams;

const turnUsageShape = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

export const runResultSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: z.string().optional(),
    resultType: z.enum(["success", "cancelled", "error"]),
    response: z.string().optional(),
    usage: turnUsageShape,
    durationMs: z.number().nonnegative().optional(),
    error: z.object({ message: z.string(), code: z.string().optional() }).strict().optional(),
  })
  .strict();
export type RunResult = z.infer<typeof runResultSchema>;

// ── 事件流 ──

export const subscribeEventsParamsSchema = z.object({ ...sessionTarget }).strict();
export type SubscribeEventsParams = z.infer<typeof subscribeEventsParamsSchema>;

export const subscribeEventsResultSchema = z
  .object({
    subscriptionId: nonEmptyString,
    /** 订阅建立时已观察到的最后 seq（消费方可据此判断是否有历史缺口，走 readEvents 补偿）。 */
    lastSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SubscribeEventsResult = z.infer<typeof subscribeEventsResultSchema>;

export const unsubscribeEventsParamsSchema = z.object({ subscriptionId: nonEmptyString }).strict();
export type UnsubscribeEventsParams = z.infer<typeof unsubscribeEventsParamsSchema>;
export const unsubscribeEventsResultSchema = z.object({ unsubscribed: z.boolean() }).strict();

// ── 权限 ──

export const permissionRespondParamsSchema = z
  .object({
    ...sessionTarget,
    requestId: nonEmptyString,
    /** PermissionRequested 事件里 options 之一的 optionId。 */
    optionId: nonEmptyString,
  })
  .strict();
export type PermissionRespondParams = z.infer<typeof permissionRespondParamsSchema>;
export const permissionRespondResultSchema = z.object({ accepted: z.boolean() }).strict();
export type PermissionRespondResult = z.infer<typeof permissionRespondResultSchema>;

// ── 配置 ──

export const setModelParamsSchema = z
  .object({
    ...sessionTarget,
    model: harnessModelSelectionSchema,
  })
  .strict();
export type SetModelParams = z.infer<typeof setModelParamsSchema>;
export const setModelResultSchema = z
  .object({ revision: z.number().int().nonnegative().optional() })
  .strict();

export const getModelsParamsSchema = z.object({}).strict();
export type GetModelsParams = z.infer<typeof getModelsParamsSchema>;

export const getModelsResultSchema = z
  .object({
    providers: z.array(
      z
        .object({
          providerId: nonEmptyString,
          providerName: z.string().optional(),
          models: z
            .array(
              z
                .object({
                  modelId: nonEmptyString,
                })
                .strict(),
            )
            .default([]),
        })
        .strict(),
    ),
    preferredSelection: harnessModelSelectionSchema.optional(),
  })
  .strict();
export type GetModelsResult = z.infer<typeof getModelsResultSchema>;

export const compactParamsSchema = z
  .object({
    ...sessionTarget,
    instructions: z.string().optional(),
  })
  .strict();
export type CompactParams = z.infer<typeof compactParamsSchema>;
export const compactResultSchema = z
  .object({ revision: z.number().int().nonnegative().optional() })
  .strict();
export type CompactResult = z.infer<typeof compactResultSchema>;

// ── 文件（嵌入场景便利面）──

export const readFileParamsSchema = z
  .object({
    path: nonEmptyString,
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().positive().optional(),
  })
  .strict();
export type ReadFileParams = z.infer<typeof readFileParamsSchema>;

export const readFileResultSchema = z
  .object({
    path: nonEmptyString,
    content: z.string(),
    offset: z.number().int().nonnegative(),
    bytesRead: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    isBinary: z.boolean(),
  })
  .strict();
export type ReadFileResult = z.infer<typeof readFileResultSchema>;

export const searchTextParamsSchema = z
  .object({
    rootPath: nonEmptyString,
    query: nonEmptyString,
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();
export type SearchTextParams = z.infer<typeof searchTextParamsSchema>;

export const searchTextResultSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            path: nonEmptyString,
            line: z.number().int().positive().optional(),
            preview: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type SearchTextResult = z.infer<typeof searchTextResultSchema>;

export const findFilesParamsSchema = z
  .object({
    rootPath: nonEmptyString,
    query: nonEmptyString,
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();
export type FindFilesParams = z.infer<typeof findFilesParamsSchema>;

export const findFilesResultSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            name: z.string(),
            path: z.string(),
            relativePath: z.string().optional(),
            type: z.enum(["file", "directory"]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type FindFilesResult = z.infer<typeof findFilesResultSchema>;

// ── 工具控制 ──

export const configureToolsParamsSchema = z
  .object({
    ...sessionTarget,
    /** 会话级禁用清单；v1 翻译桥返回 not_supported（services 层无 create 后动态配置面）。 */
    disable: z.array(nonEmptyString).optional(),
    /** 自定义工具注册；v1 翻译桥返回 not_supported（SDK 回调无法注入引擎工具面）。 */
    custom: z
      .array(
        z
          .object({
            name: nonEmptyString,
            description: z.string().optional(),
            schema: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ConfigureToolsParams = z.infer<typeof configureToolsParamsSchema>;

export const configureToolsResultSchema = z
  .object({
    applied: z.boolean(),
    disabled: z.array(nonEmptyString).default([]),
    customRegistered: z.array(nonEmptyString).default([]),
  })
  .strict();
export type ConfigureToolsResult = z.infer<typeof configureToolsResultSchema>;

// ── 方法 → 入参 schema 映射表（H2：翻译桥按此表 safeParse，单一出处）──

/**
 * 方法名 → 入参 zod schema 的映射表（服务端 parseParams 的校验依据）。
 * subscribe_events / unsubscribe_events 在桥的 server 层单独分发，同样经此表校验。
 */
export const harnessMethodParamsSchemas = {
  list_sessions: listSessionsParamsSchema,
  create_session: createSessionParamsSchema,
  attach_session: attachSessionParamsSchema,
  detach_session: detachSessionParamsSchema,
  fork_session: forkSessionParamsSchema,
  rewind_session: rewindSessionParamsSchema,
  send_message: sendMessageParamsSchema,
  cancel_turn: cancelTurnParamsSchema,
  run: runParamsSchema,
  subscribe_events: subscribeEventsParamsSchema,
  unsubscribe_events: unsubscribeEventsParamsSchema,
  permission_respond: permissionRespondParamsSchema,
  set_model: setModelParamsSchema,
  get_models: getModelsParamsSchema,
  compact: compactParamsSchema,
  read_file: readFileParamsSchema,
  search_text: searchTextParamsSchema,
  find_files: findFilesParamsSchema,
  configure_tools: configureToolsParamsSchema,
} as const satisfies Record<HarnessMethodName, z.ZodType>;

// ── 方法名常量（单一出处；additive 才允许追加）──

export const HARNESS_METHODS = [
  "list_sessions",
  "create_session",
  "attach_session",
  "detach_session",
  "fork_session",
  "rewind_session",
  "send_message",
  "cancel_turn",
  "run",
  "subscribe_events",
  "unsubscribe_events",
  "permission_respond",
  "set_model",
  "get_models",
  "compact",
  "read_file",
  "search_text",
  "find_files",
  "configure_tools",
] as const;
export type HarnessMethodName = (typeof HARNESS_METHODS)[number];

export function isHarnessMethodName(value: string): value is HarnessMethodName {
  return (HARNESS_METHODS as readonly string[]).includes(value);
}
