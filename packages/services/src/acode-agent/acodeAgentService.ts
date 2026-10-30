import { requestPluginReferenceCatalog } from "#src/acode-agent/pluginReferenceCatalogRequest.js";
/* oxlint-disable eslint(max-lines) -- ACode Protocol transport、通知 wiring 和 app-facing session 方法必须共享同一个 client/emitter 上下文。 */
import { randomUUID } from "node:crypto";
import { ensureIndependentPlanSupport } from "./independentPlanSupport.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Emitter, Event } from "@acode/rpc";
import type { IDisposable } from "@acode/rpc";
import type {
  AccountProviderConfigSnapshot,
  ModelSelectionView,
  ProviderSource,
} from "@acode/provider";
import { completeNewModelSelection } from "@acode/provider";
import type { OffPeakClientConfig } from "#src/coding-plan-subscription/codingPlanSubscription.js";
import { ACODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS, resolveWorkspaceKey, type TraceId, ACODE_AGENT_PROVIDER, ACODE_AGENT_PROVIDER_NOT_READY_CODE, ACODE_AGENT_PROVIDER_NOT_READY_REASON, ACODE_MODEL_REASONING_SEPARATOR, isRemoteWorkspaceIdentity, ACODE_PROTOCOL_NAME, ACODE_PROTOCOL_VERSION, acodePluginOperationProgressNotificationSchema, acodePluginsCancelOperationResultSchema, OFF_PEAK_PROVIDER_IDS, summarizeOfficialMcpIdentityHeaders, acodeProtocolEmptyResultSchema, LEGACY_SURVIVOR_METHODS, LEGACY_NOTIFICATIONS, acodeMcpTelemetryEventSchema, acodeMcpResourceSamplesSchema, acodeToolExecResourceSchema, acodeProcessResourceSampleSchema, acodeSessionEventsResultSchema, acodeSessionSubagentsResultSchema, acodeSessionEventSchema, acodeSessionSendResultSchema, acodeSessionRuntimePreferencesResultSchema, acodeSessionStateSnapshotSchema, acodeSessionSubscribeResultSchema, acodeStateUpdatedNotificationSchema, type ACodeSessionStateSnapshot, type ACodeSessionGoal, type ACodeAutomation, type ACodeAutomationRun, type DynamicWorkflowClientConfig, type ScriptWorkflowMode, isScriptWorkflowModeEnabled, type ToolSearchAppMode, type AgentLaneResourceSample, type ProcessResourceCliLane, type ACodeMcpTelemetryEvent, type ACodeMcpResourceSample, type ACodeToolExecResource, type ACodePluginOperationProgressNotification, type ACodeTaskMode } from "@acode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { createOfficialMcpIssuanceAudit } from "#src/official-mcp/officialMcpIssuanceAudit.js";
import type {
  AccountRequestAuthMaterial,
  IAccountRequestAuthService,
} from "#src/model-provider/accountRequestAuthService.js";
import {
  mergeAutomationMutationToolDenylist,
  mergeOffPeakMutationToolDenylist,
} from "#src/acode-agent/automationToolPolicy.js";
import { ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./acodeAgent.js";
import type { ACodeProtocolRequestId, ModelSelection, ACodeMessageWithParts, ACodeSessionEvent, ACodeSessionRuntimePreferencesScope, ACodeStateUpdatedNotification, ACodeWorkspaceRef, ACodeSessionRuntimePreferencesResult } from "@acode/shared";
import type {
  IACodeAgentService,
  ACodeAgentBackgroundBashOutputParams,
  ACodeAgentAppRuntimePreferences,
  ACodeAgentRuntimeLifecycleEvent,
  ACodeAgentAddPluginMarketplaceParams,
  ACodeAgentAppUsageParams,
  ACodeAgentCancelPluginOperationParams,
  ACodeAgentCompactParams,
  ACodeAgentConfigurePluginParams,
  ACodeAgentResetPluginConfigParams,
  ACodeAgentCreateSessionParams,
  ACodeAgentInstallPluginParams,
  ACodeAgentCancelWorkspaceGenerateTextParams,
  ACodeAgentGenerateWorkspaceTextParams,
  ACodeAgentTestModelConnectivityParams,
  ACodeAgentGoalParams,
  ACodeAgentGrantWorkspaceHookTrustParams,
  ACodeAgentInitializeResult,
  ACodeAgentListSessionsParams,
  ACodeAgentListSessionSubagentsParams,
  ACodeAgentReadWorkspacePresentationParams,
  ACodeAgentReadSessionEventsParams,
  ACodeAgentReadSessionMessagesParams,
  ACodeAgentReadSessionParams,
  ACodeAgentRemovePluginMarketplaceParams,
  ACodeAgentRespondSessionRuntimePreferencesParams,
  ACodeAgentResumeSessionParams,
  ACodeAgentSendPromptParams,
  ACodeAgentServiceEvent,
  ACodeAgentSessionSubscribeParams,
  ACodeAgentSessionTarget,
  ACodeAgentSessionRuntimePreferencesRequest,
  ACodeAgentTaskTokenUsageParams,
  ACodeAgentSetModeParams,
  ACodeAgentSetModelParams,
  ACodeAgentSetPluginEnabledParams,
  ACodeAgentSetThoughtLevelParams,
  ACodeAgentPluginReferenceCatalogParams,
  ACodeAgentSkillReferenceCatalogParams,
  ACodeAgentDeleteSavedWorkflowParams,
  ACodeAgentGetSavedWorkflowParams,
  ACodeAgentListSavedWorkflowRunsParams,
  ACodeAgentListSavedWorkflowsParams,
  ACodeAgentMoveSavedWorkflowParams,
  ACodeAgentSavedWorkflowTarget,
  ACodeAgentUpdateSavedWorkflowMetaParams,
  ACodeAgentResolveSuggestedPluginReferenceParams,
  ACodeAgentPluginViewParams,
  ACodeAgentUninstallPluginParams,
  ACodeAgentUpdatePluginParams,
  ACodeAgentRestoreBuiltinPluginParams,
  ACodeAgentUpdatePluginMarketplaceParams,
  ACodeAgentValidatePluginParams,
  ACodeAgentDescribePluginParams,
  ACodeAgentListMcpServerStatusesParams,
  ACodeAgentWorkspaceTarget,
  ACodeAgentCuaPermissionObservation,
  ACodeAgentNetworkCaptureSetEnabledParams,
  ACodeAgentNetworkCaptureSetEnabledResult,
  ACodeAgentCreateAutomationParams,
  ACodeAgentUpdateAutomationParams,
  ACodeAgentAutomationIdParams,
  ACodeAgentRunAutomationNowParams,
  ACodeAgentSetAutomationEnabledParams,
  ACodeAgentDeleteAutomationRunParams,
  ACodeAgentAttachmentBeginParams,
  ACodeAgentAttachmentChunkParams,
  ACodeAgentAttachmentReadParams,
  ACodeAgentConversationAttachmentReadParams,
  ACodeAgentConversationAttachmentStatParams,
  ACodeAgentAttachmentPreviewSourceParams,
  ACodeAgentAttachmentTerminalParams,
  ACodeAgentConversationCommandParams,
  ACodeAgentCommandsQueryParams,
  ACodeAgentConversationFileChangesParams,
  ACodeAgentConversationFileRewindPreviewParams,
  ACodeAgentConversationRowsRangeParams,
  ACodeAgentConversationPlansParams,
  ACodeAgentConversationWorkflowRunEventsParams,
  ACodeAgentConversationWorkflowRunArtifactDataParams,
  ACodeAgentConversationWorkflowRunArtifactReadParams,
  ACodeAgentConversationWorkflowRunArtifactsParams,
  ACodeAgentConversationVisualizationReadParams,
  ACodeAgentConversationWorkflowRunNodeResultParams,
  ACodeAgentConversationWorkflowRunWorkspaceParams,
  ACodeAgentConversationWorkflowRunsParams,
  ACodeAgentConversationResyncParams,
  ACodeAgentConversationSubscribeParams,
  ACodeAgentConversationUnsubscribeParams,
  ACodeAgentConnectionFlowParams,
  ACodeAgentSessionsIndexSubscribeParams,
  ACodeAgentWorkspaceConfigSubscribeParams,
} from "./acodeAgent.js";
import { backgroundBashOutputResultSchema, v4BackgroundBashOutputParamsSchema, V4_WIRE_PROTOCOL_VERSION, PROTOCOL_V4_LIMITS, clientHelloSchema, commandAckSchema, commandPayloadSchemas, commandsQueryParamsSchema, commandsQueryResultSchema, conversationTopic, conversationTopicWireCandidateSchema, conversationTelemetryFactSchema, cuaPermissionObservationSchema, v4NetworkCaptureRecordsNotificationSchema, v4NetworkCaptureSetEnabledParamsSchema, v4NetworkCaptureSetEnabledResultSchema, V4_OVERNIGHT_COMPLETION_METHOD, v4OvernightCompletionNotificationSchema, sessionsIndexTopic, sessionsIndexTopicWireCandidateSchema, MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE, V4_METHODS, V4_NOTIFICATIONS, v4AttachmentAbortResultSchema, v4AttachmentBeginResultSchema, v4AttachmentChunkResultSchema, v4AttachmentCommitResultSchema, v4AttachmentPreviewSourceParamsSchema, v4AttachmentPreviewSourceResultSchema, v4AttachmentReadParamsSchema, v4AttachmentReadResultSchema, v4ConversationAttachmentReadParamsSchema, v4ConversationAttachmentReadResultSchema, v4ConversationAttachmentStatParamsSchema, v4ConversationAttachmentStatResultSchema, v4ConnectionFlowResultSchema, v4ConversationFileChangesResultSchema, v4ConversationFileRewindPreviewResultSchema, v4ConversationRowsRangeResultSchema, v4ConversationPlansResultSchema, v4ConversationWorkflowRunEventsResultSchema, v4ConversationWorkflowRunArtifactDataResultSchema, v4ConversationWorkflowRunArtifactReadResultSchema, v4ConversationVisualizationReadResultSchema, v4ConversationWorkflowRunArtifactsResultSchema, v4ConversationWorkflowRunNodeResultResultSchema, v4ConversationWorkflowRunWorkspaceResultSchema, v4ConversationWorkflowRunsResultSchema, v4ConversationResyncResultSchema, v4ConversationSubscribeResultSchema, v4ConversationUsageResultSchema, v4McpListResultSchema, v4ProcessChildProcessesResultSchema, v4ProviderTestModelConnectivityResultSchema, v4ProviderUpdateAccountConfigResultSchema, v4WorkspaceCancelGenerateTextResultSchema, v4WorkspaceGenerateTextResultSchema, v4WorkspaceHookTrustGrantResultSchema, v4WorkspacePresentationSchema, v4WorkspaceUpdateDynamicWorkflowPolicyResultSchema, v4WorkspaceUpdateInteractionPreferencesResultSchema, v4WorkspaceUpdateModelIoPreferencesResultSchema, v4WorkspaceUpdateOffPeakToolPolicyResultSchema, type V4ProcessChildProcess, type V4WorkspacePresentation, v4PluginsConfigureResultSchema, v4PluginsDescribeResultSchema, v4PluginsInstallResultSchema, v4PluginsListResultSchema, v4PluginsMarketplaceMutationResultSchema, v4PluginsOverviewResultSchema, v4PluginsResolveSuggestedReferenceResultSchema, v4PluginsRestoreBuiltinResultSchema, v4PluginsSetEnabledResultSchema, v4PluginsUninstallResultSchema, v4PluginsValidateResultSchema, v4SessionsIndexSubscribeResultSchema, v4SessionHeaderMetaResultSchema, v4SkillsReferenceCatalogResultSchema, v4UsageStatsResultSchema, v4WorkflowsDeleteResultSchema, v4WorkflowsGetResultSchema, v4WorkflowsListResultSchema, v4WorkflowsMoveResultSchema, v4WorkflowsRunsResultSchema, v4WorkflowsUpdateMetaResultSchema, v4WorkspaceConfigSubscribeResultSchema, workspaceConfigTopic, workspaceConfigTopicWireCandidateSchema, utf8JsonByteLength, ACODE_ATTACHMENT_FAULT_CODES, ACodeAttachmentFaultError, readPendingInteractionHints, type CommandAck, type CommandPayloadMap, type ConversationTopicWireCandidate, type ConversationTelemetryFact, type SessionsIndexTopicWireCandidate, type WorkspaceConfigTopicWireCandidate, type CommandEnvelope, type V4NetworkCaptureRecordsNotification, type V4OvernightCompletionNotification, v4SessionGoalQueryResultSchema, v4SessionDebugResultSchema, v4SessionsListResultSchema, v4SessionRuntimePreferencesResultSchema, v4InteractionRequestPermissionParamsSchema, v4InteractionRequestUserInputParamsSchema, v4InteractionRequestProviderRuntimeHeadersParamsSchema, v4InteractionRequestOfficialMcpAuthHeadersParamsSchema, v4InteractionBrowserListParamsSchema, v4InteractionBrowserExecuteParamsSchema, v4CuaOperationEventSchema, v4ProviderRuntimeHeadersCancelledSchema, v4AutomationCreateParamsSchema, v4AutomationUpdateParamsSchema, v4AutomationListParamsSchema, v4AutomationCheckTaskBindingParamsSchema, v4AutomationDeleteParamsSchema, v4OffPeakCreateParamsSchema, v4OffPeakListParamsSchema, type V4AutomationCheckTaskBindingParams, type V4AutomationCreateParams, type V4AutomationDeleteParams, type V4AutomationUpdateParams, type V4OffPeakCreateParams, type V4InteractionBrowserExecuteParams, type V4InteractionBrowserListParams, type V4CuaOperationEvent, type V4InteractionRequestOfficialMcpAuthHeadersParams, type V4InteractionRequestPermissionParams, type V4InteractionRequestProviderRuntimeHeadersParams, type V4InteractionRequestUserInputParams, type V4SavedWorkflowScope } from "@acode/shared/acode-protocol-v4";
import {
  readTrustedACodeAgentV4Connection,
  readTrustedACodeAgentV4UnsubscribeRoute,
  type ACodeAgentV4ClientMode,
  type ACodeAgentV4ConnectionContext,
} from "./acodeAgentConnectionScope.js";
import {
  resolveTrustedCommandClientMode,
  stampCreateSessionClientMode,
} from "./acodeV4CreateSessionClientMode.js";
import {
  assertV4CommandAckOk,
  createHostCommandEnvelope,
  sendHostCasCommandV4,
} from "./acodeV4HostCommand.js";
import { createBackgroundSessionEventCoalescer } from "#src/acode-agent/acodeSessionEventCoalescer.js";
import {
  AutomationService,
  AutomationManualTriggerRejectedError,
  type AutomationManualRunTriggerContext,
  AutomationRepo,
} from "#src/session/contract.js";
import type { AutomationManualTriggerOrigin } from "@acode/shared";
// TaskIndexRepo 是 tasks-index 表的唯一写入所有者，构造边刻意不走消费契约：
// task-index-writers 守护把任何文本引用都当写入面评审（specs/task-index-write-ownership.md），
// 本文件是守护白名单登记的写入方，故直引实现文件并由 internalEdgeAllowlist 登记。
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
// M2-6：ACodeAgentMcpStatusModeUnsupportedError 不再由本文件抛出（v4/mcp/list 无
// legacy 兼容重试链）；类本体与 index.ts 导出保留——UI 仍 import 该符号（禁改面）。
import { ACodeAgentProcessManager } from "./acodeAgentProcessManager.js";
import type { ACodeAgentProcessManagerOptions } from "./acodeAgentProcessManager.js";
import type { IOffPeakTaskService } from "#src/session/contract.js";
import {
  ACodeProtocolRequestTimeoutError,
  type ACodeProtocolClient,
} from "./acodeProtocolClient.js";
import { getDataBaseDir } from "../paths.js";
import {
  collectBrowserAmbientContext,
  type BrowserAmbientContextExecutor,
} from "./acodeAgentBrowserAmbientContext.js";
import {
  createCuaOperationTurnTracker,
  type CuaOperationWorkspaceTarget,
  type CuaOperationStateReporter,
} from "./cuaOperationTurnTracker.js";
import type { PipSessionEvent } from "@acode/acode-cua/pip-session";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const logger = createServiceLogger("acode-agent-service");
const cuaOperationLogger = createServiceLogger("cua-operation-turn");
const PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME = "plugin-workspace";
// 状态探测完成后释放闲置的 MCP 子进程；只作用于控制面，不回收会话进程。
const MCP_STATUS_LANE_IDLE_TIMEOUT_MS = 5 * 60_000;
// 官方 Claude marketplace 首次接入需要 clone/copy GitHub 仓库，30s 默认协议超时会杀掉健康 agent。
// 插件市场管理属于低频网络 I/O 操作，单独放宽超时，不影响普通会话消息的实时失败边界。
const PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** 资源管理器每秒刷新；子进程映射是纯内存请求，超时就当本轮无映射，不能拖慢采样节拍。 */
const CHILD_PROCESSES_REQUEST_TIMEOUT_MS = 800;
const PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS = 5_000;
const SESSION_COMPACT_REQUEST_TIMEOUT_MS = 5 * 60_000;

interface PendingPermissionRequest {
  client: ACodeProtocolClient;
  protocolRequestId: ACodeProtocolRequestId;
}

interface PendingProviderRuntimeHeadersRequest extends PendingPermissionRequest {
  request: V4InteractionRequestProviderRuntimeHeadersParams;
  responding?: boolean;
}

interface PendingSessionRuntimePreferencesRequest {
  // M2-3（specs/m2-3-session-readwrite.md §2.8）：偏好供给改为 host→CLI v4 push 后，
  // pending 不再承载 CLI 请求的 respond 通道（protocolRequestId 消亡），改为内部
  // await 的 promise 结算回调；client 仅保留用于断连时快速失败在途解析。
  client: ACodeProtocolClient;
  request: ACodeAgentSessionRuntimePreferencesRequest;
  timeout: ReturnType<typeof setTimeout>;
  workspaceKey: string;
  resolve: (preferences: ACodeSessionRuntimePreferencesResult) => void;
  reject: (error: Error) => void;
}

type SessionSendCompatField =
  | "browserAmbientContext"
  | "automationId"
  | "offPeakTaskId"
  | "offPeakRunType"
  | "botDeliveryTarget"
  | "toolDenylist";

const SESSION_SEND_OPTIONAL_COMPAT_FIELDS = new Set<SessionSendCompatField>([
  "browserAmbientContext",
  "automationId",
  "offPeakTaskId",
  "offPeakRunType",
  "botDeliveryTarget",
  "toolDenylist",
]);
// onDynamicSessionEvent 建立上游订阅时若 getClient / sessionSubscribe 瞬时失败
// （agent 进程刚启动、runtime 抛 "Session is not active" 竞态、transport 抖动），
// 直接 .catch(() => {}) 静默吞掉且不重试的话，调用方（含 syncer shadow 订阅）会把
// emitter.event 当作"订阅成功"缓存，永不重建——这条 session 的终态事件再也到不了，
// sqlite 停在旧状态、侧边栏 spinner 转不停。这里改为有限次指数退避重试，覆盖瞬时失败窗口。
const SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS = 500;
const SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS = 5_000;
const SESSION_SUBSCRIBE_MAX_ATTEMPTS = 8;
const MAX_TRACKED_SESSION_EVENT_IDS = 10_000;
const SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:ssh:";
const WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:wsl:";

function supportsLegacyRemoteTaskAllowlist(workspaceIdentity: string | undefined): boolean {
  return Boolean(
    workspaceIdentity?.startsWith(SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX) ||
    workspaceIdentity?.startsWith(WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX),
  );
}

function isClosedStdioTransportError(error: unknown): boolean {
  return error instanceof Error && error.message === "ACode agent stdio transport is closed";
}

interface SessionEventSequenceState {
  assignedSeqByEventId: Map<string, number>;
  assignedSeqEventIds: string[];
  liveEventIds: Set<string>;
  liveEventIdOrder: string[];
  lastAssignedSeq: number;
}

function isProtocolMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

function buildWorkspaceRef(params: ACodeAgentWorkspaceTarget): ACodeWorkspaceRef {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    remoteSessionId: params.remoteSessionId,
    workspaceKey: resolveWorkspaceKey(params),
  };
}

// 已保存工作流的 target 是否带 workspace：项目档、以及
// GUI 项目组里明说 `scope:"global"` 的动作都带 workspacePath；只给 `{ scope: "global" }` 的
// 全局组动作不带，交给 services 自选载体。
function savedWorkflowTargetHasWorkspace(
  params: ACodeAgentSavedWorkflowTarget,
): params is ACodeAgentWorkspaceTarget & { scope?: V4SavedWorkflowScope } {
  return typeof (params as Partial<ACodeAgentWorkspaceTarget>).workspacePath === "string";
}

// 只在 `scope` 有定义时下推到 RPC params：不给 scope 的项目档保持与今天逐字一致的线上形状。
function savedWorkflowScopeParam(params: ACodeAgentSavedWorkflowTarget): {
  scope?: V4SavedWorkflowScope;
} {
  return params.scope === undefined ? {} : { scope: params.scope };
}

function ensurePluginManagementWorkspacePath(): string {
  const workspacePath = join(getDataBaseDir(), ".acode", PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME);
  // 插件管理是控制面能力，不能复用可能因真实 workspace 被删而 EPIPE 的会话进程。
  // 这里给它固定一个内部 cwd；真实 workspace 仍通过协议参数传给 CLI 做 workspace-scope 判定。
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

// NOTE: this counts ONLY the per-session MCP servers passed through the ACode Protocol
// session/create params (the app→protocol channel). It is deliberately independent of the
// CLI/bootstrap MCP servers configured in ~/.acode/cli/config.json (mcp.servers), which the agent
// runtime connects separately and reports via the `mcp.server.connected`/toolCount events. So a
// createSession log line with mcpServerCount:0 is EXPECTED when acode-cua is a CLI-config MCP server
// (e.g. the product Helper broker path injected through the gated bootstrap env): the model still receives those
// tools — the two numbers describe different channels, not a missing tool set. Verified on-machine:
// real kimi-k2.6 turns call mcp__acode-cua__* tools (get_app_state/type/open_application, status
// completed) in sessions whose createSession logged mcpServerCount:0.
function getMcpServerCount(params: { mcpServers?: readonly unknown[] }): number {
  return params.mcpServers?.length ?? 0;
}

function getMcpServerNames(params: { mcpServers?: readonly { name: string }[] }): string[] {
  return params.mcpServers?.map((server) => server.name) ?? [];
}

function parseInvalidParamsIssues(error: unknown): unknown[] {
  const errorLike = error as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
  const message = errorLike.message;
  if (
    errorLike.code !== -32602 ||
    typeof message !== "string" ||
    (message !== "Invalid params" && !message.startsWith("Invalid params — "))
  ) {
    return [];
  }
  const data = errorLike.data;
  if (!data || typeof data !== "object") {
    return [];
  }
  // 新版 Agent 会把 Zod 摘要附加到顶层 message，旧兼容解析却只接受严格等于
  // "Invalid params"，导致 App/Agent 版本错位时无法省略新增字段重试。字段判断仍只信任
  // data 中的结构化 issues，不能从可变的人类可读摘要里猜字段名。
  const serializedIssues = (data as { message?: unknown }).message;
  if (typeof serializedIssues !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(serializedIssues) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getUnrecognizedTopLevelKeys(error: unknown): string[] {
  const keys = new Set<string>();
  for (const issue of parseInvalidParamsIssues(error)) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const issueLike = issue as {
      code?: unknown;
      keys?: unknown;
      path?: unknown;
    };
    if (
      issueLike.code !== "unrecognized_keys" ||
      (Array.isArray(issueLike.path) && issueLike.path.length > 0) ||
      !Array.isArray(issueLike.keys)
    ) {
      continue;
    }
    for (const key of issueLike.keys) {
      if (typeof key === "string") {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

function getSessionSendCompatFields(error: unknown): SessionSendCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionSendCompatField =>
      SESSION_SEND_OPTIONAL_COMPAT_FIELDS.has(key as SessionSendCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function isProtocolRequestTimeout(error: unknown, method: string): boolean {
  if (error instanceof ACodeProtocolRequestTimeoutError) {
    return error.method === method;
  }
  return error instanceof Error && error.message === `ACode Protocol request timed out: ${method}`;
}

function assertV4AttachmentNdjsonEnvelope(method: string, params: unknown): void {
  // 实际 CLI request id 是递增整数；这里用更宽的 32-char id 做保守 exact-JSON meter。
  const bytes = utf8JsonByteLength({ id: "9".repeat(32), method, params }) + 1; // NDJSON newline
  if (bytes > PROTOCOL_V4_LIMITS.maxFrameBytes) {
    throw new Error("proto.frameTooLarge");
  }
}

function buildSessionSendParams(
  params: ACodeAgentSendPromptParams,
  omittedFields: ReadonlySet<SessionSendCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    // 执行身份/约束不是可忽略的兼容字段；旧 Worker 不支持时必须失败，不能静默剥掉。
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
    inputId: params.inputId,
    queryId: params.queryId,
    content: params.content,
    attachments: params.attachments,
    ...(params.browserAmbientContext !== undefined && !omittedFields.has("browserAmbientContext")
      ? { browserAmbientContext: params.browserAmbientContext }
      : {}),
    expectedRevision: params.expectedRevision,
    expectedProviderRevision: params.expectedProviderRevision,
    ...(params.automationId !== undefined && !omittedFields.has("automationId")
      ? { automationId: params.automationId }
      : {}),
    ...(params.offPeakTaskId !== undefined && !omittedFields.has("offPeakTaskId")
      ? { offPeakTaskId: params.offPeakTaskId }
      : {}),
    ...(params.offPeakRunType !== undefined && !omittedFields.has("offPeakRunType")
      ? { offPeakRunType: params.offPeakRunType }
      : {}),
    ...(params.botDeliveryTarget !== undefined && !omittedFields.has("botDeliveryTarget")
      ? { botDeliveryTarget: params.botDeliveryTarget }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
  };
}

// ── M2-2：legacy session/goal 回执文案的逐字等价物（旧 CLI op 已删，facade 承担格式化）──
// 字符串与旧 server-operations.ts formatGoalSummary/formatGoalChanged 一致。wire goal
// （acodeSessionGoalSchema）的 tokensUsed/tokenBudget/timeUsedSeconds 恒定义，故
// Usage/Time 两行恒在（旧 ProtocolGoalTarget 可选字段经 mapSessionGoal 补 0 后同形）。
const GOAL_PLAN_CONTINUATION_SKIPPED_MESSAGE = "Plan mode 下已记录 goal，但不会自动继续。";

function formatGoalChangedText(title: string, target: ACodeSessionGoal): string {
  const lines = [title, `Objective: ${target.objective}`];
  const budget = target.tokenBudget === null ? "none" : target.tokenBudget.toString();
  lines.push(`Usage: ${target.tokensUsed} tokens / ${budget}`);
  lines.push(`Time: ${target.timeUsedSeconds} seconds`);
  return lines.join("\n");
}

function formatGoalSummaryText(target: ACodeSessionGoal | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }
  return formatGoalChangedText(`Goal ${target.status}`, target);
}

function formatModelSelectionForLog(ref: ModelSelection | undefined): string | null {
  if (!ref) {
    return null;
  }

  const base = `${ref.providerId}/${ref.modelId}`;
  const reasoningLevel = ref.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ACODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

function sessionEventKey(params: ACodeAgentSessionTarget): string {
  return `${resolveWorkspaceKey(params)}\u0000${params.sessionId}`;
}

function rememberBoundedEventId(ids: Set<string>, order: string[], eventId: string): boolean {
  if (ids.has(eventId)) {
    return false;
  }
  ids.add(eventId);
  order.push(eventId);
  while (order.length > MAX_TRACKED_SESSION_EVENT_IDS) {
    const removed = order.shift();
    if (removed) {
      ids.delete(removed);
    }
  }
  return true;
}

function permissionRequestKey(params: ACodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function userInputRequestKey(params: ACodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function providerRuntimeHeadersRequestKey(
  params: ACodeAgentSessionTarget & { requestId: string },
): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

/**
 * 进程级 Provider Registry 的只读选择投影。
 *
 * 本地 Worker 自己持有完整 Registry；Host 只用这份投影判断模型执行是否可以启动，
 * 不能再把它扩张成 runtimeModel 并覆盖 Worker 的执行事实源。
 */
interface ModelSelectionReadinessSource {
  getView(): Promise<ModelSelectionView>;
  onDidChange?: (listener: (view: ModelSelectionView) => void) => IDisposable;
}

interface ACodeAgentProviderReadinessSnapshot {
  readonly providerCount: number;
  readonly revision: string;
  readonly readiness: {
    readonly ready: boolean;
    readonly providerId?: string;
    readonly modelId?: string;
  };
}

function createProviderReadinessSnapshotFromSelectionView(
  view: ModelSelectionView,
): ACodeAgentProviderReadinessSnapshot {
  for (const provider of view.providers) {
    const model = provider.models[0];
    if (!model) continue;
    return {
      providerCount: view.providers.length,
      revision: `model-selection:${view.revision}`,
      readiness: {
        ready: true,
        providerId: provider.providerId,
        modelId: model.modelId,
      },
    };
  }
  return {
    providerCount: view.providers.length,
    revision: `model-selection:${view.revision}`,
    readiness: { ready: false },
  };
}

interface WaitingWorkspaceStartup {
  cancelled: boolean;
  lastLoggedRevision?: string;
  workspace: ACodeAgentWorkspaceTarget;
}

interface ActiveWorkspaceClient {
  client: ACodeProtocolClient;
  interactionPreferencesReady?: Promise<void>;
  /**
   * 只记录该进程生命周期内是否曾通过 provider/model 启动门禁。
   * 只读 topic 可以先启动 CLI，但不能因此让后续 create/command 绕过门禁。
   */
  modelExecutionEnabled: boolean;
  workspace: ACodeAgentWorkspaceTarget;
}

function createRuntimeUnavailableError(params: ACodeAgentWorkspaceTarget): Error & {
  code: typeof ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  workspaceKey: string;
} {
  const error = new Error("ACode Agent runtime is not running.") as Error & {
    code: typeof ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
    workspaceKey: string;
  };
  error.code = ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  error.workspaceKey = resolveWorkspaceKey(params);
  return error;
}

interface CreateACodeAgentServiceOptions extends Omit<
  ACodeAgentProcessManagerOptions,
  // 两个空闲回收面都不许外部调用方直接配置:Host 侧 idleTimeoutMs 只属于 mcp-status
  // 探测 lane;CLI 侧空闲自退(spec: chat-lane-idle-reclaim.md)只对 chat lane 生效,
  // plugin/mcp-status 由本文件内部显式关闭(R8)。
  "idleTimeoutMs" | "disableCliIdleExit"
> {
  /** 仅供 MCP 状态探测进程使用，不能把空闲回收传给 chat。 */
  mcpStatusIdleTimeoutMs?: number;
  accountProviderConfigSource?: ProviderSource<AccountProviderConfigSnapshot>;
  accountRequestAuthService?: IAccountRequestAuthService;
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  modelSelectionReadinessSource?: ModelSelectionReadinessSource;
  sessionRuntimePreferencesAuthority?: "local" | "external";
  resolveSessionRuntimePreferences?: (
    scope: ACodeSessionRuntimePreferencesScope,
  ) => Promise<ACodeSessionRuntimePreferencesResult>;
  /** manual run 落库后由当前 host 直接派发；返回时 prompt 必须已被 session 接受。 */
  onAutomationManualRunRequested?: (params: {
    automation: ACodeAutomation;
    run: ACodeAutomationRun;
  }) => Promise<void>;
  /**
   * 手动触发的调用来源（specs/scheduled-manual-trigger-activation.md R3）：装配层按
   * **传输事实**声明（desktop 本地 IPC 装 "local_ui"，远程 channel 装 "remote"），
   * 禁止做成 wire 入参让调用方自报。缺席 = 兼容窗（trigger 不组装，既有调用方形状），
   * 但垃圾凭据在任何 origin 下都拒（shared 守卫 R5）。按传输分装的接线（host 命令
   * 路由/relay 面）属后续批次，见 spec「不在本项范围」。
   */
  automationManualTriggerOrigin?: AutomationManualTriggerOrigin;
  /**
   * Off-Peak 会话内创建。config 同时承担曝光门（enabled && Selection View 非空 →
   * session create/resume 下发 offPeakToolEnabled）与缺省解析（model=白名单末位 /
   * thoughtLevel=最高档）；service 供 offPeak/create、offPeak/list 协议 handler 调用。
   * 两者任一缺省即整体关闭（纯 CLI / desktop-attached-remote 装配不传）。
   */
  resolveOffPeakClientConfig?: () => Promise<OffPeakClientConfig | undefined>;
  /**
   * 动态工作流灰度快照。Host 是唯一裁决者：
   * 结果既作为 workspace 级事实下发给 CLI，也决定 session create/resume/v4 是否带
   * dynamicWorkflowEnabled。缺省不传（纯 CLI 装配）= 永远关闭，与 CLI 缺省一致。
   */
  resolveDynamicWorkflowClientConfig?: () => Promise<DynamicWorkflowClientConfig | undefined>;
  /**
   * 脚本工作流三档的唯一折叠出口（node.ts resolveScriptWorkflowModeWithLocalOverride）。
   * 缺省不传（纯 CLI 装配）= 会话门按 enabled=true 处理（缺席=本机缺省档 onDemand，开）。
   */
  resolveScriptWorkflowMode?: () => Promise<ScriptWorkflowMode>;
  /**
   * 工具按需检索三档的唯一折叠出口（node.ts resolveToolSearchModeFromSettings，
   * specs/tool-search.md R11）。缺省不传（纯 CLI 装配）= 会话门不写字段
   * （缺席 = off，零行为变化红线）；传入时每次 v4 createSession 现读（不 memoize，
   * 无会话中途改档通道），读取异常按 off + warn（与 node.ts 折叠出口双层兜底）。
   */
  resolveToolSearchMode?: () => Promise<ToolSearchAppMode>;
  resolveOffPeakTaskService?: () =>
    | Pick<IOffPeakTaskService, "createTask" | "list" | "getCodingPlanSupport">
    | undefined;
  /**
   * browser-use 执行桥：把 agent 的 interaction/browserExecute 反向请求转发到 main
   * （WebContentsView+CDP）。desktop host 装配时注入；缺省（纯 CLI/远控无 main）则
   * browser 命令返回 backend_unavailable，不影响其它功能。
   */
  browserControlExecutor?: BrowserAmbientContextExecutor;
  /**
   * 官方 Server MCP 身份头解析器。Agent 进程不持有用户身份权威，
   * 经 interaction/requestOfficialMcpAuthHeaders 向 host 索取本次请求的身份头。
   *
   * 缺省时该请求一律返回 official_auth_unavailable，绝不降级为匿名请求——
   * 例如 standalone CLI 没有 host auth port 的场景。
   */
  officialMcpAuthHeadersResolver?: {
    resolveHeaders(request: {
      mcpKey: string;
      pluginId: string;
      targetOrigin: string;
      workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
    }): Promise<
      | { ok: true; headers: Record<string, string> }
      | { ok: false; reason: "official_auth_unavailable" | "official_auth_plan_required" }
    >;
  };
  /**
   * 官方 MCP 可信 Origin 校验器。**host 是身份权威边界**，因此
   * targetOrigin 的校验必须在这里执行，不能只依赖 agent adapter 的 fetch wrapper——那等于让
   * 被审查方自己当审查者。desktop-attached remote 场景下 agent 跑在远端而 host 持有本地用户身份。
   *
   * 此校验约束凭据请求的目标 origin，不提供逐插件权限控制。
   * HTTP 鉴权由宿主 fetch wrapper 注入，stdio 鉴权会将凭据交给插件进程；后者
   * 必须按受信任的可执行代码管理。服务端仍须校验每次调用的身份、权限和配额。
   *
   * 缺省时一律拒绝（fail closed），不退化为"只做 schema 校验就发凭据"。
   */
  officialMcpTrustedOrigins?: {
    isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
      detail?: string;
      trusted: boolean;
    }>;
  };
  /** desktop-local Host 注入；只消费已校验、已去重的 live session event。 */
  cuaOperationStateReporter?: CuaOperationStateReporter;
  onCuaPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
}

function toProtocolAutomation(automation: ACodeAutomation) {
  return {
    automationId: automation.automationId,
    title: automation.title,
    cronExpr: automation.cronExpr,
    prompt: automation.prompt,
    modelSelection: automation.modelSelection,
    mode: automation.mode,
    targetTaskId: automation.targetTaskId,
    enabled: automation.enabled,
    lifecycleStatus: automation.lifecycleStatus,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    runCount: automation.runCount,
    recurring: automation.recurring,
    maxRuns: automation.maxRuns,
    // 透传权威 scheduleRule；会话卡片必须读到本字段才能展示 cron 无法表达的真实间隔
    // （如每50小时、每40天），否则只能从兼容 cronExpr 推断出「每小时的第00分」等错误展示。
    scheduleRule: automation.scheduleRule,
  };
}

function toProtocolOffPeakTaskSnapshot(task: {
  offPeakTaskId: string;
  title: string;
  status: "queued" | "paused" | "running" | "completed" | "failed" | "cancelled";
  queuePosition?: number;
  sessionId?: string;
  createdAt: number;
}) {
  // 协议最小面：不暴露 serverTicketId / providerName / workspace 细节。
  return {
    offPeakTaskId: task.offPeakTaskId,
    title: task.title,
    status: task.status,
    ...(typeof task.queuePosition === "number" && task.queuePosition > 0
      ? { queuePosition: task.queuePosition }
      : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    createdAt: task.createdAt,
  };
}

const OFF_PEAK_INTERNAL_ERROR_CODE = "offpeak_internal_error";
const OFF_PEAK_INTERNAL_ERROR_MESSAGE = "Internal off-peak service error";

/**
 * offPeak/create、offPeak/list 的兜底 catch 不得把跨层异常文本（SQLite/文件路径/
 * 上游响应片段）原样回传协议——它会进入 CLI 日志与模型可见错误。原始错误只进服务端日志，
 * 对外固定稳定错误码 + 通用文案；业务失败分类仍走 respond({ok:false}) 不经此处。
 */
async function respondOffPeakInternalError(
  client: Pick<ACodeProtocolClient, "respondError">,
  request: { id: ACodeProtocolRequestId; method: string },
  workspace: ACodeAgentWorkspaceTarget,
  error: unknown,
): Promise<void> {
  logger.warn(undefined, "Off-peak 协议请求处理失败", {
    method: request.method,
    workspaceKey: resolveWorkspaceKey(workspace),
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  await client.respondError(request.id, {
    code: -32603,
    message: OFF_PEAK_INTERNAL_ERROR_MESSAGE,
    data: { errorCode: OFF_PEAK_INTERNAL_ERROR_CODE },
  });
}

/** 只有灰度有效开启且白名单非空才算"可创建"；其余一律视为关闭（空数组）。 */
function resolveOffPeakAllowedModels(
  grayConfig: OffPeakClientConfig | undefined,
  providerId?: string,
): readonly string[] {
  if (grayConfig?.enabled !== true) return [];
  return grayConfig.modelSelectionView.providers
    .filter((provider) => providerId === undefined || provider.providerId === providerId)
    .flatMap((provider) => provider.models.map((model) => model.modelId));
}

/**
 * model 解析：省略 → 白名单末位（服务端顺序末位≈最新最强）；显式 → trim + 大小写不敏感匹配，
 * 命中返回白名单原写法，未命中返回 null（调用方回 model_not_allowed）。
 */
function resolveOffPeakCreateModel(
  allowedModels: readonly string[],
  requested: string | undefined,
): string | null {
  const wanted = requested?.trim();
  if (!wanted) return allowedModels[allowedModels.length - 1] ?? null;
  const lower = wanted.toLowerCase();
  return allowedModels.find((model) => model.trim().toLowerCase() === lower) ?? null;
}

/**
 * 新工具任务复用公共最高档补全；旧 metadata/型号特判会偏离 values 的语义顺序。
 * 显式档位留给 createTask 的现有校验，不在入口擅自换档。
 */
function resolveOffPeakToolSelection(
  view: ModelSelectionView,
  providerId: string,
  modelId: string,
  thoughtLevel?: string,
): ModelSelection | undefined {
  const selection = completeNewModelSelection(view, { providerId, modelId });
  if (!selection) return undefined;
  return thoughtLevel === undefined
    ? selection
    : { ...selection, options: { reasoningLevel: thoughtLevel } };
}
export function createACodeAgentService(
  options?: CreateACodeAgentServiceOptions,
): IACodeAgentService & { disposeAllAndWait(): Promise<void> } {
  const processManager = new ACodeAgentProcessManager(options);
  // Windows indicator 与 macOS producer lifecycle client 共用已校验、去重的 sideband facts。
  const cuaOperationTurnTracker =
    options?.cuaOperationStateReporter || options?.onCuaPipSessionLifecycle
      ? createCuaOperationTurnTracker({
          ...(options?.cuaOperationStateReporter
            ? { reporter: options.cuaOperationStateReporter }
            : {}),
          ...(options?.onCuaPipSessionLifecycle
            ? { onPipSessionLifecycle: options.onCuaPipSessionLifecycle }
            : {}),
          logger: {
            debug: (message) => cuaOperationLogger.debug(undefined, message),
            info: (message) => cuaOperationLogger.info(undefined, message),
            warn: (message) => cuaOperationLogger.warn(undefined, message),
          },
        })
      : undefined;
  // AutomationRepo 也持有 tasks-index.sqlite 连接，disposeAll 需一并收口（见下方 disposeAll 注释）
  const automationRepo = new AutomationRepo();
  const automationService = new AutomationService(automationRepo);
  const automationTaskIndexRepo = new TaskIndexRepo();
  const pluginProcessManager = new ACodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
    // plugin lane 维持现状不回收(spec: chat-lane-idle-reclaim.md R8)。
    disableCliIdleExit: true,
  });
  // 合并时误删了独立进程：mcp/list 的慢握手会堵住串行 stdio 队列，连带卡住插件卸载。
  // 恢复专用控制面进程及空闲回收；共享 workspace 路径，不共享请求队列或 watchdog。
  const mcpStatusProcessManager = new ACodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    processLifecycleReporter: options?.processLifecycleReporter,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
    lane: "mcp-status",
    idleTimeoutMs: options?.mcpStatusIdleTimeoutMs ?? MCP_STATUS_LANE_IDLE_TIMEOUT_MS,
    // 空闲回收单一所有者:该 lane 已由 Host 侧 idleTimeoutMs 管理,不叠加 CLI 自退。
    disableCliIdleExit: true,
  });
  const sessionEmitters = new Map<string, Emitter<ACodeAgentServiceEvent>>();
  /**
   * 已经记过"首次发放官方身份头"审计日志的 (pluginId, mcpKey, workspaceKey)。
   *
   * 存在理由：成功路径不能只记 debug——生产构建的最低级别是 Info，事后无法回答
   * "凭据被哪个插件取走过"。但每次 initialize / tools\_list / tools\_call 都会触发一次发放，
   * 全量记 info 就是消息量级的日志膨胀。折中：每个三元组只在本进程内首次发放时记一条 info，
   * 之后仍走 debug。审计线索到"哪个插件、哪个 workspace、什么时候第一次拿"这个粒度。
   */
  const officialMcpIssuanceAudit = createOfficialMcpIssuanceAudit();
  function cancelProviderRuntimeHeaders(
    key: string,
    pending: PendingProviderRuntimeHeadersRequest,
  ): void {
    pendingProviderRuntimeHeaders.delete(key);
    const { requestId, sessionId, workspace } = pending.request;
    logger.info(undefined, "Provider runtime headers 请求已取消", {
      requestId,
      sessionId,
      workspaceKey: resolveWorkspaceKey(workspace),
    });
  }
  const sessionRuntimePreferencesRequestEmitter =
    new Emitter<ACodeAgentSessionRuntimePreferencesRequest>();
  const processResourceSampleEmitter = new Emitter<AgentLaneResourceSample>();
  const toolExecResourceEmitter = new Emitter<ACodeToolExecResource>();
  const mcpResourceSamplesEmitter = new Emitter<ACodeMcpResourceSample[]>();
  const mcpTelemetryEmitter = new Emitter<ACodeMcpTelemetryEvent>();
  const pluginOperationProgressEmitters = new Map<
    string,
    Emitter<ACodePluginOperationProgressNotification>
  >();
  // v4 conversation 帧 fan-out：workspace 级 emitter，renderer 侧按 topic 自行路由。
  const conversationFrameEmitters = new Map<string, Emitter<ConversationTopicWireCandidate>>();
  const conversationTelemetryFactEmitters = new Map<string, Emitter<ConversationTelemetryFact>>();
  const cuaPermissionObservationEmitter = new Emitter<ACodeAgentCuaPermissionObservation>();
  // v4 networkCaptureRecords（agent→host，仅 live）的进程级 fan-out；
  // 消费者是 desktop main 的 sink（资源管理器 network tab），不进任何 session/conversation 状态。
  const networkCaptureRecordsEmitter = new Emitter<V4NetworkCaptureRecordsNotification>();
  // v4 overnightCompletion（agent→host，仅 live）的进程级 fan-out（specs/overnight-completion-notify.md §7）；
  // 消费者是 desktop host 的转发器，它原样镜像成 HostResponseTypes.OvernightCompletionNotify 给 main。
  // 与 networkCaptureRecords 同款：不进任何 session/conversation 状态，不落 host、不缓存、不去重。
  const overnightCompletionEmitter = new Emitter<V4OvernightCompletionNotification>();
  // sessions-index 帧 fan-out：与 conversation 同一 conversationFrame 通知，按 topic 前缀分流到此 emitter。
  const sessionsIndexFrameEmitters = new Map<string, Emitter<SessionsIndexTopicWireCandidate>>();
  // workspace-config 帧 fan-out：配置目录活性（task-index syncer 消费），同一通知按前缀分流。
  const workspaceConfigFrameEmitters = new Map<
    string,
    Emitter<WorkspaceConfigTopicWireCandidate>
  >();
  // v4 订阅替换按 (connectionId, topic) 判定；每个 host process 服务一个
  // renderer 窗口，一个稳定 connectionId 即可让重订阅天然替换旧订阅。
  const v4ConnectionId = `host-${randomUUID()}`;
  interface V4SubscriptionRoute {
    workspaceKey: string;
    topic: string;
    subscriptionId: string;
    connectionId: string;
  }
  const v4SubscriptionRoutes = new Map<string, V4SubscriptionRoute>();
  const v4RouteKeyByOwnership = new Map<string, string>();
  const v4RouteRuntimeRestartDisposable = processManager.onRuntimeRestarted(({ workspaceKey }) => {
    clearV4SubscriptionRoutes(workspaceKey);
    cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
  });
  const sessionEventSequenceStates = new Map<string, SessionEventSequenceState>();
  const wiredClients = new WeakSet<ACodeProtocolClient>();
  const clientDisposables = new WeakMap<ACodeProtocolClient, IDisposable[]>();
  const pendingPermissions = new Map<string, PendingPermissionRequest>();
  const pendingUserInputs = new Map<string, PendingPermissionRequest>();
  // 内存诊断计数器：只读各 per-session 镜像表的 size。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("agent", () => ({
    sessionEmitters: sessionEmitters.size,
    seqStates: sessionEventSequenceStates.size,
    pendingPermissions: pendingPermissions.size,
    pendingUserInputs: pendingUserInputs.size,
  }));
  const pendingProviderRuntimeHeaders = new Map<string, PendingProviderRuntimeHeadersRequest>();
  const pendingSessionRuntimePreferences = new Map<
    string,
    PendingSessionRuntimePreferencesRequest
  >();
  const activeClientsByWorkspaceKey = new Map<string, ActiveWorkspaceClient>();
  // 网络观测开关的 host 进程级 wire 状态：RM 开关的产品语义是「观测本 host 的 agent」，
  // 而 v4 命令按 workspace 路由只到一个 agent；这里记住 wire 参数，开启时循环补发既有
  // client，新 workspace client 入池时再补发一次（2026-10-11 实机：按需 spawn 的
  // workspace agent 永远收不到 setEnabled，Network tab 恒空）。
  let networkCaptureWireState: { enabled: true; captureId: string } | null = null;
  /** 补发观测开关到单个 agent client；尽力而为，失败不影响目标 workspace 的开关响应。 */
  function pushNetworkCaptureWire(
    client: ACodeProtocolClient,
    wire: { enabled: boolean; captureId: string },
  ): void {
    client
      .request(
        V4_METHODS.networkCaptureSetEnabled,
        v4NetworkCaptureSetEnabledParamsSchema.parse(wire),
        v4NetworkCaptureSetEnabledResultSchema,
      )
      .catch(() => {
        // 单个 agent 补发失败静默：观测是尽力而为的 live 面。
      });
  }
  const interactionPreferenceSyncByWorkspaceKey = new Map<string, Promise<void>>();
  let latestAppRuntimePreferences: ACodeAgentAppRuntimePreferences | undefined;
  /** 动态工作流灰度门的进程内单次判定；见 resolveDynamicWorkflowGate 的注释。 */
  let dynamicWorkflowGate: Promise<boolean> | undefined;
  const waitingWorkspaceStartups = new Map<string, WaitingWorkspaceStartup>();
  function cancelWaitingWorkspaceStartup(workspaceKey: string): void {
    const waiting = waitingWorkspaceStartups.get(workspaceKey);
    if (waiting) {
      waiting.cancelled = true;
      waitingWorkspaceStartups.delete(workspaceKey);
    }
  }
  function cancelAllWaitingWorkspaceStartups(): void {
    for (const waiting of waitingWorkspaceStartups.values()) {
      waiting.cancelled = true;
    }
    waitingWorkspaceStartups.clear();
  }
  const accountConfigSyncByClient = new WeakMap<ACodeProtocolClient, Promise<void>>();
  // 此缓存只去重已交付的账号快照，不表示 Worker 的 Registry 已应用该版本。
  const accountConfigReceivedRevisionByClient = new WeakMap<ACodeProtocolClient, string>();
  const sessionTraceIdBySessionKey = new Map<string, TraceId>();
  const accountRequestAuthService = options?.accountRequestAuthService;
  const accountProviderConfigSource = options?.accountProviderConfigSource;
  const modelSelectionReadinessSource = options?.modelSelectionReadinessSource;
  const sessionRuntimePreferencesAuthority = options?.sessionRuntimePreferencesAuthority ?? "local";
  const resolveSessionRuntimePreferences = options?.resolveSessionRuntimePreferences;

  function invalidateWorkspaceClient(workspaceKey: string, client: ACodeProtocolClient): void {
    for (const [key, pending] of pendingPermissions) {
      if (pending.client === client) {
        pendingPermissions.delete(key);
      }
    }
    for (const [key, pending] of pendingUserInputs) {
      if (pending.client === client) {
        pendingUserInputs.delete(key);
      }
    }
    for (const [key, pending] of pendingProviderRuntimeHeaders) {
      if (pending.client === client) {
        cancelProviderRuntimeHeaders(key, pending);
      }
    }
    for (const [key, pending] of pendingSessionRuntimePreferences) {
      if (pending.client === client) {
        clearTimeout(pending.timeout);
        pendingSessionRuntimePreferences.delete(key);
        // M2-3：client 断连时在途解析快速失败（push 目标已死），push 帮助器捕获后跳过。
        pending.reject(new Error("ACode Protocol client disconnected"));
      }
    }
    for (const disposable of clientDisposables.get(client) ?? []) {
      disposable.dispose();
    }
    clientDisposables.delete(client);

    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.client !== client) {
      // Runtime lifecycle 事件可能与下一代启动交错；旧 client 的迟到清理只能释放
      // 自身绑定，绝不能删除同 workspace 已登记的新 client 与新 runtime 状态。
      return;
    }
    activeClientsByWorkspaceKey.delete(workspaceKey);
    // Interaction preference 是 CLI 进程内存态；runtime 换代后即使 app revision
    // 未变化也必须重新同步，不能沿用旧 client 的完成 Promise。
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
  }

  const runtimeLifecycleDisposable = processManager.onRuntimeLifecycle((event) => {
    if (event.state !== "unavailable") return;
    // 协议关闭、进程崩溃或请求超时时，runtime 可能不会再发送 turn-failed/
    // session-closed，也不一定能成功启动下一代 runtime。必须在 unavailable 这个权威
    // 生命周期边界清掉 CUA tracker，否则 Windows 顶部提示和 Helper 恢复门控会永久残留。
    cuaOperationTurnTracker?.clearWorkspaceKey(event.workspaceKey);
    const active = activeClientsByWorkspaceKey.get(event.workspaceKey);
    if (!active) return;
    // Process manager 只会为当前 available runtime 发布 unavailable；这里再绑定当前
    // active client 做第二层 identity guard，避免旧 runtime 的迟到回收误伤换代结果。
    invalidateWorkspaceClient(event.workspaceKey, active.client);
  });

  async function resolveAccountRequestAuth(
    request: V4InteractionRequestProviderRuntimeHeadersParams,
  ): Promise<AccountRequestAuthMaterial | undefined> {
    if (!request.accountAccess || !accountRequestAuthService) {
      return undefined;
    }
    return accountRequestAuthService.resolveCurrent({
      providerId: request.providerId,
      modelId: request.modelSelection.modelId,
      accountAccess: request.accountAccess,
      reason: request.reason,
    });
  }

  async function respondAccountRequestAuthWithoutInteraction(params: {
    key: string;
    pending: PendingProviderRuntimeHeadersRequest;
  }): Promise<void> {
    params.pending.responding = true;
    try {
      const requestAuth = await resolveAccountRequestAuth(params.pending.request);
      // 账号解析是异步 IO；取消/进程退出后不能把迟到材料发给已撤销的请求。
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      if (!requestAuth) {
        throw new Error("Account request auth resolver returned no material");
      }
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: true,
        requestAuth,
      });
      logger.info(undefined, "ACode provider runtime headers 已应用", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
    } catch (error) {
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      logger.warn(undefined, "ACode provider runtime headers 应用失败", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        error: error instanceof Error ? error.message : String(error),
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (pendingProviderRuntimeHeaders.get(params.key) === params.pending) {
        pendingProviderRuntimeHeaders.delete(params.key);
      }
    }
  }

  function takePendingSessionRuntimePreferences(
    requestId: string,
  ): PendingSessionRuntimePreferencesRequest | undefined {
    const pending = pendingSessionRuntimePreferences.get(requestId);
    if (!pending) {
      return undefined;
    }
    pendingSessionRuntimePreferences.delete(requestId);
    clearTimeout(pending.timeout);
    return pending;
  }

  function expireSessionRuntimePreferencesRequest(requestId: string): void {
    const pending = takePendingSessionRuntimePreferences(requestId);
    if (!pending) {
      return;
    }
    // 远端 Host transport 仍存活但设置 responder 不返回时，旧 pending
    // 没有终止条件，会阻塞 Session 生命周期。超时只结束本次请求，不重试或降级。
    logger.warn(undefined, "运行时偏好请求等待 Host 响应超时", {
      event: "acode_agent.runtime_preferences.host_response_timeout",
      module: "services.acode_agent",
      requestId,
      scope: pending.request.scope,
      sessionId: pending.request.sessionId,
      timeoutMs: ACODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
      workspaceKey: pending.workspaceKey,
    });
    // M2-3：pending 不再承载 CLI respond 通道；超时改为 reject 内部 await，
    // pushSessionRuntimePreferences 捕获后跳过本次推送（CLI 沿用上次推送或缺省，
    // 与 legacy CLI 侧超时落缺省的值结论一致）。
    pending.reject(new Error("Session runtime preferences request timed out"));
  }

  /**
   * M2-3（specs/m2-3-session-readwrite.md §2.8）：外部权威（desktop-attached remote）的
   * 偏好经既有 emitter/pending 桥逐 scope 取回。sessionId 仅作诊断（desktop 桥只进日志）；
   * 物化时机外的连接预热推送没有会话，用占位串（schema 要求非空 string）。
   */
  function requestExternalSessionRuntimePreferences(
    client: ACodeProtocolClient,
    workspace: ACodeAgentWorkspaceTarget,
    scope: ACodeSessionRuntimePreferencesScope,
    sessionId?: string,
  ): Promise<ACodeSessionRuntimePreferencesResult> {
    const requestId = randomUUID();
    const dynamicRequest: ACodeAgentSessionRuntimePreferencesRequest = {
      sessionId: (sessionId ??
        "runtime-preferences-sync") as ACodeAgentSessionRuntimePreferencesRequest["sessionId"],
      scope,
      requestId,
    };
    const { promise, resolve, reject } =
      Promise.withResolvers<ACodeSessionRuntimePreferencesResult>();
    pendingSessionRuntimePreferences.set(requestId, {
      client,
      request: dynamicRequest,
      timeout: setTimeout(
        () => expireSessionRuntimePreferencesRequest(requestId),
        ACODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
      ),
      workspaceKey: resolveWorkspaceKey(workspace),
      resolve,
      reject,
    });
    logger.info(undefined, "运行时偏好请求已转发给 Host", {
      event: "acode_agent.runtime_preferences.host_request_dispatched",
      module: "services.acode_agent",
      requestId,
      scope: dynamicRequest.scope,
      sessionId: dynamicRequest.sessionId,
      workspaceKey: resolveWorkspaceKey(workspace),
    });
    sessionRuntimePreferencesRequestEmitter.fire(dynamicRequest);
    return promise;
  }

  /**
   * M2-3：legacy session/requestRuntimePreferences 是 CLI→host 的 per-materialization
   * pull；v4 面改为 host→CLI push（v4/session/runtimePreferences，CLI 落缓存后在
   * resolveSessionStartupPreferences 物化时机读取，cache miss 回落缺省）。触发点：
   * client 入池（冷恢复预热）、facade createSession/resumeSession 物化时机前。
   * 永不抛出：推送失败只记 warn，CLI 沿用上次推送或缺省值。
   */
  async function pushSessionRuntimePreferences(
    client: ACodeProtocolClient,
    workspace: ACodeAgentWorkspaceTarget,
    sessionId?: string,
  ): Promise<void> {
    try {
      // 两个 scope 各取所长后合并推送：materialization 承载三开关+预算策略，
      // user-execution 独占 integratedTerminalShell（同 legacy CLI compat 分支
      // 两次请求的合并结果）。
      let materialization: ACodeSessionRuntimePreferencesResult;
      let userExecution: ACodeSessionRuntimePreferencesResult;
      if (sessionRuntimePreferencesAuthority === "local") {
        materialization = acodeSessionRuntimePreferencesResultSchema.parse(
          (await resolveSessionRuntimePreferences?.("runtime-materialization")) ?? {
            askUserQuestionAutoResolutionEnabled: true,
            nativeSearchEnhancementsEnabled: true,
            memoryEnabled: false,
          },
        );
        userExecution = acodeSessionRuntimePreferencesResultSchema.parse(
          (await resolveSessionRuntimePreferences?.("user-execution")) ?? {},
        );
      } else {
        [materialization, userExecution] = await Promise.all([
          requestExternalSessionRuntimePreferences(
            client,
            workspace,
            "runtime-materialization",
            sessionId,
          ),
          requestExternalSessionRuntimePreferences(client, workspace, "user-execution", sessionId),
        ]);
      }
      const merged = {
        ...materialization,
        ...(userExecution.integratedTerminalShell !== undefined
          ? { integratedTerminalShell: userExecution.integratedTerminalShell }
          : {}),
      };
      await client.request(
        V4_METHODS.sessionRuntimePreferences,
        { preferences: merged },
        // 推送面是无返回值的承载（CLI handler 落缓存后回 {}）。
        v4SessionRuntimePreferencesResultSchema,
      );
      logger.debug(undefined, "运行时偏好已推送到 CLI", {
        event: "acode_agent.runtime_preferences.pushed",
        module: "services.acode_agent",
        sessionId: sessionId ?? null,
        workspaceKey: resolveWorkspaceKey(workspace),
      });
    } catch (error) {
      logger.warn(undefined, "运行时偏好推送失败，CLI 沿用上次推送或缺省值", {
        event: "acode_agent.runtime_preferences.push_failed",
        module: "services.acode_agent",
        errorMessage: error instanceof Error ? error.message : String(error),
        sessionId: sessionId ?? null,
        workspaceKey: resolveWorkspaceKey(workspace),
      });
    }
  }

  let modelSelectionSubscription = modelSelectionReadinessSource?.onDidChange?.((view) => {
    void handleProviderReadinessChanged({
      reason: "model_selection_changed",
      snapshot: createProviderReadinessSnapshotFromSelectionView(view),
    }).catch((error) => {
      logger.warn(undefined, "model selection readiness 热同步失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  let accountProviderConfigUnsubscribe = accountProviderConfigSource?.onDidChange((reason) => {
    void handleAccountProviderConfigChanged(reason).catch((error) => {
      logger.warn(undefined, "account provider config 热同步失败", {
        message: error instanceof Error ? error.message : String(error),
        reason,
      });
    });
  });

  async function syncAccountProviderConfigToClient(params: {
    client: ACodeProtocolClient;
    reason: string;
  }): Promise<void> {
    if (!accountProviderConfigSource) return;
    const previous = accountConfigSyncByClient.get(params.client) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // 前一次失败不能阻断后续较新的 Account Config；当前调用会重新尝试。
      })
      .then(async () => {
        // 排队前异步读取可能晚返回，把旧结果排在新结果之后。读取与交付
        // 共用现有 Client 串行队列；不新增发送屏障，也不按内容 revision 猜测时间先后。
        const snapshot = await accountProviderConfigSource.read();
        if (accountConfigReceivedRevisionByClient.get(params.client) === snapshot.revision) return;
        const result = await params.client.request(
          V4_METHODS.providerUpdateAccountConfig,
          {
            revision: snapshot.revision,
            basedOnACodeBuiltinRevision: snapshot.basedOnACodeBuiltinRevision,
            // Account 是运行时事实信封，不是磁盘 Provider 规则集合；保持原有协议字典。
            providers: Object.fromEntries(
              [...snapshot.providers.entries()].map(([providerId, config]) => [
                providerId,
                config.toJSON(),
              ]),
            ),
            states: snapshot.states ?? {},
          },
          v4ProviderUpdateAccountConfigResultSchema,
        );
        if (result.receivedRevision !== snapshot.revision) {
          throw new Error("Account Config 接收回执版本与交付版本不一致");
        }
        accountConfigReceivedRevisionByClient.set(params.client, result.receivedRevision);
        logger.info(undefined, "account provider config 已交付到 ACode agent", {
          providerCount: result.providerCount,
          reason: params.reason,
          receivedRevision: result.receivedRevision,
          status: result.status,
        });
      });
    accountConfigSyncByClient.set(params.client, current);
    try {
      await current;
    } finally {
      if (accountConfigSyncByClient.get(params.client) === current) {
        accountConfigSyncByClient.delete(params.client);
      }
    }
  }

  async function ensureAccountProviderConfigSynced(params: {
    client: ACodeProtocolClient;
    reason: string;
    workspace: ACodeAgentWorkspaceTarget;
  }): Promise<void> {
    await syncAccountProviderConfigToClient({
      client: params.client,
      reason: params.reason,
    });
  }

  async function handleAccountProviderConfigChanged(reason: string): Promise<void> {
    await Promise.all(
      Array.from(activeClientsByWorkspaceKey.values()).map(async (active) => {
        await syncAccountProviderConfigToClient({
          client: active.client,
          reason,
        });
      }),
    );
  }

  function enqueueInteractionPreferenceSync(params: {
    client: ACodeProtocolClient;
    preferences: ACodeAgentAppRuntimePreferences;
    workspace: ACodeAgentWorkspaceTarget;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const previous = interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // 前一次失败不能打乱之后开关提交的顺序；当前快照仍需继续尝试。
      })
      .then(async () => {
        await params.client.request(
          V4_METHODS.workspaceUpdateInteractionPreferences,
          {
            workspace: buildWorkspaceRef(params.workspace),
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                params.preferences.askUserQuestionAutoResolutionEnabled,
            },
          },
          v4WorkspaceUpdateInteractionPreferencesResultSchema,
        );
        try {
          await params.client.request(
            V4_METHODS.workspaceUpdateModelIoPreferences,
            {
              workspace: buildWorkspaceRef(params.workspace),
              preferences: {
                fullRetentionEnabled: params.preferences.modelIoFullRetentionEnabled === true,
              },
            },
            v4WorkspaceUpdateModelIoPreferencesResultSchema,
          );
        } catch (error) {
          // 新 Host 兼容尚未升级的 CLI：只有 method-not-found 可降级，其他同步失败仍需上抛。
          if (!isProtocolMethodNotFoundError(error)) throw error;
        }
      });
    interactionPreferenceSyncByWorkspaceKey.set(workspaceKey, current);
    void current.then(
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
    );
    return current;
  }

  async function handleProviderReadinessChanged(event: {
    reason: string;
    snapshot: ACodeAgentProviderReadinessSnapshot;
  }): Promise<void> {
    if (event.snapshot.readiness.ready) {
      await Promise.allSettled(
        Array.from(waitingWorkspaceStartups.entries()).map(async ([workspaceKey, waiting]) => {
          // provider-ready 事件会先快照 waiting 列表再异步启动；workspace 在
          // await 期间被移除后，旧快照仍会把已释放的 Agent 重新拉起。只允许当前
          // waiting identity 对应的 generation 继续，删除或换代后的回调必须失效。
          if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
            return;
          }
          const { workspace } = waiting;
          const client = await getClient(workspace);
          await ensureAccountProviderConfigSynced({
            client,
            reason: `startup_ready:${event.reason}`,
            workspace,
          });
          logger.info(undefined, "provider/model 就绪后已启动等待中的 ACode agent", {
            providerCount: event.snapshot.providerCount,
            reason: event.reason,
            revision: event.snapshot.revision,
            workspaceKey: resolveWorkspaceKey(workspace),
            workspacePath: workspace.workspacePath,
          });
        }),
      );
    }
  }

  function getSessionEmitter(params: ACodeAgentSessionTarget) {
    const key = sessionEventKey(params);
    const existing = sessionEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ACodeAgentServiceEvent>();
    sessionEmitters.set(key, created);
    return created;
  }

  function getPluginOperationProgressEmitter(operationId: string) {
    const existing = pluginOperationProgressEmitters.get(operationId);
    if (existing) return existing;
    let created: Emitter<ACodePluginOperationProgressNotification>;
    created = new Emitter({
      onDidRemoveLastListener: () => {
        if (pluginOperationProgressEmitters.get(operationId) !== created) return;
        pluginOperationProgressEmitters.delete(operationId);
        created.dispose();
      },
    });
    pluginOperationProgressEmitters.set(operationId, created);
    return created;
  }

  function getConversationFrameEmitter(workspace: ACodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ConversationTopicWireCandidate>();
    conversationFrameEmitters.set(key, created);
    return created;
  }

  function getConversationTelemetryFactEmitter(workspace: ACodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationTelemetryFactEmitters.get(key);
    if (existing) return existing;
    const created = new Emitter<ConversationTelemetryFact>();
    conversationTelemetryFactEmitters.set(key, created);
    return created;
  }

  function getSessionsIndexFrameEmitter(workspace: ACodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = sessionsIndexFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<SessionsIndexTopicWireCandidate>();
    sessionsIndexFrameEmitters.set(key, created);
    return created;
  }

  function getWorkspaceConfigFrameEmitter(workspace: ACodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = workspaceConfigFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<WorkspaceConfigTopicWireCandidate>();
    workspaceConfigFrameEmitters.set(key, created);
    return created;
  }

  /** v4 订阅 connectionId：同 host 进程内多个独立消费者（renderer/syncer）用 scope 后缀区分。 */
  function v4ConnectionIdFor(subscriberScope?: string): string {
    return subscriberScope ? `${v4ConnectionId}#${subscriberScope}` : v4ConnectionId;
  }

  function resolveV4Connection(
    params: unknown,
    fallbackConnectionId: string = v4ConnectionId,
  ): ACodeAgentV4ConnectionContext {
    return (
      readTrustedACodeAgentV4Connection(params) ?? {
        // 没有可信 carrier 就是宿主内部直调：按旧消费者订阅（整键 patch），不猜能力。
        connectionId: fallbackConnectionId,
        clientMode: "desktop-continuous" as const,
      }
    );
  }

  function v4SubscriptionRouteKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.subscriptionId}\0${route.connectionId}`;
  }

  function v4SubscriptionOwnershipKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.connectionId}`;
  }

  function rememberV4SubscriptionRoute(
    workspace: ACodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ): void {
    const route: V4SubscriptionRoute = {
      workspaceKey: resolveWorkspaceKey(workspace),
      topic,
      subscriptionId,
      connectionId,
    };
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    const previous = v4RouteKeyByOwnership.get(ownershipKey);
    if (previous) v4SubscriptionRoutes.delete(previous);
    const routeKey = v4SubscriptionRouteKey(route);
    v4RouteKeyByOwnership.set(ownershipKey, routeKey);
    v4SubscriptionRoutes.set(routeKey, route);
  }

  function forgetV4SubscriptionRoute(route: V4SubscriptionRoute): void {
    const routeKey = v4SubscriptionRouteKey(route);
    v4SubscriptionRoutes.delete(routeKey);
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    if (v4RouteKeyByOwnership.get(ownershipKey) === routeKey) {
      v4RouteKeyByOwnership.delete(ownershipKey);
    }
  }

  function isCurrentV4SubscriptionRoute(route: V4SubscriptionRoute): boolean {
    return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) === route;
  }

  function clearV4SubscriptionRoutes(workspaceKey?: string): void {
    for (const route of v4SubscriptionRoutes.values()) {
      if (workspaceKey !== undefined && route.workspaceKey !== workspaceKey) {
        continue;
      }
      forgetV4SubscriptionRoute(route);
    }
  }

  function resolveV4UnsubscribeRoute(
    params: ACodeAgentConversationUnsubscribeParams | ACodeAgentConversationResyncParams,
    topicPrefix: string,
  ): V4SubscriptionRoute | null {
    const expectedWorkspaceKey = resolveWorkspaceKey(params);
    const trusted = readTrustedACodeAgentV4UnsubscribeRoute(params);
    if (trusted) {
      if (!trusted.topic.startsWith(topicPrefix)) return null;
      const route: V4SubscriptionRoute = {
        workspaceKey: expectedWorkspaceKey,
        topic: trusted.topic,
        subscriptionId: params.subscriptionId,
        connectionId: trusted.connectionId,
      };
      return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) ?? null;
    }
    // base service 的内部直连消费者没有 facade carrier；只在 method topic 域内唯一
    // 命中时兼容，碰撞则拒绝猜测，更不能多 publisher 广播删除。
    const matches = [...v4SubscriptionRoutes.values()].filter(
      (route) =>
        route.workspaceKey === expectedWorkspaceKey &&
        route.subscriptionId === params.subscriptionId &&
        route.topic.startsWith(topicPrefix),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  async function unsubscribeV4Route(
    params: ACodeAgentConversationUnsubscribeParams,
    topicPrefix: string,
  ): Promise<void> {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) return;
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    // getReadOnlyClient 可能在 await 中拉起新 runtime；restart listener 已清旧 route，且新
    // runtime 可能复用相同 key/subId。必须以对象身份复核，不能拿局部旧 route 发给新 CLI。
    if (!isCurrentV4SubscriptionRoute(route)) return;
    await client.request(
      V4_METHODS.conversationUnsubscribe,
      {
        topic: route.topic,
        subscriptionId: route.subscriptionId,
        connectionId: route.connectionId,
      },
      acodeProtocolEmptyResultSchema,
    );
    // request 在途时 runtime restart/重订阅可用相同 route key 建立新对象；
    // 迟到旧 response 只能清理它自己的 generation，不能按复合 key 删除新 route。
    if (isCurrentV4SubscriptionRoute(route)) forgetV4SubscriptionRoute(route);
  }

  async function resyncV4Route(params: ACodeAgentConversationResyncParams, topicPrefix: string) {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) throw new Error("fault.subscription.notOwned");
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = await client.request(
      V4_METHODS.conversationResync,
      {
        topic: route.topic,
        connectionId: route.connectionId,
        subscriptionId: route.subscriptionId,
        base: params.base,
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      },
      v4ConversationResyncResultSchema,
    );
    // resync ACK 只对发起时的 route generation 有效。若 await 期间已 restart/重订阅，
    // 返回 stale success 会让 consumer 把旧 recovery 当作新 subscription 的恢复结果。
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    return result;
  }

  function emitSessionEvent(
    workspace: ACodeAgentWorkspaceTarget,
    sessionId: string,
    event: ACodeAgentServiceEvent,
  ): void {
    sessionEmitters.get(sessionEventKey({ ...workspace, sessionId }))?.fire(event);
  }

  function emitWorkspaceEvent(
    workspace: ACodeAgentWorkspaceTarget,
    event: ACodeAgentServiceEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    for (const [key, emitter] of sessionEmitters) {
      if (key.startsWith(`${workspaceKey}\u0000`)) {
        emitter.fire(event);
      }
    }
  }

  function getSessionEventSequenceState(
    workspace: ACodeAgentWorkspaceTarget,
    sessionId: string,
  ): SessionEventSequenceState {
    const key = sessionEventKey({ ...workspace, sessionId });
    const existing = sessionEventSequenceStates.get(key);
    if (existing) {
      return existing;
    }
    const created: SessionEventSequenceState = {
      assignedSeqByEventId: new Map<string, number>(),
      assignedSeqEventIds: [],
      liveEventIds: new Set<string>(),
      liveEventIdOrder: [],
      lastAssignedSeq: 0,
    };
    sessionEventSequenceStates.set(key, created);
    return created;
  }

  function normalizeSessionEventSeq(
    workspace: ACodeAgentWorkspaceTarget,
    event: ACodeSessionEvent,
  ): ACodeSessionEvent {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    if (event.seq > 0) {
      state.lastAssignedSeq = Math.max(state.lastAssignedSeq, event.seq);
      return event;
    }

    const assignedSeq = state.assignedSeqByEventId.get(event.eventId);
    if (assignedSeq !== undefined) {
      return { ...event, seq: assignedSeq };
    }

    const nextSeq = state.lastAssignedSeq + 1;
    state.lastAssignedSeq = nextSeq;
    state.assignedSeqByEventId.set(event.eventId, nextSeq);
    state.assignedSeqEventIds.push(event.eventId);
    while (state.assignedSeqEventIds.length > MAX_TRACKED_SESSION_EVENT_IDS) {
      const removed = state.assignedSeqEventIds.shift();
      if (removed) {
        state.assignedSeqByEventId.delete(removed);
      }
    }
    // 旧 agent live sink 会把 createSessionEvent 默认 seq=0 直接发给 app，
    // 而 replay/read 走 event store 后才补号。这里只做旧版本兼容；新 runtime 的顺序事实源仍是 event store。
    return { ...event, seq: nextSeq };
  }

  function shouldDeliverLiveSessionEvent(
    workspace: ACodeAgentWorkspaceTarget,
    event: ACodeSessionEvent,
  ): boolean {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    return rememberBoundedEventId(state.liveEventIds, state.liveEventIdOrder, event.eventId);
  }

  function handleSessionEvent(
    workspace: ACodeAgentWorkspaceTarget,
    event: ACodeSessionEvent,
  ): void {
    const normalizedEvent = normalizeSessionEventSeq(workspace, event);
    if (!shouldDeliverLiveSessionEvent(workspace, normalizedEvent)) {
      return;
    }
    emitSessionEvent(workspace, normalizedEvent.sessionId, {
      type: "session.event",
      event: normalizedEvent,
    });
  }

  function handleStateUpdated(
    workspace: ACodeAgentWorkspaceTarget,
    notification: ACodeStateUpdatedNotification,
  ): void {
    if (notification.sessionId) {
      emitSessionEvent(workspace, notification.sessionId, {
        type: "state.updated",
        notification,
      });
      return;
    }
    emitWorkspaceEvent(workspace, { type: "state.updated", notification });
  }

  function wireClient(
    client: ACodeProtocolClient,
    workspace: ACodeAgentWorkspaceTarget,
    /**
     * 该 client 所属的进程泳道。CLI 进程不知道自己被哪个进程管理器拉起，
     * 因此资源样本的 lane 只能在这里按调用方补齐。
     */
    lane: ProcessResourceCliLane,
  ): void {
    if (wiredClients.has(client)) {
      return;
    }
    wiredClients.add(client);

    // ── M2-4 交互面 inbound 核心（specs/m2-4-inbound-interaction.md）──
    // v4 与 legacy 两种 wire 形态解析成功后统一走这些核心，保证形态切换行为逐点等价。
    // 偏斜期结束后（M3）删除 legacy 分支即可，核心无需再动。

    function handleProviderRuntimeHeadersCancel(params: {
      requestId: string;
      sessionId: string;
      workspace: ACodeWorkspaceRef;
    }): void {
      if (resolveWorkspaceKey(params.workspace) !== resolveWorkspaceKey(workspace)) return;
      const key = providerRuntimeHeadersRequestKey({
        ...workspace,
        sessionId: params.sessionId,
        requestId: params.requestId,
      });
      const pending = pendingProviderRuntimeHeaders.get(key);
      // 旧 client 或同路径不同 identity 的取消不能删除新 runtime/其他工作区的请求。
      if (pending?.client === client) cancelProviderRuntimeHeaders(key, pending);
    }

    function acceptCuaOperationEventData(event: V4CuaOperationEvent): void {
      // v4 会话不会投影 legacy session/event，CUA 提示必须直接消费 runtime sideband，
      // 避免把两条独立事件流的 sequenceNumber/seq 混为同一顺序域。
      cuaOperationTurnTracker?.accept(workspace, event);
    }

    // announce 语义：只登记 + 广播，不 respond。v4 形态由分支侧立即回 `{}` ack；
    // legacy 形态保持原有"请求悬置、答案经 resolveInteraction 回流"语义。
    function registerPendingPermission(
      data: V4InteractionRequestPermissionParams,
      protocolRequestId: ACodeProtocolRequestId,
    ): void {
      const key = permissionRequestKey({
        ...workspace,
        sessionId: data.sessionId,
        requestId: data.requestId,
      });
      const wasPending = pendingPermissions.has(key);
      pendingPermissions.set(key, { client, protocolRequestId });
      if (!wasPending) {
        emitSessionEvent(workspace, data.sessionId, {
          type: "permission.request",
          request: data,
        });
      }
    }

    function registerPendingUserInput(
      data: V4InteractionRequestUserInputParams,
      protocolRequestId: ACodeProtocolRequestId,
    ): void {
      const key = userInputRequestKey({
        ...workspace,
        sessionId: data.sessionId,
        requestId: data.requestId,
      });
      const wasPending = pendingUserInputs.has(key);
      pendingUserInputs.set(key, { client, protocolRequestId });
      if (!wasPending) {
        // agent 为恢复丢失的 protocol id 会重发同一业务 requestId。
        // host 需要刷新可响应的 protocolRequestId，但不能重复广播给 UI，
        // 否则多问题 AskUserQuestion 会在用户翻到后续问题时被重置回第一页。
        emitSessionEvent(workspace, data.sessionId, {
          type: "userInput.request",
          request: data,
        });
      }
    }

    // 真 RPC：accountAccess 自动应答或快速失败，两条路径都必须响应请求。
    function handleProviderRuntimeHeadersRequest(
      data: V4InteractionRequestProviderRuntimeHeadersParams,
      protocolRequestId: ACodeProtocolRequestId,
      traceId?: TraceId,
    ): void {
      const pendingKey = providerRuntimeHeadersRequestKey({
        ...workspace,
        sessionId: data.sessionId,
        requestId: data.requestId,
      });
      const pending = { client, protocolRequestId, request: data };
      pendingProviderRuntimeHeaders.set(pendingKey, pending);
      logger.info(traceId, "收到 ACode provider runtime headers 请求", {
        modelId: data.modelSelection.modelId,
        providerId: data.providerId,
        requestId: data.requestId,
        sessionId: data.sessionId,
        turnId: data.turnId ?? null,
        workspaceKey: resolveWorkspaceKey(workspace),
        workspacePath: workspace.workspacePath,
      });
      const accountAccess = data.accountAccess;
      if (accountRequestAuthService && accountAccess) {
        // Account API Key / Team Runtime Key / Start Plan JWT 都不需要 Renderer 交互。
        // Host 按 Model 固定的 Account Access 自动应答，避免后台任务和无 pane 会话依赖 UI 订阅者。
        void respondAccountRequestAuthWithoutInteraction({
          key: pendingKey,
          pending,
        });
        return;
      }
      // 没有账号凭据解析器的请求无人应答只会滞留到 CLI 侧 180s 超时，直接快速失败。
      pendingProviderRuntimeHeaders.delete(pendingKey);
      void client.respond(protocolRequestId, {
        headersApplied: false,
        errorMessage: "Provider request auth is unavailable",
      });
    }

    // 官方 Server MCP 身份头：纯 RPC 中继，host 自动解析并响应。
    // 不 emitSessionEvent、不进 pending map——该请求没有 UI 语义，renderer 不参与。
    function handleOfficialMcpAuthHeadersRequest(
      data: V4InteractionRequestOfficialMcpAuthHeadersParams,
      protocolRequestId: ACodeProtocolRequestId,
      traceId?: TraceId,
    ): void {
      // host 侧二次校验必须发生在**读取凭据之前**：未命中即返回，resolveHeaders 不被调用，
      // 因此不会有任何凭据被读入内存。
      void (async () => {
        const trustedOrigins = options?.officialMcpTrustedOrigins;
        const trust = trustedOrigins
          ? await trustedOrigins
              .isTrusted({
                mcpKey: data.mcpKey,
                origin: data.targetOrigin,
                pluginId: data.pluginId,
              })
              // 判定自身异常也按不可信处理，绝不因为校验失败就放行。
              .catch(() => ({ detail: "validator_error", trusted: false }))
          : { detail: "validator_missing", trusted: false };
        if (!trust.trusted) {
          // 只记录非敏感的请求上下文；凭据未被读取，自然也无从泄露。
          logger.warn(traceId, "官方 MCP 身份头请求未通过 host 侧可信校验", {
            detail: trust.detail ?? "unknown",
            mcpKey: data.mcpKey,
            pluginId: data.pluginId,
            requestId: data.requestId,
            targetOrigin: data.targetOrigin,
            workspaceKey: data.workspace.workspaceKey,
          });
          void client.respond(protocolRequestId, {
            ok: false,
            reason: "official_mcp_origin_untrusted",
          });
          return;
        }
        const resolver = options?.officialMcpAuthHeadersResolver;
        if (!resolver) {
          void client.respond(protocolRequestId, {
            ok: false,
            reason: "official_auth_unavailable",
          });
          return;
        }
        try {
          const resolveStartedAt = Date.now();
          const result = await resolver.resolveHeaders({
            mcpKey: data.mcpKey,
            pluginId: data.pluginId,
            targetOrigin: data.targetOrigin,
            workspace: data.workspace,
          });
          // host 侧不能只在失败时留日志，成功路径完全静默会无法回答"到底发了哪几个头"。
          // 只记 header 名与套餐维度：凭证值绝不入日志（日志留存周期不受控）。
          if (result.ok) {
            const firstIssuance = officialMcpIssuanceAudit.markFirst(
              data.pluginId,
              data.mcpKey,
              data.workspace.workspaceKey,
            );
            const logIssuance = firstIssuance ? logger.info : logger.debug;
            logIssuance(traceId, "官方 MCP 身份头已解析", {
              firstIssuance,
              ...summarizeOfficialMcpIdentityHeaders(result.headers),
              mcpKey: data.mcpKey,
              pluginId: data.pluginId,
              requestId: data.requestId,
              resolveDurationMs: Date.now() - resolveStartedAt,
              targetOrigin: data.targetOrigin,
            });
          } else {
            logger.info(traceId, "官方 MCP 身份头不可用", {
              mcpKey: data.mcpKey,
              pluginId: data.pluginId,
              reason: result.reason,
              requestId: data.requestId,
              resolveDurationMs: Date.now() - resolveStartedAt,
              targetOrigin: data.targetOrigin,
            });
          }
          void client.respond(protocolRequestId, result);
        } catch (error: unknown) {
          // 解析异常按不可用返回而非 respondError：adapter 只按可枚举 reason 分流，
          // 且此处绝不能让 MCP 退化成匿名请求。凭证原文不进日志。
          logger.warn(traceId, "官方 MCP 身份头解析失败", {
            error: error instanceof Error ? error.message : String(error),
            mcpKey: data.mcpKey,
            pluginId: data.pluginId,
            requestId: data.requestId,
            targetOrigin: data.targetOrigin,
          });
          void client.respond(protocolRequestId, {
            ok: false,
            reason: "official_auth_unavailable",
          });
        }
      })();
    }

    function handleBrowserListRequest(
      data: V4InteractionBrowserListParams,
      protocolRequestId: ACodeProtocolRequestId,
    ): void {
      const executor = options?.browserControlExecutor;
      if (!executor) {
        void client.respond(protocolRequestId, { browsers: [] });
        return;
      }
      void executor
        .list(data)
        .then((browsers) => client.respond(protocolRequestId, { browsers }))
        .catch((error: unknown) => {
          void client.respondError(protocolRequestId, {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }

    function handleBrowserExecuteRequest(
      data: V4InteractionBrowserExecuteParams,
      protocolRequestId: ACodeProtocolRequestId,
    ): void {
      const executor = options?.browserControlExecutor;
      if (!executor) {
        void client.respond(protocolRequestId, {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser control not available",
          },
          elapsedMs: 0,
        });
        return;
      }
      void executor
        .execute({
          requestId: data.requestId,
          ...(data.browserId ? { browserId: data.browserId } : {}),
          ...(data.browserGeneration !== undefined
            ? { browserGeneration: data.browserGeneration }
            : {}),
          sessionId: data.sessionId,
          ...(data.turnId ? { turnId: data.turnId } : {}),
          workspaceKey: data.workspaceKey ?? resolveWorkspaceKey(workspace),
          workspacePath: data.workspacePath ?? workspace.workspacePath,
          ...((data.workspaceIdentity ?? workspace.workspaceIdentity)
            ? { workspaceIdentity: data.workspaceIdentity ?? workspace.workspaceIdentity }
            : {}),
          ...(data.remoteSessionId ? { remoteSessionId: data.remoteSessionId } : {}),
          clientMode: data.clientMode ?? "desktop-continuous",
          sessionContext: data.sessionContext ?? "live",
          command: data.command,
        })
        .then((result) => client.respond(protocolRequestId, result))
        .catch((error: unknown) => {
          void client.respond(protocolRequestId, {
            ok: false,
            error: {
              code: "execution_error",
              message: error instanceof Error ? error.message : String(error),
            },
            elapsedMs: 0,
          });
        });
    }

    // M2-7（specs/m2-7-automation-offpeak.md §2.2）：automation/offPeak 七法核心助手。
    // v4 分支与偏斜期字面量 legacy 分支共用，语义与迁移前逐点不变；原分支体的逻辑只换位置、不改行为。
    function handleAutomationCreate(
      data: V4AutomationCreateParams,
      requestId: ACodeProtocolRequestId,
    ): void {
      void (async () => {
        try {
          const automation = await automationService.create({
            title: data.title ?? "",
            cronExpr: data.cronExpr,
            relativeDelayMinutes: data.relativeDelayMinutes,
            // 会话侧长间隔 carrier（intervalUnit+interval）透传给 service 归一化为权威 scheduleRule。
            intervalUnit: data.intervalUnit,
            interval: data.interval,
            prompt: data.prompt,
            modelSelection: data.modelSelection,
            mode: data.mode,
            targetTaskId: data.targetTaskId,
            botDeliveryTarget: data.botDeliveryTarget,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            recurring: data.recurring ?? true,
            maxRuns: data.maxRuns,
          });
          if (automation.targetTaskId) {
            const taskMeta = await automationTaskIndexRepo
              .getTaskMeta({
                workspacePath: automation.workspacePath,
                workspaceIdentity: automation.workspaceIdentity,
                taskId: automation.targetTaskId,
              })
              .catch(() => null);
            if (taskMeta) {
              await automationTaskIndexRepo.syncTaskMeta({
                meta: {
                  ...taskMeta,
                  // 会话内创建的 automation 复用当前 session；显式写入标记供 V4 侧栏展示。
                  cronAutomationId: automation.automationId,
                  updatedAt: Math.max(taskMeta.updatedAt, Date.now()),
                },
              });
            }
          }
          await client.respond(requestId, {
            automation: toProtocolAutomation(automation),
          });
        } catch (error) {
          await client.respondError(requestId, {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }

    function handleAutomationUpdate(
      data: V4AutomationUpdateParams,
      requestId: ACodeProtocolRequestId,
    ): void {
      void (async () => {
        try {
          const automation = await automationService.update(
            data.automationId,
            {
              title: data.title,
              cronExpr: data.cronExpr,
              prompt: data.prompt,
              recurring: data.recurring,
              maxRuns: data.maxRuns,
              // 会话侧长间隔 carrier（intervalUnit+interval）透传给 service 归一化为权威 scheduleRule。
              intervalUnit: data.intervalUnit,
              interval: data.interval,
            },
            workspace,
          );
          if (!automation) {
            throw new Error("Scheduled task not found in the current workspace.");
          }
          await client.respond(requestId, {
            automation: toProtocolAutomation(automation),
          });
        } catch (error) {
          await client.respondError(requestId, {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }

    function handleAutomationList(requestId: ACodeProtocolRequestId): void {
      void (async () => {
        try {
          const automations = await automationService.list(workspace);
          await client.respond(requestId, {
            automations: automations.map(toProtocolAutomation),
          });
        } catch (error) {
          await client.respondError(requestId, {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }

    function handleAutomationCheckTaskBinding(
      data: V4AutomationCheckTaskBindingParams,
      requestId: ACodeProtocolRequestId,
    ): void {
      void (async () => {
        try {
          const bound = await automationService.hasTaskBinding({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            targetTaskId: data.targetTaskId,
          });
          await client.respond(requestId, { bound });
        } catch (error) {
          await client.respondError(requestId, {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }

    function handleAutomationDelete(
      data: V4AutomationDeleteParams,
      requestId: ACodeProtocolRequestId,
    ): void {
      void (async () => {
        try {
          const deleted = await automationService.delete(data.automationId, workspace);
          await client.respond(requestId, { deleted });
        } catch (error) {
          await client.respondError(requestId, {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }

    function handleOffPeakCreate(
      data: V4OffPeakCreateParams,
      requestId: ACodeProtocolRequestId,
      method: string,
    ): void {
      void (async () => {
        try {
          const offPeakTaskService = options?.resolveOffPeakTaskService?.();
          if (!offPeakTaskService) {
            await client.respondError(requestId, {
              code: -32601,
              message: "Off-peak task service is unavailable on this host",
            });
            return;
          }
          const grayConfig = await options
            ?.resolveOffPeakClientConfig?.()
            .catch(() => undefined);
          // 工具注册后灰度被关闭/配置解析失败时，不能继续走"白名单为空"的推导
          // （显式 model 会误报 model_not_allowed，省略 model 会以空模型落库）；直接返回稳定分类。
          // 模型视图可同时包含两个域；必须用已有支持快照确认归属，不能从首个 Provider 猜。
          const support =
            resolveOffPeakAllowedModels(grayConfig).length > 0
              ? await offPeakTaskService.getCodingPlanSupport()
              : undefined;
          const providerId = support?.supported
            ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
            : undefined;
          const allowedModels = providerId
            ? resolveOffPeakAllowedModels(grayConfig, providerId)
            : [];
          if (allowedModels.length === 0) {
            await client.respond(requestId, {
              ok: false,
              failureStage: "client_validation",
              errorCategory: "client_validation",
              errorCode: "offpeak_disabled",
            });
            return;
          }
          // model 白名单预校：显式入参不在白名单返回稳定分类，
          // 复用 client_validation 分类 + 专用 errorCode，不扩分类枚举。
          // 匹配与 thoughtLevel/UI 同语义（trim + 大小写不敏感），命中后回写白名单原写法。
          const model = resolveOffPeakCreateModel(allowedModels, data.model);
          if (model === null) {
            await client.respond(requestId, {
              ok: false,
              failureStage: "client_validation",
              errorCategory: "client_validation",
              errorCode: "model_not_allowed",
            });
            return;
          }
          const modelSelection =
            grayConfig && providerId
              ? resolveOffPeakToolSelection(
                  grayConfig.modelSelectionView,
                  providerId,
                  model,
                  data.thoughtLevel,
                )
              : undefined;
          if (!modelSelection) {
            await client.respond(requestId, {
              ok: false,
              failureStage: "client_validation",
              errorCategory: "client_validation",
              errorCode: "model_not_allowed",
            });
            return;
          }
          const result = await offPeakTaskService.createTask({
            title: data.title,
            prompt: data.prompt,
            permissionMode: data.permissionMode ?? "yolo",
            modelSelection,
            // 会话内创建绑定当前会话，派发时 resume 该会话执行。
            ...(data.boundSessionId ? { boundSessionId: data.boundSessionId } : {}),
            // workspace 由 host 从当前 session 注入（对称 automation/create），不进协议参数。
            workspacePath: workspace.workspacePath,
            ...(workspace.workspaceIdentity
              ? { workspaceIdentity: workspace.workspaceIdentity }
              : {}),
          });
          if (!result.ok) {
            // 失败分类原样过协议（不 respondError），供 CLI handler 翻译为稳定错误。
            await client.respond(requestId, {
              ok: false,
              failureStage: result.failureStage,
              errorCategory: result.errorCategory,
              errorCode: result.errorCode,
            });
            return;
          }
          await client.respond(requestId, {
            ok: true,
            task: toProtocolOffPeakTaskSnapshot(result.task),
          });
        } catch (error) {
          await respondOffPeakInternalError(client, { id: requestId, method }, workspace, error);
        }
      })();
    }

    function handleOffPeakList(requestId: ACodeProtocolRequestId, method: string): void {
      void (async () => {
        try {
          const offPeakTaskService = options?.resolveOffPeakTaskService?.();
          if (!offPeakTaskService) {
            await client.respondError(requestId, {
              code: -32601,
              message: "Off-peak task service is unavailable on this host",
            });
            return;
          }
          const workspaceKey = resolveWorkspaceKey(workspace);
          const tasks = (await offPeakTaskService.list())
            .filter((task) => task.workspaceKey === workspaceKey)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 20);
          await client.respond(requestId, {
            tasks: tasks.map(toProtocolOffPeakTaskSnapshot),
          });
        } catch (error) {
          await respondOffPeakInternalError(client, { id: requestId, method }, workspace, error);
        }
      })();
    }

    const disposables = [
      client.onNotification((message) => {
        // M2-4 第八点：取消通知的形态绑定其触发请求的形态（CLI 侧 closure-local），
        // host 两个形态都收，行为一致（只认同 workspace + 同 client 的 pending）。
        if (message.method === V4_NOTIFICATIONS.interactionProviderRuntimeHeadersCancelled) {
          const parsed = v4ProviderRuntimeHeadersCancelledSchema.safeParse(message.params);
          if (parsed.success) handleProviderRuntimeHeadersCancel(parsed.data);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (message.method === "interaction/providerRuntimeHeadersCancelled") {
          const parsed = v4ProviderRuntimeHeadersCancelledSchema.safeParse(message.params);
          if (parsed.success) handleProviderRuntimeHeadersCancel(parsed.data);
          return;
        }
        if (message.method === LEGACY_NOTIFICATIONS.processResourceSample) {
          const parsed = acodeProcessResourceSampleSchema.safeParse(message.params);
          if (parsed.success) {
            processResourceSampleEmitter.fire({ ...parsed.data, lane });
          } else {
            logger.debug(undefined, "丢弃无效 ACode CLI 资源样本", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === LEGACY_NOTIFICATIONS.toolExecResource) {
          const parsed = acodeToolExecResourceSchema.safeParse(message.params);
          if (parsed.success) toolExecResourceEmitter.fire(parsed.data);
          return;
        }
        if (message.method === LEGACY_NOTIFICATIONS.mcpResourceSamples) {
          const parsed = acodeMcpResourceSamplesSchema.safeParse(message.params);
          if (parsed.success) mcpResourceSamplesEmitter.fire(parsed.data);
          else logger.debug(undefined, "丢弃无效 MCP 资源样本");
          return;
        }

        if (message.method === LEGACY_NOTIFICATIONS.mcpTelemetry) {
          const parsed = acodeMcpTelemetryEventSchema.safeParse(message.params);
          if (parsed.success) {
            mcpTelemetryEmitter.fire(parsed.data);
          } else {
            logger.debug(undefined, "丢弃无效 ACode CLI MCP 遥测事件", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === LEGACY_NOTIFICATIONS.pluginOperationProgress) {
          const parsed = acodePluginOperationProgressNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            pluginOperationProgressEmitters.get(parsed.data.operationId)?.fire(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 ACode Protocol 插件操作进度", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        // M2-4：CUA 操作事件迁不删（fail-closed 面），v4 形态与 legacy 逐点等价。
        // CLI 侧按 established flag 决定发哪个形态，host 两边都收。
        if (message.method === V4_NOTIFICATIONS.cuaOperationEvent) {
          const parsed = v4CuaOperationEventSchema.safeParse(message.params);
          if (parsed.success) {
            acceptCuaOperationEventData(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 ACode Protocol Computer Use operation event", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (message.method === "computer-use/operation-event") {
          const parsed = v4CuaOperationEventSchema.safeParse(message.params);
          if (parsed.success) {
            acceptCuaOperationEventData(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 ACode Protocol Computer Use operation event", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === "session/event") {
          const parsed = acodeSessionEventSchema.safeParse(message.params);
          if (parsed.success) {
            handleSessionEvent(workspace, parsed.data);
          } else {
            const rawParams =
              typeof message.params === "object" && message.params !== null
                ? (message.params as Record<string, unknown>)
                : {};
            logger.warn(
              typeof rawParams.traceId === "string" ? rawParams.traceId : undefined,
              "丢弃无效 ACode Protocol session event",
              {
                eventId: rawParams.eventId,
                issues: parsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                sessionId: rawParams.sessionId,
                type: rawParams.type,
              },
            );
          }
          return;
        }

        if (message.method === "state.updated") {
          const parsed = acodeStateUpdatedNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            handleStateUpdated(workspace, parsed.data);
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.conversationTelemetryFact) {
          const parsed = conversationTelemetryFactSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationTelemetryFactEmitter(workspace).fire(parsed.data);
          } else {
            // 严格丢弃未知字段，避免 CLI runtime 新字段未经审计穿透到 renderer reporter。
            logger.warn(undefined, "丢弃无效 v4 conversation telemetry fact", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.cuaPermissionObservation) {
          const parsed = cuaPermissionObservationSchema.safeParse(message.params);
          if (
            parsed.success &&
            !workspace.remoteSessionId &&
            !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
          ) {
            cuaPermissionObservationEmitter.fire({
              ...parsed.data,
              workspacePath: workspace.workspacePath,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
            });
          } else if (!parsed.success) {
            // 原因：权限观察会触发 renderer 副作用，未知字段必须 fail closed，不能宽松透传。
            logger.warn(undefined, "丢弃无效 v4 CUA 权限观察", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.networkCaptureRecords) {
          const parsed = v4NetworkCaptureRecordsNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            networkCaptureRecordsEmitter.fire(parsed.data);
          } else {
            // 脱敏纪律的第二道闸：schema 拒绝的记录整批丢弃，不宽松透传到资源管理器。
            logger.warn(undefined, "丢弃无效 v4 network capture records", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_OVERNIGHT_COMPLETION_METHOD) {
          const parsed = v4OvernightCompletionNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            overnightCompletionEmitter.fire(parsed.data);
          } else {
            // 严格丢弃：跨进程边界的未知/畸形完成信号 fail-closed，不透传给 main 弹通知。
            logger.warn(undefined, "丢弃无效 v4 overnight completion 信号", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.conversationFrame) {
          // 同一通知也载 sessions-index 帧，按 topic 前缀分流到列表 emitter
          // （否则会被 conversation schema 校验丢弃）。
          const topic = (message.params as { topic?: unknown } | null)?.topic;
          if (typeof topic === "string" && topic.startsWith("sessions-index/")) {
            const indexParsed = sessionsIndexTopicWireCandidateSchema.safeParse(message.params);
            if (indexParsed.success) {
              getSessionsIndexFrameEmitter(workspace).fire(indexParsed.data);
            } else {
              logger.warn(undefined, "丢弃无效 v4 sessions-index frame", {
                issues: indexParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          if (typeof topic === "string" && topic.startsWith("workspace-config/")) {
            const configParsed = workspaceConfigTopicWireCandidateSchema.safeParse(message.params);
            if (configParsed.success) {
              getWorkspaceConfigFrameEmitter(workspace).fire(configParsed.data);
            } else {
              logger.warn(undefined, "丢弃无效 v4 workspace-config frame", {
                issues: configParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          const parsed = conversationTopicWireCandidateSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationFrameEmitter(workspace).fire(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 v4 conversation frame", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
      }),
      client.onRequest((request) => {
        // M2-3（specs/m2-3-session-readwrite.md §2.8）：legacy
        // session/requestRuntimePreferences（CLI→host pull）已删除；偏好供给改为
        // host→CLI 的 v4/session/runtimePreferences push（见 pushSessionRuntimePreferences）。
        // M2-4：v4 announce + 立即 ack `{}`（CLI 侧 hold promise 与 wire 解耦），
        // 答案仍经 v4 resolveInteraction 回流；-32601 时 CLI 回落 legacy 反向 RPC。
        if (request.method === V4_METHODS.interactionRequestPermission) {
          const parsed = v4InteractionRequestPermissionParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid permission request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          registerPendingPermission(parsed.data, request.id);
          void client.respond(request.id, {});
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        // 语义保持原样：请求悬置不 respond，答案经 resolveInteraction 回流。
        if (request.method === "interaction/requestPermission") {
          const parsed = v4InteractionRequestPermissionParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid permission request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          registerPendingPermission(parsed.data, request.id);
          return;
        }

        // M2-4：同 permission，v4 announce + 立即 ack `{}`；重发去重逻辑在核心内保留。
        if (request.method === V4_METHODS.interactionRequestUserInput) {
          const parsed = v4InteractionRequestUserInputParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid user input request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          registerPendingUserInput(parsed.data, request.id);
          void client.respond(request.id, {});
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "interaction/requestUserInput") {
          const parsed = v4InteractionRequestUserInputParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid user input request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          registerPendingUserInput(parsed.data, request.id);
          return;
        }

        // M2-4：真 RPC（无 announce/ack 语义）；v4 优先，-32601 回落走下方字面量分支。
        if (request.method === V4_METHODS.interactionRequestProviderRuntimeHeaders) {
          const parsed =
            v4InteractionRequestProviderRuntimeHeadersParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid provider runtime headers request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleProviderRuntimeHeadersRequest(parsed.data, request.id, request.trace?.traceId);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "interaction/requestProviderRuntimeHeaders") {
          const parsed = v4InteractionRequestProviderRuntimeHeadersParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid provider runtime headers request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleProviderRuntimeHeadersRequest(parsed.data, request.id, request.trace?.traceId);
          return;
        }

        // 官方 Server MCP 身份头：纯 RPC 中继，host 自动解析并响应。
        // 不 emitSessionEvent、不进 pending map——该请求没有 UI 语义，renderer 不参与。
        // M2-4：信任校验与凭据读取顺序约束全部收进 handleOfficialMcpAuthHeadersRequest。
        if (request.method === V4_METHODS.interactionRequestOfficialMcpAuthHeaders) {
          const parsed =
            v4InteractionRequestOfficialMcpAuthHeadersParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/requestOfficialMcpAuthHeaders params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleOfficialMcpAuthHeadersRequest(parsed.data, request.id, request.trace?.traceId);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "interaction/requestOfficialMcpAuthHeaders") {
          const parsed = v4InteractionRequestOfficialMcpAuthHeadersParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/requestOfficialMcpAuthHeaders params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleOfficialMcpAuthHeadersRequest(parsed.data, request.id, request.trace?.traceId);
          return;
        }

        // browser-use discovery：backend 在线状态与 plugin/skill 是否暴露是两层状态。
        // executor 缺省时返回空列表，禁止 facade 伪造 IAB available。
        // M2-4：v4 优先，行为收进 handleBrowserListRequest（两形态等价）。
        if (request.method === V4_METHODS.interactionBrowserList) {
          const parsed = v4InteractionBrowserListParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserList params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleBrowserListRequest(parsed.data, request.id);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "interaction/browserList") {
          const parsed = v4InteractionBrowserListParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserList params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleBrowserListRequest(parsed.data, request.id);
          return;
        }

        // browser-use：agent 的 agent.browsers.* 经 interaction/browserExecute 到达这里。
        // 纯 RPC 中继——转发给 main（WebContentsView+CDP）执行后 respondResult，不 emitSessionEvent、
        // 不进 pending map（区别于 permission 的 UI 阻塞语义）。executor 缺省则 backend_unavailable。
        // M2-4：v4 优先，execute 归一化收进 handleBrowserExecuteRequest（两形态等价）。
        if (request.method === V4_METHODS.interactionBrowserExecute) {
          const parsed = v4InteractionBrowserExecuteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserExecute params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleBrowserExecuteRequest(parsed.data, request.id);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "interaction/browserExecute") {
          const parsed = v4InteractionBrowserExecuteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserExecute params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleBrowserExecuteRequest(parsed.data, request.id);
          return;
        }

        if (request.method === V4_METHODS.automationCreate) {
          const parsed = v4AutomationCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationCreate(parsed.data, request.id);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "automation/create") {
          const parsed = v4AutomationCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationCreate(parsed.data, request.id);
          return;
        }

        if (request.method === V4_METHODS.offPeakCreate) {
          const parsed = v4OffPeakCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleOffPeakCreate(parsed.data, request.id, request.method);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "offPeak/create") {
          const parsed = v4OffPeakCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleOffPeakCreate(parsed.data, request.id, request.method);
          return;
        }

        if (request.method === V4_METHODS.offPeakList) {
          const parsed = v4OffPeakListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleOffPeakList(request.id, request.method);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "offPeak/list") {
          const parsed = v4OffPeakListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleOffPeakList(request.id, request.method);
          return;
        }

        if (request.method === V4_METHODS.automationList) {
          const parsed = v4AutomationListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationList(request.id);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "automation/list") {
          const parsed = v4AutomationListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationList(request.id);
          return;
        }

        if (request.method === V4_METHODS.automationCheckTaskBinding) {
          const parsed = v4AutomationCheckTaskBindingParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation task binding params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationCheckTaskBinding(parsed.data, request.id);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "automation/checkTaskBinding") {
          const parsed = v4AutomationCheckTaskBindingParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation task binding params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationCheckTaskBinding(parsed.data, request.id);
          return;
        }

        if (request.method === V4_METHODS.automationUpdate) {
          const parsed = v4AutomationUpdateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation update params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationUpdate(parsed.data, request.id);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "automation/update") {
          const parsed = v4AutomationUpdateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation update params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationUpdate(parsed.data, request.id);
          return;
        }

        if (request.method === V4_METHODS.automationDelete) {
          const parsed = v4AutomationDeleteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation delete params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationDelete(parsed.data, request.id);
          return;
        }
        // 偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除。
        if (request.method === "automation/delete") {
          const parsed = v4AutomationDeleteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation delete params",
              data: parsed.error.flatten(),
            });
            return;
          }
          handleAutomationDelete(parsed.data, request.id);
          return;
        }

        void client.respondError(request.id, {
          code: -32601,
          message: `Unsupported ACode Protocol request: ${request.method}`,
        });
      }),
      client.onClose(() => {
        invalidateWorkspaceClient(resolveWorkspaceKey(workspace), client);
      }),
    ];
    clientDisposables.set(client, disposables);
  }

  function rememberSessionTrace(
    target: ACodeAgentSessionTarget,
    snapshot: ACodeSessionStateSnapshot,
  ): TraceId | undefined {
    const traceId = snapshot.session.traceId as TraceId | undefined;
    if (traceId) {
      sessionTraceIdBySessionKey.set(sessionEventKey(target), traceId);
    }
    return traceId;
  }

  function getSessionTraceId(target: ACodeAgentSessionTarget): TraceId | undefined {
    return sessionTraceIdBySessionKey.get(sessionEventKey(target));
  }

  function createProviderNotReadyError(params: {
    snapshot?: ACodeAgentProviderReadinessSnapshot;
    workspace: ACodeAgentWorkspaceTarget;
  }): Error & {
    code: typeof ACODE_AGENT_PROVIDER_NOT_READY_CODE;
    data: {
      providerCount: number;
      reason: typeof ACODE_AGENT_PROVIDER_NOT_READY_REASON;
      revision: string | null;
      workspaceKey: string;
      workspacePath: string;
    };
  } {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const error = new Error("当前没有可用的模型供应商和模型，请先登录或配置 API Key。") as Error & {
      code: typeof ACODE_AGENT_PROVIDER_NOT_READY_CODE;
      data: {
        providerCount: number;
        reason: typeof ACODE_AGENT_PROVIDER_NOT_READY_REASON;
        revision: string | null;
        workspaceKey: string;
        workspacePath: string;
      };
    };
    error.code = ACODE_AGENT_PROVIDER_NOT_READY_CODE;
    error.data = {
      providerCount: params.snapshot?.providerCount ?? 0,
      reason: ACODE_AGENT_PROVIDER_NOT_READY_REASON,
      revision: params.snapshot?.revision ?? null,
      workspaceKey,
      workspacePath: params.workspace.workspacePath,
    };
    return error;
  }

  function isProviderNotReadyError(
    error: unknown,
  ): error is Error & { code: typeof ACODE_AGENT_PROVIDER_NOT_READY_CODE } {
    return (
      error instanceof Error &&
      (error as { code?: unknown }).code === ACODE_AGENT_PROVIDER_NOT_READY_CODE
    );
  }

  async function resolveStartupReadiness(): Promise<
    ACodeAgentProviderReadinessSnapshot | undefined
  > {
    if (modelSelectionReadinessSource) {
      return createProviderReadinessSnapshotFromSelectionView(
        await modelSelectionReadinessSource.getView(),
      );
    }
    return undefined;
  }

  /**
   * stop/取消 RPC 超时或 watchdog 会回收 client/进程，但进程异步退出，
   * client.onClose 尚未触发时 activeClientsByWorkspaceKey 仍指向已 disposed 的 client。
   * 所有复用 active entry 的路径必须先经过本检查；disposed 时清理 stale entry 并返回 false，
   * 让调用方重新拉起进程（start-if-needed）或按“无运行时”处理（existing-only）。
   */
  function isReusableActiveClientEntry(
    params: ACodeAgentWorkspaceTarget,
    active: ActiveWorkspaceClient | undefined,
  ): boolean {
    if (!active) {
      return false;
    }
    if (!active.client.isDisposed) {
      return true;
    }
    const workspaceKey = resolveWorkspaceKey(params);
    activeClientsByWorkspaceKey.delete(workspaceKey);
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
    logger.warn(undefined, "复用的 ACode Protocol client 已 disposed，清理 stale entry", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return false;
  }

  async function getOrStartReadOnlyClient(
    params: ACodeAgentWorkspaceTarget,
  ): Promise<ActiveWorkspaceClient> {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      await active.interactionPreferencesReady;
      return active;
    }

    const client = await processManager.getClient(params);
    wireClient(client, params, "chat");

    // processManager 会按 workspaceKey 对并发启动 single-flight。await 期间若另一条
    // read/write 路径已登记同一 client，必须复用现有 entry，不能把已提升的写能力降回 false。
    const concurrent = activeClientsByWorkspaceKey.get(workspaceKey);
    if (concurrent && isReusableActiveClientEntry(params, concurrent)) {
      concurrent.workspace = params;
      await concurrent.interactionPreferencesReady;
      return concurrent;
    }

    const entry: ActiveWorkspaceClient = {
      client,
      modelExecutionEnabled: false,
      workspace: params,
    };
    activeClientsByWorkspaceKey.set(workspaceKey, entry);
    // 观测开启期间新 spawn 的 workspace agent 入池即补发开关（host 级观测语义）。
    if (networkCaptureWireState) pushNetworkCaptureWire(client, networkCaptureWireState);
    const interactionPreferencesReady = (async () => {
      let appliedSnapshot: ACodeAgentAppRuntimePreferences | undefined;
      while (latestAppRuntimePreferences && latestAppRuntimePreferences !== appliedSnapshot) {
        const snapshot = latestAppRuntimePreferences;
        await enqueueInteractionPreferenceSync({
          client,
          preferences: { ...snapshot },
          workspace: params,
        });
        appliedSnapshot = snapshot;
      }
    })();
    // Off-Peak 本地支持能力是 workspace 级事实，在允许任何 session 工作前同步到 CLI，
    // 让 v4 冷恢复（没有 per-request flag 通道）也能拿到工具面。旧 CLI method-not-found 降级忽略。
    // CLI 缺省即 false，且每个 agent 进程只服务一个 workspace，门禁关闭时不发请求（对未实现该
    // 方法的旧 CLI/测试假客户端零打扰）。
    const offPeakToolPolicyReady = (async () => {
      if (!isOffPeakToolSupported(params)) return;
      try {
        await client.request(
          V4_METHODS.workspaceUpdateOffPeakToolPolicy,
          { workspace: buildWorkspaceRef(params), enabled: true },
          v4WorkspaceUpdateOffPeakToolPolicyResultSchema,
        );
      } catch (error) {
        // 策略同步是尽力而为的能力分发，失败方向是 fail-closed（CLI 缺省不注册工具），
        // 超时/暂时性 IPC 错误不得阻断客户端就绪；-32601 是旧 CLI 的正常降级。
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "Off-Peak 工具策略同步失败，CLI 维持缺省关闭", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    // 动态工作流灰度门禁：与 Off-Peak 同一
    // 模式的 workspace 级事实，在允许任何 session 工作前同步给 CLI，v4 冷恢复也才拿得到工具面。
    // 关闭时不发请求（CLI 缺省即 false，对旧 CLI/测试假客户端零打扰）。
    const dynamicWorkflowPolicyReady = (async () => {
      if (!(await resolveDynamicWorkflowGate())) return;
      try {
        await client.request(
          V4_METHODS.workspaceUpdateDynamicWorkflowPolicy,
          { workspace: buildWorkspaceRef(params), enabled: true },
          v4WorkspaceUpdateDynamicWorkflowPolicyResultSchema,
        );
      } catch (error) {
        // 与 Off-Peak 同判据：-32601 是旧 CLI 的正常降级（其 z.object 也会丢掉 session flag，
        // 整体退回 disabled）；其它错误只记 warn，不阻断客户端就绪。
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "动态工作流策略同步失败，CLI 维持缺省关闭", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    entry.interactionPreferencesReady = Promise.all([
      interactionPreferencesReady,
      offPeakToolPolicyReady,
      dynamicWorkflowPolicyReady,
      // M2-3（specs/m2-3-session-readwrite.md §2.8）：偏好推送纳入入池就绪，保证冷恢复
      // （conversationSubscribe 物化）发生前 CLI 侧缓存已暖；推送内部吞错（永不 reject），
      // 不进 Promise.all 失败面。
      pushSessionRuntimePreferences(client, params),
    ]).then(() => undefined);
    try {
      // 新建或重启 runtime 在允许任何 session 工作前追平缓存；同步期间的新开关
      // 会因 entry 已登记而进入同一 workspace 串行队列，不会丢失提交顺序。
      await entry.interactionPreferencesReady;
    } catch (error) {
      if (activeClientsByWorkspaceKey.get(workspaceKey) === entry) {
        activeClientsByWorkspaceKey.delete(workspaceKey);
      }
      throw error;
    } finally {
      delete entry.interactionPreferencesReady;
    }
    logger.info(undefined, "为只读会话控制面启动 ACode agent", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry;
  }

  async function getClient(params: ACodeAgentWorkspaceTarget) {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.modelExecutionEnabled && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      return active.client;
    }

    const waiting = waitingWorkspaceStartups.get(workspaceKey) ?? {
      cancelled: false,
      workspace: params,
    };
    waiting.workspace = params;
    waitingWorkspaceStartups.set(workspaceKey, waiting);

    const readinessSnapshot = await resolveStartupReadiness();
    // readiness 读取可能与 workspace release 交错；release 删除 waiting identity 后，
    // 旧 continuation 不能创建新进程。未来重新打开同一路径会获得新的 identity，互不误伤。
    if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
      throw createRuntimeUnavailableError(params);
    }
    const readiness = readinessSnapshot?.readiness;
    if (!readinessSnapshot || !readiness?.ready) {
      const revision = readinessSnapshot?.revision ?? "missing";
      if (waiting.lastLoggedRevision !== revision) {
        waiting.lastLoggedRevision = revision;
        logger.info(
          undefined,
          active
            ? "provider/model 尚未就绪，ACode agent 保持只读"
            : "provider/model 尚未就绪，ACode agent 保持未启动",
          {
            providerCount: readinessSnapshot?.providerCount ?? 0,
            revision: readinessSnapshot?.revision ?? null,
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
      }
      throw createProviderNotReadyError({ snapshot: readinessSnapshot, workspace: params });
    }

    const entry = await getOrStartReadOnlyClient(params);
    if (waiting.cancelled) {
      throw createRuntimeUnavailableError(params);
    }
    entry.modelExecutionEnabled = true;
    processManager.markReady(params, entry.client);
    entry.workspace = params;
    waitingWorkspaceStartups.delete(workspaceKey);
    logger.info(undefined, "provider/model 就绪，允许 ACode agent 模型执行", {
      modelId: readiness.modelId,
      providerId: readiness.providerId,
      revision: readinessSnapshot.revision,
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry.client;
  }

  async function getReadOnlyClient(
    params: ACodeAgentWorkspaceTarget,
    runtimePolicy: "start-if-needed" | "existing-only" = "start-if-needed",
  ) {
    if (runtimePolicy === "existing-only") {
      const workspaceKey = resolveWorkspaceKey(params);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      // 观察者路径同样要拒绝 disposed 的 stale entry；清理后按“无运行时”处理，
      // 绝不为观察者拉起新进程（保持 existing-only 语义）。
      if (active && isReusableActiveClientEntry(params, active)) {
        active.workspace = params;
        return active.client;
      }
      // runtime available 可能先于原启动调用的 await continuation 到达。这里允许把
      // process manager 已登记的 client 提升为 service active entry，但绝不创建新进程。
      const existingClient = processManager.getExistingClient(params);
      if (!existingClient) {
        throw createRuntimeUnavailableError(params);
      }
      wireClient(existingClient, params, "chat");
      activeClientsByWorkspaceKey.set(workspaceKey, {
        client: existingClient,
        modelExecutionEnabled: false,
        workspace: params,
      });
      // 观测开启期间既有 client 被重新 wire 入池：同样补发开关。
      if (networkCaptureWireState) pushNetworkCaptureWire(existingClient, networkCaptureWireState);
      return existingClient;
    }
    return (await getOrStartReadOnlyClient(params)).client;
  }

  async function getPluginManagementClient(): Promise<ACodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await pluginProcessManager.getClient(workspace);
    wireClient(client, workspace, "plugin");
    return client;
  }

  // 全局工作流的载体运行时选择：
  // 调用方只给 `{ scope: "global" }` 不带 workspace 时，先复用任一已活跃的**本地** runtime
  // （existing-only 语义：只看 activeClientsByWorkspaceKey，绝不为此拉起新进程），否则回落到
  // 管理面 workspace——照 getPluginManagementClient 先例用专用 pluginProcessManager 拉一个控制面
  // runtime。选它而非 getOrStartReadOnlyClient 的理由：workflows/* 是无会话、不依赖 provider/model
  // 就绪的 workspace 级方法，管理面进程正是为这种「不寄居真实项目」的控制面能力准备的，且不会因
  // 真实 workspace 生命周期被 watchdog 回收；getOrStartReadOnlyClient 反而会把这个合成 workspace
  // 塞进 activeClientsByWorkspaceKey 并跑一遍交互偏好同步，污染会话 client map。两条路径都在本机，
  // homedir() 即用户家目录，全局根 `~/.acode/workflows/` 因此解析到真实目录。
  // 远程 runtime（SSH/WSL identity 或带 remoteSessionId）的 home 不是本机，绝不选它当载体。
  function isLocalActiveWorkspaceClient(workspace: ACodeAgentWorkspaceTarget): boolean {
    return (
      !workspace.remoteSessionId &&
      !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
    );
  }

  async function resolveGlobalSavedWorkflowCarrier(): Promise<{
    client: ACodeProtocolClient;
    workspace: ACodeWorkspaceRef;
  }> {
    for (const active of activeClientsByWorkspaceKey.values()) {
      if (!isLocalActiveWorkspaceClient(active.workspace)) {
        continue;
      }
      // disposed / stale entry 的清理语义与 getReadOnlyClient(existing-only) 一致：
      // isReusableActiveClientEntry 会顺手清掉已回收的 entry，然后我们跳过它继续找。
      if (!isReusableActiveClientEntry(active.workspace, active)) {
        continue;
      }
      return { client: active.client, workspace: buildWorkspaceRef(active.workspace) };
    }
    const managementWorkspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await getPluginManagementClient();
    return { client, workspace: buildWorkspaceRef(managementWorkspace) };
  }

  // 五个 workflows/* 方法的载体：带 workspace 就直通（项目档，或 GUI 项目组里明说 scope 的动作），
  // 只给 `scope:"global"` 时交给 services 自选本机载体。
  async function resolveSavedWorkflowCarrier(
    params: ACodeAgentSavedWorkflowTarget,
  ): Promise<{ client: ACodeProtocolClient; workspace: ACodeWorkspaceRef }> {
    if (savedWorkflowTargetHasWorkspace(params)) {
      return { client: await getReadOnlyClient(params), workspace: buildWorkspaceRef(params) };
    }
    return resolveGlobalSavedWorkflowCarrier();
  }

  // mcp/list 专用：与插件管理命令隔离进程，见 mcpStatusProcessManager 处的说明。
  async function getMcpStatusClient(): Promise<ACodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await mcpStatusProcessManager.getClient(workspace);
    wireClient(client, workspace, "mcp-status");
    return client;
  }

  function disposeLocalState(): void {
    accountProviderConfigUnsubscribe?.();
    accountProviderConfigUnsubscribe = undefined;
    modelSelectionSubscription?.dispose();
    modelSelectionSubscription = undefined;
    memoryDiagnostics.dispose();
    for (const emitter of sessionEmitters.values()) {
      emitter.dispose();
    }
    sessionEmitters.clear();
    sessionRuntimePreferencesRequestEmitter.dispose();
    processResourceSampleEmitter.dispose();
    mcpTelemetryEmitter.dispose();
    toolExecResourceEmitter.dispose();
    mcpResourceSamplesEmitter.dispose();
    for (const emitter of pluginOperationProgressEmitters.values()) {
      emitter.dispose();
    }
    pluginOperationProgressEmitters.clear();
    for (const emitter of conversationFrameEmitters.values()) {
      emitter.dispose();
    }
    conversationFrameEmitters.clear();
    for (const emitter of conversationTelemetryFactEmitters.values()) {
      emitter.dispose();
    }
    conversationTelemetryFactEmitters.clear();
    cuaPermissionObservationEmitter.dispose();
    networkCaptureRecordsEmitter.dispose();
    overnightCompletionEmitter.dispose();
    for (const emitter of workspaceConfigFrameEmitters.values()) {
      emitter.dispose();
    }
    workspaceConfigFrameEmitters.clear();
    for (const emitter of sessionsIndexFrameEmitters.values()) {
      emitter.dispose();
    }
    sessionsIndexFrameEmitters.clear();
    sessionEventSequenceStates.clear();
    pendingPermissions.clear();
    pendingUserInputs.clear();
    pendingProviderRuntimeHeaders.clear();
    for (const pending of pendingSessionRuntimePreferences.values()) {
      clearTimeout(pending.timeout);
      // M2-3：dispose 时在途解析快速失败，避免 push 帮助器的 await 悬挂。
      pending.reject(new Error("ACode agent service disposed"));
    }
    pendingSessionRuntimePreferences.clear();
    activeClientsByWorkspaceKey.clear();
    cancelAllWaitingWorkspaceStartups();
    interactionPreferenceSyncByWorkspaceKey.clear();
    cuaOperationTurnTracker?.clearAll();
    clearV4SubscriptionRoutes();
    v4RouteRuntimeRestartDisposable.dispose();
    runtimeLifecycleDisposable.dispose();
  }

  // 3.12.2：远端灰度读取不能放进客户端就绪与创建命令：失败时串行重试会阻塞普通聊天。
  // 注册只判断本地支持能力；灰度、套餐与模型准入仍由 offPeak/create handler 在取号前校验。
  function isOffPeakToolSupported(params: {
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): boolean {
    if (!options?.resolveOffPeakClientConfig || !options.resolveOffPeakTaskService) return false;
    if (params.remoteSessionId) return false;
    return !params.workspaceIdentity || !isRemoteWorkspaceIdentity(params.workspaceIdentity);
  }

  /**
   * 动态工作流灰度门：Host 判定一次并在本
   * 进程内固定。三点理由：
   *   1. 同一次判定同时喂给 workspace/updateDynamicWorkflowPolicy 和 session flag，两者不会
   *      出现"策略说开、create 说关"的裂口；
   *   2. 判定落在 client 就绪路径上，不能每次建会话都等远端——3.12.2 已因此回归过一次；
   *   3. 读取**抛异常**时本进程按不可用处理且不再重试。这一条不是灰度的缺省档位——档位
   *      （包括请求失败落什么）由 provider 与 shared 的 DEFAULT_DYNAMIC_WORKFLOW_MODE 唯一
   *      裁决，而 provider 自己就把网络失败收敛成 default 快照、从不抛到这里。所以这个 catch
   *      实际只剩一种触发方式：装配出了问题（resolver 没接对、依赖构造失败）。那种情况下按
   *      不可用处理是防御姿态，不是灰度语义；不重试则是为了避免离线时每条 create 都赔上一次
   *      请求超时。服务端翻转灰度按设计在下一个 Host 进程生效（provider 侧另有 1h 快照与
   *      forceRefresh）。
   * 与 Off-Peak 不同：远程 workspace 同样可用，所以这里不看 workspaceIdentity / remoteSessionId。
   */
  function resolveDynamicWorkflowGate(): Promise<boolean> {
    const resolve = options?.resolveDynamicWorkflowClientConfig;
    if (!resolve) return Promise.resolve(false);
    dynamicWorkflowGate ??= (async () => {
      try {
        return (await resolve())?.enabled === true;
      } catch (error) {
        logger.warn(undefined, "动态工作流灰度读取异常，本进程按不可用处理", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })();
    return dynamicWorkflowGate;
  }

  /**
   * 脚本工作流产品开关的会话门（spec script-workflow-management-surface.md §4.4/§5 行 8）。
   * 与 resolveDynamicWorkflowGate 的两点**刻意差异**：
   * 1. **不 memoize**：每次 v4 createSession 现读折叠出口（无跨会话缓存）。dwf 可 memoize
   *    是因为有 workspace/updateDynamicWorkflowPolicy 推送通道兜底（缓存失效有中途改档
   *    补偿）；script 无中途改档通道（§4.5 末行），进程内缓存会使「下次会话生效」承诺
   *    失效——与 §8.1 时序不变式「每次判定现读，无缓存」对齐。
   * 2. **异常按 enabled=true**：本机缺省档是 onDemand（开），读取异常时 fail 到缺省档
   *    保住今天的行为，与 dwf 的「异常按不可用（false）」方向相反（两边缺席语义相反
   *    所致，§4.4）。
   * 与 Off-Peak / dwf 同：不看 workspaceIdentity / remoteSessionId——本机设置全局生效。
   */
  async function resolveScriptWorkflowGate(): Promise<boolean> {
    const resolve = options?.resolveScriptWorkflowMode;
    if (!resolve) return true;
    try {
      return isScriptWorkflowModeEnabled(await resolve());
    } catch (error) {
      logger.warn(undefined, "脚本工作流档位读取异常，按缺省档（onDemand）处理", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  /**
   * 工具按需检索档位的会话门（specs/tool-search.md R3/R11）。与 resolveScriptWorkflowGate
   * 同构的三点裁决：
   * 1. **不 memoize**：每次 v4 createSession 现读折叠出口（node.ts
   *    resolveToolSearchModeFromSettings 自身已现读 AppSettings）——无会话中途改档
   *    通道，进程内缓存会使「下次会话生效」失效。
   * 2. **异常按 off**：缺省语义是 off（零行为变化红线），与 script 的 fail-open 方向
   *    相反；node.ts 折叠出口已 warn 一次，这里再兜一层防未来消费方直连抛错。
   * 3. **返回值三态**：undefined = 装配层没给折叠出口（纯 CLI/远控不读本设置，R1），
   *    信封**不写字段**（缺席 = off）；有值时 auto/local/off **都写**——CLI 侧
   *    appRuntimePreferences 冷恢复兜底缓存依赖显式 off 才能刷新掉旧档位。
   */
  async function resolveToolSearchGate(): Promise<ToolSearchAppMode | undefined> {
    const resolve = options?.resolveToolSearchMode;
    if (!resolve) return undefined;
    try {
      return await resolve();
    } catch (error) {
      logger.warn(undefined, "工具检索档位读取异常，按缺省档（off）处理", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return "off";
    }
  }

  async function buildConversationCommandEnvelope(
    params: ACodeAgentConversationCommandParams,
    // U11（spec tool-media-attachment-ref.md R10.2a）：createSession 的可信 clientMode。由
    // sendConversationCommandV4 从 trusted carrier 解析（resolveTrustedCommandClientMode），
    // 传进来而非在信封里重算，保证「盖进 payload 的值」与「TTFT 门用的值」是同一个可信来源。
    commandClientMode?: ACodeAgentV4ClientMode,
  ): Promise<CommandEnvelope> {
    const envelope = params.envelope;
    if (envelope.type === "createSession") {
      // V4 createSession 绕过 legacy session/create 的参数构造，工具面 flag 必须在
      // 信封处同源注入；门禁 false 时不写字段（缺省即 fail-closed，与 legacy 一致）。
      const dynamicWorkflowEnabled = await resolveDynamicWorkflowGate();
      // 脚本工作流开关：true/false **都写**（极性与 dwf 相反）——CLI 侧缺席=开启的
      // fail-open 极性意味着 Host 必须显式写 false 才能关掉 RunWorkflow（§4.4）。
      const scriptWorkflowEnabled = await resolveScriptWorkflowGate();
      // 工具按需检索档位（specs/tool-search.md R11）：undefined = 装配层没给折叠出口，
      // 不写字段（缺席 = off）；有值时三档都写（含 off，理由见 resolveToolSearchGate）。
      const toolSearchMode = await resolveToolSearchGate();
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // scriptWorkflowEnabled 恒写，所以 createSession 没有可省略的 early return；
      // payload 解析对空 flag 组合也无害（同一条 zod schema）。
      const parsedPayload = commandPayloadSchemas.createSession.parse(envelope.payload);
      // **安全关键（R10.2a）**：先把 wire 上可能存在的 `clientMode` 从 payload 里**丢弃**——它是
      // renderer 可控字段（facade 的 withTrustedConnection 只删顶层 clientMode，不触碰 payload），
      // 唯一的合法来源是下面用可信 commandClientMode 重新盖章。丢弃 + 重盖 = 「wire clientMode 永不
      // 被信任」的结构性不变量：即使可信值缺席（commandClientMode === undefined），伪造值也已随
      // rest 解构被剔除，CLI 侧退回缺席即 inline（fail-closed），不会误开 ref 生产。
      const { clientMode: _forgedClientMode, ...payload } = parsedPayload;
      // 先装配 host 裁决的工具面 flag（顺序即优先级，后写覆盖前写）。
      const withHostFlags = {
        ...payload,
        ...(offPeakToolEnabled ? { offPeakToolEnabled: true } : {}),
        // 动态工作流灰度：V4 createSession 是桌面新会话的实际创建路径，不透传则那一批
        // 工作流工具（core 的 GATED_WORKFLOW_TOOL_NAMES）永不注册。数量刻意不写进注释：
        // 名单的唯一所有者是 core 的 GATED_WORKFLOW_TOOL_NAMES（dwf 十个 + 脚本工作流的
        // RunWorkflow），写死数字的注释已经错过一次，第二次不会有人再发现。
        ...(dynamicWorkflowEnabled ? { dynamicWorkflowEnabled: true } : {}),
        scriptWorkflowEnabled,
        // 工具按需检索档位：缺席 = off（CLI 侧 zod optional 静默兼容旧面），
        // 显式三档（含 off）都写，供 CLI appRuntimePreferences 冷恢复兜底刷新。
        ...(toolSearchMode === undefined ? {} : { toolSearchMode }),
      };
      return {
        ...envelope,
        // clientMode 必须**最后**盖（覆盖 withHostFlags）；覆盖语义在 stampCreateSessionClientMode
        // （spread 在前、可信值在后，伪造值永不存活）。commandClientMode 缺席 = 不盖章 = 保持上面的
        // 剔除结果 = CLI 侧缺席即 inline（fail-closed）。
        payload:
          commandClientMode === undefined
            ? withHostFlags
            : stampCreateSessionClientMode(withHostFlags, commandClientMode),
      };
    }
    if (envelope.type !== "sendText") return envelope;

    const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
    // 读取持久化 cronAutomationId 后不能把整个绑定会话永久视为 automation
    // 执行上下文。用户后续主动输入也因此丢失 CronUpdate/CronDelete。这里只认本轮 payload；
    // automation runId 漏传 payload 的兼容识别由 CLI 的 resolveTurnAutomationId 兜底。
    if (payload.automationId) {
      // desktop continuous 的 automation 派发不一定经过 task adapter；在协议信封处合并本轮
      // denylist，且不覆盖调用方已有策略。
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeAutomationMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    if (payload.offPeakTaskId) {
      // 闲时派发轮同型纵深——只 deny OffPeakCreate（OffPeakList 只读保留）。
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeOffPeakMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    return envelope;
  }

  /**
   * session/read 线请求单点（M2-1）：readSession 方法与配置写后回读共用本函数，
   * grep 判据（acodeProtocolMethods 点号消费计数）中 sessionRead 仍只有一个消费行——
   * M2-3 迁读路径时只需改这里。配置写方法的「ACK 后回读」复刻旧 op 单调用返回变更后
   * 快照的契约：v4 命令只回 ACK，host 无本地 v4 投影，全量快照只能再读一次（与
   * adapter 的 resumeSnapshot 后置回读同型）。
   */
  async function requestSessionStateSnapshot(
    client: ACodeProtocolClient,
    params: Pick<
      ACodeAgentReadSessionParams,
      "sessionId" | "deliveryKind" | "messageLimit" | "afterSeq"
    >,
  ): Promise<ACodeSessionStateSnapshot> {
    // M2-3（specs/m2-3-session-readwrite.md §2.4）：legacy session/read → v4/session/read
    // query。wire 参数与返回形状与 legacy 逐字同形（CLI handler 直通 legacy readSession op），
    // 结果继续用既有 barrel acodeSessionStateSnapshotSchema 校验。
    return client.request(
      V4_METHODS.sessionRead,
      {
        sessionId: params.sessionId,
        deliveryKind: params.deliveryKind,
        messageLimit: params.messageLimit,
        afterSeq: params.afterSeq,
      },
      acodeSessionStateSnapshotSchema,
    );
  }

  /**
   * 会话级配置写（模型/思考深度/模式）的 v4 CAS 命令提交（M2-1：
   * session/setModel|setThoughtLevel|setMode → switchModelConfig/switchCollaborationMode）。
   * 与 adapter 的 sendConfigCasCommandV4 同一收口件：stale ACK 用 revisionAtDecision 收敛
   * 重试；facade 的旧 expectedRevision 是 legacy stateRevision 计数器，与 v4 conversation
   * revision 不互通，刻意不透传（无 CAS 提交语义保真，见 sendHostCasCommandV4 注释）。
   */
  async function sendSessionConfigCommandV4<
    T extends "switchModelConfig" | "switchCollaborationMode",
  >(
    client: ACodeProtocolClient,
    sessionId: string,
    type: T,
    payload: CommandPayloadMap[T],
    contextMessage: string,
  ): Promise<void> {
    await sendHostCasCommandV4({
      send: (envelope) => client.request(V4_METHODS.command, envelope, commandAckSchema),
      type,
      payload,
      sessionId,
      contextMessage,
    });
  }

  /**
   * M2-2：goalSession facade 的 action→v4 分派（legacy session/goal 六 action 的等价物，
   * spec apps/acode-cli/specs/m2-2-session-control.md §2.2）。show→v4/session/goal query；
   * set/replace→sendGoalCommand（重复 set 收敛 replace 由 CLI handler 原生承担）；
   * pause/resume→CAS（sendHostCasCommandV4，stale 以 revisionAtDecision 收敛）；
   * clear→clearGoal。返回旧 op 回执的 response/startedTurn 两字段；全量快照由调用方
   * 统一 ACK 后回读（requestSessionStateSnapshot）。
   * 有意的行为收敛（spec §2.2）：busy 时 set 走 v4 原生 FIFO 入队（legacy 抛 -32010），
   * 此时 ACK 无 goalControl result，按 response=""/startedTurn=false 收口；resume 遇
   * plan 模式由 v4 guard.planGoalMutuallyExclusive 拒绝（legacy 落库不续跑），不削弱 guard。
   */
  async function dispatchGoalActionV4(
    client: ACodeProtocolClient,
    params: ACodeAgentGoalParams,
  ): Promise<{ response: string; startedTurn: boolean }> {
    const action = params.action;
    if (action === "show") {
      const result = await client.request(
        V4_METHODS.sessionGoalQuery,
        { sessionId: params.sessionId },
        v4SessionGoalQueryResultSchema,
      );
      return {
        response: result.supported
          ? formatGoalSummaryText(result.target ?? null)
          : "Goal management is not available in this client.",
        startedTurn: false,
      };
    }
    if (action === "set" || action === "replace") {
      const objective = params.objective?.trim() ?? "";
      if (objective.length === 0) {
        // legacy 空 objective 不发命令直接回 usage 文案（snapshot 由调用方统一回读）。
        return {
          response:
            action === "replace" ? "Usage: /goal replace <objective>" : "Usage: /goal <objective>",
          startedTurn: false,
        };
      }
      const ack = await client.request(
        V4_METHODS.command,
        createHostCommandEnvelope({
          type: "sendGoalCommand",
          payload: { text: objective },
          sessionId: params.sessionId,
          // commandId=inputId 对齐（sendText 同例）：goal turn 的终态事件 inputId 与
          // host command queue 的 traceId 对账收口。
          ...(params.inputId ? { commandId: params.inputId } : {}),
        }),
        commandAckSchema,
      );
      assertV4CommandAckOk("sendGoalCommand", ack, `session=${params.sessionId} action=${action}`);
      const control = ack.result?.type === "goalControl" ? ack.result : undefined;
      if (!control) return { response: "", startedTurn: false };
      const base = control.target ? formatGoalChangedText("Goal active", control.target) : "";
      return {
        response: control.planContinuationSkipped
          ? `${base}\n\n${GOAL_PLAN_CONTINUATION_SKIPPED_MESSAGE}`
          : base,
        startedTurn: control.startedTurn,
      };
    }
    if (action === "pause" || action === "resume") {
      const ack = await sendHostCasCommandV4({
        send: (envelope) => client.request(V4_METHODS.command, envelope, commandAckSchema),
        type: action === "pause" ? "pauseGoal" : "resumeGoal",
        payload: {},
        sessionId: params.sessionId,
        contextMessage: `session=${params.sessionId} action=${action}`,
      });
      const control = ack.result?.type === "goalControl" ? ack.result : undefined;
      if (!control) return { response: "", startedTurn: false };
      if (!control.hadTarget) {
        return {
          response: action === "pause" ? "No goal to pause." : "No goal to resume.",
          startedTurn: false,
        };
      }
      if (action === "pause") {
        // legacy pause 有目标时 response 恒 ""（UI 经目标面板收口，不渲染气泡）。
        return { response: "", startedTurn: false };
      }
      const base = control.target ? formatGoalChangedText("Goal resumed", control.target) : "";
      return {
        response: control.planContinuationSkipped
          ? `${base}\n\n${GOAL_PLAN_CONTINUATION_SKIPPED_MESSAGE}`
          : base,
        startedTurn: control.startedTurn,
      };
    }
    // action === "clear"（非 CAS：legacy clear 无 revision 断言）。
    const ack = await client.request(
      V4_METHODS.command,
      createHostCommandEnvelope({
        type: "clearGoal",
        payload: {},
        sessionId: params.sessionId,
      }),
      commandAckSchema,
    );
    assertV4CommandAckOk("clearGoal", ack, `session=${params.sessionId} action=clear`);
    const control = ack.result?.type === "goalControl" ? ack.result : undefined;
    return {
      response: control ? (control.hadTarget ? "Goal cleared." : "No goal to clear.") : "",
      startedTurn: false,
    };
  }

  return {
    async prepareStorage(params) {
      const client = await processManager.getClient(params);
      wireClient(client, params, "chat");
      await client.storageStartup.wait();
    },
    async getStorageStartupState(params) {
      return processManager.getStorageStartupState(params);
    },
    onDynamicStorageStartupState(params) {
      const workspaceKey = resolveWorkspaceKey(params);
      return (listener) =>
        processManager.onStorageStartupChanged((event) => {
          if (event.workspaceKey === workspaceKey) listener(event.snapshot);
        });
    },
    hasActiveCuaOperationTurn(): boolean {
      return cuaOperationTurnTracker?.hasActiveTurn() ?? false;
    },
    async initialize(params: ACodeAgentWorkspaceTarget): Promise<ACodeAgentInitializeResult> {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "开始初始化 ACode agent", {
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        const client = await getClient(params);
        logger.info(undefined, "ACode agent 初始化完成", {
          durationMs: Date.now() - startedAt,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return {
          available: true,
          workspaceKey,
          protocolName: ACODE_PROTOCOL_NAME,
          protocolVersion: ACODE_PROTOCOL_VERSION,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
        };
      } catch (error) {
        const providerNotReady = isProviderNotReadyError(error);
        logger[providerNotReady ? "info" : "warn"](
          undefined,
          providerNotReady ? "ACode agent 等待 provider/model 就绪" : "ACode agent 初始化失败",
          {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
        // initialize 现在承担 host 启动预热职责，但首屏不能因为 agent 缺失直接崩溃。
        // 保留 available=false 结果，让 UI/调用方沿用既有的可恢复错误路径。
        return {
          available: false,
          workspaceKey,
          protocolName: ACODE_PROTOCOL_NAME,
          protocolVersion: ACODE_PROTOCOL_VERSION,
          reason: error instanceof Error ? error.message : String(error),
          ...(providerNotReady ? { reasonCode: ACODE_AGENT_PROVIDER_NOT_READY_REASON } : {}),
        };
      }
    },

    async syncAppRuntimePreferences(preferences: ACodeAgentAppRuntimePreferences): Promise<void> {
      const normalizedPreferences: ACodeAgentAppRuntimePreferences = {
        ...preferences,
        modelIoFullRetentionEnabled: preferences.modelIoFullRetentionEnabled === true,
      };
      latestAppRuntimePreferences = normalizedPreferences;
      const activeClients = [...activeClientsByWorkspaceKey.values()];
      await Promise.all(
        activeClients.map((entry) =>
          enqueueInteractionPreferenceSync({
            client: entry.client,
            preferences: { ...normalizedPreferences },
            workspace: entry.workspace,
          }),
        ),
      );
    },

    async getWorkspaceRuntimeIdentity(params: ACodeAgentWorkspaceTarget) {
      // 查询 runtime identity 只能观察现有进程，不能把 dormant workspace 变成活动进程。
      await getReadOnlyClient(params, "existing-only");
      return await processManager.getRuntimeIdentity(params);
    },

    async createSession(params: ACodeAgentCreateSessionParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_create",
        workspace: params,
      });
      const sessionTraceId = params.sessionTraceId;
      logger.info(sessionTraceId, "开始请求 ACode Protocol session/create", {
        hasInitialModel: params.model !== undefined,
        hasInitialThoughtLevel: params.thoughtLevel !== undefined,
        initialModel: formatModelSelectionForLog(params.model),
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        persistence: params.persistence,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      // M2-3（specs/m2-3-session-readwrite.md §2.8）：create 是偏好物化时机，发命令前
      // 先把最新偏好推给 CLI（推送失败不阻断创建，CLI 沿用上次推送或缺省）。
      await pushSessionRuntimePreferences(client, params, params.sessionId);
      try {
        // M2-3（specs/m2-3-session-readwrite.md §2.1）：legacy session/create →
        // v4/command createSession + ACK 后 v4/session/read 回读。信封经
        // buildConversationCommandEnvelope 同源注入 host 工具面 flag（offPeak/dwf/
        // scriptWorkflow/toolSearchMode）——与桌面 v4 草稿创建路径同口径。
        // commandClientMode 刻意传 undefined：本 facade 不经 trusted carrier（R10.2a
        // 盖章只在 sendConversationCommandV4），伪造值被信封构造剔除后不盖章 =
        // CLI 缺席即 inline（fail-closed），与 legacy session/create 无 clientMode
        // 侧通道的旧行为零差。
        const envelope = await buildConversationCommandEnvelope(
          {
            ...params,
            envelope: createHostCommandEnvelope({
              type: "createSession",
              sessionId: null,
              payload: {
                workspaceId: resolveWorkspaceKey(params),
                // parity 字段直通 legacy createSessionWithProjection 的 rawParams：
                // sessionId 仅限 importedHistory 的裁决、persistence 缺省 deferred、
                // mode/model/thoughtLevel 的 createRecord 语义全在 CLI 下游既有逻辑承载。
                ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                ...(params.persistence !== undefined ? { persistence: params.persistence } : {}),
                ...(params.titleGenerationEnabled !== undefined
                  ? { titleGenerationEnabled: params.titleGenerationEnabled }
                  : {}),
                ...(params.toolAllowlist !== undefined
                  ? { toolAllowlist: params.toolAllowlist }
                  : {}),
                ...(params.toolDenylist !== undefined ? { toolDenylist: params.toolDenylist } : {}),
                // importedHistory 是导入历史的完整性边界，绝不省略——否则会创建一个可切
                // 模型但没有历史内容的空 session。
                ...(params.importedHistory !== undefined
                  ? { importedHistory: params.importedHistory }
                  : {}),
                ...(params.mode !== undefined ? { mode: params.mode } : {}),
                ...(params.model !== undefined ? { model: params.model } : {}),
                ...(params.thoughtLevel !== undefined
                  ? { thoughtLevel: params.thoughtLevel }
                  : {}),
                // desktop-continuous 首发/恢复走 session service，不经过 legacy task adapter。
                // MCP 是 runtime 启动期配置，必须在 create 请求边界显式传递，后续 sendPrompt 无法补上。
                ...(params.mcpServers !== undefined ? { mcpServers: params.mcpServers } : {}),
              },
            }),
          },
          undefined,
        );
        const ack: CommandAck = await client.request(
          V4_METHODS.command,
          envelope,
          commandAckSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        assertV4CommandAckOk("createSession", ack, `workspace=${params.workspacePath}`);
        const sessionId = ack.result?.type === "createSession" ? ack.result.sessionId : undefined;
        if (!sessionId) {
          // ACK accepted 必带 createSession result（taskAdapter v4Create 同款判空先例）。
          throw new Error("v4 createSession accepted without sessionId result");
        }
        // 回读全量快照复刻 legacy session/create 单调用返回快照的契约（host 无本地 v4
        // 投影；与配置写方法的 ACK 后回读同型，见 requestSessionStateSnapshot 注释）。
        const snapshot = await requestSessionStateSnapshot(client, { sessionId });
        rememberSessionTrace({ ...params, sessionId }, snapshot);
        logger.info(sessionTraceId, "ACode Protocol session/create 完成", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          persistence: params.persistence,
          sessionId: snapshot.session.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        // v4 方法名即版本边界：legacy 的新旧 schema 兼容重试（omittedFields 降级）与
        // 兼容重试内补发 session/setThoughtLevel 的链路随本批一起删除。
        logger.warn(sessionTraceId, "ACode Protocol session/create 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          persistence: params.persistence,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async resumeSession(params: ACodeAgentResumeSessionParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_resume",
        workspace: params,
      });
      const cachedTraceId = getSessionTraceId(params);
      // M2-3（specs/m2-3-session-readwrite.md §2.8）：legacy 是 CLI 侧 per-materialization
      // pull 偏好；v4 push 模型下 resume 的 runtime 重建是物化时机，必须先推再查（推送失败
      // 不阻断 resume，CLI 沿用上次推送或缺省）。
      await pushSessionRuntimePreferences(client, params, params.sessionId);
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // 冷恢复同样按 Host 的灰度判定下发，否则恢复出来的会话会丢掉工作流工具簇。
      const dynamicWorkflowEnabled = await resolveDynamicWorkflowGate();
      logger.info(cachedTraceId, "开始请求 ACode Protocol session/resume", {
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        modelHint: params.model ?? null,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        // M2-3：legacy session/resume → v4/session/resume query（CLI handler 直通 legacy
        // resumeSession op，冷恢复/消息保留/thoughtLevel/MCP/工具名单语义逐字一致）。
        // v4 方法名即版本边界，新旧 schema 兼容重试（omittedFields 降级）随 legacy 面一起删除。
        const snapshot = await client.request(
          V4_METHODS.sessionResume,
          {
            sessionId: params.sessionId,
            workspace: buildWorkspaceRef(params),
            ...(params.thoughtLevel !== undefined ? { thoughtLevel: params.thoughtLevel } : {}),
            // 冷恢复 session 时 app-server 可能重新创建 runtime；MCP 同样需要随 resume 请求下发。
            ...(params.mcpServers !== undefined ? { mcpServers: params.mcpServers } : {}),
            // 工具面约束必须和 create 路径一致随 resume 下发，否则冷恢复重建 runtime 后会丢失
            // allow/deny 隔离（CUA 会话会重新可见 Bash 等被禁工具）。
            ...(params.toolAllowlist !== undefined ? { toolAllowlist: params.toolAllowlist } : {}),
            ...(params.toolDenylist !== undefined ? { toolDenylist: params.toolDenylist } : {}),
            // resume 不带该 flag 会让冷恢复丢 Off-Peak 工具面（与 toolAllowlist 同因）。
            ...(offPeakToolEnabled === true ? { offPeakToolEnabled: true } : {}),
            // 同因：resume 不带该 flag 会让冷恢复丢掉工作流工具簇。
            ...(dynamicWorkflowEnabled === true ? { dynamicWorkflowEnabled: true } : {}),
          },
          acodeSessionStateSnapshotSchema,
        );
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ACode Protocol session/resume 完成", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        logger.warn(cachedTraceId, "ACode Protocol session/resume 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async listSessions(params: ACodeAgentListSessionsParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      // M2-3（specs/m2-3-session-readwrite.md §2.3）：legacy session/list → v4/sessions/list
      // query；CLI handler 直通 legacy listSessions op（分页/归档/trace 保留逐字一致）。
      const result = await client.request(
        V4_METHODS.sessionsList,
        {
          workspace: buildWorkspaceRef(params),
          includeArchived: params.includeArchived ?? false,
          limit: params.limit,
          ...(params.sessionIds ? { sessionIds: params.sessionIds } : {}),
        },
        v4SessionsListResultSchema,
      );
      for (const session of result.sessions) {
        if (session.traceId) {
          sessionTraceIdBySessionKey.set(
            sessionEventKey({ ...params, sessionId: session.sessionId }),
            session.traceId as TraceId,
          );
        }
      }
      return result.sessions;
    },

    async listSessionSubagents(params: ACodeAgentListSessionSubagentsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        LEGACY_SURVIVOR_METHODS.sessionSubagents,
        {
          sessionId: params.sessionId,
          endedCursor: params.endedCursor,
          endedLimit: params.endedLimit ?? 20,
        },
        acodeSessionSubagentsResultSchema,
      );
    },

    async getAppUsageStats(params: ACodeAgentAppUsageParams) {
      // usage 表位于全局 session 库；复用任意已连接的 workspace client 即可拿到全应用范围数据。
      const active = activeClientsByWorkspaceKey.values().next().value;
      if (!active) {
        throw new Error("no_active_workspace");
      }
      // usage/stats → v4/usage/stats（additive query，事实源在 CLI usage store，
      // 载荷同形；旧词消费清零，CLI 旧 case 留到旧词删除之时）。
      return active.client.request(
        V4_METHODS.usageStats,
        { range: params.range, timeZone: params.timeZone },
        v4UsageStatsResultSchema,
      );
    },

    async getTaskTokenUsage(params: ACodeAgentTaskTokenUsageParams) {
      const client = await getReadOnlyClient(params);
      // session/usage → v4/conversation/usage（同上；task 是 UI 投影概念，
      // v4 名字空间落位 conversation）。
      return client.request(
        V4_METHODS.conversationUsage,
        { sessionId: params.sessionId },
        v4ConversationUsageResultSchema,
      );
    },

    async readSession(params: ACodeAgentReadSessionParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      // task-index 为补正文索引调用 readSession 时，默认策略会在 runtime
      // 已被回收后重新拉起 Agent；这条观察路径不应改变 session 生命周期。只有显式
      // 的普通读取才同步 provider registry，existing-only 读取必须保持纯观察语义。
      if (params.runtimePolicy !== "existing-only") {
        await ensureAccountProviderConfigSynced({
          client,
          reason: "session_read",
          workspace: params,
        });
      }
      const snapshot = await requestSessionStateSnapshot(client, params);
      rememberSessionTrace(params, snapshot);
      return snapshot;
    },

    async readSessionHeaderMeta(params: ACodeAgentSessionTarget) {
      // 归档 header 冷读（apps/acode-cli/specs/v4-session-header-meta.md）。与 readSession 三点不同：
      // ① 用默认 runtimePolicy（start-if-needed）而非 existing-only——归档任务的 workspace 进程可能
      //    已回收，existing-only 会在无进程时抛 createRuntimeUnavailableError，让兜底读直接失败
      //    （spec R2）。这里复用 workspace 进程，但**不建 session record / 不激活 session 运行时**：
      //    CLI 侧 handler 只读持久层（sessionStore.getSession/readTarget/sessionEntries），不碰
      //    context.sessions。
      // ② 不 ensureAccountProviderConfigSynced——header 只回持久元数据，不依赖 provider 配置同步，
      //    为一个兜底读触发账号同步是不必要的副作用。
      // ③ 不 rememberSessionTrace——那是 readSession 快照消费链的职责；header meta 是纯展示兜底，
      //    往 sessionTraceIdBySessionKey 写会是第二条 trace 写入路径（AGENTS.md：单一写入路径）。
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.sessionHeaderMeta,
        { sessionId: params.sessionId },
        v4SessionHeaderMetaResultSchema,
      );
    },

    async readSessionMessages(params: ACodeAgentReadSessionMessagesParams) {
      const client = await getReadOnlyClient(params);
      // M2-3（specs/m2-3-session-readwrite.md §2.5）：legacy session/messages →
      // v4/session/messages query；afterMessageId 越界抛错 + 尾切片语义由直通 op 承载。
      // result 不挂 schema 校验（legacy parity）：wire 直通 raw opencode MessageWithParts
      // （info.id 词汇），legacy services 对 barrel result schema 仅是孤儿 import 从不
      // 校验；normalized 词汇（messageId/sessionId）只存在于 session/read snapshot 的
      // mapMessageWithParts 路径。接口返回类型是历史类型谎言，原样承载（spec §6 登记）。
      const result = await client.request<{ messages: ACodeMessageWithParts[] }>(
        V4_METHODS.sessionMessages,
        {
          sessionId: params.sessionId,
          afterMessageId: params.afterMessageId,
          limit: params.limit,
        },
      );
      return result.messages;
    },

    async readSessionDebug(params) {
      // M2-2：legacy session/debug → v4/session/debug query（裁决：sessionDebug 保留新建
      // v4 query，spec m2-2-session-control.md §2.4）。result schema 同形直通
      // （v4SessionDebugResultSchema = sessionDebugSnapshotSchema 中立叶复用）；
      // existing-only 策略与 live-only 语义不变（无 record 时 CLI 侧 requireSession 抛错）。
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(
        V4_METHODS.sessionDebug,
        { sessionId: params.sessionId },
        v4SessionDebugResultSchema,
      );
    },

    async readSessionEvents(params: ACodeAgentReadSessionEventsParams) {
      const client = await getReadOnlyClient(params);
      // M2-3（specs/m2-3-session-readwrite.md §2.6）：legacy session/events →
      // v4/session/events query；独立事件日志查询面保留（裁决：不并入 conversation
      // frame），afterSeq/尾切片语义由直通 op 承载，结果校验沿用既有 barrel schema。
      const result = await client.request(
        V4_METHODS.sessionEvents,
        {
          sessionId: params.sessionId,
          afterSeq: params.afterSeq,
          limit: params.limit,
        },
        acodeSessionEventsResultSchema,
      );
      return result.events;
    },

    async readWorkspacePresentation(params: ACodeAgentReadWorkspacePresentationParams) {
      const startedAt = Date.now();
      logger.info(undefined, "开始请求 ACode Protocol workspace/readPresentation", {
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        let presentation: V4WorkspacePresentation | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const client = await getReadOnlyClient(params);
          try {
            await ensureAccountProviderConfigSynced({
              client,
              reason: "workspace_read_presentation",
              workspace: params,
            });
            presentation = await client.request(
              V4_METHODS.workspaceReadPresentation,
              { workspace: buildWorkspaceRef(params) },
              v4WorkspacePresentationSchema,
            );
            break;
          } catch (error) {
            if (attempt > 0 || !isClosedStdioTransportError(error)) {
              throw error;
            }
            // 读取 workspace 状态时，配置更新可能正好重启该 workspace Agent。
            // 旧 client 已取得但尚未发送请求，stdio transport 就被关闭；只读请求重新获取
            // 当前 client 并重试一次，避免把生命周期竞态直接暴露给用户。
            logger.warn(
              undefined,
              "workspace/readPresentation 命中已关闭 transport，重新获取 Agent",
              {
                workspaceKey: resolveWorkspaceKey(params),
                workspacePath: params.workspacePath,
              },
            );
            const workspaceKey = resolveWorkspaceKey(params);
            if (activeClientsByWorkspaceKey.get(workspaceKey)?.client === client) {
              // transport.send 可能先观察到关闭，而 onClose 清理尚未执行；统一走 identity-
              // guarded invalidation，避免只删 active entry 却遗留 preference/model sync 状态。
              invalidateWorkspaceClient(workspaceKey, client);
            }
          }
        }
        if (!presentation) {
          throw new Error("ACode Protocol workspace/readPresentation did not return a result");
        }
        logger.info(undefined, "ACode Protocol workspace/readPresentation 完成", {
          durationMs: Date.now() - startedAt,
          slashCommandCount: presentation.slashCommands.length,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return presentation;
      } catch (error) {
        logger.warn(undefined, "ACode Protocol workspace/readPresentation 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async grantWorkspaceHookTrust(params: ACodeAgentGrantWorkspaceHookTrustParams) {
      // 没有 task 时仍允许显式预信任，但只启动 read-only Agent 控制面；不能为了
      // Settings 操作伪造 session，也不能要求 provider/model 已就绪。
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.workspaceHookTrustGrant,
        {
          workspace: buildWorkspaceRef(params),
          bundleDigest: params.bundleDigest,
          hookDeclarationDigest: params.hookDeclarationDigest,
        },
        v4WorkspaceHookTrustGrantResultSchema,
      );
    },

    async listMcpServerStatuses(params: ACodeAgentListMcpServerStatusesParams) {
      // M2-6：mcp/list → v4/mcp/list（载荷逐字 parity；specs/m2-6-workflows-skills-mcp.md）。
      // legacy 的 unrecognizedKeys 兼容重试链不迁：它服务 legacy strict-parse 旧 Agent，
      // v4 方法名本身就是版本边界（不认识的旧 CLI 报 -32601 而非 -32602）。
      // ACodeAgentMcpStatusModeUnsupportedError 保持导出（UI 仍引用该符号），本路径不再抛出。
      const requestMcpList = async () => {
        const client = await getMcpStatusClient();
        return client.request(
          V4_METHODS.mcpList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.mcpServers !== undefined ? { mcpServers: params.mcpServers } : {}),
            ...(params.mode !== undefined ? { mode: params.mode } : {}),
          },
          v4McpListResultSchema,
        );
      };
      try {
        return await requestMcpList();
      } catch (error) {
        if (!isProtocolRequestTimeout(error, V4_METHODS.mcpList)) {
          throw error;
        }
        logger.warn(undefined, "MCP 状态列表请求超时，重启无响应 agent 后重试一次", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        return await requestMcpList();
      }
    },

    async listPlugins(params: ACodeAgentPluginViewParams) {
      const requestPluginsList = async () => {
        const client = await getPluginManagementClient();
        // v4/plugins/list（M2-5 迁移）只读取本地 plugin metadata，与 mcp/list 一样走默认协议超时，
        // 这样 stale client 能在合理时间内触发回收并重试，而不是被 5 分钟市场 I/O 超时拖住。
        return client.request(
          V4_METHODS.pluginsList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.configScope ? { configScope: params.configScope } : {}),
          },
          v4PluginsListResultSchema,
        );
      };
      try {
        return await requestPluginsList();
      } catch (error) {
        if (!isProtocolRequestTimeout(error, V4_METHODS.pluginsList)) {
          throw error;
        }
        logger.warn(undefined, "插件列表请求超时，重启无响应 agent 后重试一次", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        // 插件列表只读取 CLI plugin metadata。若旧 agent 进程还活着但协议不回包，
        // 第一次 plugins/list 超时后不能继续复用 stale client。process manager 会在超时时回收该 client，
        // 这里对幂等的列表请求重试一次，让设置页可从重新拉起的 app-server 自动恢复。
        return await requestPluginsList();
      }
    },

    async getPluginReferenceCatalog(params: ACodeAgentPluginReferenceCatalogParams) {
      // Plugin 引用 catalog 必须打到持有 session 记录的 workspace agent client
      // （getReadOnlyClient 优先复用 active client），不能走独立 plugin management 进程——
      // 那个进程没有任何 session，session-owned catalog 会永远查不到。
      const client = await getReadOnlyClient(params);
      return requestPluginReferenceCatalog(client, {
        workspace: buildWorkspaceRef(params),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
    },

    async getSkillReferenceCatalog(params: ACodeAgentSkillReferenceCatalogParams) {
      // 与 Plugin 引用一样，Session 快照只存在于 workspace agent 进程；独立管理进程
      // 没有 resident Session，不能作为对话 authority。
      const client = await getReadOnlyClient(params);
      // M2-6：skills/referenceCatalog → v4/skills/referenceCatalog（载荷逐字 parity）。
      return client.request(
        V4_METHODS.skillsReferenceCatalog,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        },
        v4SkillsReferenceCatalogResultSchema,
      );
    },

    // 已保存工作流的 GUI 中枢：与 Skill catalog 同一条
    // workspace agent client 路径；文件在 workspace 里，远程 workspace 就在远端进程里扫。
    // 全局档：载体由 resolveSavedWorkflowCarrier 选，
    // `scope` 只在有定义时下推。
    async listSavedWorkflows(params: ACodeAgentListSavedWorkflowsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      // M2-6：workflows/* → v4/workflows/*（载荷逐字 parity）。
      return client.request(
        V4_METHODS.workflowsList,
        { workspace, ...savedWorkflowScopeParam(params) },
        v4WorkflowsListResultSchema,
      );
    },

    async getSavedWorkflow(params: ACodeAgentGetSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        V4_METHODS.workflowsGet,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        v4WorkflowsGetResultSchema,
      );
    },

    async updateSavedWorkflowMeta(params: ACodeAgentUpdateSavedWorkflowMetaParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        V4_METHODS.workflowsUpdateMeta,
        { workspace, name: params.name, meta: params.meta, ...savedWorkflowScopeParam(params) },
        v4WorkflowsUpdateMetaResultSchema,
      );
    },

    async deleteSavedWorkflow(params: ACodeAgentDeleteSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        V4_METHODS.workflowsDelete,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        v4WorkflowsDeleteResultSchema,
      );
    },

    async listSavedWorkflowRuns(params: ACodeAgentListSavedWorkflowRunsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        V4_METHODS.workflowsRuns,
        {
          workspace,
          ...(params.name === undefined ? {} : { name: params.name }),
          limit: params.limit,
          ...savedWorkflowScopeParam(params),
        },
        v4WorkflowsRunsResultSchema,
      );
    },

    // 把全局档搬回项目档（只此一向）：
    // `workspace` 必带，既是载体又是目标项目（协议处理器据它算项目根），因此走
    // getReadOnlyClient(params) 直通，不经全局载体选择。
    async moveSavedWorkflow(params: ACodeAgentMoveSavedWorkflowParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.workflowsMove,
        { workspace: buildWorkspaceRef(params), name: params.name },
        v4WorkflowsMoveResultSchema,
      );
    },

    async resolveSuggestedPluginReference(params: ACodeAgentResolveSuggestedPluginReferenceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsResolveSuggestedReference,
        {
          workspace: buildWorkspaceRef(params),
          stableId: params.stableId,
          operationId: params.operationId,
          clientMode: params.clientMode,
          deliveryKind: params.deliveryKind,
        },
        v4PluginsResolveSuggestedReferenceResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    onDynamicPluginOperationProgress(operationId: string) {
      return getPluginOperationProgressEmitter(operationId).event;
    },

    async collectLocalRuntimeChildProcesses(signal?: AbortSignal) {
      const managed = [processManager, pluginProcessManager, mcpStatusProcessManager]
        .flatMap((manager) => manager.listManagedProcesses())
        .filter(
          (runtime) => !runtime.client.isDisposed && !runtime.client.storageStartup.isWaiting,
        );
      return Promise.all(
        managed.map(async (runtime) => {
          let children: V4ProcessChildProcess[] = [];
          try {
            const result = await runtime.client.request(
              V4_METHODS.processChildProcesses,
              {},
              v4ProcessChildProcessesResultSchema,
              { timeoutMs: CHILD_PROCESSES_REQUEST_TIMEOUT_MS, lifecycle: "observation", signal },
            );
            children = result.processes;
          } catch {
            // 旧 CLI 不认识该方法或 runtime 正忙：本轮该 Agent 的后代全部归 cli，不影响其它 runtime。
          }
          return {
            pid: runtime.pid,
            provider: ACODE_AGENT_PROVIDER,
            workspacePath: runtime.workspacePath,
            ...(runtime.lane ? { lane: runtime.lane } : {}),
            children,
          };
        }),
      );
    },

    async getPluginsOverview(params: ACodeAgentPluginViewParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsOverview,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.configScope ? { configScope: params.configScope } : {}),
        },
        v4PluginsOverviewResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async addPluginMarketplace(params: ACodeAgentAddPluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsMarketplaceAdd,
        {
          workspace: buildWorkspaceRef(params),
          source: params.source,
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        v4PluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async removePluginMarketplace(params: ACodeAgentRemovePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsMarketplaceRemove,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
        },
        v4PluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePluginMarketplace(params: ACodeAgentUpdatePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsMarketplaceUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        v4PluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async installPlugin(params: ACodeAgentInstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsInstall,
        {
          workspace: buildWorkspaceRef(params),
          pluginName: params.pluginName,
          marketplace: params.marketplace,
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        v4PluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async cancelPluginOperation(params: ACodeAgentCancelPluginOperationParams) {
      const client = await getPluginManagementClient();
      return client.request(
        LEGACY_SURVIVOR_METHODS.pluginsCancelOperation,
        { operationId: params.operationId },
        acodePluginsCancelOperationResultSchema,
        { timeoutMs: PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS },
      );
    },

    async uninstallPlugin(params: ACodeAgentUninstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsUninstall,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.removeCache !== undefined ? { removeCache: params.removeCache } : {}),
        },
        v4PluginsUninstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePlugin(params: ACodeAgentUpdatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
        },
        v4PluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async restoreBuiltinPlugin(params: ACodeAgentRestoreBuiltinPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsRestoreBuiltin,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
        },
        v4PluginsRestoreBuiltinResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async configurePlugin(params: ACodeAgentConfigurePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsConfigure,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          options: params.options,
          ...(params.clearOptionKeys?.length ? { clearOptionKeys: params.clearOptionKeys } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
        },
        v4PluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async resetPluginConfig(params: ACodeAgentResetPluginConfigParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsResetConfig,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          ...(params.scope ? { scope: params.scope } : {}),
        },
        v4PluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async validatePlugin(params: ACodeAgentValidatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsValidate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.source ? { source: params.source } : {}),
        },
        v4PluginsValidateResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async describePlugin(params: ACodeAgentDescribePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsDescribe,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
          pluginName: params.pluginName,
        },
        v4PluginsDescribeResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async setPluginEnabled(params: ACodeAgentSetPluginEnabledParams) {
      const client = await getPluginManagementClient();
      return client.request(
        V4_METHODS.pluginsSetEnabled,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          enabled: params.enabled,
          ...(params.operationId ? { operationId: params.operationId } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
        },
        v4PluginsSetEnabledResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async listAutomations(params: ACodeAgentWorkspaceTarget) {
      return automationService.list(params);
    },

    async listAllAutomations() {
      return automationService.list();
    },

    async createAutomation(params: ACodeAgentCreateAutomationParams) {
      return automationService.create({
        title: params.title,
        cronExpr: params.cronExpr,
        relativeDelayMinutes: params.relativeDelayMinutes,
        prompt: params.prompt,
        modelSelection: params.modelSelection,
        mode: params.mode as ACodeTaskMode | undefined,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        recurring: params.recurring ?? true,
        maxRuns: params.maxRuns,
        endAt: params.endAt,
        scheduleRule: params.scheduleRule,
      });
    },

    async updateAutomation(params: ACodeAgentUpdateAutomationParams) {
      return automationService.update(
        params.automationId,
        {
          title: params.title,
          cronExpr: params.cronExpr,
          prompt: params.prompt,
          modelSelection: params.modelSelection,
          mode: params.mode === null ? null : (params.mode as ACodeTaskMode | undefined),
          recurring: params.recurring,
          maxRuns: params.maxRuns,
          endAt: params.endAt,
          scheduleRule: params.scheduleRule,
          scheduleEditedByUser: params.scheduleEditedByUser,
        },
        // 归属校验：写操作必须限定在调用方当前 workspace，禁止跨 workspace 越权。
        {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      );
    },

    async deleteAutomation(params: ACodeAgentAutomationIdParams) {
      await automationService.delete(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async setAutomationEnabled(params: ACodeAgentSetAutomationEnabledParams) {
      return automationService.setEnabled(params.automationId, params.enabled, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async restartAutomation(params: ACodeAgentAutomationIdParams) {
      return automationService.restart(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async runAutomationNow(params: ACodeAgentRunAutomationNowParams) {
      const dispatch = options?.onAutomationManualRunRequested;
      if (!dispatch) {
        // runNow 会先写 manual run 并占用 single-flight claim；dispatcher
        // 缺失是同步可判定的配置错误，必须在认领前失败，不能依赖 stale 崩溃回收。
        throw new Error("Automation immediate dispatcher is unavailable.");
      }
      // 用户激活守卫（specs/scheduled-manual-trigger-activation.md）：origin 是装配层
      // 声明的传输事实，activation 是调用方携带的用户动作凭据（wire 形状未知，校验归
      // shared 守卫）；两者都缺席时 trigger 不组装 = 兼容窗放行。拒绝发生在 runNow 的
      // repo claim 之前——不产生 run 行、不占 single-flight 锁。
      const origin = options?.automationManualTriggerOrigin;
      const trigger: AutomationManualRunTriggerContext | undefined =
        origin !== undefined || params.userActivation !== undefined
          ? {
              ...(origin !== undefined ? { origin } : {}),
              ...(params.userActivation !== undefined ? { activation: params.userActivation } : {}),
            }
          : undefined;
      let claimed;
      try {
        claimed = await automationService.runNow(
          params.automationId,
          {
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          },
          trigger,
        );
      } catch (error) {
        if (error instanceof AutomationManualTriggerRejectedError) {
          return { status: "rejected" as const, reason: error.reason };
        }
        throw error;
      }
      if (!claimed) {
        // single-flight 已拒绝重复运行时，旧的空成功返回会被 UI 误判为
        // 新 run 已入队，导致每次重复点击都展示一次“已触发”。
        return { status: "duplicate" as const };
      }
      await dispatch(claimed);
      return { status: "queued" as const };
    },

    async listAutomationRuns(params: ACodeAgentAutomationIdParams) {
      return automationService.listRuns(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async deleteAutomationRun(params: ACodeAgentDeleteAutomationRunParams) {
      return automationService.deleteRun(params.runId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async generateWorkspaceText(params: ACodeAgentGenerateWorkspaceTextParams) {
      const client = await getClient(params);
      // Worker 自己读取 ACode Built-in / Personal Config；Host 只在执行前确保账号状态形成的
      // Account Config Overlay 已同步，避免新进程先按旧套餐状态创建 Model。
      await ensureAccountProviderConfigSynced({
        client,
        reason: "workspace_generate_text",
        workspace: params,
      });
      // 跨 RPC 调用方（renderer 代理）的 signal 序列化后是缺 addEventListener 的普通
      // 对象：只有真实 signal 才接本地取消通知；跨界调用方自传 operationId 并走
      // cancelWorkspaceGenerateText（specs/prompt-polish.md，E2E D1 回归）。
      const hasLocalSignal = typeof params.signal?.addEventListener === "function";
      const operationId = params.operationId ?? (hasLocalSignal ? randomUUID() : undefined);
      const cancel = () => {
        if (!operationId) return;
        void client
          .request(
            V4_METHODS.workspaceCancelGenerateText,
            { operationId },
            v4WorkspaceCancelGenerateTextResultSchema,
            { timeoutMs: 5_000 },
          )
          .catch((error: unknown) => {
            // 取消是 best-effort 控制面操作，失败不能覆盖调用方原本的 AbortError；
            // 保留 debug 轨迹用于区分“本地停止等待”和“CLI 已收到取消”。
            logger.debug(undefined, "workspace 模型请求取消通知失败", {
              operationId,
              workspaceKey: resolveWorkspaceKey(params),
              error: error instanceof Error ? error.message : String(error),
            });
          });
      };
      if (hasLocalSignal) params.signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await client.request(
          V4_METHODS.workspaceGenerateText,
          {
            workspace: buildWorkspaceRef(params),
            selection: params.selection,
            ...(params.prompt ? { prompt: params.prompt } : {}),
            ...(params.messages ? { messages: params.messages } : {}),
            ...(params.tools ? { tools: params.tools } : {}),
            querySource: params.querySource,
            ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
            ...(operationId ? { operationId } : {}),
          },
          v4WorkspaceGenerateTextResultSchema,
          // 不传 timeoutMs 时协议 client 默认 3 分钟超时会对 thinking 模型的长请求
          // 先于调用方自身 deadline 触发，并被 onRequestTimeout 误判 stale 杀进程。
          // 调用方显式传入 requestTimeoutMs（自身 deadline + 取消缓冲）时以其为准。
          {
            ...(hasLocalSignal && params.signal ? { signal: params.signal } : {}),
            ...(params.requestTimeoutMs ? { timeoutMs: params.requestTimeoutMs } : {}),
          },
        );
      } finally {
        if (hasLocalSignal) params.signal?.removeEventListener("abort", cancel);
      }
    },

    async cancelWorkspaceGenerateText(params: ACodeAgentCancelWorkspaceGenerateTextParams) {
      const client = await getClient(params);
      try {
        return await client.request(
          V4_METHODS.workspaceCancelGenerateText,
          { operationId: params.operationId },
          v4WorkspaceCancelGenerateTextResultSchema,
          { timeoutMs: 5_000 },
        );
      } catch (error: unknown) {
        // 取消是 best-effort 控制面：失败不抛回调用方（调用方语义=丢弃回包，由
        // 代际守卫兜底）；保留 debug 轨迹区分「本地已停等」与「CLI 已收到取消」。
        logger.debug(undefined, "workspace 模型请求取消通知失败", {
          operationId: params.operationId,
          workspaceKey: resolveWorkspaceKey(params),
          error: error instanceof Error ? error.message : String(error),
        });
        return { cancelled: false, operationId: params.operationId };
      }
    },

    async testModelConnectivity(params: ACodeAgentTestModelConnectivityParams) {
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "provider_test_model_connectivity",
        workspace: params,
      });
      return client.request(
        V4_METHODS.providerTestModelConnectivity,
        {
          workspace: buildWorkspaceRef(params),
          selection: params.selection,
        },
        v4ProviderTestModelConnectivityResultSchema,
        { signal: params.signal },
      );
    },

    async sendPrompt(params: ACodeAgentSendPromptParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      const sessionTraceId = params.sessionTraceId?.trim() || getSessionTraceId(params);
      const logTraceId = sessionTraceId ?? params.inputId;
      const browserAmbientContext =
        params.browserAmbientContext ??
        (await collectBrowserAmbientContext(options?.browserControlExecutor, {
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        }));
      const protocolParams: ACodeAgentSendPromptParams = {
        ...params,
        ...(browserAmbientContext ? { browserAmbientContext } : {}),
      };
      logger.info(logTraceId, "ACode Agent session/send 开始", {
        attachmentCount: params.attachments?.length ?? 0,
        hasBrowserAmbientContext: browserAmbientContext !== undefined,
        inputId: params.inputId,
        queryId: params.queryId ?? null,
        sessionId: params.sessionId,
        sessionTraceId: sessionTraceId ?? null,
        textLength: params.content.length,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          LEGACY_SURVIVOR_METHODS.sessionSend,
          buildSessionSendParams(protocolParams),
          acodeSessionSendResultSchema,
        );
        logger.info(logTraceId, "ACode Agent session/send ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        const compatFields = getSessionSendCompatFields(error);
        if (compatFields.length > 0) {
          logger.warn(logTraceId, "ACode Agent session/send 命中新旧协议兼容重试", {
            compatFields,
            durationMs: Date.now() - startedAt,
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          const result = await client.request(
            LEGACY_SURVIVOR_METHODS.sessionSend,
            buildSessionSendParams(protocolParams, new Set(compatFields)),
            acodeSessionSendResultSchema,
          );
          return result;
        }
        logger.warn(logTraceId, "ACode Agent session/send 失败", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async compactSession(params: ACodeAgentCompactParams) {
      // M2-2：legacy session/compact → v4 compact 命令（spec m2-2-session-control.md §2.1）。
      // instructions 透传（M2-1 协议面已落，本批消费接线）；非 CAS（admission 与 revision
      // 无关，protocol 注释）；expectedRevision 不透传（legacy stateRevision 与 v4
      // conversation revision 不互通，M2-1 同例）。compactOperationLock（compact 运行中/
      // 已入队）映回 legacy already_running graceful 收口；busy 入队是 v4 原生语义
      // （legacy 抛 -32010，有意收敛，adapter 无依赖）。facade 全量快照契约经 ACK 后
      // 回读保持（requestSessionStateSnapshot，M2-1 单点）。
      const startedAt = Date.now();
      const client = await getClient(params);
      const sessionTraceId = getSessionTraceId(params);
      logger.info(sessionTraceId ?? params.inputId, "ACode Protocol v4 compact 开始（M2-2，legacy 已迁）", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const ack = await client.request(
          V4_METHODS.command,
          createHostCommandEnvelope({
            type: "compact",
            payload: params.instructions ? { instructions: params.instructions } : {},
            sessionId: params.sessionId,
            // commandId=inputId 对齐：compact turn 终态事件的 inputId 与 host command
            // queue 的 traceId 对账收口（sendText 同例）。
            ...(params.inputId ? { commandId: params.inputId } : {}),
          }),
          commandAckSchema,
          {
            // compact 的模型维护态可能进入分钟级窗口；这里放宽的是 ACK 边界，
            // 终态仍由 session timeline / snapshot 推送，不能把它当作同步 compact 结果。
            timeoutMs: SESSION_COMPACT_REQUEST_TIMEOUT_MS,
          },
        );
        // already_running 等价物：legacy 在 compact 运行中 graceful 返回
        // {compact.state:"already_running"}；v4 同情形是 failed ACK + compactOperationLock。
        // 只把这一个 reasonCode 映回 graceful，其余失败一律抛（spec §4）。
        const alreadyRunning =
          ack.status === "failed" && ack.reasonCode === "compactOperationLock";
        if (!alreadyRunning) {
          assertV4CommandAckOk("compact", ack, `session=${params.sessionId}`);
        }
        const snapshot = await requestSessionStateSnapshot(client, {
          sessionId: params.sessionId,
        });
        const result = {
          response: "",
          snapshot,
          compact: {
            state: alreadyRunning ? ("already_running" as const) : ("accepted" as const),
            ...(params.inputId ? { inputId: params.inputId } : {}),
          },
        };
        logger.info(sessionTraceId ?? params.inputId, "ACode Protocol v4 compact ACK", {
          compactState: result.compact.state,
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(sessionTraceId ?? params.inputId, "ACode Protocol v4 compact 失败", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async goalSession(params: ACodeAgentGoalParams) {
      // M2-2：legacy session/goal → v4 goal 命令族 + goal query（spec §2.2，分派细节
      // 在 dispatchGoalActionV4）。回执文本由 goalControl typed result / goal query
      // 逐字推导（旧 op 已删）；全量快照契约经 ACK 后回读保持（M2-1 同例）；
      // expectedRevision 不透传（legacy stateRevision 与 v4 conversation revision 不互通）。
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(params.inputId, "开始请求 v4 goal 控制（M2-2，legacy session/goal 已迁）", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const outcome = await dispatchGoalActionV4(client, params);
        const snapshot = await requestSessionStateSnapshot(client, {
          sessionId: params.sessionId,
        });
        const result = {
          response: outcome.response,
          snapshot,
          startedTurn: outcome.startedTurn,
        };
        logger.info(params.inputId, "v4 goal 控制完成", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          messageCount: result.snapshot.messages.length,
          responseLength: result.response?.length ?? 0,
          sessionId: params.sessionId,
          startedTurn: result.startedTurn,
          status: result.snapshot.session.status,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(params.inputId, "v4 goal 控制失败", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async closeSession(
      params: ACodeAgentSessionTarget & {
        expectedPersistence?: "deferred" | "immediate";
      },
    ): Promise<boolean> {
      // M2-2：legacy session/close → v4 closeSession 命令（裁决 2026-10-28：close≠delete
      // 两语义并存；expectedPersistence 断言由 v4 payload 等价承载，断言裁决经 typed
      // result 的 closed 字段上行，spec m2-2-session-control.md §2.3）。
      const client = await getClient(params);
      const ack = await client.request(
        V4_METHODS.command,
        createHostCommandEnvelope({
          type: "closeSession",
          payload: params.expectedPersistence
            ? { expectedPersistence: params.expectedPersistence }
            : {},
          sessionId: params.sessionId,
        }),
        commandAckSchema,
      );
      assertV4CommandAckOk("closeSession", ack, `session=${params.sessionId}`);
      // v4 必带 closeSession typed result；缺省 true 保留旧兼容行
      // （面向不产 result 的旧 Agent 容忍）。
      return ack.result?.type === "closeSession" ? ack.result.closed : true;
    },

    async setModel(params: ACodeAgentSetModelParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(undefined, "开始请求 v4 switchModelConfig（M2-1，legacy session/setModel 已迁）", {
        expectedRevision: params.expectedRevision ?? null,
        persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed ?? null,
        requestedModel: formatModelSelectionForLog(params.model),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        // M2-1：legacy session/setModel → v4 switchModelConfig。一条命令承载
        // provider/model/thought 三件套；thought 缺省 = 目标模型默认档（与 legacy
        // app.setModel(selection) 同语义）。expectedRevision 是旧 stateRevision 计数器，
        // 与 v4 conversation revision 不互通，CAS 由 stale ACK 收敛承担；
        // persistAsWorkspaceLastUsed 在 legacy CLI 侧本就是解析后未消费的死字段，不迁。
        await sendSessionConfigCommandV4(
          client,
          params.sessionId,
          "switchModelConfig",
          {
            provider: params.model.providerId,
            model: params.model.modelId,
            thought: params.model.options?.reasoningLevel ?? "",
          },
          `session=${params.sessionId} model=${params.model.providerId}/${params.model.modelId}`,
        );
        // 保持 facade 返回契约（变更后全量快照）：v4 命令只回 ACK，快照经 session/read 回读。
        const snapshot = await requestSessionStateSnapshot(client, params);
        logger.info(undefined, "v4 switchModelConfig（session/setModel）完成", {
          durationMs: Date.now() - startedAt,
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          snapshotModel: formatModelSelectionForLog(snapshot.settings.model.current),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        logger.warn(undefined, "v4 switchModelConfig（session/setModel）失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async setThoughtLevel(params: ACodeAgentSetThoughtLevelParams) {
      const client = await getClient(params);
      if (!params.thoughtLevel) {
        // legacy CLI handler 的同款拒绝（"thoughtLevel is required"），迁移后前置到 host 侧。
        throw new Error("thoughtLevel is required");
      }
      // M2-1：legacy session/setThoughtLevel → v4 switchModelConfig。v4 无独立思考深度
      // 命令，thought 字段承载；provider/model 取当前会话选型（与桌面 v4 工具条
      // setConfigOption 同一命令面）。前置读用于定位当前选型，返回契约要求的
      // 变更后快照在 ACK 后再读一次。
      const current = await requestSessionStateSnapshot(client, params);
      const model = current.settings.model.current;
      // 未绑定会话可以查看，但单独切档位不能猜测 Provider/Model。
      if (!model) throw new Error("请先选择模型，再设置思考档位");
      await sendSessionConfigCommandV4(
        client,
        params.sessionId,
        "switchModelConfig",
        {
          provider: model.providerId,
          model: model.modelId,
          thought: params.thoughtLevel,
        },
        `session=${params.sessionId} thought=${params.thoughtLevel}`,
      );
      return requestSessionStateSnapshot(client, params);
    },

    async setMode(params: ACodeAgentSetModeParams) {
      const client = await getClient(params);
      // M2-1：legacy session/setMode → v4 switchCollaborationMode。auto 值域已补回
      // v4 枚举（M2-1 裁决 2026-10-28，不收窄 legacy 能力），六值全量直透。
      await sendSessionConfigCommandV4(
        client,
        params.sessionId,
        "switchCollaborationMode",
        { mode: params.mode },
        `session=${params.sessionId} mode=${params.mode}`,
      );
      // 保持 facade 返回契约（变更后全量快照）：ACK 后经 session/read 回读。
      return requestSessionStateSnapshot(client, params);
    },

    async respondSessionRuntimePreferences(
      params: ACodeAgentRespondSessionRuntimePreferencesParams,
    ): Promise<void> {
      const pending = takePendingSessionRuntimePreferences(params.requestId);
      if (!pending) {
        logger.warn(undefined, "运行时偏好响应找不到 pending 请求", {
          event: "acode_agent.runtime_preferences.response_without_pending",
          module: "services.acode_agent",
          requestId: params.requestId,
        });
        throw new Error(`ACode session runtime preferences request not found: ${params.requestId}`);
      }
      const responseContext = {
        event: "acode_agent.runtime_preferences.host_response_received",
        module: "services.acode_agent",
        requestId: params.requestId,
        scope: pending.request.scope,
        sessionId: pending.request.sessionId,
        workspaceKey: pending.workspaceKey,
      };
      if (params.resolution.status === "failed") {
        logger.warn(undefined, "Host 返回运行时偏好失败", {
          ...responseContext,
          error: params.resolution.message,
        });
        // M2-3：push 模型下没有 CLI respond 通道；失败改为 reject 内部 await。
        pending.reject(new Error(params.resolution.message));
        return;
      }
      let preferences: ACodeSessionRuntimePreferencesResult;
      try {
        preferences = acodeSessionRuntimePreferencesResultSchema.parse(
          params.resolution.preferences,
        );
      } catch (error) {
        logger.warn(undefined, "Host 返回运行时偏好格式非法", {
          ...responseContext,
          error: error instanceof Error ? error.message : String(error),
        });
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      pending.resolve(preferences);
      logger.info(undefined, "运行时偏好响应已回传 Agent", responseContext);
    },

    onDynamicSessionRuntimePreferencesRequest() {
      return (listener) => {
        const disposable = sessionRuntimePreferencesRequestEmitter.event(listener);
        for (const pending of pendingSessionRuntimePreferences.values()) {
          listener(pending.request);
        }
        return disposable;
      };
    },

    onDynamicSessionEvent(params: ACodeAgentSessionSubscribeParams) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        // cancelled / retryTimer 的作用域是单个订阅者：调用方 dispose 时取消自己的重试，
        // 不影响共享 emitter 上的其他订阅者。
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let subscriptionReady = false;
        const pendingLiveEvents: ACodeAgentServiceEvent[] = [];
        const deliveredEventIds = new Set<string>();
        const deliveredEventIdOrder: string[] = [];
        const eventCoalescer =
          params.eventCoalescing?.mode === "background-summary"
            ? createBackgroundSessionEventCoalescer({
                emit: listener,
                flushDelayMs: params.eventCoalescing.intervalMs,
              })
            : null;

        const deliverToListener = (event: ACodeAgentServiceEvent): void => {
          if (cancelled) {
            return;
          }
          if (event.type === "session.event") {
            const firstDelivery = rememberBoundedEventId(
              deliveredEventIds,
              deliveredEventIdOrder,
              event.event.eventId,
            );
            if (!firstDelivery) {
              return;
            }
          }
          // 性能优化：后台 task 只需要低频摘要，不能让不可见任务的 token/progress
          // 同频唤醒 renderer；active 订阅没有 eventCoalescing，仍保持实时 continuous。
          if (eventCoalescer) {
            eventCoalescer.accept(event);
            return;
          }
          listener(event);
        };

        const releaseBufferedLiveEvents = (): void => {
          if (subscriptionReady) {
            return;
          }
          subscriptionReady = true;
          const bufferedEvents = pendingLiveEvents.splice(0);
          for (const event of bufferedEvents) {
            deliverToListener(event);
          }
        };

        const subscription = emitter.event((event) => {
          if (cancelled) {
            return;
          }
          if (!subscriptionReady) {
            pendingLiveEvents.push(event);
            return;
          }
          deliverToListener(event);
        });

        const establishSubscription = async (attempt: number): Promise<void> => {
          if (cancelled) {
            return;
          }
          try {
            const client = await getReadOnlyClient(params);
            if (cancelled) {
              return;
            }
            const result = await client.request(
              V4_METHODS.sessionSubscribe,
              {
                sessionId: params.sessionId,
                deliveryKind: params.deliveryKind,
                afterSeq: params.afterSeq,
                includeSnapshot: params.includeSnapshot ?? false,
              },
              // M2-3（specs/m2-3-session-readwrite.md §2.7）：legacy session/subscribe →
              // v4/session/subscribe query；水位原子性/replay 不 fire 共享 emitter 的纪律
              // 不变，结果校验沿用既有 barrel schema。
              acodeSessionSubscribeResultSchema,
            );
            if (cancelled) {
              return;
            }
            const replayEvents = result.events
              .map((event) => normalizeSessionEventSeq(params, event))
              .sort((left, right) => left.seq - right.seq || left.timestamp - right.timestamp);
            // session/subscribe 返回的是当前订阅者自己的 replay 缺口。
            // replay 不能 fire 到共享 emitter：会把历史事件重新广播给其他 live 订阅者，
            // 造成 UI 时间线里已完成工具被插回到当前模型输出之后。
            for (const event of replayEvents) {
              deliverToListener({ type: "session.event", event });
            }
            if (result.snapshot) {
              deliverToListener({
                type: "snapshot",
                snapshot: result.snapshot,
              });
            }
            releaseBufferedLiveEvents();
          } catch (error) {
            if (cancelled) {
              return;
            }
            if (attempt >= SESSION_SUBSCRIBE_MAX_ATTEMPTS - 1) {
              // 彻底失败时打 warn 让问题可观测，而不是无声失效。
              // 修复原因（review R3-console 残留）：此前用裸 console.warn，不进统一服务
              // 日志文件、不脱敏，生产环境丢失。session 订阅达最大重试属「可恢复异常」，
              // 应走 logger.warn 落盘（同文件 :334 的 createServiceLogger）。pid 前缀由
              // 漏斗内 formatLogPrefix 等价产出，不再手工拼接。
              logger.warn(undefined, "session 订阅建立失败，已达最大重试次数，放弃", {
                sessionId: params.sessionId,
                workspaceKey: resolveWorkspaceKey(params),
                attempts: attempt + 1,
                message: error instanceof Error ? error.message : String(error),
              });
              // 订阅失败后不再无限压住 live 事件；此时没有 replay 权威补洞，只能恢复 continuous 流。
              releaseBufferedLiveEvents();
              return;
            }
            const delay = Math.min(
              SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS * 2 ** attempt,
              SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS,
            );
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void establishSubscription(attempt + 1);
            }, delay);
          }
        };

        void establishSubscription(0);

        return {
          dispose() {
            cancelled = true;
            if (retryTimer) {
              clearTimeout(retryTimer);
              retryTimer = undefined;
            }
            pendingLiveEvents.length = 0;
            eventCoalescer?.dispose();
            subscription.dispose();
          },
        };
      };
    },

    // ── v4 conversation 通道（竖切）：host 只做透传，不落任何业务状态 ──

    async helloConversationV4() {
      return {
        kind: "hello" as const,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: v4ConnectionId,
        clientMode: "desktop-continuous" as const,
        deliveryProfile: "continuous" as const,
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none" as const,
          workspaceHookReview: true,
          independentPlanState: true,
          // 与 connection scope 的 hello 同一份能力集：直连 base service 的宿主内部消费者
          // 也能收到 `workflowRun.*` 增量（是否真收由它自己的 clientHello 决定）。
          workflowRunDeltas: true,
        },
        auth: {},
      };
    },

    async initializeConversationV4(rawClientHello) {
      clientHelloSchema.parse(rawClientHello);
    },

    async setConnectionFlowStateV4(params: ACodeAgentConnectionFlowParams) {
      const trusted = readTrustedACodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.connection.flowControlUntrusted");
      const client = await getReadOnlyClient(params);
      await client.request(
        V4_METHODS.connectionFlow,
        { connectionId: trusted.connectionId, state: params.state },
        v4ConnectionFlowResultSchema,
      );
    },

    async subscribeConversationV4(params: ACodeAgentConversationSubscribeParams) {
      const subscribeStartedAt = performance.now();
      const existingClient = processManager.getExistingClient(params);
      const cliProcessState: "reused" | "spawned" =
        existingClient && !existingClient.isDisposed ? "reused" : "spawned";
      const cliBootstrapStartedAt = performance.now();
      // 历史 topic 是任务列表点击后的只读事实源。provider/model 未配置时若复用
      // 模型执行门禁，列表虽然能出现但点击后仍无法打开；订阅只启动 CLI，不提升写能力。
      const client = await getReadOnlyClient(params);
      const cliBootstrapMs =
        cliProcessState === "spawned"
          ? Math.max(0, Math.round(performance.now() - cliBootstrapStartedAt))
          : undefined;
      // conversation 冷订阅会在 CLI 内部直接恢复历史 Session 并立即发布首帧。
      // 若 Account Config 尚未到达，首帧会先按缺少 Account Overlay 的 Registry 解析；这里只建立
      // Account Config 顺序屏障，不提升模型执行权限。ACode Built-in / Personal 仍由 Worker 维护。
      const providerRegistryStartedAt = performance.now();
      await ensureAccountProviderConfigSynced({
        client,
        reason: "conversation_subscribe",
        workspace: params,
      });
      const providerRegistrySyncMs = Math.max(
        0,
        Math.round(performance.now() - providerRegistryStartedAt),
      );
      const connection = resolveV4Connection(params);
      const topic = conversationTopic(params.sessionId);
      const taskMetaStartedAt = performance.now();
      const resumeThoughtLevel = await automationTaskIndexRepo
        .getTaskMeta({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId: params.sessionId,
        })
        .then((meta) => meta?.thoughtLevel?.trim() || undefined)
        .catch((error) => {
          // desktop-continuous 的 V4 冷订阅绕过 task adapter，旧 session 没有
          // Agent durable selection 时也就丢了 task-local thought。索引读取失败仍允许只读恢复。
          logger.warn(undefined, "读取 V4 cold resume thought hint 失败，继续无 hint 订阅", {
            error: error instanceof Error ? error.message : String(error),
            event: "v4.conversation.subscribe.resume_thought_hint_failed",
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return undefined;
        });
      const taskMetaReadMs = Math.max(0, Math.round(performance.now() - taskMetaStartedAt));
      const cliRequestStartedAt = performance.now();
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          // 与 clientMode 同族的可信位（10 §3.1）：只由这里从连接的 clientHello 注入。
          // 缺席即 CLI 按旧消费者发整键 patch，并先裁到旧界——重订阅、recovery、手机
          // relay attachment 都走这一条 subscribe，所以这一处写全即可。
          ...(connection.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
          // Bug 根因：冷订阅过去只传 sessionId，CLI 只能从历史 session.path 反推
          // workspace 身份；该路径已可能被 path.resolve 改写。当前 attachment 才是权威来源。
          workspace: buildWorkspaceRef(params),
          ...(resumeThoughtLevel ? { resumeThoughtLevel } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4ConversationSubscribeResultSchema,
      );
      // attach 链路判代（apps/acode-cli/specs/protocol-attachment-typed-errors.md R5 /
      // 接线 W4）：pendingInteractionHints 的**字段存在性**是响应级判代探针，唯一读法
      // readPendingInteractionHints——字段缺席只能推断对端是老世代 CLI，不得推断成
      // 「无 pending」（完整清单恒以 snapshot 的 pendingInteractions 为权威）。这里只记
      // debug 诊断供排障；ack 原样透传（含字段缺席形态），UI/手机端的判代消费归各自
      // attach 面。禁止用 wire 版本反推本字段存在性（R5 规则 3）。
      const pendingHintsReading = readPendingInteractionHints(result.ack);
      if (pendingHintsReading.generation === "legacy") {
        logger.debug(
          undefined,
          "V4 subscribe ack 缺少 pendingInteractionHints 字段（老世代 CLI）",
          {
            event: "v4.conversation.subscribe.pending_hints_legacy",
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
          },
        );
      }
      const cliRequestMs = Math.max(0, Math.round(performance.now() - cliRequestStartedAt));
      const hostPrepareMs = Math.max(0, Math.round(cliRequestStartedAt - subscribeStartedAt));
      const openTiming = {
        ...(result.ack.openTiming ? result.ack.openTiming : {}),
        version: 1 as const,
        hostPrepareMs,
        ...(cliBootstrapMs !== undefined ? { cliBootstrapMs } : {}),
        cliProcessState,
        providerRegistrySyncMs,
        taskMetaReadMs,
        cliRequestMs,
      };
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return {
        ...result,
        ack: {
          ...result.ack,
          openTiming,
        },
      };
    },

    async unsubscribeConversationV4(params: ACodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "conversation/");
    },

    async resyncConversationV4(params: ACodeAgentConversationResyncParams) {
      return resyncV4Route(params, "conversation/");
    },

    async sendConversationCommandV4(params: ACodeAgentConversationCommandParams) {
      const client = await getClient(params);
      const planPayload = params.envelope.payload as {
        planEnabled?: boolean;
        config?: { planEnabled?: boolean };
        firstInput?: { planEnabled?: boolean };
      };
      if (
        planPayload.planEnabled ||
        planPayload.config?.planEnabled ||
        planPayload.firstInput?.planEnabled
      ) {
        await ensureIndependentPlanSupport(client);
      }
      // RPC facade 会清掉调用方可伪造的顶层 clientMode，再用 trusted carrier 注入 host
      // 真值；host 内部 adapter 直调仍兼容显式 clientMode。来源纪律单源在
      // resolveTrustedCommandClientMode（**绝不**读 payload.clientMode，见该叶子注释）。
      const commandClientMode = resolveTrustedCommandClientMode(params);
      if (params.envelope.type === "createSession") {
        // V4 草稿预热直接走 command 转发；新会话创建前只需等待 Account Config，
        // ACode Built-in / Personal 已由 Worker 进程 Registry 自己装配。
        await ensureAccountProviderConfigSynced({
          client,
          reason: "v4_command_create_session",
          workspace: params,
        });
      }
      let envelope = await buildConversationCommandEnvelope(params, commandClientMode);
      // TTFT 首版只允许可信桌面本地 continuous，手机/远端透传不能开启本地观测。
      if (
        commandClientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      ) {
        const { ttft: _ttft, ...withoutTtft } = envelope;
        envelope = withoutTtft;
      }
      if (envelope.type === "sendText" && envelope.sessionId) {
        const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
        const browserAmbientContext = await collectBrowserAmbientContext(
          options?.browserControlExecutor,
          {
            sessionId: envelope.sessionId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
            clientMode: commandClientMode,
          },
        );
        if (browserAmbientContext) {
          envelope = {
            ...envelope,
            payload: { ...payload, browserAmbientContext },
          };
        }
      }
      const ack: CommandAck = await client.request(V4_METHODS.command, envelope, commandAckSchema);
      // Prompt command 在 committed TurnStarted 或 committed WorkspaceHookReviewRequested
      // 任一 authority 到达后即返回；人工审核不能占用 Host RPC，因此继续使用统一默认
      // timeout/watchdog。放宽到审核领域 deadline 只会掩盖串行协议队列死锁。
      // duplicate 只证明 commandId 曾处理过，不证明其目标仍是当前 session 配置。
      // 旧 B 命令在用户已切 C 后重放时，不能借 duplicate 把派生缓存再改回 B。
      return ack;
    },

    async queryConversationCommandsV4(params: ACodeAgentCommandsQueryParams) {
      if (!readTrustedACodeAgentV4Connection(params)) {
        throw new Error("fault.command.queryConnectionUntrusted");
      }
      const query = commandsQueryParamsSchema.parse({
        commands: params.commands,
        ...(params.clock ? { clock: true } : {}),
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.commandsQuery, query, commandsQueryResultSchema);
    },

    async attachmentBeginV4(params: ACodeAgentAttachmentBeginParams) {
      const trusted = readTrustedACodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        fileName: params.fileName,
        mime: params.mime,
        totalBytes: params.totalBytes,
        totalChunks: params.totalChunks,
        checksum: params.checksum,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentBegin, wireParams);
      return client.request(V4_METHODS.attachmentBegin, wireParams, v4AttachmentBeginResultSchema);
    },

    async attachmentChunkV4(params: ACodeAgentAttachmentChunkParams) {
      const trusted = readTrustedACodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        chunkIndex: params.chunkIndex,
        dataBase64: params.dataBase64,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentChunk, wireParams);
      return client.request(V4_METHODS.attachmentChunk, wireParams, v4AttachmentChunkResultSchema);
    },

    async attachmentCommitV4(params: ACodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedACodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentCommit, wireParams);
      return client.request(
        V4_METHODS.attachmentCommit,
        wireParams,
        v4AttachmentCommitResultSchema,
      );
    },

    async attachmentAbortV4(params: ACodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedACodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentAbort, wireParams);
      await client.request(V4_METHODS.attachmentAbort, wireParams, v4AttachmentAbortResultSchema);
    },

    async attachmentReadV4(params: ACodeAgentAttachmentReadParams) {
      if (!readTrustedACodeAgentV4Connection(params)) {
        throw new Error("fault.attachment.readConnectionUntrusted");
      }
      const wireParams = v4AttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.attachmentRead, wireParams, v4AttachmentReadResultSchema);
    },

    async conversationAttachmentReadV4(params: ACodeAgentConversationAttachmentReadParams) {
      if (!readTrustedACodeAgentV4Connection(params)) {
        throw new ACodeAttachmentFaultError(
          ACODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentRead,
        wireParams,
        v4ConversationAttachmentReadResultSchema,
      );
    },

    async conversationAttachmentStatV4(params: ACodeAgentConversationAttachmentStatParams) {
      if (!readTrustedACodeAgentV4Connection(params)) {
        throw new ACodeAttachmentFaultError(
          ACODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentStatParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentStat,
        wireParams,
        v4ConversationAttachmentStatResultSchema,
      );
    },

    async attachmentPreviewSourceV4(params: ACodeAgentAttachmentPreviewSourceParams) {
      const trusted = readTrustedACodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.previewSourceConnectionUntrusted");
      if (trusted.clientMode !== "desktop-continuous" || params.remoteSessionId) {
        return { kind: "chunked" } as const;
      }
      const wireParams = v4AttachmentPreviewSourceParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        clientMode: trusted.clientMode,
      });
      const client = await getReadOnlyClient(params);
      const source = await client.request(
        V4_METHODS.attachmentPreviewSource,
        wireParams,
        v4AttachmentPreviewSourceResultSchema,
      );
      if (source.kind !== "local_path") return source;
      if (!options?.authorizeLocalMediaPreviewPath) {
        throw new Error("fault.attachment.previewPathAuthorizationUnavailable");
      }
      return {
        ...source,
        path: await options.authorizeLocalMediaPreviewPath(source.path),
      };
    },

    // 行分页：只读 query 透传（超时重发安全，无订阅状态）。
    async conversationRowsRangeV4(params: ACodeAgentConversationRowsRangeParams) {
      const trusted = readTrustedACodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.conversation.rowsRangeConnectionUntrusted");
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationRowsRange,
        {
          sessionId: params.sessionId,
          clientMode: trusted.clientMode,
          ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
          limit: params.limit,
        },
        v4ConversationRowsRangeResultSchema,
      );
    },

    // 只读计划目录沿现有 workspace attachment 透传，不建立新 runtime。
    async conversationPlansV4(params: ACodeAgentConversationPlansParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationPlans,
        { sessionId: params.sessionId },
        v4ConversationPlansResultSchema,
      );
    },

    // workflow run 事件日志：同样是只读 query，沿现有 workspace attachment 透传。
    // 分页发生在存储层（JournalStorePort.listEvents 带 afterSequence/limit），这里不切片；
    // 在 RPC 层切等于每翻一页把整条 journal 读进内存。
    async conversationWorkflowRunEventsV4(params: ACodeAgentConversationWorkflowRunEventsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunEvents,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunEventsResultSchema,
      );
    },

    // workflow run 枚举：journal-backed 的重启后发现面（workflowRuns 投影跨进程不存活）。
    async conversationWorkflowRunsV4(params: ACodeAgentConversationWorkflowRunsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRuns,
        {
          sessionId: params.sessionId,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunsResultSchema,
      );
    },

    // dwf 用户面产物的三条读面。
    // ⚠ 术语：artifact = 脚本发布给用户看的产出，不是 run 的顶层返回值。
    // 三条与 plans / workflowRunEvents 同族：只读、无状态、超时重发安全，走只读客户端。
    async conversationWorkflowRunArtifactsV4(
      params: ACodeAgentConversationWorkflowRunArtifactsParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifacts,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunArtifactsResultSchema,
      );
    },

    // 看板取数：limit 的缺省与钳制在 CLI 网关侧，这里只透传——两处各钳一次，
    // 同一个 limit 迟早会在两层上得到不同的页大小。
    async conversationWorkflowRunArtifactDataV4(
      params: ACodeAgentConversationWorkflowRunArtifactDataParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactData,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunArtifactDataResultSchema,
      );
    },

    // 字节：一次一块（≤ 512 KiB），拼接归 renderer 的 hook。授权全在 CLI 侧——
    // 这里传下去的 id 只用于在 journal 里查行，绝不成为路径。
    async conversationWorkflowRunArtifactReadV4(
      params: ACodeAgentConversationWorkflowRunArtifactReadParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactRead,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          version: params.version,
          offset: params.offset,
          limit: params.limit,
        },
        v4ConversationWorkflowRunArtifactReadResultSchema,
      );
    },

    // 对话内可视化（::visualize）的字节读面。同族：只读、无状态、超时重发安全；
    // 授权在 CLI 侧（会话 visualize 目录 + 注册名核对，renderer 传参不拼路径）。
    async conversationVisualizationReadV4(params: ACodeAgentConversationVisualizationReadParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationVisualizationRead,
        {
          sessionId: params.sessionId,
          name: params.name,
          offset: params.offset,
          limit: params.limit,
        },
        v4ConversationVisualizationReadResultSchema,
      );
    },

    // dwf 工作区 transcript 的两条读面。同族：
    // 只读、无状态、超时重发安全，走只读客户端。maxBytes 的缺省与钳制在 CLI 网关侧。
    async conversationWorkflowRunWorkspaceV4(
      params: ACodeAgentConversationWorkflowRunWorkspaceParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunWorkspace,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunWorkspaceResultSchema,
      );
    },

    async conversationWorkflowRunNodeResultV4(
      params: ACodeAgentConversationWorkflowRunNodeResultParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunNodeResult,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          siteId: params.siteId,
          ordinal: params.ordinal,
          ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        },
        v4ConversationWorkflowRunNodeResultResultSchema,
      );
    },

    async backgroundBashOutputV4(params: ACodeAgentBackgroundBashOutputParams) {
      if (!readTrustedACodeAgentV4Connection(params))
        throw new Error("fault.bashOutput.connectionUntrusted");
      const wireParams = v4BackgroundBashOutputParamsSchema.parse({
        sessionId: params.sessionId,
        workId: params.workId,
      });
      try {
        const client = await getReadOnlyClient(params, "existing-only");
        return await client.request(
          V4_METHODS.backgroundBashOutput,
          wireParams,
          backgroundBashOutputResultSchema,
        );
      } catch (error) {
        if (isProtocolMethodNotFoundError(error))
          return { kind: "unsupported", workId: params.workId };
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE
        ) {
          return { kind: "unavailable", workId: params.workId };
        }
        throw error;
      }
    },

    async conversationFileChangesV4(params: ACodeAgentConversationFileChangesParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileChanges,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileChangesResultSchema,
      );
    },

    async conversationFileRewindPreviewV4(params: ACodeAgentConversationFileRewindPreviewParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileRewindPreview,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileRewindPreviewResultSchema,
      );
    },

    onDynamicConversationFrame(params: ACodeAgentWorkspaceTarget) {
      return getConversationFrameEmitter(params).event;
    },

    onDynamicLocalTtftFacts() {
      // 审计版已删除 TTFT 采集和协议通知；兼容现有 UI 订阅接口，不保存状态或产生网络行为。
      return Event.None;
    },
    onDynamicConversationTelemetryFact(params: ACodeAgentWorkspaceTarget) {
      return getConversationTelemetryFactEmitter(params).event;
    },

    onDynamicCuaPermissionObservation() {
      return cuaPermissionObservationEmitter.event;
    },

    async networkCaptureSetEnabledV4(
      params: ACodeAgentNetworkCaptureSetEnabledParams,
    ): Promise<ACodeAgentNetworkCaptureSetEnabledResult> {
      try {
        // existing-only：开关命令绝不为抓包单独拉起 agent 进程；无运行时时上报
        // runtime_unavailable，由 main 按记忆在新会话 attach/进程 ready 时重发。
        const client = await getReadOnlyClient(params, "existing-only");
        const wireParams = v4NetworkCaptureSetEnabledParamsSchema.parse({
          enabled: params.enabled,
          captureId: params.captureId ?? randomUUID(),
        });
        const result = await client.request(
          V4_METHODS.networkCaptureSetEnabled,
          wireParams,
          v4NetworkCaptureSetEnabledResultSchema,
        );
        // 产品语义是 host 级观测：目标 workspace 成功后把同一 wire 状态补发给池内其余
        // agent（各自进程独立观测环），并记住状态供后续入池的 client 补发。
        if (params.enabled) {
          networkCaptureWireState = { enabled: true, captureId: wireParams.captureId };
        } else {
          networkCaptureWireState = null;
        }
        const targetKey = resolveWorkspaceKey(params);
        for (const [key, entry] of activeClientsByWorkspaceKey) {
          if (key === targetKey) continue;
          pushNetworkCaptureWire(entry.client, wireParams);
        }
        return { ok: true, enabled: result.enabled };
      } catch (error) {
        if (isProtocolMethodNotFoundError(error)) {
          // 旧 CLI 未登记 networkCaptureSetEnabled 方法：诚实返回 unsupported，
          // 让资源管理器 network tab 显示不可用而不是假装已开启。
          return { ok: false, reason: "unsupported" };
        }
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE
        ) {
          return { ok: false, reason: "runtime_unavailable" };
        }
        throw error;
      }
    },

    onDynamicNetworkCaptureRecords() {
      return networkCaptureRecordsEmitter.event;
    },

    onDynamicOvernightCompletion() {
      return overnightCompletionEmitter.event;
    },

    // ── sessions-index 通道（列表活性）：复用 conversationSubscribe RPC，
    // 按 topic 前缀由 CLI server 分派 ──

    async subscribeSessionsIndexV4(params: ACodeAgentSessionsIndexSubscribeParams) {
      // 侧栏会同时登记所有 restored workspace。被动订阅若使用启动型 client，
      // workspace 数量会直接放大成 CLI 数量；existing-only 缺 runtime 时只进入 dormant。
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = sessionsIndexTopic(resolveWorkspaceKey(params));
      // 3.3.6 的 CLI session 未写 remote workspace_id，但同版本 host task index
      // 已按完整 identity 隔离。升级时必须用当前 workspaceKey 下的 taskId 作归属证明；
      // 禁止只把 workspacePath 传给 CLI，否则同路径不同 SSH/WSL authority 会互相认领历史。
      let legacyTaskIds: string[] = [];
      if (supportsLegacyRemoteTaskAllowlist(params.workspaceIdentity)) {
        try {
          legacyTaskIds = (
            await automationTaskIndexRepo.listTaskMetas({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              provider: "glm",
            })
          )
            .slice(0, MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE)
            .map((task) => task.taskId);
        } catch (error) {
          // 归属证明只用于升级迁移；task index 不可用时仍要让已有完整
          // identity 的 3.4 会话走严格查询，不能让兼容读取故障变成整个列表不可用。
          logger.warn(undefined, "读取远端历史任务归属证明失败，继续按严格 identity 订阅", {
            error: error instanceof Error ? error.message : String(error),
            event: "sessions_index.legacy_remote_allowlist_read_failed",
            workspaceIdentity: params.workspaceIdentity,
            workspacePath: params.workspacePath,
          });
        }
      }
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(legacyTaskIds.length > 0 ? { legacyTaskIds } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4SessionsIndexSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeSessionsIndexV4(params: ACodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "sessions-index/");
    },

    async resyncSessionsIndexV4(params: ACodeAgentConversationResyncParams) {
      return resyncV4Route(params, "sessions-index/");
    },

    onDynamicSessionsIndexFrame(params: ACodeAgentWorkspaceTarget) {
      return getSessionsIndexFrameEmitter(params).event;
    },

    // ── workspace-config 通道（配置目录活性）：复用 conversationSubscribe RPC，
    // 按 topic 前缀由 CLI server 分派 ──

    async subscribeWorkspaceConfigV4(params: ACodeAgentWorkspaceConfigSubscribeParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = workspaceConfigTopic(resolveWorkspaceKey(params));
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4WorkspaceConfigSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeWorkspaceConfigV4(params: ACodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "workspace-config/");
    },

    async resyncWorkspaceConfigV4(params: ACodeAgentConversationResyncParams) {
      return resyncV4Route(params, "workspace-config/");
    },

    onDynamicWorkspaceConfigFrame(params: ACodeAgentWorkspaceTarget) {
      return getWorkspaceConfigFrameEmitter(params).event;
    },

    onDynamicProcessResourceSample() {
      return processResourceSampleEmitter.event;
    },

    onDynamicToolExecResource() {
      return toolExecResourceEmitter.event;
    },
    onDynamicMcpResourceSamples() {
      return mcpResourceSamplesEmitter.event;
    },

    onDynamicMcpTelemetry() {
      return mcpTelemetryEmitter.event;
    },

    // （CLI 重连重订）：进程换代直通 process manager；v4 订阅方（task-index
    // syncer 等）据此重发 subscribe——订阅活在 CLI 进程内存，换代即静默失活。
    onAgentRuntimeRestarted(listener) {
      return processManager.onRuntimeRestarted(listener);
    },

    onAgentRuntimeLifecycle(listener: (event: ACodeAgentRuntimeLifecycleEvent) => void) {
      return processManager.onRuntimeLifecycle(listener);
    },

    async disposeWorkspace(params): Promise<void> {
      const workspaceKey = resolveWorkspaceKey(params);
      // 释放不仅要终止当前进程，还要让已排队的 provider-ready continuation 失效；
      // 否则它会在 dispose 完成后把同一个 workspace 的 Agent 再次启动。
      cancelWaitingWorkspaceStartup(workspaceKey);
      clearV4SubscriptionRoutes(workspaceKey);
      cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      if (active) {
        invalidateWorkspaceClient(workspaceKey, active.client);
      } else {
        interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
      }
      // 该入口被 restartWorkspaceProcess 用作 runtime invalidation，并非
      // workspace/service 真 teardown。销毁 workspace emitter 会让既有 UI/task-index
      // listener 永久绑在死对象上；emitters 只由 disposeLocalState/disposeAll 释放。
      await processManager.disposeWorkspace(params);
    },

    disposeAll(): void {
      processManager.disposeAll();
      pluginProcessManager.disposeAll();
      mcpStatusProcessManager.disposeAll();
      // automation 专用的 AutomationRepo / TaskIndexRepo 各持 tasks-index.sqlite
      // 连接句柄，dispose 后必须收口，否则 Windows 上句柄悬着（临时目录清理撞 EBUSY）
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },

    async disposeAllAndWait(): Promise<void> {
      await Promise.all([
        processManager.disposeAllAndWait(),
        pluginProcessManager.disposeAllAndWait(),
        mcpStatusProcessManager.disposeAllAndWait(),
      ]);
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },
  };
}
