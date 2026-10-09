/**
 * acode-cli-contracts 模块架构契约（curated stable public surface）。
 *
 * 本文件是模块的**架构契约**入口（architecture-policy.yaml publicEntrypoints），
 * 与 `tools/contract.ts`（工具声明面的领域文件）不是一回事。它从各具体定义文件
 * 策展跨模块稳定面：宿主（bootstrap/core/cli/node-repl-host/plugins 与 Desktop/Web
 * 适配层）依赖这些端口和类型编程，而不是依赖实现。完整导出面在 `index.ts`
 * （package.json `exports["."]`）；本文件保持纯 re-export、≤300 行、不声明接口，
 * 增删条目即契约变更，需按 AGENTS.md 先更新 specs/architecture-contracts-module.md。
 */

// —— 基础词汇（叶子）——
export type {
  EventId,
  InteractionRequestOrigin,
  MessageId,
  PartId,
  QueryId,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
} from "./interfaces/shared.js";
export type { TraceContext } from "./tracing/tracer.js";
export type {
  CollaborationMode,
  RiskLevel,
  TurnInputIntentMetadata,
  TurnSteerCommandKind,
  TurnSteerDeliveryMode,
  TurnSteerSource,
} from "./interfaces/session-shared.js";

// —— Session 域：事件、投影与管理端口 ——
export type { ErrorAttribution, SessionEvent } from "./events/session.events.js";
export type {
  EventReducerPort,
  PendingPermission,
  PendingTurnInput,
  Session,
  SessionConfig,
  SessionEventSink,
  SessionEventStorePort,
  SessionManagerPort,
  SessionProjection,
  SessionSummary,
  TurnSteerInput,
  TurnSteerResult,
} from "./interfaces/session.port.js";
export type {
  SessionStorePort,
  UsageStorePort,
  LocalSettingStorePort,
} from "./interfaces/session-store.port.js";

// —— 权限边界 ——
export type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
  PermissionDecision,
  PermissionOptionsPolicy,
  PermissionRuleset,
  PermissionUpdate,
} from "./interfaces/permission.port.js";

// —— 模型域：端口中立契约 ——
export type {
  Model,
  ModelEvent,
  ModelOptions,
  ModelRequest,
  ModelResult,
  ModelSelection,
} from "./model/model.js";
export type {
  JsonSchema,
  ModelId,
  ModelInputMessage,
  ModelProviderId,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
} from "./model/protocol-types.js";
export type {
  ModelErrorCode,
  ModelNetworkStatusEvent,
  ModelRequestAdmission,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  ModelTransportKind,
} from "./model/request-status.js";
export type { ModelCatalogPort } from "./interfaces/model-catalog.port.js";

// —— 观测与遥测 ——
export type {
  ModelApiCallObservation,
  ModelApiOperation,
} from "./telemetry/observations.js";
export type {
  AgentTelemetryRuntimeOwner,
  ModelAttemptSpanWriter,
  ModelCallSpanWriter,
  ModelExecutionTelemetryPort,
} from "./telemetry/index.js";

// —— 工具声明面 ——
export type {
  ToolContractDeclaration,
  ToolPermissionSpec,
  ToolResultBudget,
  ToolSideEffectScope,
} from "./tools/contract.js";

// —— 执行环境端口 ——
export type { ExecutionPort } from "./interfaces/execution.port.js";
export type { FileSystemPort } from "./interfaces/file-system.port.js";
export type { SubagentPort } from "./interfaces/subagent.port.js";
export type { BrowserControlPort } from "./interfaces/browser-control.port.js";
export type { McpPort } from "./interfaces/mcp.port.js";

// —— Workflow 域 ——
export type { WorkflowPort, WorkflowTaskSnapshot } from "./interfaces/workflow.port.js";
export type {
  DynamicWorkflowRunError,
  DynamicWorkflowRunPort,
} from "./interfaces/dynamic-workflow-run.port.js";
