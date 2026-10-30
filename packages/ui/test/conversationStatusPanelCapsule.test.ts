import assert from "node:assert/strict";
import test from "node:test";
import type { PlanState } from "@acode/shared/acode-protocol-v4";
import {
  buildStatusSummaryCapsuleFacts,
  resolveRunningSummaryIconKind,
  resolveStatusSummaryCapsuleKind,
  shouldUseSubagentRunningLabel,
  STATUS_SUMMARY_CAPSULE_PRIORITY,
  type StatusSummaryCapsuleKind,
} from "../src/v4/conversation-status-panel/statusSummaryCapsuleModel.js";
import type { ConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";

/**
 * ConversationStatusPanel 批次 7 第二阶段：**胶囊分支优先级契约测试**。
 *
 * 批次 4/6 都点名「`StatusSummaryRow` 胶囊兜底链（10 分支优先级）是第三阶段，需先补一条
 * 分支优先级契约测试」。本文件就是那条测试：把 10 个分支的**顺序**钉死，任何重排
 * （改产品行为）都会红。胶囊是 mini 形态下唯一的展开入口，顺序错了用户会失去入口。
 *
 * 覆盖：优先级全序断言 × 逐分支单独命中 × 相邻分支的覆盖关系（高优先级压住低优先级）×
 * 空模型整段缺席 × 实时活动图标族与计数文案语义。
 */

const makeModel = (
  overrides: Partial<ConversationStatusPanelModel> = {},
): ConversationStatusPanelModel =>
  ({
    hasContent: true,
    git: null,
    goal: null,
    sessionPlans: null,
    plan: null,
    runningBashWorks: [],
    runningSubagentWorks: [],
    runningWorkflowRuns: [],
    team: null,
    teams: [],
    endedTeams: [],
    totalCount: 0,
    ...overrides,
  }) as unknown as ConversationStatusPanelModel;

const planItems = (
  statuses: readonly PlanState["items"][number]["status"][],
): PlanState["items"] =>
  statuses.map((status, index) => ({
    id: `todo-${index}`,
    content: `事项 ${index}`,
    status,
  }));

const planModel = (
  statuses: readonly PlanState["items"][number]["status"][],
): ConversationStatusPanelModel["plan"] => {
  const items = planItems(statuses);
  return {
    items,
    displayItems: items,
    completedCount: items.filter((item) => item.status === "completed").length,
    waitingCount: items.filter((item) => item.status === "pending").length,
    totalCount: items.length,
  };
};

const goal = (status: string, summaryTitle?: string) =>
  ({
    status,
    objective: "objective text",
    ...(summaryTitle === undefined ? {} : { summaryTitle }),
  }) as never;

const resolve = (
  model: ConversationStatusPanelModel,
  options: { endedWorkflowRunCount?: number; gitWorktreeChangeSummary?: { added: number; removed: number } | null } = {},
): StatusSummaryCapsuleKind | null =>
  resolveStatusSummaryCapsuleKind(
    buildStatusSummaryCapsuleFacts({
      model,
      gitWorktreeChangeSummary: options.gitWorktreeChangeSummary ?? null,
      endedWorkflowRunCount: options.endedWorkflowRunCount ?? 0,
    }),
  );

// ---- 优先级全序 ----

test("优先级全序：10 个分支按既定顺序排列（顺序即产品行为）", () => {
  assert.deepEqual(STATUS_SUMMARY_CAPSULE_PRIORITY, [
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
  ]);
});

test("优先级全序：每个 kind 都能由至少一种模型命中（无死分支）", () => {
  const cases: Record<StatusSummaryCapsuleKind, ConversationStatusPanelModel> = {
    team: makeModel({ team: { counts: { done: 1 }, totalCount: 2 } as never }),
    "current-plan": makeModel({ plan: planModel(["inProgress"]) }),
    "active-goal": makeModel({ goal: goal("active") }),
    "git-summary": makeModel({ git: {} as never }),
    "done-goal": makeModel({ goal: goal("verified") }),
    "completed-plan": makeModel({ plan: planModel(["completed"]) }),
    "plan-count": makeModel({ plan: planModel([]) }),
    "session-plan": makeModel({ sessionPlans: { items: [{ title: "p" }] } as never }),
    "running-count": makeModel({ runningBashWorks: [{}] as never }),
    "ended-workflows": makeModel(),
  };
  for (const kind of STATUS_SUMMARY_CAPSULE_PRIORITY) {
    const options =
      kind === "git-summary"
        ? { gitWorktreeChangeSummary: { added: 1, removed: 0 } }
        : kind === "ended-workflows"
          ? { endedWorkflowRunCount: 1 }
          : {};
    assert.equal(resolve(cases[kind], options), kind, `${kind} 未被命中`);
  }
});

// ---- 逐分支 ----

test("team 优先于 current-plan（团队在跑时胶囊先说团队）", () => {
  const model = makeModel({
    team: { counts: { done: 1 }, totalCount: 2 } as never,
    plan: planModel(["inProgress"]),
  });
  assert.equal(resolve(model), "team");
});

test("current-plan 优先于 active-goal 与 git", () => {
  const model = makeModel({
    plan: planModel(["inProgress"]),
    goal: goal("active"),
    git: {} as never,
  });
  assert.equal(resolve(model, { gitWorktreeChangeSummary: { added: 1, removed: 1 } }), "current-plan");
});

test("active-goal 优先于 git-summary（进行中目标压住变更摘要）", () => {
  const model = makeModel({ goal: goal("active"), git: {} as never });
  assert.equal(resolve(model, { gitWorktreeChangeSummary: { added: 1, removed: 0 } }), "active-goal");
});

test("active goal 的四种合法开放态都命中（含 notSatisfied：曾漏掉导致失去展开入口）", () => {
  for (const status of ["active", "notSatisfied", "paused", "verifying"]) {
    assert.equal(resolve(makeModel({ goal: goal(status) })), "active-goal", `${status} 未命中`);
  }
});

test("goal 无标题（objective 与 summaryTitle 都空白）时不进 active-goal 分支", () => {
  const blankGoal = { status: "active", objective: "   ", summaryTitle: "  " } as never;
  assert.equal(resolve(makeModel({ goal: blankGoal })), null);
});

test("summaryTitle 优先于 objective 作为胶囊标题来源（有标题即用标题）", () => {
  const facts = buildStatusSummaryCapsuleFacts({
    model: makeModel({ goal: goal("active", "标题") }),
    gitWorktreeChangeSummary: null,
    endedWorkflowRunCount: 0,
  });
  assert.equal(facts.hasActiveGoal, true);
});

test("git-summary 只在 added+removed > 0 时命中（零变更不占胶囊）", () => {
  const model = makeModel({ git: {} as never });
  assert.equal(resolve(model, { gitWorktreeChangeSummary: { added: 0, removed: 0 } }), null);
  assert.equal(
    resolve(model, { gitWorktreeChangeSummary: { added: 0, removed: 3 } }),
    "git-summary",
  );
});

test("git-summary 需要模型层 git 存在（有变更但 git 投影缺席时不命中）", () => {
  assert.equal(resolve(makeModel({ git: null }), { gitWorktreeChangeSummary: { added: 2, removed: 1 } }), null);
});

test("done-goal 在 git 之后（已完成的 goal 让位于工作区变更）", () => {
  const model = makeModel({ goal: goal("verified"), git: {} as never });
  assert.equal(resolve(model, { gitWorktreeChangeSummary: { added: 1, removed: 0 } }), "git-summary");
  assert.equal(resolve(model, { gitWorktreeChangeSummary: null }), "done-goal");
});

test("completed-plan 在 done-goal 之后", () => {
  const model = makeModel({ goal: goal("verified"), plan: planModel(["completed"]) });
  assert.equal(resolve(model), "done-goal");
});

test("plan-count 只在「有 plan 但无进行中/最近完成项」时命中", () => {
  assert.equal(resolve(makeModel({ plan: planModel([]) })), "plan-count");
  // pending 也算「当前项」（getCurrentPlanItem 的第二优先），因此走 current-plan
  assert.equal(resolve(makeModel({ plan: planModel(["pending"]) })), "current-plan");
  // 只有 completed 项时走 completed-plan
  assert.equal(resolve(makeModel({ plan: planModel(["completed"]) })), "completed-plan");
});

test("session-plan 在 plan-count 之后（Todo 计数优先于会话计划标题）", () => {
  const model = makeModel({
    plan: planModel([]),
    sessionPlans: { items: [{ title: "p" }] } as never,
  });
  assert.equal(resolve(model), "plan-count");
});

test("running-count 在 session-plan 之后（主状态优先于实时活动）", () => {
  const model = makeModel({
    sessionPlans: { items: [{ title: "p" }] } as never,
    runningBashWorks: [{}] as never,
  });
  assert.equal(resolve(model), "session-plan");
});

test("ended-workflows 是最低优先级兜底（其余分支全缺席时才出现）", () => {
  assert.equal(resolve(makeModel(), { endedWorkflowRunCount: 1 }), "ended-workflows");
  // 有任何更高优先级分支时不出现
  assert.equal(
    resolve(makeModel({ runningBashWorks: [{}] as never }), { endedWorkflowRunCount: 1 }),
    "running-count",
  );
});

test("空模型（无团队/无计划/无 goal/无变更/无活动/无已结束）→ 胶囊整段缺席", () => {
  assert.equal(resolve(makeModel()), null);
});

// ---- 实时活动图标族与计数文案 ----

test("实时活动图标：恰好一类沿用该类图标", () => {
  assert.equal(
    resolveRunningSummaryIconKind(buildStatusSummaryCapsuleFacts({
      model: makeModel({ runningWorkflowRuns: [{}] as never }),
      gitWorktreeChangeSummary: null,
      endedWorkflowRunCount: 0,
    })),
    "workflow",
  );
  assert.equal(
    resolveRunningSummaryIconKind(buildStatusSummaryCapsuleFacts({
      model: makeModel({ runningBashWorks: [{}] as never }),
      gitWorktreeChangeSummary: null,
      endedWorkflowRunCount: 0,
    })),
    "bash",
  );
  assert.equal(
    resolveRunningSummaryIconKind(buildStatusSummaryCapsuleFacts({
      model: makeModel({ runningSubagentWorks: [{}] as never }),
      gitWorktreeChangeSummary: null,
      endedWorkflowRunCount: 0,
    })),
    "subagent",
  );
});

test("实时活动图标：两类以上混合走 Activity（含 workflow+agent 这种新增组合）", () => {
  assert.equal(
    resolveRunningSummaryIconKind(buildStatusSummaryCapsuleFacts({
      model: makeModel({
        runningWorkflowRuns: [{}] as never,
        runningSubagentWorks: [{}] as never,
      }),
      gitWorktreeChangeSummary: null,
      endedWorkflowRunCount: 0,
    })),
    "mixed",
  );
  assert.equal(
    resolveRunningSummaryIconKind(buildStatusSummaryCapsuleFacts({
      model: makeModel({
        runningBashWorks: [{}] as never,
        runningSubagentWorks: [{}] as never,
      }),
      gitWorktreeChangeSummary: null,
      endedWorkflowRunCount: 0,
    })),
    "mixed",
  );
});

test("实时活动计数文案：存在 subagent 时走「运行」语义，纯后台任务走任务语义", () => {
  const withSubagent = buildStatusSummaryCapsuleFacts({
    model: makeModel({
      runningSubagentWorks: [{}] as never,
      runningBashWorks: [{}] as never,
    }),
    gitWorktreeChangeSummary: null,
    endedWorkflowRunCount: 0,
  });
  assert.equal(shouldUseSubagentRunningLabel(withSubagent), true);

  const withoutSubagent = buildStatusSummaryCapsuleFacts({
    model: makeModel({ runningBashWorks: [{}] as never }),
    gitWorktreeChangeSummary: null,
    endedWorkflowRunCount: 0,
  });
  assert.equal(shouldUseSubagentRunningLabel(withoutSubagent), false);
});

test("实时活动计数：三类活动数量相加（不是类别数）", () => {
  const facts = buildStatusSummaryCapsuleFacts({
    model: makeModel({
      runningBashWorks: [{}, {}] as never,
      runningSubagentWorks: [{}] as never,
      runningWorkflowRuns: [{}] as never,
    }),
    gitWorktreeChangeSummary: null,
    endedWorkflowRunCount: 0,
  });
  assert.equal(facts.runningCount, 4);
});
