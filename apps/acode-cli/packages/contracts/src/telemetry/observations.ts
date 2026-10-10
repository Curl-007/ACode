// ============================================================
// Model API observation vocabulary - telemetry leaf types
// ============================================================
// 架构断环叶子（specs/architecture-contracts-module.md）：这组 ModelApi*/ModelReasoning*
// 观测类型原住在 telemetry/index.ts，而 model/index.ts、model/invocation-context.ts、
// events/session.events.ts 都要引用它们，telemetry/index.ts 又反向引用 model 侧的
// ModelId/ModelTransportKind/ModelStatusSink，形成 telemetry ↔ model 文件级 import 环。
// 下沉到本叶子文件断环；telemetry/index.ts 原样再导出（export *），包导出面逐名不变。
//
// 本文件必须保持叶子地位：不导入任何内部模块（映射/解析函数留在 telemetry/index.ts，
// 因为它们依赖 agent-execution 与 model 侧类型）。

export const ModelApiOperation = {
  AgentStep: "agent_step",
  AutoRiskClassification: "auto_risk_classification",
  ContextCompaction: "context_compaction",
  GoalTitle: "goal_title_generation",
  GoalVerification: "goal_completion_verification",
  GitCommitMessage: "workspace_git_commit_message",
  ProjectMemoryExtract: "project_memory_extract",
  ReadSessionContextExtract: "read_session_context_extract",
  ReadSessionContextSynthesize: "read_session_context_synthesize",
  SessionTitle: "session_title_generation",
  ToolInternalModelCall: "tool_internal_model_call",
  WebFetch: "web_fetch_processing",
  WebSearch: "web_search",
  WorkspaceGenerateText: "workspace_generate_text",
} as const;

export type ModelApiOperation = (typeof ModelApiOperation)[keyof typeof ModelApiOperation];

export const ModelApiActorKind = {
  MainAgent: "main",
  Subagent: "subagent",
  WorkflowChild: "workflow_child",
  System: "system",
  Tool: "tool",
} as const;

export type ModelApiActorKind = (typeof ModelApiActorKind)[keyof typeof ModelApiActorKind];
export type ModelApiCallCause = "initial" | "continuation" | "fallback_replacement" | "recovery";
export type ModelApiRuntimeSurface =
  | "standalone_cli"
  | "desktop_local_host"
  | "remote_workspace_host";
export type ModelApiErrorPhase =
  | "prepare"
  | "configuration"
  | "connect"
  | "response"
  | "stream"
  | "parse"
  | "validation"
  | "unhandled";
export const ModelFailureExceptionKind = {
  ApiCall: "api_call",
  Generic: "generic",
  Protocol: "protocol",
  ProviderBusiness: "provider_business",
  Transport: "transport",
  TypeError: "type_error",
  Validation: "validation",
} as const;
export type ModelFailureExceptionKind =
  (typeof ModelFailureExceptionKind)[keyof typeof ModelFailureExceptionKind];
export type ModelReasoningCapabilityStatus = "supported" | "unsupported" | "unknown";
export type ModelReasoningState = "enabled" | "disabled" | "provider_default" | "unknown";
export type ModelReasoningControlType =
  | "fixed_level"
  | "fixed_budget"
  | "adaptive"
  | "toggle"
  | "provider_default"
  | "unknown";

/** 调用点只声明用户/业务请求的 reasoning 意图，Provider Adapter 决定最终事实。 */
export interface ModelReasoningCallHint {
  requestedLevel?: string;
  explicit?: {
    state: Exclude<ModelReasoningState, "unknown">;
    controlType?: Exclude<ModelReasoningControlType, "unknown">;
    effectiveLevel?: string;
    effectiveBudgetTokens?: number;
  };
}

/** 一次最终 Provider 请求的 canonical reasoning 事实。 */
export interface ModelReasoningObservation {
  capability: ModelReasoningCapabilityStatus;
  requestedState: ModelReasoningState;
  requestedControl: ModelReasoningControlType;
  requestedLevel?: string;
  requestedBudgetTokens?: number;
  effectiveState: ModelReasoningState;
  effectiveControl: ModelReasoningControlType;
  effectiveLevel?: string;
  effectiveBudgetTokens?: number;
}

/**
 * 受控调用专属事实。禁止 prompt、message、header、body、原始 URL、命令和工具 I/O。
 */
export interface ModelApiCustomAttributes {
  compactionOuterAttempt?: number;
  compactionTrigger?: string;
  streamRecoveryNumber?: number;
}

export interface ModelApiCallObservation {
  operation?: ModelApiOperation;
  actorKind?: ModelApiActorKind;
  operationId?: string;
  logicalCallId?: string;
  callCause?: ModelApiCallCause;
  previousLogicalCallId?: string;
  runtimeSurface?: ModelApiRuntimeSurface;
  agentName?: string;
  stepIndex?: number;
  reasoning?: ModelReasoningCallHint;
  attributes?: ModelApiCustomAttributes;
}

export type ResolvedModelApiCallObservation = Omit<ModelApiCallObservation, "reasoning"> & {
  logicalCallId: string;
  operation: ModelApiOperation;
  actorKind: ModelApiActorKind;
  reasoning: ModelReasoningObservation;
};
