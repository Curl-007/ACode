// ============================================================
// Provider Doctor live 档检查点执行（J3-1 / spec R3 #10-#12）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================

import type { ProviderDoctorCheckRecorder } from "./check-recorder.js";
import { isCheckpointRunAtTier, getProviderDoctorCheckpoint } from "./checkpoints.js";
import { timedRun } from "./internal.js";
import {
  probeNonStreamingCompletion,
  probeStreamingCompletion,
  probeToolCallParse,
  type ProviderDoctorLiveProbeInput,
  type ProviderDoctorProbeOutcome,
} from "./live-probe.js";
import type { ProviderDoctorSpendTracker } from "./spend.js";
import type { ProviderDoctorCheckpointId, ProviderDoctorTier } from "./types.js";

export interface ProviderDoctorLiveChecksInput {
  readonly recorder: ProviderDoctorCheckRecorder;
  readonly spend: ProviderDoctorSpendTracker;
  readonly tier: ProviderDoctorTier;
  /**
   * 凭据、模型路由与**端点判定**（#3 形态 + #7 公网出口）的前置结论：任一不满足就不打
   * 真实调用——既不花费余额，也不把凭据送到本模块已经拒绝的端点（spec R4「先校验后连接」）。
   */
  readonly prerequisitesMet: boolean;
  /** 目标模型事实不齐（无模型可选）时缺席：同样跳过真实调用。 */
  readonly probeInput?: ProviderDoctorLiveProbeInput;
}

export async function runProviderDoctorLiveChecks(
  input: ProviderDoctorLiveChecksInput,
): Promise<void> {
  const { recorder, spend, tier } = input;
  if (!isCheckpointRunAtTier(getProviderDoctorCheckpoint("non_streaming_chat_completion"), tier)) {
    const reason = `${tier} 档不花费余额：真实调用需要 --tier=live`;
    recorder.skip("non_streaming_chat_completion", reason);
    recorder.skip("streaming_chat_completion", reason);
    recorder.skip("tool_call_parse", reason);
    return;
  }
  const probeInput = input.probeInput;
  if (!input.prerequisitesMet || !probeInput) {
    const reason = "前置检查未通过，跳过真实调用（不花费余额）";
    recorder.skip("non_streaming_chat_completion", reason);
    recorder.skip("streaming_chat_completion", reason);
    recorder.skip("tool_call_parse", reason);
    return;
  }

  await runProbe("non_streaming_chat_completion", recorder, spend, () =>
    probeNonStreamingCompletion(probeInput),
  );
  await runProbe("streaming_chat_completion", recorder, spend, () =>
    probeStreamingCompletion(probeInput),
  );
  await runProbe("tool_call_parse", recorder, spend, () => probeToolCallParse(probeInput));
}

async function runProbe(
  id: ProviderDoctorCheckpointId,
  recorder: ProviderDoctorCheckRecorder,
  spend: ProviderDoctorSpendTracker,
  run: () => Promise<ProviderDoctorProbeOutcome>,
): Promise<void> {
  const outcome = await timedRun(run);
  // 只有真的发出了请求才计可计费调用：构造失败/档位缺失不该被记成花费。
  if (outcome.result.attempted) spend.recordModelCall(outcome.result.usage);
  recorder.set(id, outcome.result.status, outcome.result.detail, outcome.durationMs);
}
