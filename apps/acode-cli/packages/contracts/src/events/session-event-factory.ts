// ============================================================
// Session Event factory - createSessionEvent / usage 汇总 / payload 联合
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session.events.ts（1373 行）按主题拆叶，
// 本文件承载事件工厂与 SessionEventPayload 联合类型（原文件 Event Factory 节）。
// 依赖方向（DAG 顶层）：type 叶 + 全部 payload 叶 + stream-recovery / hooks / compact /
// rewind / model（createModelUsageSummary 为值导入）→ 本文件 → session.events.ts 桶。
// 断环纪律：createModelUsageSummary 取自叶子文件 model/index（model 桶不反向依赖 events 叶）。
// crypto.randomUUID 为 Node ambient global，无需 import。

import type { EventId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";
import { createModelUsageSummary } from "../model/index.js";
import type { ModelUsage, ModelUsageSummary } from "../model/index.js";
import type { HookRunLifecyclePayload } from "../hooks/index.js";
import type { CheckpointCreatedPayload, RewindTriggeredPayload } from "../rewind/index.js";
import type { CompactBoundaryPayload } from "../compact/index.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamRecoveryAnchorSelectedPayload,
  StreamRecoveryBlockedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryTailDiscardedPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";
import type { SessionEvent } from "./session-event-type.js";
import { SessionEventType } from "./session-event-type.js";
import type {
  CompactLifecyclePayload,
  MicrocompactBoundaryEventPayload,
  SessionCompactedPayload,
  SessionCreatedPayload,
  SessionForkedPayload,
  SessionModeChangedPayload,
  SessionResumedPayload,
  SessionTitleUpdatedPayload,
  SystemMessagePayload,
} from "./session-event-lifecycle.js";
import type {
  AssistantMessagePayload,
  FollowupModeChangedPayload,
  QueueAutoDrainChangedPayload,
  SessionInputPromotedPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnInputReceivedPayload,
  TurnStartedPayload,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerDiscardedPayload,
  TurnSteerDrainedPayload,
  TurnSteerQueuedPayload,
  TurnSteerRejectedPayload,
  TurnSteerReorderedPayload,
  UserMessagePayload,
} from "./session-event-turn.js";
import type {
  ModelAnomalyWarningPayload,
  ModelCompletePayload,
  ModelErrorPayload,
  ModelNetworkStatusPayload,
  ModelRequestPayload,
  ModelSelectedPayload,
  ModelStreamingPayload,
  NetworkRequestStatusPayload,
} from "./session-event-model.js";
import type {
  BackgroundTaskCompletedPayload,
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
  ToolBatchCompletePayload,
  ToolCallErrorPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
} from "./session-event-tool.js";
import type {
  DynamicWorkflowRunProgressPayload,
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PluginStateUpdatedPayload,
  SwarmPlanProgressPayload,
  TargetCompletionVerificationPayload,
  UserInputAutoResolutionUpdatedPayload,
  WorkspaceHookAdmissionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
} from "./session-event-runtime.js";

// -----------------------------------------------
// Event Factory
// -----------------------------------------------

export function createSessionEvent<T>(
  type: SessionEventType,
  sessionId: SessionId,
  payload: T,
  options?: {
    turnId?: TurnId;
    traceId?: TraceId;
    sequenceNumber?: number;
  },
): SessionEvent {
  return {
    id: crypto.randomUUID() as EventId,
    sessionId,
    turnId: options?.turnId,
    type,
    timestamp: new Date(),
    traceId: options?.traceId ?? (crypto.randomUUID() as TraceId),
    sequenceNumber: options?.sequenceNumber ?? 0,
    payload,
  };
}

export function createModelUsageSummaryFromEvents(
  events: readonly SessionEvent[],
): ModelUsageSummary | undefined {
  const usages: ModelUsage[] = [];

  for (const event of events) {
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload as Partial<ModelCompletePayload>;
    if (payload.usage) {
      usages.push(payload.usage as ModelUsage);
    }
  }

  return createModelUsageSummary(usages);
}

export type SessionEventPayload =
  | SessionCreatedPayload
  | SessionResumedPayload
  | SessionForkedPayload
  | SessionCompactedPayload
  | SessionTitleUpdatedPayload
  | SessionModeChangedPayload
  | TurnStartedPayload
  | TurnInputReceivedPayload
  | TurnSteerQueuedPayload
  | TurnSteerDeliveryChangedPayload
  | TurnSteerDispatchChangedPayload
  | TurnSteerDrainedPayload
  | TurnSteerReorderedPayload
  | QueueAutoDrainChangedPayload
  | FollowupModeChangedPayload
  | TurnSteerRejectedPayload
  | TurnSteerDiscardedPayload
  | SessionInputPromotedPayload
  | TurnCompletePayload
  | TurnErrorPayload
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload
  | ModelRequestPayload
  | ModelSelectedPayload
  | ModelStreamingPayload
  | StreamingToolLedgerPayload
  | StreamRecoveryAnchorPayload
  | StreamRecoveryStartedPayload
  | StreamRecoveryAnchorSelectedPayload
  | StreamRecoveryTailDiscardedPayload
  | StreamRecoveryRetryStartedPayload
  | StreamRecoveryBlockedPayload
  | ModelNetworkStatusPayload
  | ModelAnomalyWarningPayload
  | NetworkRequestStatusPayload
  | ModelCompletePayload
  | TargetCompletionVerificationPayload
  | ModelErrorPayload
  | ToolCallScheduledPayload
  | ToolCallStartedPayload
  | ToolCallProgressPayload
  | ToolCallResultPayload
  | ToolCallErrorPayload
  | ToolBatchCompletePayload
  | BackgroundTaskStartedPayload
  | BackgroundTaskUpdatedPayload
  | BackgroundTaskCompletedPayload
  | DynamicWorkflowRunProgressPayload
  | SwarmPlanProgressPayload
  | PluginStateUpdatedPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload
  | PermissionDeniedPayload
  | UserInputAutoResolutionUpdatedPayload
  | WorkspaceHookReviewRequestedPayload
  | WorkspaceHookReviewSettledPayload
  | WorkspaceHookReviewSupersededPayload
  | WorkspaceHookAdmissionUpdatedPayload
  | HookRunLifecyclePayload
  | CompactLifecyclePayload
  | MicrocompactBoundaryEventPayload
  | CheckpointCreatedPayload
  | RewindTriggeredPayload
  | CompactBoundaryPayload;
