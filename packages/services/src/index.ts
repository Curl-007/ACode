// Descriptors & collection (browser-safe)
export { type ServiceDescriptor, createServiceDescriptor } from "./descriptors.js";
export { ServiceCollection } from "./collection.js";
export {
  IModelSelectionService,
  IProviderSettingsService,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderSettingsProviderView,
  type ProviderSettingsView,
} from "./model-provider/providerFacadeServices.js";
export {
  createAccountRequestAuthService,
  type IAccountRequestAuthService,
  type AccountRequestAuthInput,
  type AccountRequestAuthMaterial,
  type AccountRequestAuthResolver,
} from "./model-provider/accountRequestAuthService.js";
export { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
export {
  collectServiceMemoryDiagnostics,
  memoryDiagnosticsRegistry,
  registerMemoryDiagnosticsProvider,
} from "./memoryDiagnostics.js";

// Accessor
export type { IServiceAccessor } from "./accessor.js";
export {
  createConversationTelemetryService,
  type ConversationTelemetryWorkspaceTarget,
  type IConversationTelemetryService,
} from "./conversation-telemetry/conversationTelemetry.js";

// File service — IFileService is both a type (interface) and value (descriptor)
export { IFileService } from "./file/file.js";
export { IMediaPreviewService } from "./media-preview/mediaPreview.js";
export type { MediaPreviewPreparation } from "./media-preview/mediaPreview.js";

// Git service — IGitService is both a type (interface) and value (descriptor)
export { IGitService } from "./git/git.js";
export { IGitCheckpointService } from "./git/gitCheckpoint.js";

// System service — ISystemService is both a type (interface) and value (descriptor)
export { ISystemService } from "./system/system.js";

// Terminal service — ITerminalService is both a type (interface) and value (descriptor)
export { ITerminalService } from "./terminal/terminal.js";

// Setting service — ISettingService is both a type (interface) and value (descriptor)
export { ISettingService } from "./setting/setting.js";

// Credential service — ICredentialService is both a type (interface) and value (descriptor)
export { ICredentialService } from "./credential/credential.js";

// Broadcast service — IBroadcastService is both a type (interface) and value (descriptor)
export { IBroadcastService } from "./broadcast/broadcast.js";

// Onboarding 完成记录服务（本地持久化，后续上传服务器）
export { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
export type {
  CreateOnboardingRecordServiceOptions,
  OnboardingRecordServiceFactory,
} from "./onboarding/onboardingRecord.js";
// 这里只能导出 descriptor 和类型。根 index 会被 renderer 经 value import 拉进浏览器包，
// 若 value 导出 createOnboardingRecordService，会连带 fs/atomicFileUtils → @acode/shared/node →
// node:timers/promises 整条 Node 链进浏览器，模块加载直接抛错导致整个应用黑屏。
// 工厂函数由 host 侧（node.ts）与测试从实现文件路径直接导入，与 createSettingService 同惯例。
export type {
  BroadcastClaimAcquireResult,
  BroadcastClaimLease,
  BroadcastMessage,
} from "./broadcast/broadcast.js";

// ACode task wrapper service — task 列表/置顶/归档等 app 侧包装状态入口。
export { IACodeTaskService } from "./session/acodeTaskService.js";
export type {
  ACodeArchivedTaskDeletionResult,
  ACodeModelTrajectory,
  ACodeModelTrajectoryCallSource,
  ACodeModelTrajectoryCallSourceKind,
  ACodeModelTrajectoryContentPart,
  ACodeModelTrajectoryMessage,
  ACodeModelTrajectoryRecord,
  ACodeModelTrajectoryUsage,
  ACodeTaskListKind,
  ACodeTaskListQuery,
  ACodeTaskListResult,
  ACodeTaskListSortBy,
  ACodeTaskListWorkspaceScope,
  ACodeTaskReadyOutcome,
  ACodeGroupedTaskRef,
  ACodeGroupedTaskView,
  ACodeGroupedTaskViewNode,
  ACodeGroupedTaskViewOrderInput,
  ACodeGroupedTaskViewQuery,
  ACodeGroupedTaskViewStructure,
  ACodeGroupedTaskViewStructureMember,
  ACodeGroupedTaskViewStructureTopOrder,
  ACodeGroupedTaskViewTopLevelNodeRef,
  ACodeTaskGroup,
  ACodeTaskGroupColor,
} from "./session/acodeTaskService.js";
export type { ACodeTaskListItem } from "./session/acodeTaskListTypes.js";

export { IWindowControllerService } from "./window-controller/windowController.js";
export type {
  WindowHostControllerFrame,
  WindowHostControllerMutation,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
} from "./window-controller/windowController.js";

// ACode agent service — IACodeAgentService is both a type (interface) and value (descriptor)
export {
  IACodeAgentService,
  type ACodeAgentLocalRuntimeChildProcesses,
  ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
} from "./acode-agent/acodeAgent.js";
export {
  isACodeAgentMcpStatusModeUnsupportedError,
  ACODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  ACodeAgentMcpStatusModeUnsupportedError,
} from "./acode-agent/acodeAgentErrors.js";
export {
  createACodeAgentConnectionScope,
  readTrustedACodeAgentV4Connection,
} from "./acode-agent/acodeAgentConnectionScope.js";
export type {
  ACodeAgentConnectionScope,
  ACodeAgentV4ClientMode,
  ACodeAgentV4ConnectionContext,
} from "./acode-agent/acodeAgentConnectionScope.js";
export type {
  ACodeAgentAttachmentBeginParams,
  ACodeAgentAttachmentChunkParams,
  ACodeAgentAttachmentTerminalParams,
  ACodeAgentCreateSessionParams,
  ACodeAgentCuaPermissionObservation,
  ACodeAgentInitializeResult,
  ACodeAgentStorageStartupSnapshot,
  ACodeAgentRuntimeLifecycleEvent,
  ACodeAgentRuntimePolicy,
  ACodeAgentReadSessionParams,
  ACodeAgentResumeSessionParams,
  ACodeAgentRunAutomationNowResult,
  ACodeAgentSavedWorkflowTarget,
  ACodeAgentSendPromptParams,
  ACodeAgentServiceEvent,
  ACodeAgentSessionSubscribeParams,
  ACodeAgentSessionTarget,
  ACodeAgentSetModeParams,
  ACodeAgentSetModelParams,
  ACodeAgentSetThoughtLevelParams,
  ACodeAgentWorkspaceTarget,
} from "./acode-agent/acodeAgent.js";

// ACode session service — app-facing session facade without ACode Agent naming.
export { IACodeSessionService } from "./acode-session/acodeSession.js";
export type {
  ACodeSessionCreateParams,
  ACodeSessionEventsParams,
  ACodeSessionInitializeResult,
  ACodeSessionListParams,
  ACodeSessionMessagesParams,
  ACodeSessionReadParams,
  ACodeSessionResumeParams,
  ACodeSessionServiceEvent,
  ACodeSessionSetModeParams,
  ACodeSessionSetModelParams,
  ACodeSessionSetThoughtLevelParams,
  ACodeSessionSubscribeParams,
  ACodeTaskTarget,
  ACodeSessionWorkspaceTarget,
} from "./acode-session/acodeSession.js";

// Bots service — IBotsService is both a type (interface) and value (descriptor).
export { IBotsService } from "./bots/bots.js";
export type {
  BotBindCodeResult,
  BotCreateBindCodeParams,
  BotListWorkspaceRefsParams,
  BotSaveBotParams,
  BotTestResult,
} from "./bots/bots.js";

// Hooks service — IHooksService is both a type (interface) and value (descriptor).
export { IHooksService } from "./hooks/hooks.js";

// Memory service — IMemoryService is both a type (interface) and value (descriptor).
export {
  IMemoryService,
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "./memory/memory.js";
export type { ProjectMemoryFileSummary, ProjectMemoryWorkspaceSummary } from "./memory/memory.js";

export type { SessionRealtimePort } from "./session/sessionRealtimePort.js";

// FileWatcher service — IFileWatcherService is both a type (interface) and value (descriptor)
export { IFileWatcherService } from "./fileWatcher/fileWatcher.js";

// OAuth service — IOAuthService is both a type (interface) and value (descriptor)
export { IOAuthService } from "./oauth/oauth.js";

// UsageStats service — IUsageStatsService is both a type (interface) and value (descriptor)
export { IUsageStatsService } from "./usage-stats/usageStats.js";

// Storage（资源管理器「存储」tab）：数据类型在 @acode/shared；这里只导出服务接口与卷分组纯函数
export type { IStorageService } from "./storage/contract.js";

// CodingPlanSubscription service — ICodingPlanSubscriptionService is both a type (interface) and value (descriptor)
export {
  ICodingPlanSubscriptionService,
  type OffPeakClientConfig,
} from "./coding-plan-subscription/codingPlanSubscription.js";
export {
  IClientScenesService,
  type ClientSceneConfig,
  type ClientSceneItem,
  type ClientSceneOption,
  type ClientSceneResponseBody,
  type ClientScenesResponse,
} from "./client-scenes/clientScenes.js";
export { isValidCronExpr } from "./session/automationCronValidation.js";
// 闲时任务管理服务（与 automation 服务面独立）；接口/描述符 browser-safe。
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export type { OffPeakUpdateTaskParams } from "./session/offPeakTask.js";

// Skills service — ISkillsService is both a type (interface) and value (descriptor)
export { ISkillsService } from "./skills/skills.js";
export { ISkillSyncService } from "./skill-sync/skillSync.js";
export { IMcpSyncService } from "./mcp-sync/mcpSync.js";
export { IPluginSyncService } from "./plugin-sync/pluginSync.js";
export {
  ICuaPermissionService,
  type CuaPermissionState,
  type CuaPermissionRestartOptions,
  type CuaPermissionStatus,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
  type CuaPermissionStatusUnavailable,
  isCuaPermissionStatusAvailable,
} from "./cua-permission-broker/cuaPermissionService.js";
export {
  ICuaPipSessionService,
  type CuaPipSessionService,
} from "./cua-permission-broker/cuaPipSession.js";

// Plugins service — IPluginsService is both a type (interface) and value (descriptor)
export { IPluginsService } from "./plugins/plugins.js";
// 设置页插件管理薄服务（UI 平台能力面不再直触 acodeAgentService）
export { IPluginManagementService } from "./plugins/pluginManagement.js";

// Subagents service — ISubagentsService is both a type (interface) and value (descriptor)
export { ISubagentsService } from "./subagents/subagents.js";

// Commands service — ICommandsService is both a type (interface) and value (descriptor)
export { ICommandsService } from "./commands/commands.js";

export { ISettingsSyncService } from "./settings-sync/settingsSync.js";

export { IFeedbackService } from "./feedback/feedback.js";
export type { FeedbackUploadProgress } from "./feedback/feedback.js";
export { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
export type {
  PromptAttachmentStageParams,
  PromptAttachmentStageResult,
  PromptAttachmentTransferPhase,
  PromptAttachmentTransferProgress,
} from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
export type {
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackDeviceInfo,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackReporter,
  FeedbackTicketDetail,
  FeedbackTicketFramework,
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketStatus,
  FeedbackTicketSummary,
  FeedbackTicketType,
} from "@acode/shared";
export { IClientConfigService } from "./client-config/clientConfig.js";
