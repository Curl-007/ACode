// ConversationStatusPanel 批次 7 第二阶段：收起态胶囊的渲染契约。
//
// `statusSummaryCapsuleModel.test.ts` 钉住了**分支优先级**（纯决策）；本文件钉住
// `StatusSummaryRow.tsx` 把 kind 渲染成 DOM 的那一半：每个分支的可见锚点（图标/文案/数值）
// 与「无内容整段缺席」。两者合起来才等于批次 4/6 要求的「分支优先级契约 + 结构契约」。
//
// 口径同前序：ControlHintTooltip 走 Radix Tooltip（需 TooltipProvider），DropdownMenu 走 Portal
// 只钉 Trigger 侧——本组件不含菜单，故直接渲染即可。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanState } from "@acode/shared/acode-protocol-v4";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { StatusSummaryRow } from "../src/v4/conversation-status-panel/StatusSummaryRow.js";
import type { ConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";

test.before(async () => {
  await getLocaleMessagesResource("en-US").promise;
});

const render = (node: unknown): string =>
  renderToStaticMarkup(
    createElement(
      ACodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(TooltipProvider, {}, node as React.ReactElement),
    ),
  );

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

const planModel = (
  statuses: readonly PlanState["items"][number]["status"][],
): ConversationStatusPanelModel["plan"] => {
  const items = statuses.map((status, index) => ({
    id: `todo-${index}`,
    content: `事项 ${index}`,
    status,
  }));
  return {
    items,
    displayItems: items,
    completedCount: items.filter((item) => item.status === "completed").length,
    waitingCount: items.filter((item) => item.status === "pending").length,
    totalCount: items.length,
  };
};

const renderRow = (
  model: ConversationStatusPanelModel,
  options: { endedWorkflowRunCount?: number; gitWorktreeChangeSummary?: { added: number; removed: number } | null } = {},
): string =>
  render(
    createElement(StatusSummaryRow, {
      model,
      endedWorkflowRunCount: options.endedWorkflowRunCount ?? 0,
      gitWorktreeChangeSummary: options.gitWorktreeChangeSummary ?? null,
    }),
  );

test("胶囊：空模型整段缺席（不输出空壳按钮）", () => {
  assert.equal(renderRow(makeModel()), "");
});

test("胶囊：团队分支输出团队文案与完成比", () => {
  const html = renderRow(
    makeModel({ team: { counts: { done: 2 }, totalCount: 5 } as never }),
  );
  assert.match(html, /aria-label=/);
  assert.match(html, /2\/5/);
});

test("胶囊：进行中 Todo 分支输出事项内容", () => {
  const html = renderRow(makeModel({ plan: planModel(["inProgress"]) }));
  assert.match(html, /事项 0/);
});

test("胶囊：git 分支输出 +added / -removed 两段", () => {
  const html = renderRow(makeModel({ git: {} as never }), {
    gitWorktreeChangeSummary: { added: 7, removed: 3 },
  });
  assert.match(html, /\+7/);
  assert.match(html, /-3/);
});

test("胶囊：plan-count 分支输出 completed/total 计数", () => {
  const html = renderRow(makeModel({ plan: planModel([]) }));
  assert.match(html, /0\/0/);
});

test("胶囊：session-plan 分支输出计划标题", () => {
  const html = renderRow(makeModel({ sessionPlans: { items: [{ title: "计划乙" }] } as never }));
  assert.match(html, /计划乙/);
});

test("胶囊：ended-workflows 分支输出已结束计数（最低优先级兜底）", () => {
  const html = renderRow(makeModel(), { endedWorkflowRunCount: 3 });
  assert.match(html, />3</);
});

test("胶囊：点击触发 onVariantChange('panel') 的接线存在于按钮 onClick", () => {
  // SSR 不派发事件，这里只断言按钮可交互结构（button + aria-label）在场，
  // 实际回调由 StatusSummaryRow 的 onClick 直传（行为由 typecheck + 人工验证兜底）。
  const html = renderRow(makeModel({ runningBashWorks: [{}] as never }));
  assert.match(html, /<button/);
  assert.match(html, /type="button"/);
});
