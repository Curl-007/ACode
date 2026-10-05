// K2 对话内 Swarm 任务图 R4/R7 的 turn 接线面（specs/swarm-task-graph.md）：
// - dispatchSwarmPlanReadyNodes：成功 Main turn 后的调度点（methods/turn.ts 与 memory
//   extraction 同位挂点）——引擎把 ready worker 节点批量派发到活跃上限，不 await 阻塞
//   turn 返回，失败只 warn 不影响 turn（调度可由下一个调度点/级联派发补上）。
// - buildSwarmPlanTurnReminderBody：plan 进展 reminder 的 per-turn 正文（R7：图摘要 +
//   gate 待办 + stalled 告警；无 plan 零注入——条件不满足时提醒只是噪声）。载体是
//   system-reminder source: swarm_plan_status 的 per-request 动态段，K1
//   memory_semantic_recall 同款模式（helpers/memory-semantic-recall.ts 先例）。
//
// 两个入口都只消费 runtime.swarmPlanPort（bootstrap 注入的 store+runner 绑定面），
// 端口缺席 = 本会话不参与 swarm，全部入口静默返回（不是错误）。

import type { TraceContext } from "@acode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildSwarmPlanReminderBody } from "../../swarm/prompts.js";

/**
 * 子会话身份不驱动引擎（R4 调度点归主对话 turn）：worker 自己的 turn 结束不触发
 * dispatchReadyNodes——worker 拿的是只读面，也不该制造调度副作用（防「worker 的完成
 * 回调顺便推进图」成为第二条调度路径）。nested/subagent 同理排除。
 */
function swarmPlanPortForEngineDriving(runtime: AgentRuntimeInternal) {
  const taskType = runtime.config.taskType;
  if (taskType === "workflow_child" || taskType === "subagent_child" || taskType === "nested_workflow_child") {
    return undefined;
  }
  return runtime.swarmPlanPort;
}

/**
 * 调度点入口（成功 Main turn 后）：不阻塞调用方。dispatchReadyNodes 内部按活跃上限批
 * 派发并让完成回调级联推进；这里 void 掉返回的 promise，仅在派发启动失败时 warn
 * （调度点每 turn 都有，单次失败自愈——不用超时/重试掩盖，下一次调度点即重试面）。
 */
export function dispatchSwarmPlanReadyNodes(
  runtime: AgentRuntimeInternal,
  input: { traceContext: TraceContext },
): void {
  const port = swarmPlanPortForEngineDriving(runtime);
  if (port === undefined) return;
  void port.runner.dispatchReadyNodes().catch((error: unknown) => {
    runtime.logger?.warn("Swarm plan dispatch failed after turn", {
      ...traceContextToLogContext(input.traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "swarm.plan.dispatch_failed",
      module: "core.swarm",
      status: "failed",
    });
  });
}

/**
 * reminder 正文（R7）。无 plan / 子会话身份 → null：调用方据此零注入（todo reminder 的
 * null 语义同款）。正文推导单一来源在 swarm/prompts.ts（与 PlanStatus 投影共用
 * projection.ts，两个可见面不会各自渲染后漂移）。
 */
export function buildSwarmPlanTurnReminderBody(runtime: AgentRuntimeInternal): string | null {
  const taskType = runtime.config.taskType;
  // 主 turn 注入（R7）：worker 子会话的图可见面是 PlanStatus 工具，不需要进展 reminder
  // （子会话 prompt 已由 R3 dataflow 装配携带上游 artifact）。
  if (taskType === "workflow_child" || taskType === "subagent_child" || taskType === "nested_workflow_child") {
    return null;
  }
  const port = runtime.swarmPlanPort;
  if (port === undefined) return null;
  return buildSwarmPlanReminderBody(port.store.getPlan());
}
