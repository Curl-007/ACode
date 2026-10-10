import type { SessionGoal, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function targetContinuationCandidate(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (this.hasActiveOrQueuedTurnWork()) return null;
  return targetContinuationCandidateForCommand.call(this, traceContext);
}

export async function targetContinuationCandidateForCommand(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (!this.sessionStore || this.getPlanEnabled()) return null;
  if (this.activeTurn || this.activeTurnStartReservation || !this.sessionPersisted) return null;
  const target = await this.readSessionTargetForContext(traceContext);
  return target?.status === "active" ? target : null;
}
