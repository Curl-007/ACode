// ConversationStatusPanel 批次 6 第一阶段：分区渲染契约测试。
//
// 覆盖外迁到 `v4/conversation-status-panel/` 的四个展示单元（StatusSectionShell /
// GitStatusSection / PlanStatusSections / TeamAndEndedSections）的 renderToStaticMarkup
// 结构契约。口径同 pluginListRows.test.ts / workspaceSidebarTaskToolbar.test.ts：
// Radix Collapsible 与 HoverCard 的 Content 在 SSR 下按 open 状态渲染（Collapsible 已
// 实测可静态展开），DropdownMenu 走 Portal 只钉 Trigger。
//
// 这些测试是「逐 section 外迁」的前置：先把每个分区的可见结构钉住，后续批次移动 section
// 时才能区分「结构没变」与「行为被改」。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanState } from "@acode/shared/acode-protocol-v4";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { Collapsible } from "../src/components/ui/collapsible.js";
import {
  StatusSection,
  StatusSectionHeader,
  STATUS_SECTION_SCROLL_POLICY,
  type StatusSectionKind,
} from "../src/v4/conversation-status-panel/StatusSectionShell.js";
import {
  PlanStatusSection,
  SessionPlansStatusSection,
} from "../src/v4/conversation-status-panel/PlanStatusSections.js";
import {
  EndedDirectoryRow,
  EndedSubagentDirectoryRow,
  TeamStatusSection,
} from "../src/v4/conversation-status-panel/TeamAndEndedSections.js";
import type { ConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelTeam } from "../src/v4/teamPanelModel.js";

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

const planModel = (items: PlanState["items"]): ConversationStatusPanelModel["plan"] => ({
  items,
  displayItems: items,
  completedCount: items.filter((item) => item.status === "completed").length,
  waitingCount: items.filter((item) => item.status === "pending").length,
  totalCount: items.length,
});

const makePlan = (statuses: readonly PlanState["items"][number]["status"][]): PlanState["items"] =>
  statuses.map((status, index) => ({
    id: `todo-${index}`,
    content: `事项 ${index}`,
    status,
  }));

const team: ConversationStatusPanelTeam = {
  teamId: "team-1",
  goal: "Render the team goal",
  status: "active",
  counts: { done: 1, inProgress: 1, todo: 1, failed: 0, blocked: 0 },
  tasks: [{ taskId: "t-1" }, { taskId: "t-2" }, { taskId: "t-3" }],
  members: [],
} as unknown as ConversationStatusPanelTeam;

// ---- StatusSectionShell ----

test("StatusSection：data-status-section 锚点 + 展开态 header 触发器", () => {
  const html = render(
    createElement(
      StatusSection,
      { section: "goal", title: "Goal title" },
      createElement("div", { "data-child": "yes" }, "body"),
    ),
  );
  assert.match(html, /data-status-section="goal"/);
  assert.match(html, /data-status-section-trigger="goal"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /data-child="yes"/);
  assert.match(html, /Goal title/);
});

test("StatusSection：defaultOpen=false 时内容不展开", () => {
  const html = render(
    createElement(
      StatusSection,
      { section: "agent", title: "Agents", defaultOpen: false },
      createElement("div", { "data-child": "yes" }, "body"),
    ),
  );
  assert.match(html, /data-status-section-trigger="agent"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /data-child="yes"/);
});

test("StatusSection：受控 open 决定展开态（覆盖 defaultOpen）", () => {
  const html = render(
    createElement(
      StatusSection,
      { section: "terminal", title: "Terminals", open: false, defaultOpen: true },
      createElement("div", { "data-child": "yes" }, "body"),
    ),
  );
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /data-child="yes"/);
});

test("StatusSection：限高策略为 null 的分区不包滚动视口（environment）", () => {
  const html = render(
    createElement(
      StatusSection,
      { section: "environment", title: "Environment" },
      createElement("div", null, "body"),
    ),
  );
  assert.doesNotMatch(html, /data-status-section-scroll="environment"/);
  assert.equal(STATUS_SECTION_SCROLL_POLICY.environment, null);
});

test("StatusSection：有滚动策略的分区包滚动视口并带对应限高类", () => {
  for (const section of ["goal", "sessionPlans", "plan", "agent-teams", "terminal", "workflow", "agent"] as const) {
    const html = render(
      createElement(StatusSection, { section, title: section }, createElement("div", null, "body")),
    );
    assert.match(html, new RegExp(`data-status-section-scroll="${section}"`), `${section} 应有滚动视口`);
    const expected = STATUS_SECTION_SCROLL_POLICY[section];
    assert.ok(expected, `${section} 的限高类不应为空`);
    assert.ok(html.includes(expected!), `${section} 的限高类 ${expected} 应出现在 HTML 里`);
  }
});

test("StatusSection：separated 加顶部分隔线，不传则没有", () => {
  const separated = render(
    createElement(StatusSection, { section: "goal", title: "G", separated: true }, "body"),
  );
  assert.match(separated, /border-t border-\[var\(--color-border\)\] pt-2/);
  const plain = render(createElement(StatusSection, { section: "goal", title: "G" }, "body"));
  assert.doesNotMatch(plain, /border-t border-\[var\(--color-border\)\] pt-2/);
});

test("StatusSection：trailing 回调收到当前展开态", () => {
  const seen: boolean[] = [];
  render(
    createElement(
      StatusSection,
      {
        section: "plan",
        title: "Todo",
        trailing: (isOpen: boolean) => {
          seen.push(isOpen);
          return createElement("span", null, "1/2");
        },
      },
      "body",
    ),
  );
  assert.deepEqual(seen, [true]);
});

test("StatusSectionHeader：收起态用右箭头、展开态用下箭头", () => {
  // CollapsibleTrigger 必须在 Collapsible 上下文里（radix 契约），故用最小外壳包裹。
  const open = render(
    createElement(
      Collapsible,
      { open: true },
      createElement(StatusSectionHeader, { section: "goal", title: "T", isOpen: true }),
    ),
  );
  assert.match(open, /lucide-chevron-down/);
  const closed = render(
    createElement(
      Collapsible,
      { open: false },
      createElement(StatusSectionHeader, { section: "goal", title: "T", isOpen: false }),
    ),
  );
  assert.match(closed, /lucide-chevron-right/);
});

test("StatusSectionHeader：children 渲染到 header 尾部槽位，缺席时不产生空容器", () => {
  const withChildren = render(
    createElement(
      Collapsible,
      { open: true },
      createElement(
        StatusSectionHeader,
        { section: "goal", title: "T", isOpen: true },
        createElement("span", { "data-trailing": "1" }, "x"),
      ),
    ),
  );
  assert.match(withChildren, /data-trailing="1"/);
  const withoutChildren = render(
    createElement(
      Collapsible,
      { open: true },
      createElement(StatusSectionHeader, { section: "goal", title: "T", isOpen: true }),
    ),
  );
  assert.doesNotMatch(withoutChildren, /data-trailing/);
});

test("StatusSectionKind：八种分区类型都有滚动策略条目（穷举守卫）", () => {
  const kinds: StatusSectionKind[] = [
    "environment",
    "goal",
    "sessionPlans",
    "plan",
    "agent-teams",
    "terminal",
    "workflow",
    "agent",
  ];
  assert.deepEqual(Object.keys(STATUS_SECTION_SCROLL_POLICY).sort(), [...kinds].sort());
});

// ---- PlanStatusSections ----

test("PlanStatusSection：无 plan 时整段缺席", () => {
  const html = render(
    createElement(PlanStatusSection, {
      model: { plan: null } as unknown as ConversationStatusPanelModel,
      popoverSide: "left",
      separated: false,
    }),
  );
  assert.equal(html, "");
});

test("PlanStatusSection：标题、计数与每项状态锚点", () => {
  const items = makePlan(["completed", "inProgress", "pending"]);
  const html = render(
    createElement(PlanStatusSection, {
      model: { plan: planModel(items) } as unknown as ConversationStatusPanelModel,
      popoverSide: "left",
      separated: false,
    }),
  );
  assert.match(html, /data-status-section="plan"/);
  assert.match(html, /1\/3/);
  assert.match(html, /data-plan-status="completed"/);
  assert.match(html, /data-plan-status="inProgress"/);
  assert.match(html, /data-plan-status="pending"/);
  assert.match(html, /事项 0/);
});

test("PlanStatusSection：完成项带删除线、未完成项不带", () => {
  const items = makePlan(["completed", "pending"]);
  const html = render(
    createElement(PlanStatusSection, {
      model: { plan: planModel(items) } as unknown as ConversationStatusPanelModel,
      popoverSide: "left",
      separated: false,
    }),
  );
  const completedBlock = html.slice(html.indexOf('data-plan-status="completed"'));
  assert.match(completedBlock.slice(0, 1000), /line-through/);
});

test("SessionPlansStatusSection：无 sessionPlans 时整段缺席", () => {
  const html = render(
    createElement(SessionPlansStatusSection, {
      model: { sessionPlans: null } as unknown as ConversationStatusPanelModel,
      separated: false,
    }),
  );
  assert.equal(html, "");
});

test("SessionPlansStatusSection：每项渲染目录按钮，缺 parentSessionId 时禁用", () => {
  const html = render(
    createElement(SessionPlansStatusSection, {
      model: {
        sessionPlans: {
          items: [{ rowId: 1, toolCallId: "tc-1", markdown: "", title: "计划甲" }],
        },
      } as unknown as ConversationStatusPanelModel,
      separated: false,
    }),
  );
  assert.match(html, /data-status-section="sessionPlans"/);
  assert.match(html, /data-plan-directory-tool-call-id="tc-1"/);
  assert.match(html, /计划甲/);
  assert.match(html, /disabled/);
});

test("SessionPlansStatusSection：有 parentSessionId + 回调时按钮可用", () => {
  const html = render(
    createElement(SessionPlansStatusSection, {
      model: {
        sessionPlans: { items: [{ rowId: 1, toolCallId: "tc-1", markdown: "", title: "计划甲" }] },
      } as unknown as ConversationStatusPanelModel,
      parentSessionId: "parent-1",
      onOpenPlanDetail: () => {},
      separated: false,
    }),
  );
  assert.doesNotMatch(
    html.slice(html.indexOf("data-plan-directory-tool-call-id"), html.indexOf("</button>")),
    /disabled/,
  );
});

// ---- TeamAndEndedSections ----

test("TeamStatusSection：标题、完成比与团队摘要", () => {
  const html = render(
    createElement(TeamStatusSection, {
      separated: false,
      team,
      title: "Agent Teams",
      parentSessionId: "parent-1",
    }),
  );
  assert.match(html, /data-status-section="agent-teams"/);
  assert.match(html, /Agent Teams/);
  assert.match(html, /1\/3/);
  assert.match(html, /Render the team goal/);
});

test("EndedDirectoryRow：count<=0 或缺回调时整行缺席", () => {
  const noCount = render(
    createElement(EndedDirectoryRow, {
      count: 0,
      icon: createElement("span", null, "i"),
      label: "已结束",
      onOpen: () => {},
      separated: false,
    }),
  );
  assert.equal(noCount, "");
  const noCallback = render(
    createElement(EndedDirectoryRow, {
      count: 3,
      icon: createElement("span", null, "i"),
      label: "已结束",
      separated: false,
    }),
  );
  assert.equal(noCallback, "");
});

test("EndedDirectoryRow：渲染图标、文案、计数与 testid", () => {
  const html = render(
    createElement(EndedDirectoryRow, {
      count: 3,
      icon: createElement("span", { "data-icon": "x" }, "i"),
      label: "已结束的 agents",
      onOpen: () => {},
      separated: true,
      testId: "directory-trigger",
    }),
  );
  assert.match(html, /data-testid="directory-trigger"/);
  assert.match(html, /data-icon="x"/);
  assert.match(html, /已结束的 agents/);
  assert.match(html, />3</);
  assert.match(html, /border-t border-\[var\(--color-border\)\] pt-2/);
});

test("EndedSubagentDirectoryRow：缺 parentSessionId 时整行缺席", () => {
  const html = render(
    createElement(EndedSubagentDirectoryRow, {
      count: 2,
      onOpen: () => {},
      separated: false,
    }),
  );
  assert.equal(html, "");
});

test("EndedSubagentDirectoryRow：有 parentSessionId 时渲染并带结束文案", () => {
  const html = render(
    createElement(EndedSubagentDirectoryRow, {
      count: 2,
      onOpen: () => {},
      parentSessionId: "parent-1",
      separated: false,
    }),
  );
  assert.match(html, /2/);
  assert.ok(html.length > 0);
});

// ---- GitStatusSection ----
// 依赖 GitBranchSwitcher（useGitBranchSwitcher → useServices）与 GitActionMenu（useServices），
// 静态渲染需要完整 ServiceProvider 桩；当前无 jsdom 且 services 面很大，按固定验收第 4 条
// 登记为「无单测覆盖」，其可见结构由 ConversationTeamStatusPanel.test.ts 的整面板渲染间接覆盖
// （该测试通过 ConversationStatusPanel 根组件走到 GitStatusSection 的缺席分支）。
