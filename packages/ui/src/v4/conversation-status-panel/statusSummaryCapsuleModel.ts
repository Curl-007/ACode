/**
 * ConversationStatusPanel 收起态胶囊的**分支优先级契约**（批次 7 外迁，第二阶段）。
 *
 * 胶囊是 mini 形态下用户唯一的展开入口，过去 10 个分支写成一条 JSX 三元链，优先级只能
 * 靠读代码确认；批次 4/6 都点名「`StatusSummaryRow` 胶囊兜底链需先补分支优先级契约测试」。
 * 本模块把整条链收成**显式判别联合 + 单入口解析函数**，优先级顺序即数组顺序，可被
 * 决策表穷举钉住（`test/conversationStatusPanelCapsule.test.ts`）。
 *
 * 顺序与迁移前的三元链逐条对应（改动顺序 = 改产品行为，必须同步改测试）：
 * 1. team            —— 团队在跑而 Goal/Todo/Git 都缺席时胶囊必须有内容，否则只剩 2px 空壳；
 * 2. currentPlanItem —— 进行中的 Todo；
 * 3. active goal     —— active / notSatisfied / paused / verifying（notSatisfied 是合法开放态，
 *                        mini 曾漏掉它导致失去展开入口）；
 * 4. git mini summary —— 有工作区变更（added+removed > 0）；
 * 5. done goal       —— verified；
 * 6. completedPlanItem —— 最近完成的 Todo；
 * 7. plan            —— 只有 Todo 计数（无进行中/最近完成项）；
 * 8. latestSessionPlan —— 会话计划标题；
 * 9. running count   —— 实时活动兜底（产品规则：不能与主状态重复拼接）；
 * 10. ended workflows —— 最低优先级终态兜底（只剩已结束 run 时保住目录入口）。
 */
import type { ConversationStatusPanelModel } from "@/v4/conversationStatusPanelModel.js";
import { getCompletedPlanItem, getCurrentPlanItem } from "@/v4/conversationStatusPanelFormat.js";

export type StatusSummaryCapsuleKind =
  | "team"
  | "current-plan"
  | "active-goal"
  | "git-summary"
  | "done-goal"
  | "completed-plan"
  | "plan-count"
  | "session-plan"
  | "running-count"
  | "ended-workflows";

/** 优先级顺序的单一来源（测试与实现共用，避免两处各写一遍）。 */
export const STATUS_SUMMARY_CAPSULE_PRIORITY: readonly StatusSummaryCapsuleKind[] = [
  "team",
  "current-plan",
  "active-goal",
  "git-summary",
  "done-goal",
  "completed-plan",
  "plan-count",
  "session-plan",
  "running-count",
  "ended-workflows",
];

export interface StatusSummaryCapsuleInput {
  model: ConversationStatusPanelModel;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  endedWorkflowRunCount: number;
}

export interface StatusSummaryCapsuleFacts {
  hasTeam: boolean;
  hasCurrentPlanItem: boolean;
  hasActiveGoal: boolean;
  hasGitMiniSummary: boolean;
  hasDoneGoal: boolean;
  hasCompletedPlanItem: boolean;
  hasPlan: boolean;
  hasSessionPlan: boolean;
  runningCount: number;
  hasRunningBash: boolean;
  hasRunningSubagent: boolean;
  hasRunningWorkflow: boolean;
  /** 三类实时活动中恰好命中两类以上 → 混合图标（Activity）。 */
  hasRunningMixedKinds: boolean;
  endedWorkflowRunCount: number;
}

/** 把模型摊平成判定事实——所有布尔都只回答「这一分支是否可用」。 */
export function buildStatusSummaryCapsuleFacts({
  model,
  gitWorktreeChangeSummary,
  endedWorkflowRunCount,
}: StatusSummaryCapsuleInput): StatusSummaryCapsuleFacts {
  const goal = model.goal;
  const goalTitle = goal ? goal.summaryTitle?.trim() || goal.objective.trim() || null : null;
  const goalStatus = goal?.status ?? null;
  // V4 goal 在 verifier 判定未完成后会进入 notSatisfied；mini 过去漏掉
  // 这个合法开放态并返回 null，导致只剩 2px 空 shell，也失去重新展开入口。
  const isActiveGoal =
    goalStatus === "active" ||
    goalStatus === "notSatisfied" ||
    goalStatus === "paused" ||
    goalStatus === "verifying";
  const isDoneGoal = goalStatus === "verified";
  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;

  const hasRunningBash = model.runningBashWorks.length > 0;
  const hasRunningSubagent = model.runningSubagentWorks.length > 0;
  const hasRunningWorkflow = model.runningWorkflowRuns.length > 0;
  const runningKindCount = [hasRunningWorkflow, hasRunningBash, hasRunningSubagent].filter(
    Boolean,
  ).length;

  return {
    hasTeam: model.team !== null,
    hasCurrentPlanItem: getCurrentPlanItem(model.plan) !== null,
    hasActiveGoal: Boolean(goalTitle && isActiveGoal),
    hasGitMiniSummary: Boolean(model.git && added + removed > 0),
    hasDoneGoal: Boolean(goalTitle && isDoneGoal),
    hasCompletedPlanItem: getCompletedPlanItem(model.plan) !== null,
    hasPlan: model.plan !== null,
    hasSessionPlan: (model.sessionPlans?.items[0] ?? null) !== null,
    runningCount:
      model.runningBashWorks.length +
      model.runningSubagentWorks.length +
      model.runningWorkflowRuns.length,
    hasRunningBash,
    hasRunningSubagent,
    hasRunningWorkflow,
    hasRunningMixedKinds: runningKindCount > 1,
    endedWorkflowRunCount,
  };
}

const CAPSULE_KIND_PREDICATES: Record<
  StatusSummaryCapsuleKind,
  (facts: StatusSummaryCapsuleFacts) => boolean
> = {
  team: (facts) => facts.hasTeam,
  "current-plan": (facts) => facts.hasCurrentPlanItem,
  "active-goal": (facts) => facts.hasActiveGoal,
  "git-summary": (facts) => facts.hasGitMiniSummary,
  "done-goal": (facts) => facts.hasDoneGoal,
  "completed-plan": (facts) => facts.hasCompletedPlanItem,
  "plan-count": (facts) => facts.hasPlan,
  "session-plan": (facts) => facts.hasSessionPlan,
  "running-count": (facts) => facts.runningCount > 0,
  "ended-workflows": (facts) => facts.endedWorkflowRunCount > 0,
};

/**
 * 单入口解析：按 `STATUS_SUMMARY_CAPSULE_PRIORITY` 顺序返回第一个可用的分支。
 * `null` = 胶囊整段缺席（此时面板壳仍有可能是 `ended-workflows` 之外的保留态）。
 */
export function resolveStatusSummaryCapsuleKind(
  facts: StatusSummaryCapsuleFacts,
): StatusSummaryCapsuleKind | null {
  for (const kind of STATUS_SUMMARY_CAPSULE_PRIORITY) {
    if (CAPSULE_KIND_PREDICATES[kind](facts)) {
      return kind;
    }
  }
  return null;
}

/** 实时活动行的图标族：恰好一类沿用该类图标，混合才是 Activity。 */
export type RunningSummaryIconKind = "mixed" | "workflow" | "bash" | "subagent";

export function resolveRunningSummaryIconKind(facts: StatusSummaryCapsuleFacts): RunningSummaryIconKind {
  return facts.hasRunningMixedKinds
    ? "mixed"
    : facts.hasRunningWorkflow
      ? "workflow"
      : facts.hasRunningBash
        ? "bash"
        : "subagent";
}

/** 实时活动计数文案：纯 Subagent 走「运行」语义，其余走后台任务语义。 */
export function shouldUseSubagentRunningLabel(facts: StatusSummaryCapsuleFacts): boolean {
  return facts.hasRunningSubagent;
}
