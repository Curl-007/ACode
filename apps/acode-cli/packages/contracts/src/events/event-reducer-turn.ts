// ============================================================
// Event Reducer - 轮次域纯函数处理器（叶子文件）
// ============================================================
// 从 event-reducer.ts 拆出（批次 B 例外债务偿还：原文件超 architecture-policy 的
// max-file-lines，头部曾挂行数抑制头注）。本叶承载轮次生命周期 + steer 队列的事件
// 处理器，全部为纯函数 (projection, event) -> projection；主文件 handlers 表按名引用，
// 分发逻辑与导出面不变。依赖仅 session.events（事件/载荷类型）与 session.port（投影
// 类型），叶子间无环。

import type {
  SessionEvent,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnSteerQueuedPayload,
  TurnSteerDeliveryChangedPayload,
  TurnSteerReorderedPayload,
  TurnSteerDrainedPayload,
  TurnSteerDiscardedPayload,
} from "./session.events.js";
import type { SessionProjection, SessionStatus } from "../interfaces/session.port.js";

export function applyTurnStarted(p: SessionProjection, e: SessionEvent): SessionProjection {
    return {
      ...p,
      currentTurnId: e.turnId,
      // 上一轮 provider 失败会写入 projection.lastError；新一轮消息被接受后，
      // 旧错误不再是当前任务事实。必须在源头清理，避免 readSession/getTaskSnapshot 反复恢复旧横幅。
      lastError: undefined,
      turnCount: p.turnCount + 1,
      status: "running" as SessionStatus,
      updatedAt: e.timestamp,
    };
}

export function applyTurnComplete(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as TurnCompletePayload;
    return {
      ...p,
      status: "idle" as SessionStatus,
      totalTokenCount: p.totalTokenCount + payload.tokenCount,
      updatedAt: e.timestamp,
    };
}

export function applyTurnError(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as TurnErrorPayload;
    return {
      ...p,
      status: "error" as SessionStatus,
      // projection 是重启/恢复链路的数据来源，必须保留真实 provider/subagent 根因。
      lastError: {
        type: payload.error.type,
        ...(payload.error.code ? { code: payload.error.code } : {}),
        message: payload.error.message,
        ...(payload.error.detail ? { detail: payload.error.detail } : {}),
        // TurnError 的 provider/network 归因是 live 与 cold projection 的共同事实；
        // 旧 reducer 只保留文案和 code，导致后续 task meta/telemetry 无法区分 provider 拒绝。
        ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
      },
      updatedAt: e.timestamp,
    };
}

export function applyTurnSteerQueued(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as TurnSteerQueuedPayload;
    const existingIndex = p.pendingSteerInputs.findIndex(
      (item) => item.pendingInputId === payload.pendingInputId,
    );
    const existing = existingIndex >= 0 ? p.pendingSteerInputs[existingIndex] : undefined;
    const next = {
      pendingInputId: payload.pendingInputId,
      input: payload.input,
      inputPreview: payload.inputPreview,
      inputSize: payload.inputSize,
      commandKind: payload.commandKind ?? existing?.commandKind,
      source: payload.source ?? existing?.source,
      inputPresentation: payload.inputPresentation ?? existing?.inputPresentation,
      intent: payload.intent ?? existing?.intent,
      toolDisallowlist: payload.toolDisallowlist ?? existing?.toolDisallowlist,
      // editQueueItem 会以同 id 重发 queued 事件；编辑不是重新 admission，
      // 必须保留原排队时间和数组位置，否则 runtime 冷重建会把它移到队尾。
      queuedAt: existing?.queuedAt ?? e.timestamp,
      targetTurnId: payload.targetTurnId,
      traceId: e.traceId,
    };
    return {
      ...p,
      pendingSteerInputs:
        existingIndex >= 0
          ? p.pendingSteerInputs.map((item, index) => (index === existingIndex ? next : item))
          : [...p.pendingSteerInputs, next],
      updatedAt: e.timestamp,
    };
}

export function applyTurnSteerDeliveryChanged(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as TurnSteerDeliveryChangedPayload;
    return {
      ...p,
      pendingSteerInputs: p.pendingSteerInputs.map((item) =>
        item.pendingInputId === payload.pendingInputId
          ? {
              ...item,
              intent:
                payload.intent ??
                (item.intent
                  ? {
                      ...item.intent,
                      admittedDelivery: payload.admittedDelivery,
                      fallbackReasonCode: payload.fallbackReasonCode,
                    }
                  : undefined),
            }
          : item,
      ),
      updatedAt: e.timestamp,
    };
}

export function applyTurnSteerReordered(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as TurnSteerReorderedPayload;
    const byId = new Map(p.pendingSteerInputs.map((item) => [item.pendingInputId, item]));
    const orderedIds = new Set(payload.orderedPendingInputIds);
    const ordered = payload.orderedPendingInputIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
    const rest = p.pendingSteerInputs.filter((item) => !orderedIds.has(item.pendingInputId));
    return {
      ...p,
      pendingSteerInputs: [...ordered, ...rest].map((item, queuePosition) => ({
        ...item,
        ...(item.intent ? { intent: { ...item.intent, queuePosition } } : {}),
      })),
      updatedAt: e.timestamp,
    };
}

export function applyTurnSteerDrained(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as TurnSteerDrainedPayload;
    return {
      ...p,
      pendingSteerInputs: p.pendingSteerInputs.filter(
        (item) => !payload.pendingInputIds.includes(item.pendingInputId),
      ),
      updatedAt: e.timestamp,
    };
}

export function applyTurnSteerDiscarded(p: SessionProjection, e: SessionEvent): SessionProjection {
    const payload = e.payload as TurnSteerDiscardedPayload;
    return {
      ...p,
      pendingSteerInputs: p.pendingSteerInputs.filter(
        (item) => !payload.pendingInputIds.includes(item.pendingInputId),
      ),
      updatedAt: e.timestamp,
    };
}
