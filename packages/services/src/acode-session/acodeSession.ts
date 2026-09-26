import { ServiceChannels } from "@acode/shared";
import type {
  TraceId,
  ACodeAgentMcpServer,
  ACodeDeliveryKind,
  ACodeMessageWithParts,
  ModelSelection,
  ACodePermissionRequestParams,
  ACodeUserInputRequestParams,
  ACodeUserInputResponse,
  ACodeSessionInfo,
  ACodeSessionImportHistory,
  ACodeSessionEvent,
  ACodeSessionMode,
  ACodeSessionPersistence,
  ACodeSessionStateSnapshot,
  ACodeStateUpdatedNotification,
  ACodeWorkspacePresentation,
} from "@acode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface ACodeSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type ACodeSessionReadWorkspacePresentationParams = ACodeSessionWorkspaceTarget;

export interface ACodeTaskTarget extends ACodeSessionWorkspaceTarget {
  sessionId: string;
}

export interface ACodeSessionCreateParams extends ACodeSessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ACodeSessionMode;
  model?: ModelSelection;
  persistence?: ACodeSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: ACodeAgentMcpServer[];
  importedHistory?: ACodeSessionImportHistory;
}

export interface ACodeSessionResumeParams extends ACodeTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ACodeAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface ACodeSessionListParams extends ACodeSessionWorkspaceTarget {
  includeArchived?: boolean;
  limit?: number;
}

export interface ACodeSessionReadParams extends ACodeTaskTarget {
  deliveryKind?: ACodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface ACodeSessionMessagesParams extends ACodeTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ACodeSessionEventsParams extends ACodeTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface ACodeSessionSetModelParams extends ACodeTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ACodeSessionSetThoughtLevelParams extends ACodeTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ACodeSessionSetModeParams extends ACodeTaskTarget {
  mode: ACodeSessionMode;
  expectedRevision?: number;
}

export interface ACodeSessionSubscribeParams extends ACodeTaskTarget {
  deliveryKind: ACodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type ACodeSessionServiceEvent =
  | { type: "session.event"; event: ACodeSessionEvent }
  | { type: "state.updated"; notification: ACodeStateUpdatedNotification }
  | { type: "permission.request"; request: ACodePermissionRequestParams }
  | { type: "userInput.request"; request: ACodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: ACodeUserInputResponse;
    }
  | { type: "snapshot"; snapshot: ACodeSessionStateSnapshot };

export interface ACodeSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ACodeSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface IACodeSessionService {
  initializeWorkspace(params: ACodeSessionWorkspaceTarget): Promise<ACodeSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: ACodeSessionWorkspaceTarget,
  ): Promise<ACodeSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: ACodeSessionReadWorkspacePresentationParams,
  ): Promise<ACodeWorkspacePresentation>;
  createSession(params: ACodeSessionCreateParams): Promise<ACodeSessionStateSnapshot>;
  resumeSession(params: ACodeSessionResumeParams): Promise<ACodeSessionStateSnapshot>;
  listSessions(params: ACodeSessionListParams): Promise<ACodeSessionInfo[]>;
  readSession(params: ACodeSessionReadParams): Promise<ACodeSessionStateSnapshot>;
  readSessionMessages(params: ACodeSessionMessagesParams): Promise<ACodeMessageWithParts[]>;
  readSessionEvents(params: ACodeSessionEventsParams): Promise<ACodeSessionEvent[]>;
  promoteDeferredDraftSession(params: ACodeTaskTarget): Promise<void>;
  closeSession(params: ACodeTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: ACodeTaskTarget): Promise<boolean>;
  setModel(params: ACodeSessionSetModelParams): Promise<ACodeSessionStateSnapshot>;
  setThoughtLevel(params: ACodeSessionSetThoughtLevelParams): Promise<ACodeSessionStateSnapshot>;
  setMode(params: ACodeSessionSetModeParams): Promise<ACodeSessionStateSnapshot>;
  // renderer 订阅面走 agentService 的 conversation/sessions-index 帧通道。
}

export const IACodeSessionService = createServiceDescriptor<IACodeSessionService>(
  ServiceChannels.ACodeSession,
);
