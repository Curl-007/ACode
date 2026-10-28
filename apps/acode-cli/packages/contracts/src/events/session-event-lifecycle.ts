// ============================================================
// Session Event lifecycle payloads - session 生命周期事件载荷
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session.events.ts（1373 行）按主题拆叶，
// 本文件承载 session 生命周期载荷（created/resumed/forked/compacted/title/mode）。
// 断环纪律：SessionTitleSource / CollaborationMode 的权威定义在 interfaces/session-shared.ts
// 叶子（不再绕道 session-store 桶，消除 session.events ↔ session-store 文件级环）。
// 依赖方向（DAG）：shared.js / compact/index / interfaces/session-shared → 本文件 →
// session.events.ts 桶。
// 注：SystemMessagePayload 依赖 compact/index 的 CompactBoundaryPayload，属生命周期载荷，随节归本叶。

import type { MessageId, SessionId, ToolCallId } from "../interfaces/shared.js";
import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MicrocompactBoundaryPayload,
} from "../compact/index.js";
import type { CollaborationMode, SessionTitleSource } from "../interfaces/session-shared.js";

export interface SessionCreatedPayload {
  planEnabled?: boolean;
  mode: CollaborationMode;
  contextWindow: number;
}

export interface SessionResumedPayload {
  directory: string;
  interruptedToolCount: number;
  messageCount: number;
  partCount: number;
  recoveredCompactTimelineCount?: number;
  recoveredSteerInputCount?: number;
  resumedTodoCount?: number;
}

export interface SessionForkedPayload {
  forkedSessionId?: SessionId;
  originalSessionId: SessionId;
  restoredFileCount?: number;
  restoredSnapshotRef?: string;
  strategy?: "fork_required";
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  /** @deprecated Use targetMessageId for message-level forks. */
  forkPoint: number;
}

export interface SessionCompactedPayload {
  compactBoundary: CompactBoundaryPayload;
  summary?: string;
  preservedEventCount?: number;
  removedEventCount?: number;
}

export type CompactLifecyclePayload = CompactTimelinePayload;

export type MicrocompactBoundaryEventPayload = MicrocompactBoundaryPayload;

export interface SessionTitleUpdatedPayload {
  messageID?: MessageId;
  previousTitle: string;
  source: SessionTitleSource;
  title: string;
}

export interface SessionModeChangedPayload {
  permissionGrant?: { interactionId: string; queueItemIds: string[] };
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  source: "tool" | "command" | "system";
  toolCallId?: ToolCallId;
}

export interface SystemMessagePayload {
  type: "init" | "compact_boundary" | "interrupted";
  content: string;
  compactBoundary?: CompactBoundaryPayload;
}
