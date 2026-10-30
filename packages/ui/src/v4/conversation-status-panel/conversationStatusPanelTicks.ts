/**
 * ConversationStatusPanel 四个秒级分区的「是否该走秒针」决策（批次 7 外迁，第二阶段）。
 *
 * 批次 6 遗留：四个分区各自持有 `useState(now) + setInterval(1000)`，与 GoalStatusSection
 * 已经在用的 `useNowTicker` 是两套节律实现，且各自的「开/关」条件散落在 effect 体内。
 * 本模块把这些条件抽成纯谓词，供 `useNowTicker(active)` 单点驱动：
 *
 * - 谓词只回答「有没有需要秒级刷新的行」，与 DOM / React 无关，可用决策表覆盖；
 * - `useNowTicker` 在 `active=false` 时**不建定时器**，且 `active` 变真时先重取一次 now
 *   （不带着上一段的偏差起步）——这是四组原实现共同的语义，只是原实现把「关」写在
 *   effect 的 early return 里，无法单测。
 *
 * 节律一致性约束（行为保持）：四组全部是 1000ms 自然粒度，不引入新的节拍。
 */
import type { BackgroundWorkSummary } from "@acode/shared/acode-protocol-v4";
import type { ConversationStatusPanelRunningSubagent } from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRun } from "@/v4/conversationStatusPanelModel.js";

/** Terminals / Agents：列表非空即需要秒针（每行都在展示 elapsed）。 */
export function shouldTickBackgroundWorks(works: readonly BackgroundWorkSummary[]): boolean {
  return works.length > 0;
}

/**
 * Workflows：只有带 `startedAt` 的行需要秒级刷新；一行都没有时不必让面板每秒重渲染。
 * 偏斜降级行（旧 CLI 没有 workflowRuns 投影键）没有 startedAt，不参与秒针。
 */
export function shouldTickWorkflowRuns(
  runs: readonly ConversationStatusPanelWorkflowRun[],
): boolean {
  return runs.some((run) => run.startedAt !== undefined);
}

/** Agents：列表非空即需要秒针（`startedAt` 缺席时 elapsed 恒为 0，但行本身仍要渲染）。 */
export function shouldTickSubagents(
  subagents: readonly ConversationStatusPanelRunningSubagent[],
): boolean {
  return subagents.length > 0;
}

/**
 * Goal：只在「有在跑的 run 且可暂停」时走秒针。effect 不能以整个 goal 对象为依赖——
 * 每个 goal 事件都同步 setNow 并重建 interval，会落在投影帧的同步提交里给 React 的
 * 嵌套更新计数记一笔（与工作流卡 React #185 崩溃同形）。
 */
export function shouldTickGoal(input: {
  status: string | undefined;
  activeRunStartedAtMs: number | undefined;
}): boolean {
  const isPausable =
    input.status === "active" || input.status === "verifying" || input.status === "notSatisfied";
  return isPausable && input.activeRunStartedAtMs != null;
}

/**
 * 收起态耗时标签：`formatDurationUnits` 的入参口径（至少 1 秒，向下取整）。
 * 抽出来是为了让「0ms 也要显示 1 秒而不是 0 秒假时长」这条产品规则可单测。
 */
export function toCollapsedElapsedSeconds(elapsedMs: number): number {
  return Math.max(1, Math.floor(elapsedMs / 1000));
}

/** Workflows 收起态：一行都没有 startedAt 时最长耗时为 0，此时不显示时长（宁可少一段）。 */
export function shouldShowWorkflowCollapsedElapsed(longestElapsedMs: number): boolean {
  return longestElapsedMs > 0;
}
