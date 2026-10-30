/**
 * session 模块公开契约（迁移目标入口，精选视图）。
 *
 * 收敛状态（2026-10-27）：本面覆盖 services→session 的**消费方**符号；存量内部边已迁到
 * 本入口，`architecture-policy.yaml` 的 `publicEntrypoints` 已注册、`internalEdgeAllowlist`
 * 只保留写路径/装配类边（见策略注释与 specs/session-module-boundary.md）。
 * 新代码一律从这里导入，不再直引实现文件。
 *
 * 域边界：任务索引/列表（acodeTaskService、taskIndexRepo）、automation 调度
 * （automationRepo/Service/Cron）、off-peak 闲时任务（offPeak*）、跨会话
 * mailbox（sessionMailbox）。repo 是各自表的唯一写入所有者；service 只做编排。
 *
 * **任务索引 repo 类不在本面**（下面刻意用描述性说法而不写它的类名：task-index-writers
 * 守护把源码中对该符号的**任何文本引用**都当作待评审写入面，注释也算——所以本文件连提它的
 * 名字都会被判红。这是有意的：把本文件登记进守护白名单会让「将来真把 repo 加进契约面」也
 * 静默通过，守护就失去意义。改动本注释时请保持这一写法）：装配根与写入方需要构造它，但
 * 守护（specs/task-index-write-ownership.md）要求每个引用方显式登记。把构造口放进消费契约
 * 会让**每个**消费方都成为登记写入方，守护立即失去意义——实测尝试加一个转发叶子即被判红。
 * 故其构造边保留为写入方直引，由写所有权守护 + internalEdgeAllowlist 双重登记。
 */

// ── 任务索引与列表 ──────────────────────────────────────────────────
// 契约面只暴露服务接口（IACodeTaskService）与纯投影（列表类型/变更汇总），不暴露 repo。
export { IACodeTaskService } from "./acodeTaskService.js";
export type {
  ACodeArchivedTaskDeletionResult,
  ACodeTaskReadyOutcome,
  ACodeTaskTerminalOutcome,
  // 模型轨迹投影（只读派生视图，写入所有者仍是 taskIndexRepo）。
  ACodeModelTrajectory,
  ACodeModelTrajectoryCallSource,
  ACodeModelTrajectoryCallSourceKind,
  ACodeModelTrajectoryContentPart,
  ACodeModelTrajectoryMessage,
  ACodeModelTrajectoryRecord,
  ACodeModelTrajectoryUsage,
  // 列表查询/结果与分组视图投影。
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
  ACodeWorkspaceEventSubscriptionParams,
} from "./acodeTaskService.js";
export type {
  ACodeTaskListItem,
  ACodeTaskListKind,
  ACodeTaskListQuery,
  ACodeTaskListResult,
  ACodeTaskListSortBy,
  ACodeTaskListWorkspaceScope,
} from "./acodeTaskListTypes.js";
export { buildPerTurnChangeSummaries, buildTaskChangeSummary } from "./taskChangeSummary.js";
export type { SessionRealtimePort } from "./sessionRealtimePort.js";
// 会话模式与标题派生：纯函数（无 IO），供 bots/装配层复用而不下沉实现依赖。
export { resolveProviderModeIdFromConfigOptions } from "./sessionModeOptions.js";
export { deriveSessionTitle } from "./sessionTitle.js";

// ── automation 调度 ────────────────────────────────────────────────
export {
  AutomationRepo,
  AutomationCreateLimitError,
  CLAIM_STALE_MS,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  computeRetryAt,
} from "./automationRepo.js";
export { AutomationService, InvalidCronExprError } from "./automationService.js";
// 手动触发 automation 的拒绝语义与上下文（消费方需据此区分「用户触发被拒」与其它失败）。
export {
  AutomationManualTriggerRejectedError,
  type AutomationManualRunTriggerContext,
} from "./automationManualTrigger.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "./automationCron.js";

// ── off-peak 闲时任务 ──────────────────────────────────────────────
export { IOffPeakTaskService, type OffPeakUpdateTaskParams } from "./offPeakTask.js";
export { OffPeakTaskService } from "./offPeakTaskService.js";
export { OffPeakTaskRepo, OFF_PEAK_CLAIM_STALE_MS } from "./offPeakTaskRepo.js";
export { createOffPeakServerClient, OffPeakServerError } from "./offPeakServerClient.js";
export { isOffPeakMockEnabled, startOffPeakMockGateway } from "./offPeakMockGateway.js";
// off-peak 上游模型解析与鉴权装配（纯函数 + 失败类型）；装配根经契约取用，
// 不再直引实现文件。
export {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakCredentials,
  resolveOffPeakMockUpstream,
  OffPeakCodingPlanUnavailableError,
  OffPeakCredentialsUnavailableError,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
} from "./offPeakRuntimeModel.js";

// ── 跨会话 mailbox ─────────────────────────────────────────────────
export type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "./sessionMailbox.js";
