// ============================================================
// Permission exports
// ============================================================

export * from "./broker.js";
export * from "./service.js";
// 安全加固 P2 补丁项：托管策略地板的进程级注册点（Explore/memory agent 的
// defaultPermissionConfig 实例经进程回落自动携带地板）。
export * from "./process-policy-floor.js";
// J1-2：Bash Confirm 级反射门。对外只需要审计 sink 的注册点与条目形态——门本体是
// PermissionService 的实例私有字段，不单独暴露（消费点唯一，见 spec「状态所有者」）。
export { registerBashReflexAuditSink, setBashReflexAuditSink } from "./bash-confirm-reflex-gate.js";
export type { BashReflexAuditEntry, BashReflexAuditSink } from "./bash-confirm-reflex-gate.js";
// auto 模式风险分类器（specs/auto-mode-risk-classifier.md）：对外只需端口类型与审计
// sink 注册点——rubric/解析/缓存预算是 core 内部实现，sidecar 构造点唯一在
// runtime/helpers/runtime-tools.ts（createRuntimeToolExecutor）。
export {
  registerAutoClassifierAuditSink,
  setAutoClassifierAuditSink,
} from "./auto-risk-classifier.js";
export type {
  AutoClassifierAuditEntry,
  AutoClassifierAuditSink,
  AutoRiskClassifierPort,
  AutoRiskVerdict,
} from "./auto-risk-classifier.js";
// TTL 持久授权（specs/mcp-lifecycle-ttl-approval.md R4）：存储本体 + 判定侧窄读
// 接口 + 期限常量。装配层 await TtlApprovalStore.create() 后注入
// PermissionConfig.ttlApprovals；批准链路经 grantSessionPermission（带 expiresAt 的
// allow 更新）或 store.applyPermissionUpdates 写入。
export {
  DEFAULT_MAX_TTL_DAYS,
  DEFAULT_UNATTENDED_TTL_DAYS,
  defaultTtlApprovalFilePath,
  MAX_UNATTENDED_TTL_DAYS,
  TtlApprovalStore,
} from "./ttl-approvals.js";
export type {
  TtlApprovalGrantInput,
  TtlApprovalReader,
  TtlApprovalStoreOptions,
  TtlApprovalWriter,
} from "./ttl-approvals.js";
// 落盘文件形态（版本号 / 逐条校验 / 迁移的 fail-closed 作废）单独成模块。
export { parseTtlPermissionGrantFile } from "./ttl-approval-file.js";
export type { ParseTtlPermissionGrantFileResult } from "./ttl-approval-file.js";
