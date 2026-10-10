// 编排方案 Phase 4 第二批（specs/subagent-nesting-budget.md R4）：树级预算——准入闸
// 的常量与状态面。与 dwf facade/budget-caps.ts 同姿态：三闸**不合并**、数字即契约、
// 溢出是**结构化拒绝**不静默截断（Agent 可并行派发，Promise.all 同款论证：每个被拒的
// 派发都必须拿到结果，截断会让调用方 await 一个永不结算的 promise）。
//
// 键纪律（script-workflow-runtime 记录的三个真实 bug 之首）：键必须是**树根**
// （rootSessionId）而不是 runtime 实例——每层子代理各有一份 registry/runtime，按实例
// 建键的预算在 depth≥2 各算各的，树总量重新变成 10^depth。
//
// 生命周期：entries 随进程保留（量级 = 会话树数 × O(1)；tokens 是事后保险丝，必须
// 跨整棵树存续）。刻意**不设清理点**：任何非结算路径的清零都是「预算被悄悄重置」的
// bug 模式（同纪律第三条）。释放走 releaseTreeBudgetSlot（settle 事件单点触发，
// Set 删除幂等）。

/** 树级预算上限。数字即契约；定值依据回写 spec「常量定值记录」。 */
export const TREE_BUDGET_CAPS = {
  /** 一棵树累计准入的派发总量（含 resume 重臂——每次派发都消耗真实算力）。 */
  maxAgentsPerTree: 256,
  /** 深度维度的策略上限：生效 maxDepth = min(装配值, 本值)（R3 闸门的 clamp 面）。 */
  maxDepth: 4,
  /** 同一棵树同时在飞（非终态）的 agent 积压上限。 */
  maxLiveAgentsPerTree: 16,
  /** 一棵树累计 token 的事后保险丝（与 dwf maxTokensPerRun 同量级：合理编排碰不到）。 */
  maxTokensPerTree: 2_000_000_000,
} as const;

export type TreeBudgetRejectionReason = "agents" | "live" | "tokens";

export type TreeBudgetClaimResult =
  | { ok: true }
  | { cap: number; current: number; ok: false; reason: TreeBudgetRejectionReason };

interface TreeBudgetEntry {
  agents: number;
  live: Set<string>;
  tokens: number;
}

const treeBudgets = new Map<string, TreeBudgetEntry>();

function entryFor(rootKey: string): TreeBudgetEntry {
  let entry = treeBudgets.get(rootKey);
  if (entry === undefined) {
    entry = { agents: 0, live: new Set(), tokens: 0 };
    treeBudgets.set(rootKey, entry);
  }
  return entry;
}

/**
 * 派发准入（单一准入点 = runner runAgentToCompletion 顶部，前台/后台/resume 三路全经）。
 * 三闸独立判定、按序检查：总量 → token 事后闸 → 积压。重臂（resume 复用 agentId）
 * 计一次新派发（agents 递增），live Set 幂等。
 */
export function claimTreeBudgetSlot(input: {
  agentId: string;
  rootKey: string;
}): TreeBudgetClaimResult {
  const entry = entryFor(input.rootKey);
  if (entry.agents >= TREE_BUDGET_CAPS.maxAgentsPerTree) {
    return {
      cap: TREE_BUDGET_CAPS.maxAgentsPerTree,
      current: entry.agents,
      ok: false,
      reason: "agents",
    };
  }
  if (entry.tokens >= TREE_BUDGET_CAPS.maxTokensPerTree) {
    return {
      cap: TREE_BUDGET_CAPS.maxTokensPerTree,
      current: entry.tokens,
      ok: false,
      reason: "tokens",
    };
  }
  if (entry.live.size >= TREE_BUDGET_CAPS.maxLiveAgentsPerTree && !entry.live.has(input.agentId)) {
    return {
      cap: TREE_BUDGET_CAPS.maxLiveAgentsPerTree,
      current: entry.live.size,
      ok: false,
      reason: "live",
    };
  }
  entry.live.add(input.agentId);
  entry.agents += 1;
  return { ok: true };
}

/** 结算释放（单点 = emitSubagentEvent 的 settle 分支；幂等，未知根 no-op）。 */
export function releaseTreeBudgetSlot(input: { agentId: string; rootKey: string }): void {
  treeBudgets.get(input.rootKey)?.live.delete(input.agentId);
}

/** token 事后累加（与释放同点；非正数/非有限值忽略）。 */
export function recordTreeBudgetTokens(input: { rootKey: string; tokens: number }): void {
  if (!Number.isFinite(input.tokens) || input.tokens <= 0) return;
  entryFor(input.rootKey).tokens += input.tokens;
}

/** 测试重置（process-policy-floor 同款「进程单例 + 测试重置」模式）。 */
export function resetTreeBudgetForTest(): void {
  treeBudgets.clear();
}
