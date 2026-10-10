// ============================================================
// Shared types used across protocol
// ============================================================

export type SessionId = string & { readonly __brand: "SessionId" };
export type TurnId = string & { readonly __brand: "TurnId" };
export type EventId = string & { readonly __brand: "EventId" };
export type TraceId = string & { readonly __brand: "TraceId" };
export type QueryId = string & { readonly __brand: "QueryId" };
export type ToolCallId = string & { readonly __brand: "ToolCallId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type PartId = string & { readonly __brand: "PartId" };
export type InputHistoryId = string & { readonly __brand: "InputHistoryId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

/**
 * 交互请求穿过的祖先层（编排方案 R5/R6，specs/subagent-interaction-origin-lineage.md）：
 * depth≥2 时由外层 broker 逐层 append，内→外排序。不变量：
 * `ancestors[0].sessionId === origin.parentSessionId`；相邻层
 * `prev.parentSessionId === next.sessionId`；末层 `parentSessionId === rootSessionId`。
 * 客户端由此把发起者一路链回自己认识的根会话。
 */
export interface SubagentInteractionOriginAncestor {
  agentId: string;
  agentType: string;
  /** 该祖先层的会话（= 该层视角的 childSessionId）。 */
  sessionId: SessionId | string;
  parentSessionId: SessionId | string;
  description?: string;
  parentToolCallId?: ToolCallId | string;
  parentTurnId?: TurnId | string;
}

export interface SubagentInteractionRequestOrigin {
  kind: "subagent";
  agentId: string;
  agentType: string;
  childSessionId: SessionId | string;
  childTurnId?: TurnId | string;
  description?: string;
  parentSessionId: SessionId | string;
  parentToolCallId?: ToolCallId | string;
  parentTurnId?: TurnId | string;
  /**
   * depth≥2：祖先链（内→外）。depth 1 缺席——parentSessionId 即根会话，origin
   * 与历史结构逐字节一致（origin-lineage spec R0）。
   */
  ancestors?: SubagentInteractionOriginAncestor[];
  /** depth≥2：客户端可见的根会话（= 外层最后改写出的 sessionId 同值）。depth 1 缺席。 */
  rootSessionId?: SessionId | string;
}

export type InteractionRequestOrigin = SubagentInteractionRequestOrigin;

export function createSessionId(id?: string): SessionId {
  return `sess_${id ?? crypto.randomUUID()}` as SessionId;
}

export function createTurnId(id?: string): TurnId {
  return `turn_${id ?? crypto.randomUUID()}` as TurnId;
}

export function createEventId(id?: string): EventId {
  return `evt_${id ?? crypto.randomUUID()}` as EventId;
}

export function createTraceId(): TraceId {
  return crypto.randomUUID() as TraceId;
}

export function createQueryId(id?: string): QueryId {
  return `query_${id ?? crypto.randomUUID()}` as QueryId;
}

export function createToolCallId(id?: string): ToolCallId {
  return `tool_${id ?? crypto.randomUUID()}` as ToolCallId;
}

export function createMessageId(id?: string): MessageId {
  return `msg_${id ?? createSortableIdSegment()}` as MessageId;
}

export function createPartId(id?: string): PartId {
  return `part_${id ?? createSortableIdSegment()}` as PartId;
}

export function createInputHistoryId(id?: string): InputHistoryId {
  return `input_${id ?? createSortableIdSegment()}` as InputHistoryId;
}

export function createProjectId(id?: string): ProjectId {
  return `proj_${id ?? crypto.randomUUID()}` as ProjectId;
}

export function createWorkspaceId(id?: string): WorkspaceId {
  return `ws_${id ?? crypto.randomUUID()}` as WorkspaceId;
}

function createSortableIdSegment(): string {
  return `${Date.now().toString(36)}_${crypto.randomUUID()}`;
}
