// ============================================================
// Event Reducer - 后台任务 + 权限域纯函数处理器（叶子文件）
// ============================================================
// 从 event-reducer.ts 拆出（批次 B 例外债务偿还：原文件超 architecture-policy 的
// max-file-lines，头部曾挂行数抑制头注）。本叶承载 Permission* 三个事件的纯函数
// 处理器；BackgroundTask* 三兄弟本就是 event-reducer-helpers.js 里的纯函数，此处原样
// 再导出，主文件统一从本叶导入——域内聚一处，handlers 表引用不变。依赖仅
// session.events、session.port 与 event-reducer-helpers，叶子间无环。

import type {
  SessionEvent,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PermissionDeniedPayload,
} from "./session.events.js";
import type { ActiveToolCall, PendingPermission, SessionProjection } from "../interfaces/session.port.js";

export {
  applyBackgroundTaskCompleted,
  applyBackgroundTaskStarted,
  applyBackgroundTaskUpdated,
} from "./event-reducer-helpers.js";

export function applyPermissionRequested(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as PermissionRequestedPayload;
    const newPending: PendingPermission = {
      input: payload.input,
      reason: payload.reason,
      requestId: payload.requestId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      ...(payload.suggestedPermissionUpdates
        ? { suggestedPermissionUpdates: payload.suggestedPermissionUpdates }
        : {}),
      ...(payload.origin ? { origin: payload.origin } : {}),
      ...(payload.display ? { display: payload.display } : {}),
      ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
      riskLevel: payload.riskLevel,
      requestedAt: e.timestamp,
    };
    return {
      ...p,
      pendingPermissions: [...p.pendingPermissions, newPending],
      updatedAt: e.timestamp,
    };
}

export function applyPermissionResolved(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as PermissionResolvedPayload;
    let toolStatus: ActiveToolCall["status"] = "completed";
    if (payload.decision === "deny") {
      toolStatus = "denied";
    }

    return {
      ...p,
      pendingPermissions: p.pendingPermissions.filter(
        (pp) => pp.toolCallId !== payload.toolCallId,
      ),
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId ? { ...tc, status: toolStatus } : tc,
      ),
      updatedAt: e.timestamp,
    };
}

export function applyPermissionDenied(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as PermissionDeniedPayload;
    return {
      ...p,
      pendingPermissions: p.pendingPermissions.filter(
        (pp) => pp.toolCallId !== payload.toolCallId,
      ),
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId ? { ...tc, status: "denied" } : tc,
      ),
      updatedAt: e.timestamp,
    };
}
