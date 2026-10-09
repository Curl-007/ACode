/**
 * session 模块公开契约（迁移目标入口，精选视图）。
 *
 * 现状：本文件已落地但尚未注册为 publicEntrypoints（策略里列表有意为空，
 * deep-import 对 session 保持惰性）；services→session 的 31 条内部边仍直引
 * 实现文件，属已登记的迁移状态（specs/session-module-boundary.md）。
 * 收敛路径：新代码从这里导入；存量内部边逐条迁到本面后再注册入口。
 *
 * 域边界：任务索引/列表（acodeTaskService、taskIndexRepo）、automation 调度
 * （automationRepo/Service/Cron）、off-peak 闲时任务（offPeak*）、跨会话
 * mailbox（sessionMailbox）。repo 是各自表的唯一写入所有者；service 只做编排。
 */

// ── 任务索引与列表 ──────────────────────────────────────────────────
// 任务索引 repo 类有意不入契约：task-index-writers 守护测试（specs/task-index-
// write-ownership.md）把源码中对该 repo 符号的任何文本引用都视为待评审的写入面
//（barrel 转发乃至注释都算引用），派生索引写入路径的扩张必须先过白名单评审；
// 契约面只暴露服务接口（IACodeTaskService）与纯投影（列表类型/变更汇总）。
export { IACodeTaskService } from "./acodeTaskService.js";
export type { ACodeTaskListItem, ACodeTaskListQuery } from "./acodeTaskListTypes.js";
export { buildTaskChangeSummary } from "./taskChangeSummary.js";
export type { SessionRealtimePort } from "./sessionRealtimePort.js";

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

// ── 跨会话 mailbox ─────────────────────────────────────────────────
export type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "./sessionMailbox.js";
