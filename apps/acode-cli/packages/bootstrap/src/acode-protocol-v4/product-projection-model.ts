// D3 model-stream 域的纯 helper（product-projection.ts 拆分批次 1，
// specs/product-projection-structure.md §2 D3 / §4）。纯函数叶子：sparse model
// selection 的克隆/相等、retry/recovery reason → 故障码映射。无 this 依赖。
// 抽出不改任何语义（reason code 映射逐分支保留）。
import type {
  ModelNetworkStatusPayload,
  ModelSelectedPayload,
  StreamRecoveryStartedPayload,
} from "@acode/contracts";

// 旧事件没有 retryable 字段；保持历史 UI 的可重试语义，但新事件必须尊重显式 false。
export const LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK = true;

export function cloneSparseModelSelection(
  selection: ModelSelectedPayload["modelSelection"],
): ModelSelectedPayload["modelSelection"] {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

export function sameSparseModelSelection(
  left: ModelSelectedPayload["modelSelection"] | undefined,
  right: ModelSelectedPayload["modelSelection"] | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export function modelRetryReasonCode(
  reason: Extract<ModelNetworkStatusPayload, { type: "model_retry_scheduled" }>["reason"],
): string {
  switch (reason) {
    case "rate_limited":
      return "fault.provider.rateLimited";
    // off-peak 排队（429/3105）语义上就是"上游让我们等"，UI 归入限流可恢复形态。
    case "offpeak_queued":
      return "fault.provider.rateLimited";
    case "provider_overloaded":
    case "server_error":
      return "fault.provider.serverError";
    case "timeout":
      return "fault.network.timeout";
    case "stream_idle_timeout":
      return "fault.network.sseStalled";
    case "stale_connection":
      return "fault.network.sseDisconnected";
    case "network_error":
      return "fault.network.unreachable";
    case "auth_refresh":
    case "reasoning_signature_repair":
      return "fault.provider.requestFailed";
  }
}

export function streamRecoveryReasonCode(
  failureKind: StreamRecoveryStartedPayload["failureKind"],
): string {
  switch (failureKind) {
    case "provider_timeout":
      return "fault.network.timeout";
    case "provider_network_error":
      return "fault.network.unreachable";
    case "provider_stream_error":
      return "fault.network.sseDisconnected";
    case "provider_turn_failed":
    case "unknown":
      return "fault.provider.requestFailed";
  }
}
