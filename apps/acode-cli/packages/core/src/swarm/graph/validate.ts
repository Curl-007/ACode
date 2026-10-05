// 机制参照 jcode (MIT)：crates/jcode-plan/src/dag/ops.rs 的图不变量校验（环检测/引用/上限/
// id 唯一/blank id 拒绝），自撰 TypeScript 实现。产品规则见 specs/swarm-task-graph.md R2
// （clone-stage-commit 的 commit 前置校验）。本模块纯函数、零 IO、零状态。
//
// 为什么所有校验集中在 commit 前而不是各 op 内散落：op 只负责自己的门槛语义（所有权、
// 状态机），结构不变量（引用存在、无环、上限、id 唯一）统一在这里对「已做完变更的克隆」
// 判定——校验失败即丢弃克隆，输入 plan 永不被写穿（读者永远见一致快照，R6 不变量）。

import {
  SWARM_MAX_NODE_DEPENDS,
  SWARM_MAX_PLAN_ITEMS,
  type SwarmGraphError,
  type SwarmPlanNode,
} from "@acode/contracts";

/**
 * commit 前置校验：blank id → id 唯一 → 节点总数上限 → 单节点依赖上限 → 依赖/父引用存在
 * → 无环。返回 null 表示可提交。
 *
 * 检查顺序有意为之：blank/duplicate 先于引用（同因更具体的错误先报），引用先于环
 * （环检测对未知引用直接跳过，先把引用错误报全）。
 */
export function validateSwarmGraph(nodes: readonly SwarmPlanNode[]): SwarmGraphError | null {
  const ids = new Set<string>();
  for (const node of nodes) {
    // blank id 拒绝（J2-3 R11 同款防 deep 死路）：不可点名的节点 id 让 gate 的词边界
    // mentionsNodeId 恒 false → 任意 coverageTexts 都判 uncovered → critic 确定性死路。
    if (node.id.trim().length === 0) {
      return { kind: "blank-id", message: "node id must contain non-whitespace characters" };
    }
    if (ids.has(node.id)) {
      return {
        kind: "duplicate-id",
        message: `duplicate node id "${node.id}"`,
        nodeId: node.id,
      };
    }
    ids.add(node.id);
  }

  if (nodes.length > SWARM_MAX_PLAN_ITEMS) {
    return {
      kind: "limit-exceeded",
      message: `plan exceeds SWARM_MAX_PLAN_ITEMS (${SWARM_MAX_PLAN_ITEMS}): ${nodes.length} nodes`,
      limit: SWARM_MAX_PLAN_ITEMS,
      actual: nodes.length,
    };
  }

  for (const node of nodes) {
    if (node.dependsOn.length > SWARM_MAX_NODE_DEPENDS) {
      return {
        kind: "limit-exceeded",
        message: `node "${node.id}" exceeds SWARM_MAX_NODE_DEPENDS (${SWARM_MAX_NODE_DEPENDS}): ${node.dependsOn.length} dependencies`,
        limit: SWARM_MAX_NODE_DEPENDS,
        actual: node.dependsOn.length,
      };
    }
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) {
        return {
          kind: "unknown-node",
          message: `node "${node.id}" depends on unknown node "${dep}"`,
          nodeId: dep,
        };
      }
    }
    if (node.parent !== null && !ids.has(node.parent)) {
      return {
        kind: "unknown-node",
        message: `node "${node.id}" has unknown parent "${node.parent}"`,
        nodeId: node.parent,
      };
    }
  }

  const cyclePath = findCyclePath(nodes);
  if (cyclePath !== null) {
    return {
      kind: "cycle",
      message: `dependency cycle detected: ${cyclePath.join(" -> ")}`,
      cyclePath,
    };
  }

  return null;
}

/**
 * DFS 环检测。expand 只向已有节点追加出边（父节点追加 children/gate 依赖、新节点声明对
 * 已有节点的依赖），任何新环必然经过新边——全图检测是对「expand 只追加时的新环即拒」的
 * 保守实现，同时覆盖 seed 内部环与 injectGap 后的复核。
 *
 * 返回闭合路径（起点重复在末尾，如 ["a", "b", "a"]）；无环返回 null。路径方向是
 * 「访问者 → 其依赖」：a -> b 表示 a 在等 b。
 */
function findCyclePath(nodes: readonly SwarmPlanNode[]): string[] | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // 三态：undefined = 未访问，1 = 在当前 DFS 栈上，2 = 已完成（其子树无环）。
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];

  const visit = (node: SwarmPlanNode): string[] | null => {
    state.set(node.id, 1);
    path.push(node.id);
    for (const dep of node.dependsOn) {
      const target = byId.get(dep);
      // 未知引用由引用校验报告，这里跳过（不能对不存在的节点判环）。
      if (target === undefined) continue;
      const depState = state.get(dep);
      if (depState === 1) {
        const start = path.indexOf(dep);
        return [...path.slice(start), dep];
      }
      if (depState === undefined) {
        const cycle = visit(target);
        if (cycle !== null) return cycle;
      }
    }
    state.set(node.id, 2);
    path.pop();
    return null;
  };

  for (const node of nodes) {
    if (!state.has(node.id)) {
      const cycle = visit(node);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}
