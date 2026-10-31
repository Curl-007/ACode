import assert from "node:assert/strict";
import test from "node:test";
import type { ACodeSessionRunningSubagent } from "@acode/shared";
import type { BackgroundWorkSummary, PlanItem } from "@acode/shared/acode-protocol-v4";
import {
  COMPACT_TODO_THRESHOLD,
  EMPTY_BACKGROUND_WORKS,
  EMPTY_RUNNING_SUBAGENTS,
  EMPTY_WORKFLOW_RUNS,
  TODO_FOCUS_WINDOW_SIZE,
  buildRunningSubagentOpenRequest,
  buildSessionPlanOpenRequest,
  formatDurationUnits,
  formatRunningCount,
  formatRunningSubagentCount,
  getBackgroundWorkElapsedMs,
  getCompletedPlanItem,
  getCurrentPlanItem,
  getLongestRunningWorkElapsedMs,
  getStatusPanelTodoFocusWindow,
} from "../src/v4/conversationStatusPanelFormat.js";
import type {
  ConversationStatusPanelModel,
  ConversationStatusPanelSessionPlanItem,
} from "../src/v4/conversationStatusPanelModel.js";

/**
 * ConversationStatusPanel 批次 4 helper 外迁（conversationStatusPanelFormat.ts）的接缝内决策表单测。
 * 覆盖：时长格式化进位边界 × background work elapsed 投影 × running/subagent 计数文案分支
 * × todo focus 窗口决策表 × plan/subagent 打开请求构造 × plan 当前/最近完成项选取。
 */

function makeWork(overrides: Partial<BackgroundWorkSummary> = {}): BackgroundWorkSummary {
  return {
    workId: "work-1",
    kind: "bash",
    title: "work",
    status: "running",
    startedAt: 1000,
    anchorRowId: null,
    ...overrides,
  };
}

function makePlanItems(statuses: readonly PlanItem["status"][]): PlanItem[] {
  return statuses.map((status, index) => ({
    id: `todo-${index}`,
    content: `事项 ${index}`,
    status,
  }));
}

function makePlanModel(items: PlanItem[]): NonNullable<ConversationStatusPanelModel["plan"]> {
  const completedCount = items.filter((item) => item.status === "completed").length;
  return {
    items,
    displayItems: items,
    completedCount,
    waitingCount: items.length - completedCount,
    totalCount: items.length,
  };
}

function makeSessionPlanItem(
  overrides: Partial<ConversationStatusPanelSessionPlanItem> = {},
): ConversationStatusPanelSessionPlanItem {
  return { rowId: 7, toolCallId: "tc-9", markdown: "# plan", ...overrides };
}

function makeRunningSubagent(
  overrides: Partial<ACodeSessionRunningSubagent> = {},
): ACodeSessionRunningSubagent {
  return {
    childSessionId: "child-1",
    subagentType: "general",
    title: "子代理",
    status: "running",
    ...overrides,
  };
}

const ids = (items: PlanItem[]) => items.map((item) => item.id);

const unitFormatMessage = (descriptor: { id: string }) => {
  switch (descriptor.id) {
    case "chat.summaryPanel.duration.hours":
      return "小时";
    case "chat.summaryPanel.duration.minutes":
      return "分";
    case "chat.summaryPanel.duration.seconds":
      return "秒";
    default:
      return descriptor.id;
  }
};

const echoFormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => `${descriptor.id}|${values?.count ?? ""}`;

test("formatDurationUnits：秒/分/时进位边界与负值、小数取整", () => {
  assert.equal(formatDurationUnits(0, unitFormatMessage), "0秒");
  assert.equal(formatDurationUnits(-5, unitFormatMessage), "0秒");
  assert.equal(formatDurationUnits(59.9, unitFormatMessage), "59秒");
  assert.equal(formatDurationUnits(60, unitFormatMessage), "1分");
  assert.equal(formatDurationUnits(3599, unitFormatMessage), "59分 59秒");
  assert.equal(formatDurationUnits(3600, unitFormatMessage), "1小时");
  assert.equal(formatDurationUnits(3661, unitFormatMessage), "1小时 1分 1秒");
  assert.equal(formatDurationUnits(7200, unitFormatMessage), "2小时");
});

test("getBackgroundWorkElapsedMs：startedAt→now，倒挂钳 0", () => {
  assert.equal(getBackgroundWorkElapsedMs(makeWork({ startedAt: 1000 }), 1600), 600);
  assert.equal(getBackgroundWorkElapsedMs(makeWork({ startedAt: 1000 }), 900), 0);
});

test("getLongestRunningWorkElapsedMs：空数组 0，多个取最大", () => {
  assert.equal(getLongestRunningWorkElapsedMs([], 2000), 0);
  const works = [
    makeWork({ workId: "a", startedAt: 1000 }),
    makeWork({ workId: "b", startedAt: 500 }),
    makeWork({ workId: "c", startedAt: 800 }),
  ];
  assert.equal(getLongestRunningWorkElapsedMs(works, 2000), 1500);
});

test("formatRunningCount / formatRunningSubagentCount：单复数文案分支与计数传值", () => {
  assert.equal(
    formatRunningCount(echoFormatMessage, 1),
    "chat.summaryPanel.runningBackgroundTasksMiniValue|1",
  );
  assert.equal(
    formatRunningCount(echoFormatMessage, 3),
    "chat.summaryPanel.runningBackgroundTasksMiniValuePlural|3",
  );
  assert.equal(
    formatRunningSubagentCount(echoFormatMessage, 1),
    "chat.statusPanel.runningAgentsValue|1",
  );
  assert.equal(
    formatRunningSubagentCount(echoFormatMessage, 5),
    "chat.statusPanel.runningAgentsValuePlural|5",
  );
});

test("getStatusPanelTodoFocusWindow：≤6 全量无窗口，focusItems 保持原数组引用", () => {
  const items = makePlanItems(["completed", "completed", "inProgress", "pending", "pending", "pending"]);
  assert.equal(items.length, COMPACT_TODO_THRESHOLD);
  const window = getStatusPanelTodoFocusWindow(items);
  assert.equal(window.compact, false);
  assert.deepEqual(window.precedingItems, []);
  assert.equal(window.focusItems, items);
  assert.deepEqual(window.followingItems, []);
});

test("getStatusPanelTodoFocusWindow：>6 时窗口含当前项，前补保持三条", () => {
  // inProgress 居中：focus 从当前项起三条。
  const middle = makePlanItems(["completed", "completed", "inProgress", "pending", "completed", "completed", "completed"]);
  const middleWindow = getStatusPanelTodoFocusWindow(middle);
  assert.equal(middleWindow.compact, true);
  assert.deepEqual(ids(middleWindow.precedingItems), ["todo-0", "todo-1"]);
  assert.deepEqual(ids(middleWindow.focusItems), ["todo-2", "todo-3", "todo-4"]);
  assert.deepEqual(ids(middleWindow.followingItems), ["todo-5", "todo-6"]);

  // inProgress 靠近末尾：从前面回补，窗口仍是三条且含当前项。
  const nearEnd = makePlanItems(["completed", "completed", "completed", "completed", "completed", "inProgress", "pending"]);
  const nearEndWindow = getStatusPanelTodoFocusWindow(nearEnd);
  assert.deepEqual(ids(nearEndWindow.focusItems), ["todo-4", "todo-5", "todo-6"]);
  assert.deepEqual(ids(nearEndWindow.followingItems), []);

  // inProgress 在末尾：窗口退到最后一组三条。
  const atEnd = makePlanItems([
    "completed", "completed", "completed", "completed", "completed",
    "completed", "completed", "completed", "completed", "inProgress",
  ]);
  const atEndWindow = getStatusPanelTodoFocusWindow(atEnd);
  assert.deepEqual(ids(atEndWindow.focusItems), ["todo-7", "todo-8", "todo-9"]);

  // 无 inProgress：focus 落在第一个未完成项。
  const noRunning = makePlanItems(["completed", "completed", "pending", "pending", "completed", "completed", "completed"]);
  const noRunningWindow = getStatusPanelTodoFocusWindow(noRunning);
  assert.deepEqual(ids(noRunningWindow.focusItems), ["todo-2", "todo-3", "todo-4"]);

  // 全部完成：focus 落在最后一组三条。
  const allDone = makePlanItems([
    "completed", "completed", "completed", "completed",
    "completed", "completed", "completed", "completed",
  ]);
  const allDoneWindow = getStatusPanelTodoFocusWindow(allDone);
  assert.deepEqual(ids(allDoneWindow.focusItems), ["todo-5", "todo-6", "todo-7"]);

  // 分组不变量：preceding + focus + following 按原序拼回全量。
  for (const window of [middleWindow, nearEndWindow, atEndWindow, noRunningWindow, allDoneWindow]) {
    assert.equal(window.focusItems.length <= TODO_FOCUS_WINDOW_SIZE, true);
  }
  assert.deepEqual(
    [...middleWindow.precedingItems, ...middleWindow.focusItems, ...middleWindow.followingItems],
    middle,
  );
});

test("buildSessionPlanOpenRequest：planFilePath 有才带上，缺时键不存在", () => {
  assert.deepEqual(buildSessionPlanOpenRequest("s-1", makeSessionPlanItem({ planFilePath: "/p.md" })), {
    parentSessionId: "s-1",
    toolCallId: "tc-9",
    markdown: "# plan",
    planFilePath: "/p.md",
  });
  const withoutPath = buildSessionPlanOpenRequest("s-1", makeSessionPlanItem());
  assert.deepEqual(withoutPath, {
    parentSessionId: "s-1",
    toolCallId: "tc-9",
    markdown: "# plan",
  });
  assert.equal("planFilePath" in withoutPath, false);
});

test("buildRunningSubagentOpenRequest：缺 parentSessionId 返 null，rootSessionId 缺省回填 parent", () => {
  assert.equal(
    buildRunningSubagentOpenRequest({ subagent: makeRunningSubagent() }),
    null,
  );
  assert.deepEqual(
    buildRunningSubagentOpenRequest({
      parentSessionId: "parent-1",
      subagent: makeRunningSubagent(),
    }),
    {
      rootSessionId: "parent-1",
      parentSessionId: "parent-1",
      childSessionId: "child-1",
      subagentType: "general",
      title: "子代理",
    },
  );
  assert.deepEqual(
    buildRunningSubagentOpenRequest({
      parentSessionId: "parent-1",
      rootSessionId: "root-0",
      subagent: makeRunningSubagent(),
    }).rootSessionId,
    "root-0",
  );
});

test("getCurrentPlanItem：空 plan → null；inProgress 优先于 pending；无则回退 pending", () => {
  assert.equal(getCurrentPlanItem(null), null);
  assert.equal(getCurrentPlanItem(makePlanModel([])), null);
  const withRunning = makePlanModel(
    makePlanItems(["pending", "inProgress", "pending"]),
  );
  assert.equal(getCurrentPlanItem(withRunning)?.id, "todo-1");
  const pendingOnly = makePlanModel(makePlanItems(["completed", "pending", "pending"]));
  assert.equal(getCurrentPlanItem(pendingOnly)?.id, "todo-1");
  const allDone = makePlanModel(makePlanItems(["completed", "completed"]));
  assert.equal(getCurrentPlanItem(allDone), null);
});

test("getCompletedPlanItem：空/无完成 → null；多个完成取数组最后；不改原序", () => {
  assert.equal(getCompletedPlanItem(null), null);
  assert.equal(getCompletedPlanItem(makePlanModel(makePlanItems(["pending", "inProgress"]))), null);
  const items = makePlanItems(["completed", "inProgress", "completed"]);
  const plan = makePlanModel(items);
  assert.equal(getCompletedPlanItem(plan)?.id, "todo-2");
  assert.deepEqual(ids(plan.items), ["todo-0", "todo-1", "todo-2"]);
});

test("EMPTY_* 默认 props 锚：稳定空数组导出", () => {
  assert.deepEqual(EMPTY_BACKGROUND_WORKS, []);
  assert.deepEqual(EMPTY_RUNNING_SUBAGENTS, []);
  assert.deepEqual(EMPTY_WORKFLOW_RUNS, []);
});
