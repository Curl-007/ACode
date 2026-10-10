import type { SessionEvent, SessionGoal, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getRuntimeBranchRestorePort } from "../turn-coordination.js";
import { assertRuntimeModelBranchCurrent } from "./runtime-command-generation.js";
import {
  verifyTargetCompletion,
  type TargetCompletionVerificationResult,
} from "./target-completion-verification.js";
import { runTargetCompletionVerificationWithTelemetry } from "./target-completion-verification-telemetry.js";

export async function verifyActiveTargetCompletionForContinuation(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    branchGeneration: number;
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<TargetCompletionVerificationResult | null> {
  assertRuntimeModelBranchCurrent(this, input.branchGeneration);
  if (this.config.targetCompletionVerification?.enabled === false) return null;
  if (!this.sessionStore || input.target.status !== "active") return null;
  const execute = async (): Promise<TargetCompletionVerificationResult> => {
    const events: SessionEvent[] = [];
    const verification = await verifyTargetCompletion.call(this, { ...input, events });
    assertRuntimeModelBranchCurrent(this, input.branchGeneration);
    if (!verification.passed) return { target: input.target, verification };

    // verifier 返回时已可能换代；目标 read/write/event 必须与分支恢复共用授权。
    const completed = await getRuntimeBranchRestorePort(this).commitTargetStateIfCurrent(
      input.branchGeneration,
      async () => {
        const previousTarget = await this.readSessionTargetForContext(input.traceContext);
        const target =
          (await this.sessionStore!.updateTargetStatus({
            sessionID: this.sessionId,
            status: "complete",
          })) ?? input.target;
        await this.recordTargetChanged({
          action: "status_updated",
          previousTarget,
          source: "runtime",
          target,
          traceContext: input.traceContext,
        });
        return { target, verification };
      },
    );
    if (!completed) {
      assertRuntimeModelBranchCurrent(this, input.branchGeneration);
      throw new Error("Target completion branch authorization was rejected");
    }
    return completed;
  };
  return runTargetCompletionVerificationWithTelemetry(this, input, execute);
}
