import type {
  ExpertWorkflowRunSnapshot,
  WorkflowCriticReopenProposal,
  WorkflowPhaseDefinition,
} from "@acode/contracts";
import {
  buildCriticSupplementRequest,
  collectCriticAuditScope,
  collectCriticCoverageTexts,
  describeCriticGateIssues,
  evaluateCriticGate,
  resolveWorkflowGateSettings,
  type CriticGateIssue,
} from "../artifact-gate.js";
import { reopenWorkflowGraphNode } from "../lifecycle.js";
import { phaseNodeId } from "./ids.js";
import { dedupeReopenProposals, parseCriticResult } from "./parsers/critic.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertWorkflowRunOptions } from "./types.js";
import { runPhase } from "./phase-runner.js";
import { runScheduledPhase } from "./scheduled-phase.js";

export async function runFinalCriticLoop(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  options: ExpertWorkflowRunOptions,
): Promise<ExpertWorkflowRunSnapshot> {
  let current = snapshot;
  // J2-3（specs/workflow-typed-artifacts.md R6-R7）：分档 gate。light（含未声明 gatePolicy
  // 的既有 definition）只强制置信度债务；deep 追加 stale scope 与全量点名校验。
  const gate = resolveWorkflowGateSettings(ctx.definition);
  // pass 被覆盖/stale 债务拒绝后注入下一轮 critic 提示词的补充要求。每轮用后即清、不落盘：
  // resume 后 critic 阶段整体重跑、重新点名，不需要恢复该状态。
  let supplementRequest: string | undefined;
  const execDefinition = ctx.definition.phases.find(
    (phaseDefinition) => phaseDefinition.behavior === "scheduled_graph",
  );
  if (!execDefinition) {
    throw new Error(`${ctx.definition.title} definition is missing a scheduled graph phase`);
  }

  for (let iteration = 1; iteration <= current.strategy.finalCritic.maxIterations; iteration++) {
    await ctx.appendEvent(current.runId, "critic_started", {
      message: `Final critic iteration ${iteration} started.`,
      payload: { iteration },
      phase: definition.phase,
      signal: options.abortSignal,
    });

    const phaseRun = await runPhase(ctx, current, definition, options, {
      gate,
      ...(supplementRequest ? { supplementRequest } : {}),
    });
    const deliveredSupplement = supplementRequest;
    supplementRequest = undefined;
    current = phaseRun.snapshot;
    const critic = parseCriticResult(phaseRun.response);

    let gateIssues: CriticGateIssue[] = [];
    let gateProposals: WorkflowCriticReopenProposal[] = [];
    if (critic.verdict === "pass") {
      gateIssues = evaluateCriticGate({
        coverageTexts: collectCriticCoverageTexts(critic),
        preset: gate.preset,
        scope: collectCriticAuditScope(current),
      });
      if (gateIssues.length === 0) {
        await ctx.appendEvent(current.runId, "critic_passed", {
          message: critic.reasoning || `Final critic iteration ${iteration} passed.`,
          payload: {
            acceptanceGaps: critic.acceptanceGaps,
            iteration,
          },
          phase: definition.phase,
          signal: options.abortSignal,
        });
        return current;
      }

      const lowConfidence = gateIssues.find(
        (issue) => issue.kind === "unaddressed_low_confidence",
      );
      if (lowConfidence) {
        // 置信度债务（两档通用的轻量规则）：自报 low 且 pass 未点名的节点转成后续工作，
        // 复用既有 reopen → exec 重跑通道；封顶由 maxReopens 与 maxIterations 保证。
        gateProposals = lowConfidence.nodeIds.map((nodeId) => ({
          nodeId,
          reason:
            "Node self-reported confidence=low and the critic pass verdict did not address it by id; routed as follow-up work by the workflow gate.",
          severity: "major" as const,
        }));
      } else {
        // 覆盖/stale 债务（deep）：不重开节点（工作本身可能没问题，薄的是审计），
        // 拒绝 pass 并要求 critic 在下一轮按 id 补充点名。
        supplementRequest = buildCriticSupplementRequest(gateIssues);
      }
    }

    const reopenProposals = dedupeReopenProposals([...critic.reopenProposals, ...gateProposals]);
    await ctx.appendEvent(current.runId, "critic_failed", {
      message:
        gateIssues.length > 0
          ? `Final critic pass rejected by the ${gate.preset} gate: ${describeCriticGateIssues(gateIssues)}`
          : critic.reasoning || `Final critic iteration ${iteration} failed.`,
      payload: {
        acceptanceGaps: critic.acceptanceGaps,
        iteration,
        reopenProposals,
        ...(gateIssues.length > 0
          ? {
              gateIssues: gateIssues.map((issue) => ({ ...issue })),
              preset: gate.preset,
            }
          : {}),
        ...(deliveredSupplement ? { supplementRequest: deliveredSupplement } : {}),
      },
      phase: definition.phase,
      signal: options.abortSignal,
    });

    if (reopenProposals.length === 0) {
      if (supplementRequest) {
        // 只重置 critic phase（exec 的 done 节点不动），下一轮 runPhase 携带补充要求重跑。
        const retryReason = `Final critic pass rejected by the ${gate.preset} gate: ${describeCriticGateIssues(gateIssues)}`;
        current = resetPhaseForRetry(ctx, current, definition.phase, retryReason);
        await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
        await ctx.appendGraphStatus(current, definition.phase, "pending", options.abortSignal);
        continue;
      }
      return current;
    }

    const reopenedNodeIds: string[] = [];
    for (const proposal of reopenProposals) {
      const reopen = await tryReopenCriticNode(
        ctx,
        current,
        proposal,
        iteration,
        definition.phase,
        options.abortSignal,
      );
      if (!reopen) continue;
      current = reopen.snapshot;
      reopenedNodeIds.push(proposal.nodeId);
      await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
      await appendGraphReopen(
        ctx,
        current,
        proposal,
        iteration,
        reopen.reopenAttempts,
        definition.phase,
        options.abortSignal,
      );
      await ctx.appendEvent(current.runId, "node_reopened", {
        message: `Node reopened by final critic: ${proposal.nodeId}`,
        nodeId: proposal.nodeId,
        payload: {
          iteration,
          reason: proposal.reason,
          reopenAttempts: reopen.reopenAttempts,
          severity: proposal.severity,
        },
        phase: definition.phase,
        signal: options.abortSignal,
      });
    }

    if (reopenedNodeIds.length === 0) {
      return current;
    }

    const retryReason = `Final critic reopened node(s): ${reopenedNodeIds.join(", ")}`;
    current = resetPhaseForRetry(ctx, current, execDefinition.phase, retryReason);
    current = resetPhaseForRetry(ctx, current, definition.phase, retryReason);
    await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
    await ctx.appendGraphStatus(current, execDefinition.phase, "pending", options.abortSignal);
    await ctx.appendGraphStatus(current, definition.phase, "pending", options.abortSignal);
    current = await runScheduledPhase(ctx, current, execDefinition, options);
  }

  current = ctx.updatePhase(current, definition.phase, {
    completedAt: ctx.timestamp(),
    error: "Final critic iteration limit reached.",
    status: "failed",
  });
  await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
  await ctx.appendGraphStatus(current, definition.phase, "failed", options.abortSignal);
  await ctx.appendEvent(current.runId, "critic_iteration_limit_reached", {
    message: "Final critic iteration limit reached.",
    payload: { maxIterations: current.strategy.finalCritic.maxIterations },
    phase: definition.phase,
    signal: options.abortSignal,
  });
  return current;
}

async function tryReopenCriticNode(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  proposal: WorkflowCriticReopenProposal,
  iteration: number,
  phase: string,
  signal?: AbortSignal,
): Promise<{ reopenAttempts: number; snapshot: ExpertWorkflowRunSnapshot } | null> {
  try {
    const result = reopenWorkflowGraphNode(snapshot, {
      maxReopens: 2,
      nodeId: proposal.nodeId,
      reason: proposal.reason,
      timestamp: ctx.timestamp(),
    });
    return {
      reopenAttempts: result.reopenAttempts,
      snapshot: result.snapshot,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.appendEvent(snapshot.runId, "critic_failed", {
      message: `Critic reopen rejected for ${proposal.nodeId}: ${message}`,
      payload: {
        iteration,
        nodeId: proposal.nodeId,
        reason: proposal.reason,
        rejected: true,
      },
      phase,
      signal,
    });
    return null;
  }
}

function resetPhaseForRetry(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  phase: string,
  reason: string,
): ExpertWorkflowRunSnapshot {
  return {
    ...snapshot,
    currentPhase: phase,
    graph: {
      collections: snapshot.graph.collections,
      edges: snapshot.graph.edges,
      nodes: snapshot.graph.nodes.map((node) =>
        node.id === phaseNodeId(phase) && node.kind === "phase"
          ? {
              ...node,
              error: reason,
              status: "pending" as const,
            }
          : node,
      ),
    },
    phases: snapshot.phases.map((item) =>
      item.phase === phase
        ? {
            error: reason,
            phase,
            status: "pending" as const,
          }
        : item,
    ),
    updatedAt: ctx.timestamp(),
  };
}

async function appendGraphReopen(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  proposal: WorkflowCriticReopenProposal,
  iteration: number,
  reopenAttempts: number,
  phase: string,
  signal?: AbortSignal,
): Promise<void> {
  await ctx.store.appendGraphRecord(
    snapshot.runId,
    {
      nodeId: proposal.nodeId,
      payload: {
        iteration,
        reason: proposal.reason,
        reopenAttempts,
        severity: proposal.severity,
      },
      phase,
      recordType: "op",
      runId: snapshot.runId,
      status: "pending",
      timestamp: ctx.timestamp(),
      type: "reopen_node",
    },
    { signal },
  );
}
