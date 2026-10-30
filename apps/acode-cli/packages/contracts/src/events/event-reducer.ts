// ============================================================
// Event Reducer - State projection from events
// ============================================================
// 拆分说明（批次 B 例外债务偿还）：原文件 587 行，超 architecture-policy 的
// max-file-lines（400），头部曾挂行数抑制头注。按事件域拆出三个纯函数叶：
//   - event-reducer-turn.ts：轮次生命周期 + steer 队列（Turn* / TurnSteer*）；
//   - event-reducer-tool.ts：工具调用状态机（ToolCall* / ToolBatchComplete）；
//   - event-reducer-task-permission.ts：后台任务 + 权限（BackgroundTask* / Permission*）。
// 处理器为纯函数 (projection, event) -> projection；本文件保留 session / compact /
// checkpoint / rewind / model / target 域处理器与分发骨架。导出面不变。


import type {
  SessionEvent,
  SessionCreatedPayload,
  SessionCompactedPayload,
  ModelCompletePayload,
  SessionModeChangedPayload,
  TargetChangedPayload,
  TargetCompletionVerificationPayload,
} from "./session.events.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";
import { SessionEventType as EventTypes } from "./session.events.js";
import type {
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
  BackgroundTaskCompletedPayload,
} from "./session.events.js";
import { getModelUsageContextTokens } from "../model/index.js";
import { parseCheckpointCreatedPayload, parseRewindTriggeredPayload } from "../rewind/index.js";
import {
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  failedGoalCompletionVerification,
  parseGoalCompletionVerificationText,
} from "../tools/target.js";
import type { SessionProjection, SessionStatus } from "../interfaces/session.port.js";
import {
  applyCompactBoundary,
  applyStreamRecoveryAnchorCreated,
  applyStreamingToolLedgerUpdate,
  initialSessionProjection,
} from "./event-reducer-helpers.js";
import {
  applyTurnComplete,
  applyTurnError,
  applyTurnStarted,
  applyTurnSteerDeliveryChanged,
  applyTurnSteerDiscarded,
  applyTurnSteerDrained,
  applyTurnSteerQueued,
  applyTurnSteerReordered,
} from "./event-reducer-turn.js";
import {
  applyToolBatchComplete,
  applyToolCallError,
  applyToolCallResult,
  applyToolCallScheduled,
  applyToolCallStarted,
} from "./event-reducer-tool.js";
import {
  applyBackgroundTaskCompleted,
  applyBackgroundTaskStarted,
  applyBackgroundTaskUpdated,
  applyPermissionDenied,
  applyPermissionRequested,
  applyPermissionResolved,
} from "./event-reducer-task-permission.js";

function shouldModelCompleteUpdateContextUsed(payload: ModelCompletePayload): boolean {
  if (payload.querySource !== undefined) {
    return payload.querySource === "main_turn";
  }

  // 兼容旧版主会话事件没有 querySource 的历史数据；工具/子任务内部模型调用
  // 过去也可能缺这个字段，但 stopReason 会标成 tool_internal，不能拿来覆盖主 session。
  return payload.stopReason !== "tool_internal";
}

// -----------------------------------------------


export class EventReducer {
  reduce(events: SessionEvent[]): SessionProjection {
    return events.reduce((projection, event) => this.apply(projection, event), {
      ...initialSessionProjection,
      id: events[0]?.sessionId ?? ("unknown" as any),
    } as SessionProjection);
  }

  apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
    const handler = this.handlers[event.type];
    if (handler) {
      return handler(projection, event);
    }
    return {
      ...projection,
      updatedAt: event.timestamp,
    };
  }

  private handlers: Record<
    string,
    (projection: SessionProjection, event: SessionEvent) => SessionProjection
  > = {

    [EventTypes.SessionCreated]: (p, e) => {
      const payload = e.payload as SessionCreatedPayload;
      return {
        ...p,
        id: e.sessionId,
        mode: payload.mode,
        planEnabled: payload.planEnabled ?? payload.mode === "plan",
        contextWindow: payload.contextWindow,
        createdAt: e.timestamp,
        updatedAt: e.timestamp,
        status: "idle" as SessionStatus,
      };
    },

    [EventTypes.TurnStarted]: applyTurnStarted,

    [EventTypes.SessionCompacted]: (p, e) => {
      const payload = e.payload as SessionCompactedPayload;
      return applyCompactBoundary(p, payload.compactBoundary, e.timestamp);
    },

    [EventTypes.SessionModeChanged]: (p, e) => {
      const payload = e.payload as SessionModeChangedPayload;
      return {
        ...p,
        ...(payload.permissionGrant
          ? {
              pendingSteerInputs: p.pendingSteerInputs.map((item) =>
                payload.permissionGrant!.queueItemIds.includes(item.pendingInputId) && item.intent
                  ? { ...item, intent: { ...item.intent, mode: "yolo" as const } }
                  : item,
              ),
            }
          : {}),
        mode: payload.mode,
        planEnabled: payload.planEnabled ?? payload.mode === "plan",
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.CompactBoundary]: (p, e) => {
      return applyCompactBoundary(p, e.payload, e.timestamp);
    },

    [EventTypes.CheckpointCreated]: (p, e) => {
      const payload = parseCheckpointCreatedPayload(e.payload);
      return {
        ...p,
        lastCheckpoint: {
          checkpointId: payload.checkpointId,
          compactBoundaryId: payload.compactBoundaryId,
          coveredByCompact: payload.coveredByCompact,
          createdAt: e.timestamp,
          fileCount: payload.fileCount,
          messageId: payload.messageId,
          targetMessageId: payload.targetMessageId,
          toolMessageId: payload.toolMessageId,
          scope: payload.scope,
          snapshotRef: payload.snapshotRef,
        },
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.RewindTriggered]: (p, e) => {
      const payload = parseRewindTriggeredPayload(e.payload);
      return {
        ...p,
        lastRewind: {
          compactBoundaryId: payload.compactBoundaryId,
          reason: payload.reason,
          rewindId: payload.rewindId,
          scope: payload.scope,
          strategy: payload.strategy,
          targetCheckpointId: payload.targetCheckpointId,
          targetMessageId: payload.targetMessageId,
          triggeredAt: e.timestamp,
        },
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TurnComplete]: applyTurnComplete,

    [EventTypes.ModelComplete]: (p, e) => {
      const payload = e.payload as ModelCompletePayload;
      if (payload.querySource === GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE) {
        return {
          ...p,
          targetCompletionVerifications: [
            ...p.targetCompletionVerifications,
            parseGoalCompletionVerificationText(payload.content),
          ],
          updatedAt: e.timestamp,
        };
      }
      // 输入栏 context usage 只代表主会话发给 provider 的最新上下文。
      // 标题生成、压缩摘要、子代理和工具内部模型调用都不是当前主 session 的可见上下文，
      // 如果用它们的 usage 覆盖 projection，UI 会显示成 89/1m 这类 sidecar 小请求。
      if (!shouldModelCompleteUpdateContextUsed(payload)) {
        return {
          ...p,
          updatedAt: e.timestamp,
        };
      }
      // AI SDK v6 的 provider input 已经是 total input（含 cache read/write）；
      // 这里通过统一 helper 计算 context used，避免各处重复理解 cache breakdown。
      const contextUsed = getModelUsageContextTokens(payload.usage);
      return {
        ...p,
        ...(contextUsed !== undefined ? { contextUsed } : {}),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.StreamingToolLedgerUpdated]: (p, e) => {
      return applyStreamingToolLedgerUpdate(
        p,
        e.payload as StreamingToolLedgerPayload,
        e.timestamp,
      );
    },

    [EventTypes.StreamRecoveryAnchorCreated]: (p, e) => {
      return applyStreamRecoveryAnchorCreated(
        p,
        e.payload as StreamRecoveryAnchorPayload,
        e.timestamp,
      );
    },

    [EventTypes.TargetChanged]: (p, e) => {
      const payload = e.payload as TargetChangedPayload;
      const targetChanged =
        payload.action === "set" && payload.previousTarget?.targetID !== payload.target?.targetID;
      return {
        ...p,
        target: payload.target,
        targetCompletionVerifications: targetChanged ? [] : p.targetCompletionVerifications,
        targetCompletionVerificationTimeline: targetChanged
          ? []
          : p.targetCompletionVerificationTimeline,
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TargetCompletionVerification]: (p, e) => {
      const payload = e.payload as TargetCompletionVerificationPayload;
      const existing = p.targetCompletionVerificationTimeline.find(
        (item) =>
          item.verificationId === payload.verificationId ||
          (payload.goalIteration !== undefined &&
            item.targetId === payload.targetId &&
            item.goalIteration === payload.goalIteration),
      );
      const startedAt =
        existing?.startedAt ?? (payload.status === "started" ? e.timestamp : undefined);
      // goal 校验的 UI 身份是 target + iteration；verificationId 只是单次尝试。
      // started/completed 或恢复重放如果只按 verificationId 合并，会把同一轮目标校验追加成多条横线。
      const goalIteration =
        payload.goalIteration ??
        existing?.goalIteration ??
        p.targetCompletionVerificationTimeline.length + 1;
      const nextTimelineItem = {
        targetId: payload.targetId,
        status: payload.status,
        verificationId: payload.verificationId,
        ...(payload.verification ? { verification: payload.verification } : {}),
        goalIteration,
        ...((payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId)
          ? {
              anchorAssistantMessageId:
                payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId,
            }
          : {}),
        ...((payload.anchorTurnId ?? existing?.anchorTurnId)
          ? { anchorTurnId: payload.anchorTurnId ?? existing?.anchorTurnId }
          : {}),
        ...(startedAt ? { startedAt } : {}),
        updatedAt: e.timestamp,
      };
      const nextTimeline = existing
        ? p.targetCompletionVerificationTimeline.map((item) =>
            item === existing ? nextTimelineItem : item,
          )
        : [...p.targetCompletionVerificationTimeline, nextTimelineItem];
      return {
        ...p,
        // failed_closed/cancelled 没有 model_complete 结果事件，必须把 lifecycle 结论补进摘要账本；
        // 正常 completed 继续由既有 model_complete 投影，避免新旧事件把同一次校验计两遍。
        targetCompletionVerifications:
          payload.status === "failed_closed" || payload.status === "cancelled"
            ? [
                ...p.targetCompletionVerifications,
                payload.verification ??
                  failedGoalCompletionVerification(
                    "The completion verifier did not return a persisted result.",
                  ),
              ]
            : p.targetCompletionVerifications,
        targetCompletionVerificationTimeline: nextTimeline,
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TurnError]: applyTurnError,

    [EventTypes.TurnSteerQueued]: applyTurnSteerQueued,

    [EventTypes.TurnSteerDeliveryChanged]: applyTurnSteerDeliveryChanged,

    [EventTypes.TurnSteerReordered]: applyTurnSteerReordered,

    [EventTypes.TurnSteerDrained]: applyTurnSteerDrained,

    [EventTypes.TurnSteerDiscarded]: applyTurnSteerDiscarded,

    [EventTypes.ToolCallScheduled]: applyToolCallScheduled,

    [EventTypes.ToolCallStarted]: applyToolCallStarted,

    [EventTypes.ToolCallResult]: applyToolCallResult,

    [EventTypes.ToolCallError]: applyToolCallError,

    [EventTypes.ToolBatchComplete]: applyToolBatchComplete,

    [EventTypes.BackgroundTaskStarted]: (p, e) => {
      const payload = e.payload as BackgroundTaskStartedPayload;
      return applyBackgroundTaskStarted(p, payload, e.timestamp);
    },

    [EventTypes.BackgroundTaskUpdated]: (p, e) => {
      const payload = e.payload as BackgroundTaskUpdatedPayload;
      return applyBackgroundTaskUpdated(p, payload, e.timestamp);
    },

    [EventTypes.BackgroundTaskCompleted]: (p, e) => {
      const payload = e.payload as BackgroundTaskCompletedPayload;
      return applyBackgroundTaskCompleted(p, payload, e.timestamp);
    },

    [EventTypes.PermissionRequested]: applyPermissionRequested,

    [EventTypes.PermissionResolved]: applyPermissionResolved,

    [EventTypes.PermissionDenied]: applyPermissionDenied,

  };
}

// -----------------------------------------------
// Utility Functions
// -----------------------------------------------

export function reduce(events: SessionEvent[]): SessionProjection {
  return new EventReducer().reduce(events);
}

export function apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
  return new EventReducer().apply(projection, event);
}
