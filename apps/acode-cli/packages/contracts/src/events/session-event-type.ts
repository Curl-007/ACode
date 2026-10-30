// ============================================================
// Session Event - 事件信封与类型词表（DAG 最底层叶子）
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session.events.ts（1373 行）按主题拆叶，
// 本文件承载事件信封 SessionEvent 与 SessionEventType 词表——所有 payload 叶的公共底座。
// 依赖方向（DAG）：interfaces/shared.js → 本文件 → 各 payload 叶 → factory 叶 →
// session.events.ts 桶。叶子间严禁互指成环；共享词汇一律取 interfaces 侧叶子。

import type { EventId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";

// Base Event
export interface SessionEvent {
  id: EventId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: SessionEventType;
  timestamp: Date;
  traceId: TraceId;
  sequenceNumber: number;
  payload: unknown;
}

export const SessionEventType = {
  SessionCreated: "session_created",
  SessionResumed: "session_resumed",
  SessionForked: "session_forked",
  SessionCompacted: "session_compacted",
  SessionTitleUpdated: "session_title_updated",
  SessionModeChanged: "session_mode_changed",
  SessionEnded: "session_ended",
  TurnStarted: "turn_started",
  TurnInputReceived: "turn_input_received",
  TurnSteerQueued: "turn_steer_queued",
  // guide 未遇到可用 tool batch 即收口时，原 intent 原地改投普通 queue。
  TurnSteerDeliveryChanged: "turn_steer_delivery_changed",
  // sendQueuedNow 原子提升：reservation/promoting/rollback 均进入事件流，投影不本地猜测。
  TurnSteerDispatchChanged: "turn_steer_dispatch_changed",
  TurnSteerDrained: "turn_steer_drained",
  TurnSteerRejected: "turn_steer_rejected",
  TurnSteerDiscarded: "turn_steer_discarded",
  // session_input 与 user message/parts 已在同一事务 promotion；CommandInbox 可安全解除 pin。
  SessionInputPromoted: "session_input_promoted",
  // v4 queue 重排：queue 项顺序变化（reducer 按 orderedPendingInputIds 重排 queue rows）。
  TurnSteerReordered: "turn_steer_reordered",
  // v4 输入控制：queue autoDrain 开关（held 派生 heldQueueInputRequiresChoice 的授权位）。
  QueueAutoDrainChanged: "queue_auto_drain_changed",
  // v4 输入控制：followup 路由模式（running 时 enqueue vs guide）。
  FollowupModeChanged: "followup_mode_changed",
  TurnComplete: "turn_complete",
  TurnError: "turn_error",
  UserMessage: "user_message",
  AssistantMessage: "assistant_message",
  AssistantFeedbackUpdated: "assistant_feedback_updated",
  SystemMessage: "system_message",
  ModelRequest: "model_request",
  ModelSelected: "model_selected",
  ModelStreaming: "model_streaming",
  StreamingToolLedgerUpdated: "streaming_tool_ledger_updated",
  StreamRecoveryAnchorCreated: "stream_recovery_anchor_created",
  StreamRecoveryStarted: "stream_recovery_started",
  StreamRecoveryAnchorSelected: "stream_recovery_anchor_selected",
  StreamRecoveryTailDiscarded: "stream_recovery_tail_discarded",
  StreamRecoveryRetryStarted: "stream_recovery_retry_started",
  StreamRecoveryBlocked: "stream_recovery_blocked",
  ModelNetworkStatus: "model_network_status",
  ModelAnomalyWarning: "model_anomaly_warning",
  NetworkRequestStatus: "network_request_status",
  ModelComplete: "model_complete",
  ModelError: "model_error",
  ToolCallScheduled: "tool_call_scheduled",
  ToolCallStarted: "tool_call_started",
  ToolCallProgress: "tool_call_progress",
  ToolCallResult: "tool_call_result",
  ToolCallError: "tool_call_error",
  ToolBatchComplete: "tool_batch_complete",
  BackgroundTaskStarted: "background_task_started",
  BackgroundTaskUpdated: "background_task_updated",
  BackgroundTaskCompleted: "background_task_completed",
  // workflow run 的实时进度：一条引擎 RunEvent 一条事件，追加到**父会话**（run 自己没有会话）。
  // v4 侧归约成 workflowRuns 状态键；v3 侧在 shouldExposeSessionEventToProtocol 剥离。
  // 命名刻意带 dynamic_：legacy `Workflow` 工具的 script run 事件（workflow_started /
  // workflow_completed，script-workflow-runtime.ts）是另一套日志，同名会真的混淆。
  DynamicWorkflowRunProgress: "dynamic_workflow_run_progress",
  // swarm plan 的提交投影：一次 plan 提交（或清除）一条事件，追加到**父会话**。
  // v4 侧归约成 swarmPlan 状态键；v3 侧在 shouldExposeSessionEventToProtocol 剥离。
  // 命名刻意带 swarm_plan_ 前缀（specs/swarm-observability-projection.md R2，
  // dynamic_workflow_run_progress 同款防混淆纪律）。
  SwarmPlanProgress: "swarm_plan_progress",
  // 插件 MCP server 经标准 logging notification（logger 前缀 acode-plugin-state）投递的
  // 自定义状态快照；v4 归约进 pluginStates 状态键（键级整体替换），v3 侧剥离。
  PluginStateUpdated: "plugin_state_updated",
  PermissionRequested: "permission_requested",
  PermissionResolved: "permission_resolved",
  PermissionDenied: "permission_denied",
  UserInputAutoResolutionUpdated: "user_input_auto_resolution_updated",
  WorkspaceHookReviewRequested: "workspace_hook_review_requested",
  WorkspaceHookReviewSettled: "workspace_hook_review_settled",
  WorkspaceHookReviewSuperseded: "workspace_hook_review_superseded",
  // 软门禁:准入状态变化时发射,pendingCount=0 时投影层清空 snapshot 字段。
  WorkspaceHookAdmissionUpdated: "workspace_hook_admission_updated",
  HookRunStarted: "hook_run_started",
  HookRunProgress: "hook_run_progress",
  HookRunCompleted: "hook_run_completed",
  HookRunFailed: "hook_run_failed",
  HookRunBlocked: "hook_run_blocked",
  CompactStarted: "compact_started",
  CompactCompleted: "compact_completed",
  CompactFailed: "compact_failed",
  CompactBoundary: "compact_boundary",
  MicrocompactBoundary: "microcompact_boundary",
  RewindTriggered: "rewind_triggered",
  CheckpointCreated: "checkpoint_created",
  TargetChanged: "target_changed",
  TargetCompletionVerification: "target_completion_verification",
  SubagentSpawned: "subagent_spawned",
  SubagentMessage: "subagent_message",
  SubagentStopped: "subagent_stopped",
  Interrupt: "interrupt",
  Cancel: "cancel",
  Resume: "resume",
  Error: "error",
} as const;

export type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];
