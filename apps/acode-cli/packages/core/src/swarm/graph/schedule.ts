// 机制参照 jcode (MIT)：crates/jcode-plan/src/dag/schedule.rs 的确定性调度推导（ready =
// Queued 且全部 dep Done、priority 升序 + id 字典序、失败不传播——失败节点停住，依赖它的
// 节点永不 ready），自撰 TypeScript 实现。产品规则见 specs/swarm-task-graph.md R2/R4。
// 纯函数、零 IO：blocked 不落存储（R1 声明），全部由这里从依赖状态推导——单一事实源。

import type { SwarmPlanNode, SwarmTaskPlan } from "@acode/contracts";

/**
 * done 判定。语义复用 workflow/scheduler/graph.ts 的 COMPLETED_NODE_STATUSES（该集合的
 * 唯一所有者）：swarm status 经 ops.ts 的映射后仅 done 落在集合内（swarm 枚举没有
 * cancelled/skipped），故这里直接判 "done"。不 import workflow 模块——图引擎的复用面
 * 只有 typed-artifact 与 artifact-gate 两个纯函数模块（specs/swarm-task-graph.md R2）。
 */
function isDone(node: SwarmPlanNode): boolean {
  return node.status === "done";
}

/**
 * ready 节点（确定性序）：status=queued 且全部依赖 done。
 *
 * 排序 = priority 升序（数值小先派发），同 priority 按 id 字典序（码点序，不用
 * localeCompare——locale 敏感的比较会破坏确定性）。调度序确定让「引擎在 turn 间隙批派发」
 * 的行为可测试、可重放（jcode 同款要求）。
 *
 * 依赖 id 不在图中（外部构造的病态 plan）视为阻塞——校验通过的图不会走到这里，防御性
 * 处理而不是抛错：读侧推导不拥有拒绝权。
 */
export function readyNodes(plan: SwarmTaskPlan): SwarmPlanNode[] {
  const nodesById = new Map(plan.nodes.map((node) => [node.id, node]));
  return plan.nodes
    .filter(
      (node) =>
        node.status === "queued" &&
        node.dependsOn.every((dep) => {
          const dependency = nodesById.get(dep);
          return dependency !== undefined && isDone(dependency);
        }),
    )
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
}

export function readyNodeIds(plan: SwarmTaskPlan): string[] {
  return readyNodes(plan).map((node) => node.id);
}

/**
 * stalled 推导（失败不传播的读侧暴露面）：queued 且传递依赖里含 failed 的节点闭包。
 * 失败节点自身不算 stalled（它是 failed）；running 节点不算（其依赖在派发时已全部
 * done，且 done 不会被翻回 failed）。返回按 nodes 数组序（稳定）。
 *
 * 不动点迭代而非一次性 BFS： stalled 会经由「依赖 stalled 节点」继续扩张，等价于
 * 对 failed 源做反向可达闭包后与 queued 求交。
 */
export function stalledNodeIds(plan: SwarmTaskPlan): string[] {
  const nodesById = new Map(plan.nodes.map((node) => [node.id, node]));
  const stalled = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of plan.nodes) {
      if (node.status !== "queued" || stalled.has(node.id)) continue;
      const blockedByFailure = node.dependsOn.some((dep) => {
        const dependency = nodesById.get(dep);
        return (
          dependency !== undefined &&
          (dependency.status === "failed" || stalled.has(dependency.id))
        );
      });
      if (blockedByFailure) {
        stalled.add(node.id);
        changed = true;
      }
    }
  }
  return [...stalled];
}

export type SwarmPlanTerminalState = "completed" | "stalled" | "active";

/**
 * 整图终态判定（R4）：
 * - completed：全部节点 done（gate 是节点，gatesAllDone 被全量 done 蕴含——root gate 不
 *   pass，plan 永不 completed）；
 * - stalled：存在 failed 或 stalled，且无 running、无「queued 且非 stalled」的节点——
 *   即没有任何可推进的工作（主对话经 reminder 收到告警，用 retry/expand 改道）；
 * - active：其余（还有 running 或可推进的 queued）。
 */
export function planTerminalState(plan: SwarmTaskPlan): SwarmPlanTerminalState {
  if (plan.nodes.every((node) => node.status === "done")) return "completed";

  const stalled = new Set(stalledNodeIds(plan));
  const hasFailure = plan.nodes.some((node) => node.status === "failed") || stalled.size > 0;
  const canProgress = plan.nodes.some(
    (node) => node.status === "running" || (node.status === "queued" && !stalled.has(node.id)),
  );
  if (hasFailure && !canProgress) return "stalled";
  return "active";
}
