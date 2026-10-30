// WorkspaceSidebar 批次 5 外迁（WorkspaceSidebarTaskToolbar）的接缝内渲染契约测试。
// renderToStaticMarkup + ACodeIntlProvider（zh-CN 词典预热），无 jsdom。
// DropdownMenu Content 走 Portal 仅打开时挂载，静态渲染只钉 Trigger 有无（对照
// pluginListRows.test.ts 口径）；Tabs/TabTrigger 与行内按钮静态可见。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import {
  WorkspaceSidebarTaskToolbar,
  type WorkspaceSidebarTaskToolbarProps,
} from "../src/WorkspaceSidebar/WorkspaceSidebarTaskToolbar.js";

// 词典是懒加载资源；renderToStaticMarkup 不支持异步 suspend，先预热 zh-CN。
test.before(async () => {
  await getLocaleMessagesResource("zh-CN").promise;
});

const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(
    createElement(
      ACodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TooltipProvider, {}, node),
    ),
  );

const makeProps = (
  overrides: Partial<WorkspaceSidebarTaskToolbarProps> = {},
): WorkspaceSidebarTaskToolbarProps => ({
  activePrimaryTaskMode: "grouped",
  archivedTasksActionLabel: "归档任务",
  createGroupedTaskGroupAction: () => {},
  onArchivedActionsContainerChange: () => {},
  onPrimaryTaskModeChange: () => {},
  onTaskSortByChange: () => {},
  onToggleAllTaskGroups: () => {},
  onToggleArchivedTasks: () => {},
  onWorkspaceTaskViewChange: () => {},
  primaryTaskIndicatorStyle: { opacity: 1, transform: "translateX(0px)", width: 40 },
  primaryTaskTabsListRef: createRef<HTMLDivElement>(),
  primaryTaskTabTriggerRefs: { current: { grouped: null, workspace: null } },
  showArchivedTasks: false,
  showTaskSortOptions: true,
  showTaskViewFilter: true,
  showWorkspaceViewOptions: true,
  taskSortBy: "updated",
  taskViewMode: "grouped",
  toggleAllTaskGroupsPresentation: null,
  workspaceReadOnly: false,
  workspaceTaskViewValue: "project",
  ...overrides,
});

test("工具栏锚点：两个视图 TabsTrigger + 归档切换按钮", () => {
  const html = render(createElement(WorkspaceSidebarTaskToolbar, makeProps()));
  // Tabs 两个触发器（aria 角色由 Radix 静态输出）。
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  // 归档切换按钮 data-state 跟随 showArchivedTasks。
  assert.ok(html.includes('data-state="off"'));
});

test("grouped 视图渲染新建分组按钮并遵守 workspaceReadOnly", () => {
  const groupedHtml = render(createElement(WorkspaceSidebarTaskToolbar, makeProps()));
  // taskGroup.newGroup 的 aria-label（zh-CN 词典文案）。
  assert.ok(groupedHtml.includes("taskGroup.newGroup") || (groupedHtml.match(/aria-label=/g) ?? []).length >= 4);
  // 只读时按钮 disabled。
  const readOnlyHtml = render(
    createElement(
      WorkspaceSidebarTaskToolbar,
      makeProps({ workspaceReadOnly: true, workspaceReadOnlyReason: "只读" }),
    ),
  );
  assert.ok(readOnlyHtml.includes("disabled"));
  // 非 grouped 视图不渲染新建分组按钮。
  const workspaceHtml = render(
    createElement(WorkspaceSidebarTaskToolbar, makeProps({ taskViewMode: "workspace", activePrimaryTaskMode: "workspace" })),
  );
  assert.ok(!workspaceHtml.includes("taskGroup.newGroup"));
});

test("showTaskViewFilter=false 时不渲染筛选菜单触发器", () => {
  const withFilter = render(createElement(WorkspaceSidebarTaskToolbar, makeProps()));
  const withoutFilter = render(
    createElement(WorkspaceSidebarTaskToolbar, makeProps({ showTaskViewFilter: false })),
  );
  // 有筛选时多一个菜单触发按钮。
  const countButtons = (html: string) => (html.match(/<button/g) ?? []).length;
  assert.equal(countButtons(withoutFilter), countButtons(withFilter) - 1);
});

test("showArchivedTasks=true 时渲染归档操作容器且切换按钮为 on", () => {
  const html = render(
    createElement(
      WorkspaceSidebarTaskToolbar,
      makeProps({ showArchivedTasks: true, taskViewMode: "archived" }),
    ),
  );
  assert.ok(html.includes('data-testid="archived-tasks-toolbar-actions"'));
  assert.ok(html.includes('data-state="on"'));
});

test("toggleAllTaskGroupsPresentation 提供时渲染折叠/展开按钮", () => {
  const html = render(
    createElement(
      WorkspaceSidebarTaskToolbar,
      makeProps({
        toggleAllTaskGroupsPresentation: {
          messageId: "taskGroup.collapseAll",
          canToggle: true,
          areAllExpanded: true,
        },
      }),
    ),
  );
  // 折叠/展开按钮带 aria-label（zh-CN 文案），且未禁用。
  assert.ok(!html.includes('aria-disabled="true"'));
  // 无 presentation 时按钮消失：按钮总数减一。
  const baseline = render(createElement(WorkspaceSidebarTaskToolbar, makeProps()));
  const countButtons = (value: string) => (value.match(/<button/g) ?? []).length;
  assert.equal(countButtons(baseline), countButtons(html) - 1);
});
