import type { BackgroundBashOutputResult, SessionDebugSnapshot } from "@acode/shared";
/* eslint-disable max-lines -- ACode agent service 接口集中声明 protocol/session/workspace 方法，拆分会增加 service descriptor 迁移成本。 */
import type { Event, IDisposable } from "@acode/rpc";
import { ServiceChannels } from "@acode/shared";
import type { AppUsageRange, AppUsageSnapshot, ACodeTaskTokenUsageResult } from "@acode/shared";
import type { ACodeAutomation, ACodeAutomationRun } from "@acode/shared";
import type {
  ACodeStorageStartupState,
  ACodeDeliveryKind,
  ACodeAgentMcpServer,
  ACodeBackgroundTurnAttribution,
  TraceId,
  ACodeSessionCompactResult,
  ACodeSessionGoalAction,
  ACodeSessionGoalResult,
  ACodeMessageWithParts,
  ModelSelection,
  ACodeSessionImportHistory,
  ACodePermissionRequestParams,
  AgentLaneResourceSample,
  ACodeMcpTelemetryEvent,
  ACodeMcpResourceSample,
  ACodeToolExecResource,
  ACodeProcessChildProcess,
  ACodeMcpListResult,
  ACodePluginsListResult,
  ACodePluginsOverviewResult,
  ACodePluginsMarketplaceMutationResult,
  ACodePluginsInstallResult,
  ACodePluginsReferenceCatalogResult,
  ACodeSkillsReferenceCatalogResult,
  ACodeWorkflowsDeleteResult,
  ACodeWorkflowsGetResult,
  ACodeWorkflowsListResult,
  ACodeWorkflowsMoveResult,
  ACodeWorkflowsRunsResult,
  ACodeWorkflowsUpdateMetaResult,
  ACodePluginsUninstallResult,
  ACodePluginsRestoreBuiltinResult,
  ACodePluginsConfigureResult,
  ACodePluginsDescribeResult,
  ACodePluginsValidateResult,
  ACodePluginsSetEnabledResult,
  ACodePluginsCancelOperationResult,
  ACodePluginOperationProgressNotification,
  ACodeProviderTestModelConnectivityParams,
  ACodeProviderTestModelConnectivityResult,
  ACodeUserInputRequestParams,
  ACodeUserInputResponse,
  ACodeSessionEvent,
  ACodeSessionInfo,
  ACodeSessionMode,
  ACodeSessionPersistence,
  ACodeSessionSendResult,
  ACodeSessionRequestRuntimePreferencesParams,
  ACodeSessionRuntimePreferencesResult,
  ACodeSessionStateSnapshot,
  ACodeSessionSubagentsResult,
  ACodeStateUpdatedNotification,
  ACodeTaskClientMode,
  ACodeBrowserAmbientContext,
  ACodeWorkspacePresentation,
  ACodeWorkspaceGenerateTextResult,
  ACodeWorkspaceGenerateTextParams,
  ACodeWorkspaceHookTrustGrantResult,
  ACodeAutomationBotDeliveryTarget,
} from "@acode/shared";
import type {
  ClientHello,
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationRowTarget,
  HelloMessage,
  SessionsIndexTopicWireCandidate,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConnectionFlowState,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@acode/shared/acode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

export * from "./acodeAgentPluginParams.js";
export * from "./acodeAgentWorkflowParams.js";
import type {
  ACodeAgentAddPluginMarketplaceParams,
  ACodeAgentAutomationIdParams,
  ACodeAgentCancelPluginOperationParams,
  ACodeAgentConfigurePluginParams,
  ACodeAgentResetPluginConfigParams,
  ACodeAgentCreateAutomationParams,
  ACodeAgentDeleteAutomationRunParams,
  ACodeAgentDescribePluginParams,
  ACodeAgentInstallPluginParams,
  ACodeAgentListMcpServerStatusesParams,
  ACodeAgentPluginViewParams,
  ACodeAgentPluginReferenceCatalogParams,
  ACodeAgentSkillReferenceCatalogParams,
  ACodeAgentResolveSuggestedPluginReferenceParams,
  ACodeAgentRemovePluginMarketplaceParams,
  ACodeAgentRestoreBuiltinPluginParams,
  ACodeAgentSetPluginEnabledParams,
  ACodeAgentSetAutomationEnabledParams,
  ACodeAgentUninstallPluginParams,
  ACodeAgentUpdatePluginMarketplaceParams,
  ACodeAgentUpdatePluginParams,
  ACodeAgentUpdateAutomationParams,
  ACodeAgentValidatePluginParams,
  ACodeAgentWorkspaceTarget,
} from "./acodeAgentPluginParams.js";
import type {
  ACodeAgentDeleteSavedWorkflowParams,
  ACodeAgentGetSavedWorkflowParams,
  ACodeAgentListSavedWorkflowRunsParams,
  ACodeAgentListSavedWorkflowsParams,
  ACodeAgentMoveSavedWorkflowParams,
  ACodeAgentUpdateSavedWorkflowMetaParams,
} from "./acodeAgentWorkflowParams.js";

export interface ACodeAgentSessionTarget extends ACodeAgentWorkspaceTarget {
  sessionId: string;
}

export interface ACodeAgentResumeSessionParams extends ACodeAgentSessionTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ACodeAgentMcpServer[];
  // 冷恢复会重建 runtime，工具面隔离必须和 create 保持同一安全边界（CUA 只放行 acode-cua 工具、
  // 禁 Bash 等）。否则 resume 后模型可见工具面/执行权限会比创建时更宽。
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface ACodeAgentInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ACodeAgentRunAutomationNowResult {
  status: "queued" | "duplicate";
}

export interface ACodeAgentWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export const ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE = "ACODE_AGENT_RUNTIME_UNAVAILABLE";

export type ACodeAgentRuntimePolicy = "start-if-needed" | "existing-only";

export interface ACodeAgentRuntimeLifecycleEvent extends ACodeAgentWorkspaceTarget {
  workspaceKey: string;
  runtimeIdentity: ACodeAgentWorkspaceRuntimeIdentity;
  state: "available" | "unavailable";
}

export type ACodeAgentCuaPermissionObservation = CuaPermissionObservation &
  ACodeAgentWorkspaceTarget;

export interface ACodeAgentCreateSessionParams extends ACodeAgentWorkspaceTarget {
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ACodeSessionMode;
  model?: ModelSelection;
  persistence?: ACodeSessionPersistence;
  thoughtLevel?: string;
  /** automation 执行会话关闭模型二次命名，保持首条用户 query 作为稳定标题。 */
  titleGenerationEnabled?: boolean;
  mcpServers?: ACodeAgentMcpServer[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  importedHistory?: ACodeSessionImportHistory;
}

export interface ACodeAgentListSessionsParams extends ACodeAgentWorkspaceTarget {
  sessionIds?: string[];
  runtimePolicy?: ACodeAgentRuntimePolicy;
  includeArchived?: boolean;
  limit?: number;
}

export interface ACodeAgentListSessionSubagentsParams extends ACodeAgentSessionTarget {
  endedCursor?: string;
  endedLimit?: number;
  /** 远程 workspace 的宿主连接身份；只用于选择现有 Host，不进入 CLI wire query。 */
  remoteSessionId?: string;
}

export interface ACodeAgentAppUsageParams {
  range: AppUsageRange;
  timeZone?: string;
}

export interface ACodeAgentTaskTokenUsageParams extends ACodeAgentSessionTarget {}

export interface ACodeAgentReadSessionParams extends ACodeAgentSessionTarget {
  deliveryKind?: ACodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
  /** 被动索引/观察者只能读取现有 runtime，禁止为了读快照拉起 session。 */
  runtimePolicy?: ACodeAgentRuntimePolicy;
}

export interface ACodeAgentReadSessionMessagesParams extends ACodeAgentSessionTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ACodeAgentReadSessionEventsParams extends ACodeAgentSessionTarget {
  afterSeq?: number;
  limit?: number;
}

export type ACodeAgentReadWorkspacePresentationParams = ACodeAgentWorkspaceTarget;

export interface ACodeAgentGrantWorkspaceHookTrustParams extends ACodeAgentWorkspaceTarget {
  bundleDigest: string;
  hookDeclarationDigest: string;
}

export interface ACodeAgentSendPromptParamsBase extends ACodeAgentSessionTarget {
  modelSelection?: ModelSelection;
  modelExecution?: import("@acode/shared/acode-protocol-v4").CommandPayloadMap["sendText"]["modelExecution"];
  inputId?: string;
  queryId?: string;
  messageId?: string;
  sessionTraceId?: TraceId;
  content: string;
  attachments?: Record<string, unknown>[];
  /** provider-only 的当前 IAB 状态；UI/session persistence 仍使用 content 原文。 */
  browserAmbientContext?: ACodeBrowserAmbientContext;
  clientMode?: ACodeTaskClientMode;
  expectedRevision?: number;
  expectedProviderRevision?: string;
  runtimeProviderHeaders?: Record<string, string>;
  toolDenylist?: string[];
  /** Bot 来源 turn 的稳定回推地址；只在当前 turn 内供 CronCreate 读取。 */
  botDeliveryTarget?: ACodeAutomationBotDeliveryTarget;
}

export type ACodeAgentSendPromptParams = ACodeAgentSendPromptParamsBase &
  ACodeBackgroundTurnAttribution;

export interface ACodeAgentCompactParams extends ACodeAgentSessionTarget {
  inputId?: string;
  instructions?: string;
  expectedRevision?: number;
}

export interface ACodeAgentGoalParams extends ACodeAgentSessionTarget {
  inputId?: string;
  action: ACodeSessionGoalAction;
  objective?: string;
  expectedRevision?: number;
}

export interface ACodeAgentSetModelParams extends ACodeAgentSessionTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ACodeAgentSetThoughtLevelParams extends ACodeAgentSessionTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ACodeAgentSetModeParams extends ACodeAgentSessionTarget {
  mode: ACodeSessionMode;
  expectedRevision?: number;
}

export interface ACodeAgentGenerateWorkspaceTextParams extends ACodeAgentWorkspaceTarget {
  selection: ACodeWorkspaceGenerateTextParams["selection"];
  prompt?: string;
  messages?: ACodeWorkspaceGenerateTextParams["messages"];
  tools?: ACodeWorkspaceGenerateTextParams["tools"];
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * 协议层 RPC 超时。thinking 模型的长请求会超过协议 client 默认的
   * 3 分钟；调用方必须把自身 deadline 透传到这里，否则默认超时先触发、
   * 还会被 onRequestTimeout 误判 stale 杀进程。
   */
  requestTimeoutMs?: number;
}

export interface ACodeAgentTestModelConnectivityParams extends ACodeAgentWorkspaceTarget {
  selection: ACodeProviderTestModelConnectivityParams["selection"];
  signal?: AbortSignal;
}

export interface ACodeAgentSessionRuntimePreferencesRequest extends ACodeSessionRequestRuntimePreferencesParams {
  requestId: string;
}

export interface ACodeAgentRespondSessionRuntimePreferencesParams {
  requestId: string;
  resolution:
    | { status: "resolved"; preferences: ACodeSessionRuntimePreferencesResult }
    | { status: "failed"; message: string };
}

export interface ACodeAgentSessionSubscribeParams extends ACodeAgentSessionTarget {
  deliveryKind: ACodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

// ── v4 conversation 通道（竖切）──
// host 只做转发：subscribe/unsubscribe/command 透传给 CLI v4 gateway，
// v4/conversation/frame 通知按 workspace fan-out 给 renderer。

export interface ACodeAgentConversationSubscribeParams extends ACodeAgentSessionTarget {
  /** 水位不变量：仅当客户端真持有该时刻一致状态才允许带。 */
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface ACodeAgentConversationUnsubscribeParams extends ACodeAgentWorkspaceTarget {
  subscriptionId: string;
  runtimePolicy?: ACodeAgentRuntimePolicy;
}

export interface ACodeAgentConversationResyncParams extends ACodeAgentWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
  runtimePolicy?: ACodeAgentRuntimePolicy;
}

/** 行分页 query（rows/range）：按游标向上取一窗历史行。 */
export interface ACodeAgentConversationRowsRangeParams extends ACodeAgentSessionTarget {
  /** 取 rowId < beforeRowId 的行；缺省 = 从当前尾部向前。 */
  beforeRowId?: number;
  /** 1..rowsRangeMaxLimit（200）。 */
  limit: number;
}

/** 当前有效分支里的终态 ExitPlanMode 目录。 */
export type ACodeAgentConversationPlansParams = ACodeAgentSessionTarget;

/** workflow run 的事件日志分页（详情页审计面）；cursor = journal sequence。 */
export interface ACodeAgentConversationWorkflowRunEventsParams extends ACodeAgentSessionTarget {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

/** dwf run 的枚举（重启后的发现查询）。 */
export interface ACodeAgentConversationWorkflowRunsParams extends ACodeAgentSessionTarget {
  limit?: number;
}

// ── dwf 用户面产物──
// ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给**用户**看的产出（文件 / markdown / 预置看板），
// 不是 run 的顶层返回值（引擎内部对后者的同名叫法）。

/** 产物清单；UI 冷恢复与中枢详情的 durable 读法。 */
export interface ACodeAgentConversationWorkflowRunArtifactsParams extends ACodeAgentSessionTarget {
  runId: string;
}

/** 预置看板的取数面；cursor = journal sequence（严格大于）。 */
export interface ACodeAgentConversationWorkflowRunArtifactDataParams extends ACodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  afterSequence?: number;
  limit?: number;
}

/** 内容产物的字节，一次一块（≤ 512 KiB，形状逐字照 attachmentRead）。 */
export interface ACodeAgentConversationWorkflowRunArtifactReadParams extends ACodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  version: number;
  offset: number;
  limit: number;
}

// ── dwf 工作区 transcript──
/** 轻行清单：一个 run 的 files.* / git.* / world.run 行，不带正文。 */
export interface ACodeAgentConversationWorkflowRunWorkspaceParams extends ACodeAgentSessionTarget {
  runId: string;
}

/** 一个工作区节点的正文，按 maxBytes 保形有界化（缺省与上限在 CLI 网关侧）。 */
export interface ACodeAgentConversationWorkflowRunNodeResultParams extends ACodeAgentSessionTarget {
  runId: string;
  siteId: string;
  ordinal: number;
  maxBytes?: number;
}

export interface ACodeAgentBackgroundBashOutputParams extends ACodeAgentSessionTarget {
  workId: string;
}

export interface ACodeAgentConversationFileChangesParams extends ACodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ACodeAgentConversationFileRewindPreviewParams extends ACodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ACodeAgentConversationCommandParams extends ACodeAgentWorkspaceTarget {
  envelope: CommandEnvelope;
  /** 仅 host 内部用于 Browser Use runtime 边界，不进入 v4 wire envelope。 */
  clientMode?: ACodeTaskClientMode;
}

export interface ACodeAgentCommandsQueryParams extends ACodeAgentWorkspaceTarget {
  clock?: true;
  commands: CommandKey[];
}

/** UI 不携带 connectionId；connection scope 以 trusted carrier 注入 wire identity。 */
export interface ACodeAgentAttachmentBeginParams extends ACodeAgentSessionTarget {
  uploadId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export interface ACodeAgentAttachmentChunkParams extends ACodeAgentSessionTarget {
  uploadId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface ACodeAgentAttachmentTerminalParams extends ACodeAgentSessionTarget {
  uploadId: string;
}

export interface ACodeAgentAttachmentReadParams extends ACodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  offset: number;
  limit: number;
}

export interface ACodeAgentConversationAttachmentReadParams extends ACodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
  offset: number;
  limit: number;
}

export interface ACodeAgentConversationAttachmentStatParams extends ACodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
}

export interface ACodeAgentAttachmentPreviewSourceParams extends ACodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

/** host scope 内部 transport 控制面；connectionId 只能经 trusted carrier 注入。 */
export interface ACodeAgentConnectionFlowParams extends ACodeAgentWorkspaceTarget {
  state: V4ConnectionFlowState;
}

/** sessions-index：workspace 级列表订阅（无 sessionId 维度）。 */
export interface ACodeAgentSessionsIndexSubscribeParams extends ACodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  /**
   * 订阅者作用域后缀：CLI 侧重订阅替换按 (connectionId, topic) 判定，
   * host 进程内多个独立消费者（renderer 侧栏 / task-index syncer）订阅同一 topic 时
   * 必须用不同 connectionId，否则互相替换对方的订阅代际。缺省共享 host 连接 id。
   */
  subscriberScope?: string;
  /**
   * task-list 等被动观察者必须使用 existing-only；runtime 不存在时返回稳定 unavailable，
   * 禁止为了建立列表订阅而启动 Agent。缺省保持显式会话入口的旧行为。
   */
  runtimePolicy?: ACodeAgentRuntimePolicy;
}

/** workspace-config：workspace 级配置目录订阅（config options + slash 目录）。 */
export interface ACodeAgentWorkspaceConfigSubscribeParams extends ACodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
  runtimePolicy?: ACodeAgentRuntimePolicy;
}

export type ACodeAgentServiceEvent =
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

export interface ACodeAgentAppRuntimePreferences {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled?: boolean;
}

export interface ACodeAgentLocalRuntimeChildProcesses {
  pid: number;
  provider: string;
  workspacePath: string;
  lane?: string;
  children: ACodeProcessChildProcess[];
}

export interface ACodeAgentStorageStartupSnapshot {
  generation: number;
  state: ACodeStorageStartupState | null;
}

export interface IACodeAgentService {
  /** 控制面不需要账号或模型，且不发送普通协议请求。 */
  prepareStorage(params: ACodeAgentWorkspaceTarget): Promise<void>;
  getStorageStartupState(
    params: ACodeAgentWorkspaceTarget,
  ): Promise<ACodeAgentStorageStartupSnapshot | null>;
  onDynamicStorageStartupState(
    params: ACodeAgentWorkspaceTarget,
  ): Event<ACodeAgentStorageStartupSnapshot>;
  initialize(params: ACodeAgentWorkspaceTarget): Promise<ACodeAgentInitializeResult>;
  /**
   * 同步 App 全局运行时偏好到所有已活动 workspace；不得为此启动空闲 Agent。
   */
  syncAppRuntimePreferences(preferences: ACodeAgentAppRuntimePreferences): Promise<void>;
  getWorkspaceRuntimeIdentity(
    params: ACodeAgentWorkspaceTarget,
  ): Promise<ACodeAgentWorkspaceRuntimeIdentity>;
  createSession(params: ACodeAgentCreateSessionParams): Promise<ACodeSessionStateSnapshot>;
  resumeSession(params: ACodeAgentResumeSessionParams): Promise<ACodeSessionStateSnapshot>;
  listSessions(params: ACodeAgentListSessionsParams): Promise<ACodeSessionInfo[]>;
  listSessionSubagents(
    params: ACodeAgentListSessionSubagentsParams,
  ): Promise<ACodeSessionSubagentsResult>;
  getAppUsageStats(params: ACodeAgentAppUsageParams): Promise<AppUsageSnapshot>;
  getTaskTokenUsage(params: ACodeAgentTaskTokenUsageParams): Promise<ACodeTaskTokenUsageResult>;
  readSession(params: ACodeAgentReadSessionParams): Promise<ACodeSessionStateSnapshot>;
  readSessionMessages(
    params: ACodeAgentReadSessionMessagesParams,
  ): Promise<ACodeMessageWithParts[]>;
  readSessionDebug(params: ACodeAgentSessionTarget): Promise<SessionDebugSnapshot>;
  readSessionEvents(params: ACodeAgentReadSessionEventsParams): Promise<ACodeSessionEvent[]>;
  readWorkspacePresentation(
    params: ACodeAgentReadWorkspacePresentationParams,
  ): Promise<ACodeWorkspacePresentation>;
  /** 无 task/session 的 Settings 预信任；Agent 会重新发现并校验 canonical snapshot。 */
  grantWorkspaceHookTrust(
    params: ACodeAgentGrantWorkspaceHookTrustParams,
  ): Promise<ACodeWorkspaceHookTrustGrantResult>;
  listMcpServerStatuses(params: ACodeAgentListMcpServerStatusesParams): Promise<ACodeMcpListResult>;
  listPlugins(params: ACodeAgentPluginViewParams): Promise<ACodePluginsListResult>;
  /**
   * Plugin 对话引用 catalog：session-scoped 只读投影。
   * 走 workspace 级 agent client（session 记录只存在于该进程），不走独立插件管理进程。
   */
  getPluginReferenceCatalog(
    params: ACodeAgentPluginReferenceCatalogParams,
  ): Promise<ACodePluginsReferenceCatalogResult>;
  /** Composer Skill 引用 catalog；带 sessionId 时读取该 runtime 的冻结快照。 */
  getSkillReferenceCatalog(
    params: ACodeAgentSkillReferenceCatalogParams,
  ): Promise<ACodeSkillsReferenceCatalogResult>;
  // 已保存工作流的 GUI 中枢：workspace 级、无会话，每次调用现扫 `<cwd>/.acode/workflows/`。
  // 全局档传 `scope: "global"`：带 workspace 就用它当载体，不带则由 services 层自选本机载体运行时。
  listSavedWorkflows(params: ACodeAgentListSavedWorkflowsParams): Promise<ACodeWorkflowsListResult>;
  getSavedWorkflow(params: ACodeAgentGetSavedWorkflowParams): Promise<ACodeWorkflowsGetResult>;
  updateSavedWorkflowMeta(
    params: ACodeAgentUpdateSavedWorkflowMetaParams,
  ): Promise<ACodeWorkflowsUpdateMetaResult>;
  deleteSavedWorkflow(
    params: ACodeAgentDeleteSavedWorkflowParams,
  ): Promise<ACodeWorkflowsDeleteResult>;
  listSavedWorkflowRuns(
    params: ACodeAgentListSavedWorkflowRunsParams,
  ): Promise<ACodeWorkflowsRunsResult>;
  // 在项目档 / 全局档之间移动同名文件：
  // `workspace` 是载体（移到项目传目标项目、移到全局传源项目），`to` 是落点档；不覆盖已存在的目标。
  moveSavedWorkflow(params: ACodeAgentMoveSavedWorkflowParams): Promise<ACodeWorkflowsMoveResult>;
  resolveSuggestedPluginReference(
    params: ACodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@acode/shared").ACodePluginsResolveSuggestedReferenceResult>;
  /** 推荐项 Plugin 首次本地检查缺失后的 operation-scoped 刷新进度。 */
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ACodePluginOperationProgressNotification>;
  getPluginsOverview(params: ACodeAgentPluginViewParams): Promise<ACodePluginsOverviewResult>;
  /**
   * 资源管理器：枚举本 Host 内全部本地 Agent 进程（含 plugin / mcp-status 泳道），
   * 并向每个存活 runtime 请求 `process/childProcesses`；单个 runtime 失败只让它的 children 为空。
   */
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<ACodeAgentLocalRuntimeChildProcesses[]>;
  addPluginMarketplace(
    params: ACodeAgentAddPluginMarketplaceParams,
  ): Promise<ACodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ACodeAgentRemovePluginMarketplaceParams,
  ): Promise<ACodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ACodeAgentUpdatePluginMarketplaceParams,
  ): Promise<ACodePluginsMarketplaceMutationResult>;
  installPlugin(params: ACodeAgentInstallPluginParams): Promise<ACodePluginsInstallResult>;
  cancelPluginOperation(
    params: ACodeAgentCancelPluginOperationParams,
  ): Promise<ACodePluginsCancelOperationResult>;
  uninstallPlugin(params: ACodeAgentUninstallPluginParams): Promise<ACodePluginsUninstallResult>;
  updatePlugin(params: ACodeAgentUpdatePluginParams): Promise<ACodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ACodeAgentRestoreBuiltinPluginParams,
  ): Promise<ACodePluginsRestoreBuiltinResult>;
  configurePlugin(params: ACodeAgentConfigurePluginParams): Promise<ACodePluginsConfigureResult>;
  resetPluginConfig(
    params: ACodeAgentResetPluginConfigParams,
  ): Promise<ACodePluginsConfigureResult>;
  validatePlugin(params: ACodeAgentValidatePluginParams): Promise<ACodePluginsValidateResult>;
  describePlugin(params: ACodeAgentDescribePluginParams): Promise<ACodePluginsDescribeResult>;
  setPluginEnabled(params: ACodeAgentSetPluginEnabledParams): Promise<ACodePluginsSetEnabledResult>;
  // ---- 定时任务(automation)管理 ----
  listAutomations(params: ACodeAgentWorkspaceTarget): Promise<ACodeAutomation[]>;
  listAllAutomations(): Promise<ACodeAutomation[]>;
  createAutomation(params: ACodeAgentCreateAutomationParams): Promise<ACodeAutomation>;
  updateAutomation(params: ACodeAgentUpdateAutomationParams): Promise<ACodeAutomation | null>;
  deleteAutomation(params: ACodeAgentAutomationIdParams): Promise<void>;
  setAutomationEnabled(params: ACodeAgentSetAutomationEnabledParams): Promise<void>;
  restartAutomation(params: ACodeAgentAutomationIdParams): Promise<void>;
  runAutomationNow(params: ACodeAgentAutomationIdParams): Promise<ACodeAgentRunAutomationNowResult>;
  listAutomationRuns(params: ACodeAgentAutomationIdParams): Promise<ACodeAutomationRun[]>;
  deleteAutomationRun(params: ACodeAgentDeleteAutomationRunParams): Promise<void>;
  generateWorkspaceText(
    params: ACodeAgentGenerateWorkspaceTextParams,
  ): Promise<ACodeWorkspaceGenerateTextResult>;
  testModelConnectivity(
    params: ACodeAgentTestModelConnectivityParams,
  ): Promise<ACodeProviderTestModelConnectivityResult>;
  /**
   * @deprecated：send 主路径已收敛 v4 sendText 命令。仅剩两个消费点——
   * adapter 带附件输入回退（待附件命令面落地后移除）与 acodeSessionService
   * pass-through；新代码禁止回用。
   */
  sendPrompt(params: ACodeAgentSendPromptParams): Promise<ACodeSessionSendResult>;
  compactSession(params: ACodeAgentCompactParams): Promise<ACodeSessionCompactResult>;
  goalSession(params: ACodeAgentGoalParams): Promise<ACodeSessionGoalResult>;
  closeSession(
    params: ACodeAgentSessionTarget & { expectedPersistence?: "deferred" | "immediate" },
  ): Promise<boolean>;
  setModel(params: ACodeAgentSetModelParams): Promise<ACodeSessionStateSnapshot>;
  setThoughtLevel(params: ACodeAgentSetThoughtLevelParams): Promise<ACodeSessionStateSnapshot>;
  setMode(params: ACodeAgentSetModeParams): Promise<ACodeSessionStateSnapshot>;
  respondSessionRuntimePreferences(
    params: ACodeAgentRespondSessionRuntimePreferencesParams,
  ): Promise<void>;
  onDynamicSessionRuntimePreferencesRequest(): Event<ACodeAgentSessionRuntimePreferencesRequest>;
  /**
   * CLI 进程级资源样本，带 services 打的 lane 标签（CLI 自己不知道 lane）。
   * 使用 dynamic event 避免 RPC 服务在无人订阅时缓冲周期事件；
   * 该事件不属于 session/conversation continuous 或 replayable 状态。
   */
  onDynamicProcessResourceSample(): Event<AgentLaneResourceSample>;
  /** MCP 进程生命周期与低频内存事件，仅供可信 Host relay 上报 ARMS。 */
  onDynamicMcpTelemetry(): Event<ACodeMcpTelemetryEvent>;
  /** MCP 进程树资源事实，只供可信 Host 汇总上报。 */
  onDynamicMcpResourceSamples(): Event<ACodeMcpResourceSample[]>;
  /** Bash 完成事实，仅可信 Host 资源旁路订阅。 */
  onDynamicToolExecResource(): Event<ACodeToolExecResource>;
  /**
   * @deprecated 旧协议订阅面（session/subscribe + session/event + state.updated）。
   * task-index syncer 已迁 v4 sessions-index/workspace-config 帧；
   * 仅剩 acodeTaskServiceAdapter.onDynamicTaskEvent（replayable 读路径）消费。
   * 写路径已收敛 v4 命令面；本订阅是读路径投影源。
   */
  onDynamicSessionEvent(params: ACodeAgentSessionSubscribeParams): Event<ACodeAgentServiceEvent>;
  // ── v4 conversation 通道（竖切）──
  /** RPC attachment 建立后先读取 host 可信 hello。 */
  helloConversationV4(): Promise<HelloMessage>;
  /** hello 校验后回送 clientHello；metadata 不能覆盖 connection mode/profile。 */
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
  /** 仅供 trusted host relay/facade；terminal RPC caller 必须被 connection scope 拒绝。 */
  setConnectionFlowStateV4(params: ACodeAgentConnectionFlowParams): Promise<void>;
  subscribeConversationV4(
    params: ACodeAgentConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(
    params: ACodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: ACodeAgentConversationUnsubscribeParams): Promise<void>;
  /** rows/range 行分页 query（loadOlder 游标向上补历史）。 */
  conversationRowsRangeV4(
    params: ACodeAgentConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  conversationPlansV4(
    params: ACodeAgentConversationPlansParams,
  ): Promise<V4ConversationPlansResult>;
  /** workflow run 事件日志分页；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunEventsV4(
    params: ACodeAgentConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** workflow run 枚举；journal-backed 的重启后发现面。 */
  conversationWorkflowRunsV4(
    params: ACodeAgentConversationWorkflowRunsParams,
  ): Promise<V4ConversationWorkflowRunsResult>;
  /** workflow run 的用户面产物清单；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunArtifactsV4(
    params: ACodeAgentConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** 预置看板的条目分页；hook 以 itemCount 变化为信号增量拉取。 */
  conversationWorkflowRunArtifactDataV4(
    params: ACodeAgentConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** 内容产物的字节，一次一块；授权在 CLI 侧（journal 行才是取字节的依据）。 */
  conversationWorkflowRunArtifactReadV4(
    params: ACodeAgentConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** dwf 工作区 transcript 的清单。 */
  conversationWorkflowRunWorkspaceV4(
    params: ACodeAgentConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** 一个工作区节点的有界正文。 */
  conversationWorkflowRunNodeResultV4(
    params: ACodeAgentConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  backgroundBashOutputV4(
    params: ACodeAgentBackgroundBashOutputParams,
  ): Promise<BackgroundBashOutputResult>;
  conversationFileChangesV4(
    params: ACodeAgentConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult>;
  conversationFileRewindPreviewV4(
    params: ACodeAgentConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  sendConversationCommandV4(params: ACodeAgentConversationCommandParams): Promise<CommandAck>;
  queryConversationCommandsV4(params: ACodeAgentCommandsQueryParams): Promise<CommandsQueryResult>;
  attachmentBeginV4(params: ACodeAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: ACodeAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: ACodeAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult>;
  attachmentAbortV4(params: ACodeAgentAttachmentTerminalParams): Promise<void>;
  /** Desktop local 已发送视频 source query；远端与 Web 返回 chunked。 */
  attachmentPreviewSourceV4(
    params: ACodeAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult>;
  /** 已发送 image/video 只读分块查询；connection scope 注入可信 workspace 连接。 */
  attachmentReadV4(params: ACodeAgentAttachmentReadParams): Promise<V4AttachmentReadResult>;
  /** Share 读取 userInput 附件，允许 text/plain 等非媒体类型。 */
  conversationAttachmentReadV4(
    params: ACodeAgentConversationAttachmentReadParams,
  ): Promise<V4ConversationAttachmentReadResult>;
  /** Share 选择阶段只读 userInput 附件元数据，不读取完整内容。 */
  conversationAttachmentStatV4(
    params: ACodeAgentConversationAttachmentStatParams,
  ): Promise<V4ConversationAttachmentStatResult>;
  /** workspace 级下行帧流（v4/conversation/frame），renderer 侧按 topic 自行路由。 */
  onDynamicConversationFrame(
    params: ACodeAgentWorkspaceTarget,
  ): Event<ConversationTopicWireCandidate>;
  /** workspace 级 live telemetry 事实；connection facade 仅向可信 desktop-continuous 下游暴露。 */
  onDynamicLocalTtftFacts(
    params: ACodeAgentWorkspaceTarget,
  ): Event<import("@acode/shared").LocalTtftFacts>;
  onDynamicConversationTelemetryFact(
    params: ACodeAgentWorkspaceTarget,
  ): Event<ConversationTelemetryFact>;
  /** 当前窗口全部本地 live task 的 CUA 权限观察；历史、远程与 replayable 不在此事件面。 */
  onDynamicCuaPermissionObservation(): Event<ACodeAgentCuaPermissionObservation>;
  // ── sessions-index 通道（列表活性）──
  subscribeSessionsIndexV4(
    params: ACodeAgentSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(
    params: ACodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(params: ACodeAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 sessions-index 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicSessionsIndexFrame(
    params: ACodeAgentWorkspaceTarget,
  ): Event<SessionsIndexTopicWireCandidate>;
  // ── workspace-config 通道（配置目录活性；task-index syncer 消费）──
  subscribeWorkspaceConfigV4(
    params: ACodeAgentWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(
    params: ACodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(params: ACodeAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 workspace-config 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicWorkspaceConfigFrame(
    params: ACodeAgentWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  /**
   * （CLI 重连重订）：agent 进程换代通知（超时回收/崩溃后重新拉起）。
   * v4 订阅活在 CLI 进程内存，进程换代即失效；订阅方（task-index syncer 等）
   * 收到后必须对该 workspaceKey 重发 subscribe，否则帧流静默中断。
   */
  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable;
  /**
   * Agent client 在 service 内完成登记后发布 available，当前 client 关闭后发布 unavailable。
   * 这是被动 observer attach/detach 的唯一生命周期信号，不表达用户使用租约。
   */
  onAgentRuntimeLifecycle?: (
    listener: (event: ACodeAgentRuntimeLifecycleEvent) => void,
  ) => IDisposable;
  /** 当前 desktop-local CUA turn 是否仍在执行，用于 Helper recovery 避免中途回收 Agent。 */
  hasActiveCuaOperationTurn(): boolean;
  disposeWorkspace(params: ACodeAgentWorkspaceTarget): Promise<void>;
  disposeAll(): void;
}

export const IACodeAgentService = createServiceDescriptor<IACodeAgentService>(
  ServiceChannels.ACodeAgent,
  {
    allowedMethods: [
      "prepareStorage",
      "getStorageStartupState",
      "onDynamicStorageStartupState",
      "initialize",
      "syncAppRuntimePreferences",
      "getWorkspaceRuntimeIdentity",
      "createSession",
      "resumeSession",
      "listSessions",
      "listSessionSubagents",
      "getAppUsageStats",
      "getTaskTokenUsage",
      "readSession",
      "readSessionMessages",
      "readSessionDebug",
      "readSessionEvents",
      "readWorkspacePresentation",
      "grantWorkspaceHookTrust",
      "listMcpServerStatuses",
      "listPlugins",
      "getPluginReferenceCatalog",
      "getSkillReferenceCatalog",
      "listSavedWorkflows",
      "getSavedWorkflow",
      "updateSavedWorkflowMeta",
      "deleteSavedWorkflow",
      "listSavedWorkflowRuns",
      "moveSavedWorkflow",
      "resolveSuggestedPluginReference",
      "onDynamicPluginOperationProgress",
      "getPluginsOverview",
      "collectLocalRuntimeChildProcesses",
      "addPluginMarketplace",
      "removePluginMarketplace",
      "updatePluginMarketplace",
      "installPlugin",
      "cancelPluginOperation",
      "uninstallPlugin",
      "updatePlugin",
      "restoreBuiltinPlugin",
      "configurePlugin",
      "resetPluginConfig",
      "validatePlugin",
      "describePlugin",
      "setPluginEnabled",
      "listAutomations",
      "listAllAutomations",
      "createAutomation",
      "updateAutomation",
      "deleteAutomation",
      "setAutomationEnabled",
      "restartAutomation",
      "runAutomationNow",
      "listAutomationRuns",
      "deleteAutomationRun",
      "generateWorkspaceText",
      "testModelConnectivity",
      "sendPrompt",
      "compactSession",
      "goalSession",
      "closeSession",
      "setModel",
      "setThoughtLevel",
      "setMode",
      "respondSessionRuntimePreferences",
      "onDynamicSessionRuntimePreferencesRequest",
      "onDynamicProcessResourceSample",
      "onDynamicMcpTelemetry",
      "onDynamicMcpResourceSamples",
      "onDynamicToolExecResource",
      "onDynamicSessionEvent",
      "helloConversationV4",
      "initializeConversationV4",
      "setConnectionFlowStateV4",
      "subscribeConversationV4",
      "resyncConversationV4",
      "unsubscribeConversationV4",
      "conversationRowsRangeV4",
      "conversationPlansV4",
      "conversationWorkflowRunEventsV4",
      "conversationWorkflowRunsV4",
      "conversationWorkflowRunArtifactsV4",
      "conversationWorkflowRunArtifactDataV4",
      "conversationWorkflowRunArtifactReadV4",
      "conversationWorkflowRunWorkspaceV4",
      "conversationWorkflowRunNodeResultV4",
      "backgroundBashOutputV4",
      "conversationFileChangesV4",
      "conversationFileRewindPreviewV4",
      "sendConversationCommandV4",
      "queryConversationCommandsV4",
      "attachmentBeginV4",
      "attachmentChunkV4",
      "attachmentCommitV4",
      "attachmentAbortV4",
      "attachmentPreviewSourceV4",
      "attachmentReadV4",
      "conversationAttachmentReadV4",
      "conversationAttachmentStatV4",
      "onDynamicConversationFrame",
      "onDynamicLocalTtftFacts",
      "onDynamicConversationTelemetryFact",
      "onDynamicCuaPermissionObservation",
      "subscribeSessionsIndexV4",
      "resyncSessionsIndexV4",
      "unsubscribeSessionsIndexV4",
      "onDynamicSessionsIndexFrame",
      "subscribeWorkspaceConfigV4",
      "resyncWorkspaceConfigV4",
      "unsubscribeWorkspaceConfigV4",
      "onDynamicWorkspaceConfigFrame",
      "onAgentRuntimeRestarted",
      "onAgentRuntimeLifecycle",
      "hasActiveCuaOperationTurn",
      "disposeWorkspace",
      "disposeAll",
    ],
    // ARCH-01 参数校验器：全部成员按 TS 签名做传输边界形状守卫（arity + 顶层类型）。
    // 校验发生在服务方法体执行前，失败统一归一为 rpc-invalid-arguments；错误文本不回显参数值。
    argumentValidators: {
      prepareStorage: requireSingleParamsObject,
      getStorageStartupState: requireSingleParamsObject,
      // 动态事件经 listen 订阅：proxy 把订阅参数包成单元素数组（无参数时为空数组）再交给校验器。
      onDynamicStorageStartupState: requireSingleParamsObject,
      initialize: requireSingleParamsObject,
      syncAppRuntimePreferences: requireSingleParamsObject,
      getWorkspaceRuntimeIdentity: requireSingleParamsObject,
      createSession: requireSingleParamsObject,
      resumeSession: requireSingleParamsObject,
      listSessions: requireSingleParamsObject,
      listSessionSubagents: requireSingleParamsObject,
      getAppUsageStats: requireSingleParamsObject,
      getTaskTokenUsage: requireSingleParamsObject,
      readSession: requireSingleParamsObject,
      readSessionMessages: requireSingleParamsObject,
      readSessionDebug: requireSingleParamsObject,
      readSessionEvents: requireSingleParamsObject,
      readWorkspacePresentation: requireSingleParamsObject,
      grantWorkspaceHookTrust: requireSingleParamsObject,
      listMcpServerStatuses: requireSingleParamsObject,
      listPlugins: requireSingleParamsObject,
      getPluginReferenceCatalog: requireSingleParamsObject,
      getSkillReferenceCatalog: requireSingleParamsObject,
      listSavedWorkflows: requireSingleParamsObject,
      getSavedWorkflow: requireSingleParamsObject,
      updateSavedWorkflowMeta: requireSingleParamsObject,
      deleteSavedWorkflow: requireSingleParamsObject,
      listSavedWorkflowRuns: requireSingleParamsObject,
      moveSavedWorkflow: requireSingleParamsObject,
      resolveSuggestedPluginReference: requireSingleParamsObject,
      onDynamicPluginOperationProgress: requireSingleString,
      getPluginsOverview: requireSingleParamsObject,
      collectLocalRuntimeChildProcesses: (args) => {
        // signal 是可选 AbortSignal：进程内调用方可能传 signal 对象，RPC wire 调用方通常省略
        // （AbortSignal 不可 JSON 序列化，序列化后退化形态也不可控）。只守 arity 与顶层类型，
        // 不要求在场、不校验内部形状，避免把合法省略或宿主侧包装对象误拒。
        if (args.length > 1) throw new Error("expected at most one abort signal");
        const signal = args[0];
        if (signal !== undefined && signal !== null && typeof signal !== "object") {
          throw new Error("expected an abort signal object");
        }
      },
      addPluginMarketplace: requireSingleParamsObject,
      removePluginMarketplace: requireSingleParamsObject,
      updatePluginMarketplace: requireSingleParamsObject,
      installPlugin: requireSingleParamsObject,
      cancelPluginOperation: requireSingleParamsObject,
      uninstallPlugin: requireSingleParamsObject,
      updatePlugin: requireSingleParamsObject,
      restoreBuiltinPlugin: requireSingleParamsObject,
      configurePlugin: requireSingleParamsObject,
      resetPluginConfig: requireSingleParamsObject,
      validatePlugin: requireSingleParamsObject,
      describePlugin: requireSingleParamsObject,
      setPluginEnabled: requireSingleParamsObject,
      listAutomations: requireSingleParamsObject,
      listAllAutomations: requireNoArguments,
      createAutomation: requireSingleParamsObject,
      updateAutomation: requireSingleParamsObject,
      deleteAutomation: requireSingleParamsObject,
      setAutomationEnabled: requireSingleParamsObject,
      restartAutomation: requireSingleParamsObject,
      runAutomationNow: requireSingleParamsObject,
      listAutomationRuns: requireSingleParamsObject,
      deleteAutomationRun: requireSingleParamsObject,
      generateWorkspaceText: requireSingleParamsObject,
      testModelConnectivity: requireSingleParamsObject,
      sendPrompt: requireSingleParamsObject,
      compactSession: requireSingleParamsObject,
      goalSession: requireSingleParamsObject,
      closeSession: requireSingleParamsObject,
      setModel: requireSingleParamsObject,
      setThoughtLevel: requireSingleParamsObject,
      setMode: requireSingleParamsObject,
      respondSessionRuntimePreferences: requireSingleParamsObject,
      onDynamicSessionRuntimePreferencesRequest: requireNoArguments,
      onDynamicProcessResourceSample: requireNoArguments,
      onDynamicMcpTelemetry: requireNoArguments,
      onDynamicMcpResourceSamples: requireNoArguments,
      onDynamicToolExecResource: requireNoArguments,
      onDynamicSessionEvent: requireSingleParamsObject,
      helloConversationV4: requireNoArguments,
      initializeConversationV4: requireSingleParamsObject,
      setConnectionFlowStateV4: requireSingleParamsObject,
      subscribeConversationV4: requireSingleParamsObject,
      resyncConversationV4: requireSingleParamsObject,
      unsubscribeConversationV4: requireSingleParamsObject,
      conversationRowsRangeV4: requireSingleParamsObject,
      conversationPlansV4: requireSingleParamsObject,
      conversationWorkflowRunEventsV4: requireSingleParamsObject,
      conversationWorkflowRunsV4: requireSingleParamsObject,
      conversationWorkflowRunArtifactsV4: requireSingleParamsObject,
      conversationWorkflowRunArtifactDataV4: requireSingleParamsObject,
      conversationWorkflowRunArtifactReadV4: requireSingleParamsObject,
      conversationWorkflowRunWorkspaceV4: requireSingleParamsObject,
      conversationWorkflowRunNodeResultV4: requireSingleParamsObject,
      backgroundBashOutputV4: requireSingleParamsObject,
      conversationFileChangesV4: requireSingleParamsObject,
      conversationFileRewindPreviewV4: requireSingleParamsObject,
      sendConversationCommandV4: requireSingleParamsObject,
      queryConversationCommandsV4: requireSingleParamsObject,
      attachmentBeginV4: requireSingleParamsObject,
      attachmentChunkV4: requireSingleParamsObject,
      attachmentCommitV4: requireSingleParamsObject,
      attachmentAbortV4: requireSingleParamsObject,
      attachmentPreviewSourceV4: requireSingleParamsObject,
      attachmentReadV4: requireSingleParamsObject,
      conversationAttachmentReadV4: requireSingleParamsObject,
      conversationAttachmentStatV4: requireSingleParamsObject,
      onDynamicConversationFrame: requireSingleParamsObject,
      onDynamicLocalTtftFacts: requireSingleParamsObject,
      onDynamicConversationTelemetryFact: requireSingleParamsObject,
      onDynamicCuaPermissionObservation: requireNoArguments,
      subscribeSessionsIndexV4: requireSingleParamsObject,
      resyncSessionsIndexV4: requireSingleParamsObject,
      unsubscribeSessionsIndexV4: requireSingleParamsObject,
      onDynamicSessionsIndexFrame: requireSingleParamsObject,
      subscribeWorkspaceConfigV4: requireSingleParamsObject,
      resyncWorkspaceConfigV4: requireSingleParamsObject,
      unsubscribeWorkspaceConfigV4: requireSingleParamsObject,
      onDynamicWorkspaceConfigFrame: requireSingleParamsObject,
      onAgentRuntimeRestarted: requireOptionalListener,
      onAgentRuntimeLifecycle: requireOptionalListener,
      hasActiveCuaOperationTurn: requireNoArguments,
      disposeWorkspace: requireSingleParamsObject,
      disposeAll: requireNoArguments,
    },
  },
);

// ── 文件内参数校验辅助（遵循 file.ts 的 requireNoArguments/requireObjectFields 先例）──
// 这是传输边界加固，不是业务 schema 校验（rpc-service-boundary spec 规则 7）：
// 只做 arity 与顶层类型守卫。错误文本必须稳定且永不回显参数值——proxy 层会把
// message 归一为 RpcArgumentError.details，任何插值都可能把路径、sessionId 或凭据带出边界。

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

/**
 * 单 params 对象入参的统一守卫。刻意不校验对象内部字段：
 * connection scope / trusted host relay facade 会在 host 内层改写并注入字段
 * （workspacePath、__acodeTrustedV4Connection、subscriberScope 等），且现有生产
 * wire 报文允许缺少 interface 标注为必填的字段（如 setConnectionFlowStateV4 只带
 * state）；在边界要求内部字段会误拒合法链路。深层形状由服务体自己的 zod/业务校验负责。
 */
function requireSingleParamsObject(args: readonly unknown[]): void {
  if (args.length !== 1) throw new Error("expected exactly one params object");
  const value = args[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a non-null params object");
  }
}

function requireSingleString(args: readonly unknown[]): void {
  if (args.length !== 1 || typeof args[0] !== "string") {
    throw new Error("expected a single string argument");
  }
}

/**
 * 普通事件（onXxx）经 listen 订阅，listener 由客户端本地持有，不会出现在 RPC wire
 * 报文中（proxy-channel 只对动态事件与 call 方法执行校验器）。此处按签名做防御性
 * 登记：允许无参数（listen 形态）或单个函数（进程内直调形态），不做更严要求。
 */
function requireOptionalListener(args: readonly unknown[]): void {
  if (args.length > 1) throw new Error("expected at most one listener argument");
  if (args.length === 1 && typeof args[0] !== "function") {
    throw new Error("expected a listener function");
  }
}
