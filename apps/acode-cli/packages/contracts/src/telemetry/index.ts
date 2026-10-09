// 架构断环下沉（specs/architecture-contracts-module.md）：ModelApi*/ModelReasoning*
// 观测词汇已下沉到 ./observations.ts（叶子），本文件 `export *` 原样再导出，包导出面
// 逐名不变；对 model 侧类型的引用改指具体定义文件（protocol-types / request-status），
// 不再引用 model/index.ts 桶文件——model/index 依赖本文件的观测类型，桶级互指即成环。
import type { ModelId, ModelProviderId } from "../model/protocol-types.js";
import type { ModelStatusSink, ModelTransportKind } from "../model/request-status.js";
import type {
  AgentExecutionTelemetryPort,
  AgentTelemetryAbandonReason,
  AgentTelemetryCancellationReason,
  AgentTelemetryErrorCategory,
  AgentTelemetryOperation,
  AgentTelemetryScope,
} from "./agent-execution.js";
// ModelApiOperation/ModelApiActorKind 是 const 对象（运行时值），必须走值导入。
import {
  ModelApiActorKind,
  ModelApiOperation,
  type ModelApiCallCause,
  type ModelApiCallObservation,
  type ModelApiRuntimeSurface,
  type ModelReasoningControlType,
  type ModelReasoningObservation,
  type ModelReasoningState,
} from "./observations.js";

export * from "./agent-execution.js";
export * from "./observations.js";

export function mapModelApiOperationToAgentOperation(
  operation: ModelApiOperation,
): AgentTelemetryOperation {
  return operation;
}

export function resolveModelApiCallObservation(
  querySource: string | undefined,
  observation: ModelApiCallObservation | undefined,
): Required<Pick<ModelApiCallObservation, "operation" | "actorKind" | "logicalCallId">> &
  ModelApiCallObservation {
  const mapped = mapQuerySourceToModelApiOperation(querySource);
  return {
    ...mapped,
    ...observation,
    operation: observation?.operation ?? mapped.operation,
    actorKind: observation?.actorKind ?? mapped.actorKind,
    logicalCallId: observation?.logicalCallId?.trim() || crypto.randomUUID(),
  };
}

function mapQuerySourceToModelApiOperation(querySource: string | undefined): {
  operation: ModelApiOperation;
  actorKind: ModelApiActorKind;
} {
  switch (querySource?.trim()) {
    case "main_turn":
      return { operation: ModelApiOperation.AgentStep, actorKind: ModelApiActorKind.MainAgent };
    case "subagent":
      return { operation: ModelApiOperation.AgentStep, actorKind: ModelApiActorKind.Subagent };
    case "workflow_child":
      return {
        operation: ModelApiOperation.AgentStep,
        actorKind: ModelApiActorKind.WorkflowChild,
      };
    case "compact":
      return {
        operation: ModelApiOperation.ContextCompaction,
        actorKind: ModelApiActorKind.System,
      };
    case "session_title":
      return {
        operation: ModelApiOperation.SessionTitle,
        actorKind: ModelApiActorKind.System,
      };
    case "goal_summary_title":
      return { operation: ModelApiOperation.GoalTitle, actorKind: ModelApiActorKind.System };
    case "target_completion_verification":
      return {
        operation: ModelApiOperation.GoalVerification,
        actorKind: ModelApiActorKind.System,
      };
    case "git_commit_message":
      return {
        operation: ModelApiOperation.GitCommitMessage,
        actorKind: ModelApiActorKind.System,
      };
    case "web_search_tool":
      return { operation: ModelApiOperation.WebSearch, actorKind: ModelApiActorKind.Tool };
    case "web_fetch_processing":
      return { operation: ModelApiOperation.WebFetch, actorKind: ModelApiActorKind.Tool };
    case "read_session_context":
      return {
        operation: ModelApiOperation.ReadSessionContextExtract,
        actorKind: ModelApiActorKind.Tool,
      };
    case "project_memory_extract":
      return {
        operation: ModelApiOperation.ProjectMemoryExtract,
        actorKind: ModelApiActorKind.System,
      };
    default:
      return {
        operation: ModelApiOperation.ToolInternalModelCall,
        actorKind: ModelApiActorKind.System,
      };
  }
}

export interface ProviderEndpointIdentity {
  origin: string;
  route: string;
  sanitizerVersion: string;
}

export interface TelemetryIdentitySnapshot {
  identityState: "authenticated" | "anonymous" | "unknown";
  userSubjectId?: string;
}

export interface TelemetryResourceContext {
  buildCommitId?: string;
  cliVersion?: string;
  deploymentEnvironment?: string;
  installationId?: string;
  productVersion?: string;
  runtimeDistribution?: "source" | "development_bundle" | "packaged" | "unknown";
  runtimeSurface: ModelApiRuntimeSurface;
  serviceInstanceId: string;
  serviceName: string;
}

export type ModelApiOperationKind =
  | "messages"
  | "chat_completions"
  | "responses"
  | "generate_content"
  | "unknown";

export type ModelCallFailureStage =
  | "resolve_target"
  | "attempts"
  | "fallback"
  | "aggregate"
  | "unhandled";

export type ModelAttemptFailureStage =
  | "configuration"
  | "connect"
  | "response"
  | "stream"
  | "parse"
  | "validation"
  | "unhandled";

/** Provider/SDK 实际返回的有界结束原因，不在领域层折叠成 other。 */
export type ModelFinishReason = string;

export interface ResolvedModelTelemetryDescriptor {
  providerId: string;
  providerKind: string;
  providerOrigin?: string;
  providerRoute?: string;
  reasoning: ModelReasoningObservation;
  requestedModel: string;
}

export interface ResponseModelTelemetryDescriptor {
  model: string;
}

export type ModelCallTraceStart = {
  logicalCallId: string;
  modelRole?: string;
  operation: ModelApiOperation;
  requested: ResolvedModelTelemetryDescriptor;
  streaming: boolean;
} & (
  | {
      callCause: "initial";
      previousLogicalCallId?: never;
    }
  | {
      callCause: Exclude<ModelApiCallCause, "initial">;
      previousLogicalCallId: string;
    }
);

export type ModelAttemptTraceStart = {
  apiOperation: ModelApiOperationKind;
  attemptNumber: number;
  maxAttempts: number;
  requestId: string;
  target: ResolvedModelTelemetryDescriptor;
  transport: ModelTransportKind;
} & (
  | {
      attemptCause: "initial";
      previousRequestId?: never;
      retryDelayMs?: never;
    }
  | {
      attemptCause: "retry" | "fallback";
      previousRequestId: string;
      retryDelayMs?: number;
    }
);

export interface ModelCallSpanWriter extends AgentTelemetryScope {
  startAttempt(input: ModelAttemptTraceStart): ModelAttemptSpanWriter;
  markFallbackSelected(reason: string): void;
  finishCompleted(): void;
  finishFailed(
    stage: ModelCallFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  finishAbandoned(reason: AgentTelemetryAbandonReason): void;
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

export interface ModelAttemptSpanWriter extends AgentTelemetryScope {
  setProviderRequestId(requestId: string): void;
  setResponseModel(model: ResponseModelTelemetryDescriptor): void;
  setEffectiveReasoningState(state: ModelReasoningState): void;
  setEffectiveReasoningControl(control: ModelReasoningControlType): void;
  setEffectiveReasoningLevel(level: string): void;
  setEffectiveReasoningBudgetTokens(tokens: number): void;
  setFinishReason(reason: ModelFinishReason): void;
  setInputTokens(tokens: number): void;
  setOutputTokens(tokens: number): void;
  setReasoningTokens(tokens: number): void;
  setCacheReadTokens(tokens: number): void;
  setCacheWriteTokens(tokens: number): void;
  setStreamOutputCommitted(committed: boolean): void;
  setHttpStatusCode(statusCode: number): void;
  setProviderErrorCode(code: string): void;
  setProviderErrorMessage(message: string): void;
  setRetryAfterMs(delayMs: number): void;
  markFirstProviderEvent(): void;
  markFirstContent(): void;
  markFirstText(): void;
  markStreamStalled(idleMs: number): void;
  finishCompleted(): void;
  finishFailed(
    stage: ModelAttemptFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  finishAbandoned(reason: AgentTelemetryAbandonReason): void;
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

export interface ModelExecutionTelemetryPort {
  startCall(input: ModelCallTraceStart): ModelCallSpanWriter;
}

/**
 * App 注入和 Standalone 初始化共用的进程级 Owner。一个 CLI 进程只能创建一个 Owner。
 */
export interface AgentTelemetryRuntimeOwner {
  readonly agentExecution: AgentExecutionTelemetryPort;
  readonly enabled: boolean;
  readonly modelExecution: ModelExecutionTelemetryPort;
  readonly statusSink?: ModelStatusSink;
  abandonSession(sessionId: string): void;
  flush(options?: { timeoutMs?: number }): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
  updateIdentity(snapshot: TelemetryIdentitySnapshot): void;
}

export interface ModelApiCallDescriptor {
  observation: Required<
    Pick<ModelApiCallObservation, "operation" | "actorKind" | "logicalCallId">
  > &
    ModelApiCallObservation;
  providerId: ModelProviderId;
  modelId: ModelId;
}
