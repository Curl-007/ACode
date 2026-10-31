// 拆分依据：translate.ts 超 400 行架构上限。内部 session/服务事件 → harness 公开事件的
// 投影（0..n 条）是纯映射层，仅依赖 isRecord 防御读取，与方法分发表无关，独立成叶子。
import type { ACodeAgentServiceEvent } from "@acode/services";
import type { ACodeSessionEvent } from "@acode/shared";
import type { HarnessEvent } from "@acode/shared/harness-api";
import { isRecord } from "./translateSupport.js";

/** turn.completed usage 字段是 unknown（内部协议自由演进），防御式读取投影。 */
function readUsage(
  usage: unknown,
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  if (!isRecord(usage)) return undefined;
  const pick = (key: string): number | undefined =>
    typeof usage[key] === "number" && Number.isFinite(usage[key])
      ? (usage[key] as number)
      : undefined;
  const inputTokens = pick("inputTokens");
  const outputTokens = pick("outputTokens");
  const totalTokens = pick("totalTokens");
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined)
    return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/**
 * 内部 session 事件 → harness 公开事件（0..n 条）。
 * 不在 v1 公开面的内部事件（message.upserted / session.* / model.streaming 等）静默丢弃：
 * 公开面刻意小于内部协议（jcode 同款裁剪），additive 才补充。
 */
export function translateSessionEvent(event: ACodeSessionEvent): HarnessEvent[] {
  const envelope = event as unknown as {
    type: string;
    eventId?: string;
    turnId?: string;
    timestamp?: number;
    payload?: unknown;
  };
  const base = {
    ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
    ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
    ...(typeof envelope.timestamp === "number" ? { timestamp: envelope.timestamp } : {}),
  };
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  switch (envelope.type) {
    case "turn.started":
      return [
        {
          kind: "turn_started",
          ...base,
          ...(typeof payload.turnNumber === "number" ? { turnNumber: payload.turnNumber } : {}),
          ...(typeof payload.inputId === "string" ? { inputId: payload.inputId } : {}),
          ...(typeof payload.input === "string"
            ? { inputPreview: payload.input.slice(0, 120) }
            : {}),
        },
      ];
    case "turn.completed": {
      // 内部 resultType 里除 success/cancelled 外都是错误变体（error_max_turns 等），统一投影 error。
      const rawResultType = typeof payload.resultType === "string" ? payload.resultType : "success";
      const resultType =
        rawResultType === "success" || rawResultType === "cancelled" ? rawResultType : "error";
      const tokenCount = typeof payload.tokenCount === "number" ? payload.tokenCount : undefined;
      const usage = readUsage(payload.usage);
      const done: HarnessEvent = {
        kind: "turn_done",
        ...base,
        ...(typeof payload.inputId === "string" ? { inputId: payload.inputId } : {}),
        resultType,
        ...(typeof payload.response === "string" ? { response: payload.response } : {}),
        ...((usage ?? (tokenCount !== undefined ? { usage: { totalTokens: tokenCount } } : {}))
          ? { usage: usage ?? { totalTokens: tokenCount as number } }
          : {}),
        ...(typeof payload.duration === "number" ? { durationMs: payload.duration } : {}),
      };
      const events: HarnessEvent[] = [done];
      if (usage || tokenCount !== undefined) {
        events.push({
          kind: "token_usage",
          ...base,
          ...(usage ?? { totalTokens: tokenCount as number }),
        });
      }
      return events;
    }
    case "turn.failed":
      return [
        {
          kind: "turn_done",
          ...base,
          ...(typeof payload.inputId === "string" ? { inputId: payload.inputId } : {}),
          resultType: "error",
          ...(isRecord(payload.error) && typeof payload.error.message === "string"
            ? {
                error: {
                  message: payload.error.message,
                  ...(typeof payload.error.code === "string" ? { code: payload.error.code } : {}),
                },
              }
            : { error: { message: "turn failed" } }),
        },
      ];
    case "part.delta":
      if (payload.field !== undefined && payload.field !== "text") return [];
      if (typeof payload.delta !== "string") return [];
      return [
        {
          kind: "text_delta",
          ...base,
          ...(typeof payload.messageId === "string"
            ? { messageId: payload.messageId }
            : { messageId: "unknown" }),
          ...(typeof payload.partId === "string" ? { partId: payload.partId } : {}),
          delta: payload.delta,
        },
      ];
    case "tool.updated": {
      const kind = payload.kind;
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
      if (!toolCallId) return [];
      const common = {
        ...base,
        toolCallId,
        ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
      };
      if (kind === "started") {
        return [
          {
            kind: "tool_call_started",
            ...common,
            ...(typeof payload.description === "string"
              ? { description: payload.description }
              : {}),
          },
        ];
      }
      if (kind === "result") {
        return [
          {
            kind: "tool_call_finished",
            ...common,
            ok: true,
            ...(typeof payload.duration === "number" ? { durationMs: payload.duration } : {}),
          },
        ];
      }
      if (kind === "error") {
        return [
          {
            kind: "tool_call_finished",
            ...common,
            ok: false,
            ...(isRecord(payload.error) && typeof payload.error.message === "string"
              ? {
                  error: {
                    message: payload.error.message,
                    ...(typeof payload.error.code === "string" ? { code: payload.error.code } : {}),
                  },
                }
              : { error: { message: "tool call failed" } }),
          },
        ];
      }
      return [];
    }
    case "permission.requested": {
      const requestId =
        typeof payload.requestId === "string" && payload.requestId.length > 0
          ? payload.requestId
          : typeof payload.toolCallId === "string"
            ? payload.toolCallId
            : "";
      if (!requestId) return [];
      const rawOptions = Array.isArray(payload.options) ? payload.options : [];
      const options = rawOptions
        .filter(
          (option): option is Record<string, unknown> =>
            isRecord(option) && typeof option.optionId === "string",
        )
        .map((option) => ({
          optionId: option.optionId as string,
          ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
          ...(typeof option.name === "string" ? { name: option.name } : {}),
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        }));
      if (options.length === 0) return [];
      return [
        {
          kind: "permission_requested",
          ...base,
          requestId,
          ...(typeof payload.toolCallId === "string" ? { toolCallId: payload.toolCallId } : {}),
          ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
          ...(payload.riskLevel === "low" ||
          payload.riskLevel === "medium" ||
          payload.riskLevel === "high" ||
          payload.riskLevel === "critical"
            ? { riskLevel: payload.riskLevel }
            : {}),
          ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
          options,
        },
      ];
    }
    default:
      return [];
  }
}

/** 服务级事件（onDynamicSessionEvent 的非 session.event 成员）→ harness 事件。 */
export function translateAgentServiceEvent(
  event: ACodeAgentServiceEvent,
  seenPermissionRequestIds: Set<string>,
): HarnessEvent[] {
  if (event.type === "session.event") {
    const translated = translateSessionEvent(event.event);
    for (const item of translated) {
      if (item.kind === "permission_requested" && !seenPermissionRequestIds.has(item.requestId)) {
        seenPermissionRequestIds.add(item.requestId);
      }
    }
    return translated;
  }
  if (event.type === "permission.request") {
    // 与 session.event(permission.requested) 双发去重：session 帧先到则 typed 帧跳过。
    const requestId =
      isRecord(event.request) && typeof event.request.requestId === "string"
        ? event.request.requestId
        : "";
    if (!requestId || seenPermissionRequestIds.has(requestId)) return [];
    seenPermissionRequestIds.add(requestId);
    const request = event.request as unknown as Record<string, unknown>;
    const rawOptions = Array.isArray(request.options) ? request.options : [];
    const options = rawOptions
      .filter(
        (option): option is Record<string, unknown> =>
          isRecord(option) && typeof option.optionId === "string",
      )
      .map((option) => ({
        optionId: option.optionId as string,
        ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
        ...(typeof option.name === "string" ? { name: option.name } : {}),
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      }));
    if (options.length === 0) return [];
    return [
      {
        kind: "permission_requested",
        requestId,
        ...(typeof request.toolCallId === "string" ? { toolCallId: request.toolCallId } : {}),
        ...(typeof request.toolName === "string" ? { toolName: request.toolName } : {}),
        ...(request.riskLevel === "low" ||
        request.riskLevel === "medium" ||
        request.riskLevel === "high" ||
        request.riskLevel === "critical"
          ? { riskLevel: request.riskLevel }
          : {}),
        ...(typeof request.reason === "string" ? { reason: request.reason } : {}),
        options,
      },
    ];
  }
  // snapshot / state.updated / userInput.* 不属于 v1 公开事件面。
  return [];
}
