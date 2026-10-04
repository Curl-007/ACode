// K2 对话内 Swarm 任务图 R5：PlanControl 的图转移（cancel-node / cancel-plan）。
//
// 为什么不在 graph/ops.ts：R2 ops 是「结构变更」（seed/expand/complete/inject/requeue），
// cancel 是执行控制的终态转移（与 runner.ts 的 claim/no-artifact/fail 同族——owner 与
// 执行状态的写面，R6「owner 只由 runner 分配/清空」的执行侧推论：取消也清 owner）。
// 第一段（graph/*）文件本段不再改，执行簿记写面集中在 swarm/ 下。纯函数：克隆 → 转移
// → version+1（「每次已提交的图变更 +1」，与 ops 的 commit 同口径）；结构校验不涉及
// （不增删节点/边，validateSwarmGraph 不变量不被触碰）。

import type { SwarmGraphError, SwarmPlanNode, SwarmTaskPlan } from "@acode/contracts";

type TransitionResult = { ok: true; plan: SwarmTaskPlan } | { ok: false; error: SwarmGraphError };

function stale(): { error: SwarmGraphError; ok: false } {
  return {
    error: {
      kind: "invalid-state",
      message:
        "swarm control transition skipped: the node is no longer in a cancellable state (queued or running)",
    },
    ok: false,
  };
}

function withTerminated(plan: SwarmTaskPlan, node: SwarmPlanNode, nowMs: number): void {
  node.status = "failed";
  node.owner = null;
  plan.updatedAtMs = nowMs;
}

/**
 * cancel-node：queued/running 的节点置 failed（owner 清空；在飞执行的结果会被 runner 的
 * stale run 防护丢弃）。done 拒绝——取消不是重开已完成工作的通道（同 requeueNode 口径：
 * 重开走 expand/gap 注入）；failed 本就是终态，重复取消按幂等 no-op 处理（返回原引用，
 * 不递增 version——「no-op 不递增」）。
 */
export function cancelSwarmNode(
  plan: SwarmTaskPlan | null,
  nodeId: string,
  nowMs: number,
): TransitionResult {
  if (plan === null) return stale();
  const node = plan.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    return {
      error: {
        kind: "unknown-node",
        message: `cancel-node: unknown node "${nodeId}"`,
        nodeId,
      },
      ok: false,
    };
  }
  if (node.status === "failed") return { ok: true, plan };
  if (node.status !== "queued" && node.status !== "running") return stale();
  const staged = structuredClone(plan);
  const stagedNode = staged.nodes.find((candidate) => candidate.id === nodeId)!;
  withTerminated(staged, stagedNode, nowMs);
  staged.version += 1;
  return { ok: true, plan: staged };
}

/**
 * cancel-plan：全部非 done 节点置 failed（含 gate 与 queued/running worker）。done 保留
 * ——已完成工作的事实不被取消抹掉；plan 保留在 store（终态 stalled 由 schedule.ts 推导，
 * PlanStatus/reminder 照常可读），需要重来用 PlanSeed re-seed。
 */
export function cancelSwarmPlan(plan: SwarmTaskPlan | null, nowMs: number): TransitionResult {
  if (plan === null) return stale();
  const staged = structuredClone(plan);
  let cancelled = 0;
  for (const node of staged.nodes) {
    if (node.status === "done" || node.status === "failed") continue;
    withTerminated(staged, node, nowMs);
    cancelled += 1;
  }
  if (cancelled === 0) return { ok: true, plan }; // 无可取消项：幂等 no-op
  staged.version += 1;
  return { ok: true, plan: staged };
}
