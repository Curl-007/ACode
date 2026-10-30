import assert from "node:assert/strict";
import test from "node:test";
import type { ACodeAutomation, ACodeOffPeakTask } from "@acode/shared";
import {
  AUTOMATIONS_TOAST_ANCHOR_ID,
  SCHEDULED_AND_IDLE_AUTOMATION_TABS,
  SCHEDULED_ONLY_AUTOMATION_TABS,
  STATUS_META,
  automationPromptSummary,
  canRestartAutomation,
  canToggleAutomation,
  getAutomationActionErrorToastId,
  getAutomationCreateErrorToastId,
  getAutomationRunNowToastId,
  isOffPeakDetailNavigationId,
  resolveAutomationDetailNavigation,
  resolveAutomationDetailTarget,
  resolveAutomationTabAfterOffPeakChange,
  resolveAutomationTabNavigation,
  resolveAutomationTemplateVisibility,
  resolveOffPeakDetailNavigation,
  resolveVisibleAutomationTabs,
} from "../src/settings/automations/navigationModel.js";

/**
 * AutomationsSection batch-1 helper 外迁的接缝内决策表单测（split-plan「settings 上帝组件拆分计划」
 * 的 AutomationsSection 登记行 + review 2026-10-28 §3.①）。
 * 覆盖：tab 可见性矩阵 × off-peak 变更后落点 × tab 导航 pending/settled × 详情导航 id 判定
 * × toast id 决策 × restart/toggle 能力矩阵。
 */

function makeAutomation(overrides: Partial<ACodeAutomation> = {}): ACodeAutomation {
  return {
    automationId: "auto-1",
    title: "t",
    cronExpr: "0 9 * * *",
    prompt: "p",
    workspaceKey: "/tmp/ws",
    workspacePath: "/tmp/ws",
    locationKind: "local",
    recurring: true,
    runCount: 0,
    enabled: true,
    lifecycleStatus: "active",
    dispatchStatus: "idle",
    dispatchAttempts: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeOffPeakTask(overrides: Partial<ACodeOffPeakTask> = {}): ACodeOffPeakTask {
  return {
    offPeakTaskId: "offpeak-1",
    title: "t",
    prompt: "p",
    permissionMode: "build",
    workspaceKey: "/tmp/ws",
    workspacePath: "/tmp/ws",
    status: "queued",
    queuedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("tab 可见性矩阵：无任务时空数组，灰度关时仅 scheduled，灰度开时 scheduled+idle", () => {
  assert.deepEqual(resolveVisibleAutomationTabs({ hasAnyTasks: false, offPeakVisible: true }), []);
  assert.deepEqual(resolveVisibleAutomationTabs({ hasAnyTasks: false, offPeakVisible: false }), []);
  assert.deepEqual(
    resolveVisibleAutomationTabs({ hasAnyTasks: true, offPeakVisible: false }),
    SCHEDULED_ONLY_AUTOMATION_TABS,
  );
  assert.deepEqual(
    resolveVisibleAutomationTabs({ hasAnyTasks: true, offPeakVisible: true }),
    SCHEDULED_AND_IDLE_AUTOMATION_TABS,
  );
  // 常量内容钉死：scheduled 常驻、无 All 混排视图。
  assert.deepEqual(SCHEDULED_ONLY_AUTOMATION_TABS, ["scheduled"]);
  assert.deepEqual(SCHEDULED_AND_IDLE_AUTOMATION_TABS, ["scheduled", "idle"]);
});

test("off-peak 灰度变更后落点：idle 遇灰度关闭回退 scheduled，其余原样保留", () => {
  assert.equal(resolveAutomationTabAfterOffPeakChange("idle", false), "scheduled");
  assert.equal(resolveAutomationTabAfterOffPeakChange("idle", true), "idle");
  assert.equal(resolveAutomationTabAfterOffPeakChange("scheduled", false), "scheduled");
  assert.equal(resolveAutomationTabAfterOffPeakChange("scheduled", true), "scheduled");
});

test("tab 导航：tabs 未就绪 pending；就绪后命中可见 tab 用请求值，否则回退 scheduled", () => {
  assert.deepEqual(
    resolveAutomationTabNavigation({
      requestedTab: "idle",
      tabsReady: false,
      visibleTabs: SCHEDULED_AND_IDLE_AUTOMATION_TABS,
    }),
    { status: "pending" },
  );
  assert.deepEqual(
    resolveAutomationTabNavigation({
      requestedTab: "idle",
      tabsReady: true,
      visibleTabs: SCHEDULED_AND_IDLE_AUTOMATION_TABS,
    }),
    { status: "settled", tab: "idle" },
  );
  assert.deepEqual(
    resolveAutomationTabNavigation({
      requestedTab: "idle",
      tabsReady: true,
      visibleTabs: SCHEDULED_ONLY_AUTOMATION_TABS,
    }),
    { status: "settled", tab: "scheduled" },
  );
});

test("模板可见性：无任务时两类并列（闲时受创建开关门控）；有任务后按 tab 分流", () => {
  assert.deepEqual(
    resolveAutomationTemplateVisibility({
      hasAnyTasks: false,
      offPeakCreationEnabled: true,
      tab: "scheduled",
    }),
    { showOffPeakTemplates: true, showScheduledTemplates: true },
  );
  assert.deepEqual(
    resolveAutomationTemplateVisibility({
      hasAnyTasks: false,
      offPeakCreationEnabled: false,
      tab: "scheduled",
    }),
    { showOffPeakTemplates: false, showScheduledTemplates: true },
  );
  assert.deepEqual(
    resolveAutomationTemplateVisibility({
      hasAnyTasks: true,
      offPeakCreationEnabled: true,
      tab: "scheduled",
    }),
    { showOffPeakTemplates: false, showScheduledTemplates: true },
  );
  assert.deepEqual(
    resolveAutomationTemplateVisibility({
      hasAnyTasks: true,
      offPeakCreationEnabled: true,
      tab: "idle",
    }),
    { showOffPeakTemplates: true, showScheduledTemplates: false },
  );
});

test("automationPromptSummary：折叠空白，空串回退单空格占位", () => {
  assert.equal(automationPromptSummary("  a\n b\tc  "), "a b c");
  assert.equal(automationPromptSummary("   "), " ");
  assert.equal(automationPromptSummary(""), " ");
});

test("canRestart/canToggle 能力矩阵：failed 可重启；completed/failed 不可启停", () => {
  assert.equal(canRestartAutomation(makeAutomation({ lifecycleStatus: "failed" })), true);
  assert.equal(canRestartAutomation(makeAutomation({ lifecycleStatus: "active" })), false);
  assert.equal(canToggleAutomation(makeAutomation({ lifecycleStatus: "active" })), true);
  assert.equal(canToggleAutomation(makeAutomation({ lifecycleStatus: "paused" })), true);
  assert.equal(canToggleAutomation(makeAutomation({ lifecycleStatus: "completed" })), false);
  assert.equal(canToggleAutomation(makeAutomation({ lifecycleStatus: "failed" })), false);
});

test("run-now toast id 决策：queued→queued、duplicate→alreadyRunning、failed→failed", () => {
  assert.equal(getAutomationRunNowToastId("queued"), "automations.runNowQueued");
  assert.equal(getAutomationRunNowToastId("duplicate"), "automations.runNowAlreadyRunning");
  assert.equal(getAutomationRunNowToastId("failed"), "automations.runNowFailed");
});

test("action/create 错误 toast id：动作入 id；创建限额错误用专用 id", () => {
  assert.equal(getAutomationActionErrorToastId("update"), "automations.error.update");
  assert.equal(getAutomationActionErrorToastId("delete"), "automations.error.delete");
  assert.equal(getAutomationCreateErrorToastId(new Error("boom")), "automations.error.create");
  // 创建限额错误由 isAutomationCreateLimitError 判别（shared 侧判定），此处钉非限额路径。
});

test("详情导航 target：空 id 未命中，trim 后按 automationId 精确匹配", () => {
  const list = [makeAutomation({ automationId: "a-1" }), makeAutomation({ automationId: "a-2" })];
  assert.equal(resolveAutomationDetailTarget(list, null), null);
  assert.equal(resolveAutomationDetailTarget(list, "  "), null);
  assert.equal(resolveAutomationDetailTarget(list, "missing"), null);
  assert.equal(resolveAutomationDetailTarget(list, " a-2 ")?.automationId, "a-2");
});

test("详情导航状态机：pending → found/missing，空 id 恒 pending", () => {
  const list = [makeAutomation({ automationId: "a-1" })];
  assert.deepEqual(resolveAutomationDetailNavigation(list, "a-1", false), { status: "pending" });
  assert.deepEqual(resolveAutomationDetailNavigation(list, "", true), { status: "pending" });
  assert.deepEqual(resolveAutomationDetailNavigation(list, "a-1", true), {
    status: "found",
    target: list[0],
  });
  assert.deepEqual(resolveAutomationDetailNavigation(list, "missing", true), {
    status: "missing",
  });
});

test("offpeak 详情 id 判别：offpeak- 前缀命中，空白与 cron id 不命中", () => {
  assert.equal(isOffPeakDetailNavigationId("offpeak-abc"), true);
  assert.equal(isOffPeakDetailNavigationId("  offpeak-abc "), true);
  assert.equal(isOffPeakDetailNavigationId("a-1"), false);
  assert.equal(isOffPeakDetailNavigationId(""), false);
  assert.equal(isOffPeakDetailNavigationId(null), false);
});

test("offpeak 详情导航：列表不可信时 unavailable，不做 found/missing 终审", () => {
  const tasks = [makeOffPeakTask({ offPeakTaskId: "offpeak-1" })];
  assert.deepEqual(resolveOffPeakDetailNavigation(tasks, "offpeak-1", false), {
    status: "pending",
  });
  assert.deepEqual(resolveOffPeakDetailNavigation(tasks, "offpeak-1", true, "load failed"), {
    status: "unavailable",
  });
  assert.deepEqual(resolveOffPeakDetailNavigation(tasks, "offpeak-1", true), {
    status: "found",
    target: tasks[0],
  });
  assert.deepEqual(resolveOffPeakDetailNavigation(tasks, "offpeak-x", true), {
    status: "missing",
  });
});

test("导出的常量锚点稳定：toast anchor 与状态元表结构", () => {
  assert.equal(AUTOMATIONS_TOAST_ANCHOR_ID, "automations-main-toast-anchor");
  // STATUS_META 四态齐全且各自带 icon/className（icon 为组件引用，只断言存在性）。
  assert.deepEqual(Object.keys(STATUS_META).sort(), ["active", "completed", "failed", "paused"]);
  for (const meta of Object.values(STATUS_META)) {
    // icon 为组件引用（memo/forwardRef 是 object，普通函数组件是 function），只断言存在性。
    assert.ok(meta.icon, "STATUS_META icon 缺失");
    assert.equal(typeof meta.className, "string");
  }
});
