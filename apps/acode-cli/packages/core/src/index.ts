// ============================================================
// Core package exports
// ============================================================

// Agent components
export * from "./agent/index.js";

// Context Builder
export * from "./context/index.js";

// Compact helpers
export * from "./compact/index.js";

// Memory paths
export { resolveProjectMemoryRoot } from "./memory/project-root.js";

// Tool components
export { ToolScheduler, defaultToolScheduler, READ_ONLY_TOOLS } from "./tool/scheduler.js";
export type {
  ToolSchedule,
  ToolScheduleItem,
  ToolDependency,
  ToolSchedulerSnapshot,
} from "./tool/scheduler.js";
export { createToolRegistry, ToolRegistry, ToolRegistryImpl } from "./tool/registry.js";
export { createToolExecutor, ToolExecutor, ToolExecutorImpl } from "./tool/executor.js";
export { builtInTools, registerBuiltInTools } from "./tool/handlers/index.js";
// 闲时派发轮 / cron automation 轮要隐藏的工具名单。**导出是为了消掉跨包的同值副本**：
// core 的 turn-loop-state 是唯一所有者，而 bootstrap 的 v4 prompt-turn 与 legacy
// server-operations 各自手抄了一份——加一个工具就得同时改三处（RunWorkflow 落地时正是如此），
// 漏一处就等于在派发轮里放行一个能在本轮 modelExecution 之外重启子 Agent 的入口。
// 两个 bootstrap 消费方都改为 import 这里的导出。
export {
  AUTOMATION_MUTATION_TOOL_NAMES,
  OFF_PEAK_MUTATION_TOOL_NAMES,
} from "./runtime/methods/turn-loop-state.js";
// Open 工具的平台端口类型：宿主（bootstrap 的 CLI native opener / desktop host 下发链）
// 实现此接口注入，缺席则工具不注册（K9 R2 port 门控）。
export type { OpenPlatformPort } from "./tool/handlers/open.js";
// dwf driver 的 submit profile 运行时守卫要把 typed 声明换回通用声明。
export {
  createSubmitResultToolEntry,
  submitResultToolEntry,
} from "./tool/handlers/submit-result.js";
// 已保存工作流的 store / codec：GUI 中枢的协议处理器住在
// bootstrap，但解析器与序列化器只能有一份——写侧与读侧各自演化的症状是「刚保存的 workflow
// 列不出来」，所以从这里导出而不是让 bootstrap 再抄一份。
export {
  SAVED_WORKFLOW_SENTINEL,
  findSavedWorkflowShadowing,
  listSavedWorkflows,
  moveSavedWorkflow,
  parseSavedWorkflow,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  savedWorkflowExists,
  savedWorkflowFileName,
  savedWorkflowPath,
  savedWorkflowRoot,
  savedWorkflowRoots,
  serializeSavedWorkflow,
  validateWorkflowArgs,
} from "./tool/handlers/saved-workflows/index.js";
export type {
  ResolvedSavedWorkflow,
  SavedWorkflowListResult,
  SavedWorkflowMoveResult,
  SavedWorkflowParseErrorReason,
  SavedWorkflowParseResult,
  SavedWorkflowResolveFailure,
  SavedWorkflowResolveResult,
  SavedWorkflowRoot,
  SavedWorkflowRootsOptions,
  WorkflowArgsValidation,
} from "./tool/handlers/saved-workflows/index.js";
export {
  DEFAULT_BASH_MAX_TIMEOUT_MS,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_BASH_TIMEOUT_POLICY,
  resolveBashTimeoutMs,
  resolveBashTimeoutPolicy,
} from "./tool/bash-timeout-policy.js";
export type { BashTimeoutPolicy } from "./tool/bash-timeout-policy.js";
export type {
  ToolMetadata,
  ToolHandler,
  ToolExecutionContext,
  ToolEntry,
  ToolExecutionResult,
  ToolResultSerialization,
  ToolBatchResult,
  ExecutableToolCall,
  ToolBatchEvent,
} from "./tool/types.js";

// Hooks
export * from "./hooks/index.js";

// MCP components
export * from "./mcp/index.js";

// Plugin 对话引用（@ Plugin capability hint）
export * from "./plugin-reference/index.js";

// Node REPL/browser-use plugin runtime primitives
export { NodeReplSession } from "./repl/node-repl-session.js";
export type {
  NodeReplCuaAppIdentity,
  NodeReplImage,
  NodeReplRequestMeta,
  NodeReplRunResult,
  NodeReplStructuredResult,
  NodeReplSessionOptions,
} from "./repl/node-repl-session.js";
export { setupBrowserRuntime } from "./browser-client/index.js";
export type { BrowserClientTransport } from "./browser-client/index.js";

// Subagent components
export * from "./subagent/index.js";

// Runtime task components
export * from "./runtime-task/index.js";

// Overnight 挂机执行（K3，specs/overnight-execution.md）：接缝层（fork 端口/runner）与
// 纯模块层一起从包入口导出——bootstrap 装配处与宿主经 @acode/core 公开入口消费，
// 不开深路径（package.json exports 只有 "."）。
export * from "./overnight/constants.js";
export * from "./overnight/duration.js";
export * from "./overnight/manifest.js";
export * from "./overnight/prompts.js";
export * from "./overnight/supervisor.js";
export * from "./overnight/preflight.js";
export * from "./overnight/coordinator.js";
export * from "./overnight/runner.js";

// Ambient 预算感知调度（K6，specs/ambient-budget-scheduler.md）：引擎层从包入口导出
// （overnight/swarm 同款纪律——bootstrap 装配经公开入口消费，不开深路径；package.json
// exports 只有 "."）。这是接线批对引擎导出面缺口的最小补齐：引擎批只落了
// core/src/ambient/ 八文件，未从 index 出口。turn-usage-hook 与 proposal 是 core
// 内部消费面（usage-observability / runner），不进公开出口。
export * from "./ambient/constants.js";
export * from "./ambient/queue.js";
export * from "./ambient/scheduler.js";
export * from "./ambient/runner.js";
export * from "./ambient/usage-ledger.js";
export * from "./ambient/session-kind.js";
// overnight fork 链同款消费的 active 分支选择器：ambient cycle/spawn 的 fork 目标
// （「fork 全部父 messages 于当下」）必须复用 session-fork 的分支语义，不能手写第二份。
export { forkSourceMessagesForSession } from "./runtime/methods/session-fork.js";

// 对话内 Swarm 任务图（K2，specs/swarm-task-graph.md）：端口/存储/runner/投影/提醒与
// 2b 接线辅助从包入口导出（bootstrap 装配与宿主经 @acode/core 公开入口消费，overnight
// 同款纪律）；graph/* 纯函数引擎留给测试深路径，不进公开面。
export * from "./swarm/port.js";
export * from "./swarm/plan-store.js";
export * from "./swarm/runner.js";
export * from "./swarm/projection.js";
export * from "./swarm/prompts.js";
export * from "./swarm/control.js";
export * from "./swarm/runtime-binding.js";
// K2 共享执行原语（specs/swarm-task-graph.md 接口章）：expert node-runner 与 swarm
// runner 的共同消费面，2b 的 bootstrap executeNode 闭包经公开入口消费（不开深路径）。
export {
  decideArtifactGateEnforcement,
  executeNodeSubsession,
  type ArtifactGateRejection,
} from "./workflow/scheduler/node-execution-core.js";

// Workflow components
export * from "./workflow/definition.js";
export * from "./workflow/expert.js";
export * from "./workflow/lifecycle.js";
export * from "./workflow/scheduler.js";

// Permission components
export {
  DenyPermissionBroker,
  ManualPermissionBroker,
  PermissionService,
  createDenyPermissionBroker,
  createManualPermissionBroker,
  defaultPermissionConfig,
  // 安全加固 P2 补丁项：托管策略地板的进程级注册点（create-app 唯一调用方；
  // get/reset 仅供测试，从 src 路径直接导入，不进公开入口避免无消费者导出）。
  setProcessManagedPolicyFloor,
  // J1-2：反射门审计 sink 的进程级注册点（create-app 唯一调用方，接 info 级 Logger
  // 落 JSONL；缺省 sink 写 stderr，见 specs/bash-confirm-reflexive-gate.md R6）。
  setBashReflexAuditSink,
  // auto 分类器审计 sink 的进程级注册点（create-app 唯一调用方，同一 JSONL 形态，
  // 见 specs/auto-mode-risk-classifier.md R6；缺省无 sink，测试环境零输出）。
  setAutoClassifierAuditSink,
} from "./permission/index.js";
export type {
  ManualPermissionBrokerOptions,
  PermissionBehavior,
  PermissionContext,
  PermissionDecisionResult,
  PermissionToolCapability,
} from "./permission/index.js";
export type { PermissionConfig } from "./permission/index.js";
export type { BashReflexAuditEntry, BashReflexAuditSink } from "./permission/index.js";
export type {
  AutoClassifierAuditEntry,
  AutoClassifierAuditSink,
  AutoRiskClassifierPort,
  AutoRiskVerdict,
} from "./permission/index.js";

// Runtime
export { AgentRuntime } from "./runtime.js";
export { createExternalTurnFaultError } from "./runtime/helpers/turn-errors.js";
export { repairPersistedRemoteSessionPaths } from "./runtime/helpers/persisted-remote-session-path-repair.js";
// 「按值把一段转录复制进另一个会话」的克隆器。fork 之外的第二个消费者是 dwf 的 amend-resume
// 转录截断（bootstrap 的 workflow-actor-transcript.ts）：同一个动作——新会话用本地 id 续写，
// parentID / part 内嵌锚点随之重映射。导出而不是让它再写一份，是因为漏掉任何一处重映射的症状
// （悬空 parentID、指向父会话的锚点）离成因都很远。
export { cloneMessageForFork, clonePartForFork } from "./runtime/helpers/steering.js";
export type {
  ChildClientPortsContext,
  ClientFacingPorts,
} from "./runtime/helpers/child-client-ports.js";
// D5 并发只读诊断投影（specs/concurrency-diagnostics-projection.md）：快照形状经包公开
// 入口再导出，文档与消费方（debug 面、测试）引用同一份类型定义，不各自手抄。
export type {
  ConcurrencyDiagnosticsSnapshot,
  ConcurrencyDomainId,
  ConcurrencyDomainSnapshot,
} from "./runtime/methods/concurrency-diagnostics.js";
// P5 tools schema token 度量（specs/tools-schema-token-metrics.md）：度量形状同上理由导出。
export type { ToolsSchemaTokenMetric } from "./runtime/methods/tools-schema-token-metric.js";
export type {
  ActiveTurnInfo,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ConversationRewindResult,
  ExecuteTurnOptions,
  ModelExecutionContext,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ProviderRuntimeHeadersPort,
  ResumeSessionOptions,
  ResumeSessionResult,
  StartSavedWorkflowRunResult,
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
  TurnResult,
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
  WorkspaceForkResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
  RuntimeFactory,
} from "./runtime.js";

// Output helpers
export { color, formatJson, supportsColor } from "./output.js";

// Environment helpers
export { getRuntimeInfo } from "./environment.js";
export type { RuntimeInfo } from "./environment.js";

export type {
  Logger,
  LoggerFactory,
  LogContext,
  LogEntry,
  SessionEvent,
  SessionEventSink,
} from "@acode/contracts";
export { LogLevel, SessionEventType } from "@acode/contracts";
