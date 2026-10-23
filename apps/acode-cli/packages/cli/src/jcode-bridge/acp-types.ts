// ============================================================
// jcode 桥接：ACP JSON-RPC 2.0 帧类型（适配层私有契约）
// spec: apps/acode-cli/specs/jcode-agent-bridge.md R2
//
// 这些类型不进 @acode/shared 或 @acode/contracts 的公开契约——与 K8 适配层同纪律
// （acp/protocol.ts 头注：「不进 shared/contracts 公开契约，规范跟随时只动适配层」）。
// jcode 的 ACP 面事实来自 docs/jcode-adapter-spike-2026-10-23.md 的 Windows 实测。
//
// 按根 AGENTS.md「跨进程边界优先用可运行时校验的 schema」：本文件是纯类型（TS 侧），
// 运行时校验在 acp-client.ts 的入站帧解析处做结构性判定（不引 zod，避免给
// cli 包新增依赖；入站帧只需判别 id/method 两三个字段即可安全分流）。
// ============================================================

/** JSON-RPC 2.0 请求（shim → jcode）。 */
export interface AcpRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 通知（无 id，shim → jcode；当前 shim 不发通知，留作扩展）。 */
export interface AcpOutboundNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** jcode → shim 的成功响应。 */
export interface AcpSuccessResponse {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

/** jcode → shim 的错误响应。 */
export interface AcpErrorResponse {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

/** jcode → shim 的通知（session/update 是主通道）。 */
export interface AcpInboundNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type AcpInboundFrame = AcpSuccessResponse | AcpErrorResponse | AcpInboundNotification;

/** initialize 的响应（spike §2 实测字段）。 */
export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: { close?: unknown; resume?: unknown };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
  };
  authMethods?: unknown[];
}

/** session/new 与 session/load 的响应（spike §2/§4.3 实测）。 */
export interface AcpSessionResult {
  sessionId?: string;
  models?: { availableModels?: { modelId: string; name?: string }[]; currentModelId?: string };
  configOptions?: unknown[];
}

/** session/prompt 的响应（spike §2 实测）。 */
export interface AcpPromptResult {
  stopReason?: string;
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  };
}

/** session/update 通知的 params 外壳。 */
export interface AcpSessionUpdateParams {
  sessionId?: string;
  update?: Record<string, unknown>;
}

/** prompt 的 content block（ACP 规范：text/image/resource/resource_link）。 */
export type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } };

/**
 * 判别入站帧是响应还是通知。
 *
 * 依据 JSON-RPC 2.0：响应必带 id（number），通知无 id 而有 method。
 * 不用 zod——这里只做三字段的结构判别，且对不可解析帧一律归 undefined 由调用方丢弃留痕
 * （fail-safe：不因一个畸形帧断掉整条会话）。
 */
export function classifyInboundFrame(frame: unknown): AcpInboundFrame | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const candidate = frame as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0") return undefined;
  if (typeof candidate.id === "number") {
    if ("error" in candidate) return candidate as unknown as AcpErrorResponse;
    if ("result" in candidate) return candidate as unknown as AcpSuccessResponse;
    return undefined;
  }
  if (typeof candidate.method === "string") {
    return candidate as unknown as AcpInboundNotification;
  }
  return undefined;
}

/** 判别是否错误响应（窄化用）。 */
export function isAcpErrorResponse(frame: AcpInboundFrame): frame is AcpErrorResponse {
  return "error" in frame;
}

/** 判别是否成功响应（窄化用）。 */
export function isAcpSuccessResponse(frame: AcpInboundFrame): frame is AcpSuccessResponse {
  return "result" in frame;
}

// ============================================================
// 翻译层契约类型（event-translator.ts 消费）。放在本文件而非 event-translator，
// 因为它们是 ACP 适配层的私有 wire 契约（与上面的帧类型同族），且让 event-translator
// 专注翻译逻辑、守住 ≤400 行 ratchet（apps/acode-cli 是 managed:false 模块，
// 唯一约束就是新文件不得超 400 行）。
// ============================================================

/** ACP session/update 的最小入站形状（spike §3 实测字段）。 */
export interface AcpSessionUpdate {
  sessionUpdate?: string;
  /** agent_message_chunk 的正文。 */
  content?: { type?: string; text?: string };
  /** tool_call / tool_call_update 的身份与状态。 */
  toolCallId?: string;
  title?: string;
  /** 工具名（jcode ACP 在 tool_call 上给 name，tool_call_update 常省略）。 */
  name?: string;
  kind?: string;
  status?: string;
  /** tool_call_update 完成时的入参/输出（ACP rawInput/rawOutput）。 */
  rawInput?: unknown;
  rawOutput?: { output?: string; error?: string };
  /** usage_update 的水位。 */
  used?: number;
  size?: number;
}

/** shim 侧合成的 SessionEvent（branded id 传裸 string，网关不校验品牌）。 */
export interface TranslatedSessionEvent {
  id: string;
  sessionId: string;
  turnId: string;
  type: string;
  timestamp: Date;
  traceId: string;
  sequenceNumber: number;
  payload: Record<string, unknown>;
}

/** 翻译层对外依赖的最小注入面（时钟与 id 生成可测）。 */
export interface TranslatorDeps {
  now(): number;
  nextEventId(): string;
  /** v4 侧 sessionId（投影 topic 键）。 */
  v4SessionId: string;
  /** 每会话稳定 traceId（根 AGENTS.md 可观测性要求：全链路可关联）。 */
  traceId: string;
  /** contextWindow 合成默认值（jcode 无对应字段，见 spec R2 usage 行）。 */
  defaultContextWindow: number;
  /** 协作模式合成默认值（jcode 无权限模式语义，见 spec R4-1）。 */
  defaultMode: string;
}
