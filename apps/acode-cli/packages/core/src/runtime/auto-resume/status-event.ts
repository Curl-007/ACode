// auto_resume_scheduled 观测事件（specs/turn-auto-resume.md「状态上报」）：走
// SessionEventType.ModelNetworkStatus 既有事件通道（runtime/methods/model-status.ts 的
// logModelNetworkStatus 同款日志面），session-mapper 投影进 apiRetry 槽。
import type {
  ModelAutoResumeScheduledStatusEvent,
  ModelId,
  ModelProviderId,
} from "@acode/contracts";
import { SessionEventType } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AutoResumeInjectionPlan } from "./types.js";

export async function emitAutoResumeScheduledStatus(
  runtime: AgentRuntimeInternal,
  input: { plan: AutoResumeInjectionPlan; delayMs: number },
): Promise<void> {
  const { plan, delayMs } = input;
  const traceContext = plan.injectionContext.traceContext;
  const selection = runtime.getSessionModelSelection();
  const attribution = plan.attribution;
  // attribution 的 provider/model 是投影出的普通字符串（失败请求的真实身份，优先）；
  // 品牌类型只服务编译期口径，值域本就来自配置词汇，内部观测面收窄回品牌。
  const providerId = (attribution?.providerId ?? selection?.providerId) as
    | ModelProviderId
    | undefined;
  const modelId = (attribution?.modelId ?? selection?.modelId) as ModelId | undefined;
  const payload: ModelAutoResumeScheduledStatusEvent = {
    type: "auto_resume_scheduled",
    timestamp: runtime.now().toISOString(),
    traceId: traceContext.traceId,
    sessionId: runtime.sessionId,
    ...(traceContext.queryId ? { queryId: traceContext.queryId } : {}),
    ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
    attempt: plan.attempt,
    maxAttempts: plan.maxResumes,
    delayMs,
    errorSummary: plan.errorSummary,
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(attribution?.transport ? { transport: attribution.transport } : {}),
  };
  const event = runtime.createEvent(SessionEventType.ModelNetworkStatus, payload, traceContext);
  await runtime.appendEvent(event, traceContext);
  runtime.logModelNetworkStatus(payload, traceContext);
}
