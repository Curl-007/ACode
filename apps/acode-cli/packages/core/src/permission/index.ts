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
export { setBashReflexAuditSink } from "./bash-confirm-reflex-gate.js";
export type { BashReflexAuditEntry, BashReflexAuditSink } from "./bash-confirm-reflex-gate.js";
// auto 模式风险分类器（specs/auto-mode-risk-classifier.md）：对外只需端口类型与审计
// sink 注册点——rubric/解析/缓存预算是 core 内部实现，sidecar 构造点唯一在
// runtime/helpers/runtime-tools.ts（createRuntimeToolExecutor）。
export { setAutoClassifierAuditSink } from "./auto-risk-classifier.js";
export type {
  AutoClassifierAuditEntry,
  AutoClassifierAuditSink,
  AutoRiskClassifierPort,
  AutoRiskVerdict,
} from "./auto-risk-classifier.js";
