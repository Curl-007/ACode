// Harness API v1 事件面（事件帧 `event` 体的 schema）。
// 参照 jcode (MIT) harness-api 的事件分类（TextDelta 关联 id / 工具面 / 权限面 / usage），
// 自撰 schema；枚举值刻意最小稳定集，未知 kind 由 parseFrameLoose 落 `unknown`。
//
// 翻译来源（bridge 侧）：ACode session 事件（onDynamicSessionEvent 的 session.event 面）：
// - part.delta(field=text)      → text_delta
// - turn.started                → turn_started
// - turn.completed / turn.failed→ turn_done（failed 时 resultType="error" 并附带 error）
// - turn.completed 的 usage     → 追加一条 token_usage
// - tool.updated kind=started   → tool_call_started
// - tool.updated kind=result|error → tool_call_finished
// - permission.requested        → permission_requested
// 其余内部事件（message.upserted / session.* 等）不属于 v1 公开面，桥侧静默丢弃。

import { z } from "zod";

const nonEmptyString = z.string().min(1);

export const harnessEventKindSchema = z.enum([
  "text_delta",
  "turn_started",
  "turn_done",
  "tool_call_started",
  "tool_call_finished",
  "permission_requested",
  "token_usage",
  "error",
]);
export type HarnessEventKind = z.infer<typeof harnessEventKindSchema>;

const eventBase = {
  kind: harnessEventKindSchema,
  /** 产生该事件的 turn 稳定 id（内部 envelope turnId，可缺省）。 */
  turnId: z.string().optional(),
  /** 内部事件 eventId 的透传，便于与宿主日志对账。 */
  eventId: z.string().optional(),
  timestamp: z.number().int().nonnegative().optional(),
} as const;

export const textDeltaEventSchema = z
  .object({
    ...eventBase,
    kind: z.literal("text_delta"),
    messageId: nonEmptyString,
    partId: z.string().optional(),
    delta: z.string(),
  })
  .strict();
export type TextDeltaEvent = z.infer<typeof textDeltaEventSchema>;

export const turnStartedEventSchema = z
  .object({
    ...eventBase,
    kind: z.literal("turn_started"),
    turnNumber: z.number().int().nonnegative().optional(),
    inputId: z.string().optional(),
    /** 输入预览（截断），不回传完整正文。 */
    inputPreview: z.string().optional(),
  })
  .strict();
export type TurnStartedEvent = z.infer<typeof turnStartedEventSchema>;

/** turn 终态：成功/取消/错误统一收口，消费方只看 resultType。 */
export const turnDoneEventSchema = z
  .object({
    ...eventBase,
    kind: z.literal("turn_done"),
    inputId: z.string().optional(),
    resultType: z.enum(["success", "cancelled", "error"]),
    /** 模型最终回复文本（success 时）。 */
    response: z.string().optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    durationMs: z.number().nonnegative().optional(),
    error: z
      .object({
        message: z.string(),
        code: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TurnDoneEvent = z.infer<typeof turnDoneEventSchema>;

export const toolCallStartedEventSchema = z
  .object({
    ...eventBase,
    kind: z.literal("tool_call_started"),
    toolCallId: nonEmptyString,
    toolName: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();
export type ToolCallStartedEvent = z.infer<typeof toolCallStartedEventSchema>;

export const toolCallFinishedEventSchema = z
  .object({
    ...eventBase,
    kind: z.literal("tool_call_finished"),
    toolCallId: nonEmptyString,
    toolName: z.string().optional(),
    ok: z.boolean(),
    durationMs: z.number().nonnegative().optional(),
    error: z
      .object({
        message: z.string(),
        code: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ToolCallFinishedEvent = z.infer<typeof toolCallFinishedEventSchema>;

/** 权限请求：消费方必须应答（permission_respond）或任由超时——超时语义=拒绝（fail-closed）。 */
export const permissionRequestedEventSchema = z
  .object({
    ...eventBase,
    kind: z.literal("permission_requested"),
    requestId: nonEmptyString,
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
    reason: z.string().optional(),
    options: z
      .array(
        z
          .object({
            optionId: nonEmptyString,
            kind: z.string().optional(),
            name: z.string().optional(),
            description: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PermissionRequestedEvent = z.infer<typeof permissionRequestedEventSchema>;

export const tokenUsageEventSchema = z
  .object({
    ...eventBase,
    kind: z.literal("token_usage"),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TokenUsageEvent = z.infer<typeof tokenUsageEventSchema>;

export const harnessErrorEventSchema = z
  .object({
    ...eventBase,
    kind: z.literal("error"),
    message: z.string(),
    code: z.string().optional(),
  })
  .strict();
export type HarnessErrorEvent = z.infer<typeof harnessErrorEventSchema>;

/** 未知事件兜底：桥/协议演进新增枚举值时，老消费方收到 unknown 不抛（wire 契约）。 */
export const unknownEventSchema = z
  .object({
    kind: z.literal("unknown"),
    rawKind: z.unknown().optional(),
    raw: z.unknown().optional(),
  })
  .strict();
export type UnknownEvent = z.infer<typeof unknownEventSchema>;

export const harnessEventSchema = z.discriminatedUnion("kind", [
  textDeltaEventSchema,
  turnStartedEventSchema,
  turnDoneEventSchema,
  toolCallStartedEventSchema,
  toolCallFinishedEventSchema,
  permissionRequestedEventSchema,
  tokenUsageEventSchema,
  harnessErrorEventSchema,
  unknownEventSchema,
]);
export type HarnessEvent = z.infer<typeof harnessEventSchema>;

/** 各 kind 的已声明字段（loose 解析的未知字段剥离白名单）。 */
const EVENT_KEYS: Record<string, readonly string[]> = {
  text_delta: ["kind", "turnId", "eventId", "timestamp", "messageId", "partId", "delta"],
  turn_started: ["kind", "turnId", "eventId", "timestamp", "turnNumber", "inputId", "inputPreview"],
  turn_done: [
    "kind",
    "turnId",
    "eventId",
    "timestamp",
    "inputId",
    "resultType",
    "response",
    "usage",
    "durationMs",
    "error",
  ],
  tool_call_started: [
    "kind",
    "turnId",
    "eventId",
    "timestamp",
    "toolCallId",
    "toolName",
    "description",
  ],
  tool_call_finished: [
    "kind",
    "turnId",
    "eventId",
    "timestamp",
    "toolCallId",
    "toolName",
    "ok",
    "durationMs",
    "error",
  ],
  permission_requested: [
    "kind",
    "turnId",
    "eventId",
    "timestamp",
    "requestId",
    "toolCallId",
    "toolName",
    "riskLevel",
    "reason",
    "options",
  ],
  token_usage: [
    "kind",
    "turnId",
    "eventId",
    "timestamp",
    "inputTokens",
    "outputTokens",
    "totalTokens",
  ],
  error: ["kind", "turnId", "eventId", "timestamp", "message", "code"],
};

/**
 * 事件体的 loose 解析（与 parseFrameLoose 同一兜底哲学）：
 * - 未知字段剥离：只保留该 kind 已声明字段后校验（round-trip 保留已知字段）；
 * - 未知 kind / 值形状不符 → `kind: "unknown"`（保留 rawKind），绝不抛错。
 */
export function parseEventLoose(raw: unknown): HarnessEvent {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const source = raw as Record<string, unknown>;
    const declared = EVENT_KEYS[source.kind as string];
    if (declared) {
      const stripped: Record<string, unknown> = {};
      for (const key of declared) {
        if (key in source) stripped[key] = source[key];
      }
      const result = harnessEventSchema.safeParse(stripped);
      if (result.success) return result.data;
    }
    return { kind: "unknown", rawKind: source.kind, raw };
  }
  return { kind: "unknown", raw };
}
