// ============================================================
// Event Reducer - 工具调用域纯函数处理器（叶子文件）
// ============================================================
// 从 event-reducer.ts 拆出（批次 B 例外债务偿还：原文件超 architecture-policy 的
// max-file-lines，头部曾挂行数抑制头注）。本叶承载工具调用状态机（ToolCall* /
// ToolBatchComplete）的事件处理器，全部为纯函数 (projection, event) -> projection；
// 主文件 handlers 表按名引用，分发逻辑与导出面不变。依赖仅 session.events 与
// session.port，叶子间无环。

import type {
  SessionEvent,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolCallResultPayload,
  ToolCallErrorPayload,
  ToolBatchCompletePayload,
} from "./session.events.js";
import type { ActiveToolCall, SessionProjection } from "../interfaces/session.port.js";

export function applyToolCallScheduled(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as ToolCallScheduledPayload;
    const newToolCall: ActiveToolCall = {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      status: "pending",
    };
    return {
      ...p,
      activeToolCalls: [...p.activeToolCalls, newToolCall],
      updatedAt: e.timestamp,
    };
}

export function applyToolCallStarted(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as ToolCallStartedPayload;
    return {
      ...p,
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId
          ? { ...tc, status: "running", startedAt: payload.startedAt }
          : tc,
      ),
      updatedAt: e.timestamp,
    };
}

export function applyToolCallResult(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as ToolCallResultPayload;
    return {
      ...p,
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId
          ? { ...tc, status: payload.result.success ? "completed" : "failed" }
          : tc,
      ),
      updatedAt: e.timestamp,
    };
}

export function applyToolCallError(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as ToolCallErrorPayload;
    return {
      ...p,
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId ? { ...tc, status: "failed" } : tc,
      ),
      updatedAt: e.timestamp,
    };
}

export function applyToolBatchComplete(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as ToolBatchCompletePayload;
    const activeToolCalls = p.activeToolCalls.filter(
      (tc) => !payload.toolCallIds.includes(tc.toolCallId as any),
    );
    return {
      ...p,
      activeToolCalls,
      // a tool batch can finish before the turn makes its follow-up model request.
      // Only turn_complete moves the session projection back to idle.
      updatedAt: e.timestamp,
    };
}
