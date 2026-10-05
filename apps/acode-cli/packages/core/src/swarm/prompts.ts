// K2 对话内 Swarm 任务图 R7（specs/swarm-task-graph.md）：提示词与提醒。
//
// - buildSwarmPlanReminderBody：plan 建立后每个主 turn 注入一次的动态段（同 K1 载体
//   模式：纯函数产正文，无 plan 零注入）。plan 在 runtime store（plan-store.ts），不受
//   transcript compact 影响——主对话 compact 后 reminder 仍持图摘要，这是 gate 归主对话
//   的必要条件（spec「未做与取舍」#3）。
// - SWARM_PLAN_VS_TODO_LANGUAGE / SWARM_GATE_CONTRACT_LANGUAGE：PlanSeed/PlanExpand 工具
//   描述引用的契约话术（R1「plan 与 todo 刻意分离」+ R5「inject gap 即成功」「增长的图
//   就是系统在正常工作」——jcode gate 指令的对抗性话术移植，防模型把 gate 拒绝当失败、
//   把图增长当偏差）。

import type { SwarmTaskPlan } from "@acode/contracts";
import { buildSwarmPlanStatus } from "./projection.js";

/**
 * plan-vs-todo 分工（R1）：todo 是 session 本地进度自报（模型自写自读）；plan 是引擎
 * 持有的协调状态（done 需 typed artifact 或 gate 审计，所有者与可信级都不同）。提示词
 * 层面明确分工，防模型用 TodoWrite 冒充计划、或用 PlanSeed 记流水账。
 */
export const SWARM_PLAN_VS_TODO_LANGUAGE = [
  "A plan is engine-owned coordination state, not a diary: node done requires a typed artifact (deep mode) or a gate verdict, unlike session todos which are self-reported.",
  "Use PlanSeed/PlanExpand to shape the work graph and let the engine dispatch it; keep TodoWrite for your own local progress notes.",
].join("\n");

/**
 * deep gate 契约话术（R5）：拒绝路径是正常路径——被拒的 pass 会把 gapProposals 注入成
 * 新工作节点，图因此增长；模型不该为「让 gate 一次通过」而软化审计。jcode 对抗性话术
 * 的移植（docs/SWARM_TASK_GRAPH.md「增长的图就是系统在正常工作」）。
 */
export const SWARM_GATE_CONTRACT_LANGUAGE = [
  "Deep mode ends with gate audits you submit via PlanCompleteGate: a pass verdict must name every done node id and address every low-confidence node, or the engine rejects it.",
  "A rejected verdict is a success path, not a failure: your gapProposals become new gap nodes and the graph grows — a growing graph is the system working as intended.",
].join("\n");

/**
 * plan 进展 reminder 正文。无 plan（null）→ null：调用方据此零注入（R7「无 plan 时零
 * 注入」；todo reminder 的 null 语义同款——条件不满足时提醒只是噪声）。
 *
 * 段落（R7）：图摘要（done/running/queued/failed/stalled 计数）→ gate 待办（ready 的
 * gate 是主对话不可绕过的收尾义务——root gate 不 pass，plan 永不 completed）→ stalled
 * 告警（模型用 PlanControl.retry 或 PlanExpand 改道）→ 终态一行（completed 时明示收尾）。
 */
export function buildSwarmPlanReminderBody(plan: SwarmTaskPlan | null): string | null {
  if (plan === null) return null;
  const status = buildSwarmPlanStatus(plan);
  const total = plan.nodes.length;
  const lines: string[] = [
    `Swarm plan (v${status.version}, ${status.mode}): ${status.goal}`,
    `Progress: ${status.counts.done}/${total} done, ${status.counts.running} running, ${status.counts.queued} queued, ${status.counts.failed} failed, ${status.counts.stalled} stalled.`,
  ];
  if (status.readyGateIds.length > 0) {
    lines.push(
      `${status.readyGateIds.length} gate(s) awaiting your audit via PlanCompleteGate: ${status.readyGateIds.join(", ")}. The plan cannot complete until every gate passes — audit the done nodes by id.`,
    );
  }
  if (status.stalledNodeIds.length > 0) {
    lines.push(
      `Stalled (blocked by failures, will not self-heal): ${status.stalledNodeIds.join(", ")}. Use PlanControl retry on the failed source or PlanExpand to reroute the work.`,
    );
  }
  if (status.terminalState === "completed") {
    lines.push(
      "Plan completed: every node is done and all gates passed. No further plan work is pending.",
    );
  }
  return lines.join("\n");
}
