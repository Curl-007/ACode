// Harness API v1 帧协议（NDJSON over stdio）。
// 协议形态（版本化帧/枚举 Unknown 兜底/未知字段剥离）参照 jcode (MIT) crates/jcode-harness-api
// 的 wire 契约方法论，自撰 TypeScript 实现；wire schema 按 ACode services 层 API 重新设计。
//
// 兼容铁律（进 wire 契约）：
// - 消费方必须忽略未知字段（本模块 schema 均 strict，但 parseFrameLoose 会先剥离未知字段再校验）；
// - 枚举解析失败一律落 `unknown` 成员不报错（parseFrameLoose 兜底）；
// - 服务端只做 additive 演进（加字段/加枚举值/加方法）；删改语义必须升主版本。
//
// 红线：本目录是「稳定投影层」的类型唯一出处，绝不 import acode-protocol（v4）——
// 内部协议继续自由演进，内部演进打不坏本公开面（结构保证：翻译层负责映射）。

import { z } from "zod";

/** Harness API 主版本。主版本不匹配即握手拒绝。唯一出处，所有实现从这里 import。 */
export const HARNESS_API_VERSION_MAJOR = 1;

/** Harness API 次版本。additive 演进（加字段/加枚举值/加方法）时递增；minor 差异容忍。 */
export const HARNESS_API_VERSION_MINOR = 0;

/**
 * 单行（单帧）长度上限（M4 防护，服务端与 SDK 两侧共用同一出处）。
 * 按解码后的字符数近似（NDJSON 一行一帧，正常帧远小于该值）：
 * 超限视为对端异常（失控生产者/恶意输入），服务端回 error 帧后断连、SDK 主动断连，
 * 不为无界行分配缓冲（防 OOM）。
 */
export const HARNESS_MAX_LINE_LENGTH = 4 * 1024 * 1024;

const nonEmptyString = z.string().min(1);

// ── 握手 ──

/**
 * 客户端首帧。`auth` 为 R3 预留字段：本地 stdio 无需 token（进程边界即信任边界），
 * 将来 HTTP/WebSocket 投影强制 bearer token 时启用；v1 服务端只做形状容忍（忽略值）。
 */
export const harnessHelloFrameSchema = z
  .object({
    v: z.literal(HARNESS_API_VERSION_MAJOR),
    kind: z.literal("hello"),
    client: nonEmptyString,
    capabilities: z.array(nonEmptyString).default([]),
    auth: z
      .object({
        scheme: z.enum(["bearer"]),
        token: z.string().optional(),
      })
      .optional(),
  })
  .strict();
export type HarnessHelloFrame = z.infer<typeof harnessHelloFrameSchema>;

export const harnessHelloAckFrameSchema = z
  .object({
    v: z.literal(HARNESS_API_VERSION_MAJOR),
    kind: z.literal("hello_ack"),
    server: nonEmptyString,
    protocolMinor: z.number().int().nonnegative(),
    capabilities: z.array(nonEmptyString).default([]),
  })
  .strict();
export type HarnessHelloAckFrame = z.infer<typeof harnessHelloAckFrameSchema>;

// ── 请求 / 响应 ──

export const harnessRequestFrameSchema = z
  .object({
    v: z.literal(HARNESS_API_VERSION_MAJOR),
    kind: z.literal("request"),
    id: z.union([z.number().int().nonnegative(), nonEmptyString]),
    method: nonEmptyString,
    params: z.unknown().optional(),
  })
  .strict();
export type HarnessRequestFrame = z.infer<typeof harnessRequestFrameSchema>;

export const harnessErrorDetailSchema = z
  .object({
    code: nonEmptyString,
    message: z.string(),
    details: z.unknown().optional(),
  })
  .strict();
export type HarnessErrorDetail = z.infer<typeof harnessErrorDetailSchema>;

export const harnessResponseFrameSchema = z.discriminatedUnion("ok", [
  z
    .object({
      v: z.literal(HARNESS_API_VERSION_MAJOR),
      kind: z.literal("response"),
      id: z.union([z.number().int().nonnegative(), nonEmptyString]),
      ok: z.literal(true),
      result: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(HARNESS_API_VERSION_MAJOR),
      kind: z.literal("response"),
      id: z.union([z.number().int().nonnegative(), nonEmptyString]),
      ok: z.literal(false),
      error: harnessErrorDetailSchema,
    })
    .strict(),
]);
export type HarnessResponseFrame = z.infer<typeof harnessResponseFrameSchema>;

// ── 事件 / 协议级错误 ──

/**
 * 服务端推送事件帧：`seq` 由翻译桥保证**整连接单调递增**（跨 session 连续），
 * 消费方可用相邻 seq 检测丢帧。event 体见 events.ts。
 */
export const harnessEventFrameSchema = z
  .object({
    v: z.literal(HARNESS_API_VERSION_MAJOR),
    kind: z.literal("event"),
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    event: z.record(z.string(), z.unknown()),
  })
  .strict();
export type HarnessEventFrame = z.infer<typeof harnessEventFrameSchema>;

export const harnessProtocolErrorFrameSchema = z
  .object({
    v: z.literal(HARNESS_API_VERSION_MAJOR),
    kind: z.literal("error"),
    code: nonEmptyString,
    message: z.string(),
    details: z.unknown().optional(),
  })
  .strict();
export type HarnessProtocolErrorFrame = z.infer<typeof harnessProtocolErrorFrameSchema>;

/** 版本协商前的原始 hello 探测帧（v 任意）——仅握手拒绝路径使用。 */
export const harnessHelloVersionProbeSchema = z
  .object({
    kind: z.literal("hello"),
    v: z.number().int(),
  })
  .passthrough();

// ── Unknown 兜底 ──

/** 枚举/形状无法识别的帧：不报错，保留 rawKind 供消费方诊断。 */
export interface HarnessUnknownFrame {
  v: number;
  kind: "unknown";
  rawKind: unknown;
  raw: unknown;
}

export type HarnessFrame =
  | HarnessHelloFrame
  | HarnessHelloAckFrame
  | HarnessRequestFrame
  | HarnessResponseFrame
  | HarnessEventFrame
  | HarnessProtocolErrorFrame
  | HarnessUnknownFrame;

/** 把 schema 校验失败归一为 Unknown 帧（枚举兜底），不向上抛。 */
function toUnknownFrame(raw: unknown): HarnessUnknownFrame {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    v: typeof record.v === "number" ? record.v : HARNESS_API_VERSION_MAJOR,
    kind: "unknown",
    rawKind: record.kind,
    raw,
  };
}

/**
 * `parseFrameLoose`：Unknown 兜底解析器（wire 契约的落地点）。
 *
 * - 未知字段剥离：非 strict 消费入口，多余字段在校验前剥掉，round-trip 保留已知字段；
 * - 枚举解析失败（kind 非法/discriminant 缺失）→ 落 `kind: "unknown"` 成员，不报错；
 * - 只有非对象输入才返回 unknown 帧（同样不抛）。
 *
 * 注意：strict schema 的「未知字段报错」是给发送方（服务端/SDK 序列化端）的收紧约束；
 * 消费方一律走本入口，这是「additive 演进打不坏老消费方」的结构保证。
 */
export function parseFrameLoose(raw: unknown): HarnessFrame {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return toUnknownFrame(raw);
  }
  // 未知字段剥离：只保留各 schema 已声明字段的超集进行校验。
  const source = raw as Record<string, unknown>;
  const strip = (keys: readonly string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in source) out[key] = source[key];
    }
    return out;
  };
  const kind = source.kind;
  const tryParse = (schema: z.ZodTypeAny, keys: readonly string[]): HarnessFrame | undefined => {
    const result = schema.safeParse(strip(keys));
    return result.success ? (result.data as HarnessFrame) : undefined;
  };
  switch (kind) {
    case "hello":
      return (
        tryParse(harnessHelloFrameSchema, ["v", "kind", "client", "capabilities", "auth"]) ??
        toUnknownFrame(raw)
      );
    case "hello_ack":
      return (
        tryParse(harnessHelloAckFrameSchema, [
          "v",
          "kind",
          "server",
          "protocolMinor",
          "capabilities",
        ]) ?? toUnknownFrame(raw)
      );
    case "request":
      return (
        tryParse(harnessRequestFrameSchema, ["v", "kind", "id", "method", "params"]) ??
        toUnknownFrame(raw)
      );
    case "response":
      return (
        tryParse(harnessResponseFrameSchema, ["v", "kind", "id", "ok", "result", "error"]) ??
        toUnknownFrame(raw)
      );
    case "event":
      return (
        tryParse(harnessEventFrameSchema, ["v", "kind", "sessionId", "seq", "event"]) ??
        toUnknownFrame(raw)
      );
    case "error":
      return (
        tryParse(harnessProtocolErrorFrameSchema, ["v", "kind", "code", "message", "details"]) ??
        toUnknownFrame(raw)
      );
    default:
      return toUnknownFrame(raw);
  }
}
