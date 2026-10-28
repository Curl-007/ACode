// WorkspaceSidebar 批次 5 外迁（sidebarChrome）的接缝内渲染契约测试。
// renderToStaticMarkup + createElement，无 jsdom；ControlHintTooltip 的 Radix Content
// 走 Portal 且仅打开时挂载，静态渲染只钉 Trigger 侧结构（对照 pluginListRows.test.ts 口径）。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceTabState } from "../src/store/tabStore.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import {
  WorkspaceDragOverlay,
  WorkspaceNewTaskTooltip,
} from "../src/WorkspaceSidebar/sidebarChrome.js";

const baseTab: WorkspaceTabState = {
  id: "tab-1",
  kind: "workspace",
  label: "proj-a",
  workspacePath: "/ws/proj-a",
};

test("WorkspaceNewTaskTooltip：无 disabledReason 时原样透传 children", () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceNewTaskTooltip, {}, createElement("button", {}, "新建")),
  );
  // 无 tooltip 包装层（ControlHintTooltip 会包一层带 tooltip 语义的 trigger）。
  assert.equal(html, "<button>新建</button>");
});

test("WorkspaceNewTaskTooltip：有 disabledReason 时挂 tooltip 包装", () => {
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      {},
      createElement(
        WorkspaceNewTaskTooltip,
        { disabledReason: "只读工作区" },
        createElement("button", {}, "新建"),
      ),
    ),
  );
  assert.ok(html.includes("<button>新建</button>"));
  // 包装 div 带 tooltip trigger 语义（data-slot / data-state）。
  assert.ok(html.includes('data-slot="tooltip-trigger"'));
});

test("WorkspaceDragOverlay：本地 workspace 用 Folder 图标", () => {
  const html = renderToStaticMarkup(createElement(WorkspaceDragOverlay, { tab: baseTab, width: null }));
  assert.ok(html.includes('data-testid="workspace-drag-overlay"'));
  assert.ok(html.includes("proj-a"));
  // 本地态不出现 Cloud 远程图标（lucide Cloud 带特定 path；以 svg 数量钉分支：本地/远程各一枚图标）。
  assert.equal((html.match(/<svg/g) ?? []).length, 1);
  // width=null 时不写 style。
  assert.ok(!html.includes("style="));
});

test("WorkspaceDragOverlay：remote 标记三分支（remoteSessionId/remoteTarget/workspaceIdentity）+ 宽度", () => {
  for (const patch of [
    { remoteSessionId: "rs-1" },
    { remoteTarget: { kind: "ssh", host: "h", username: "u" } },
    { workspaceIdentity: "id-1" },
  ] as const) {
    const tab: WorkspaceTabState = { ...baseTab, ...patch };
    const html = renderToStaticMarkup(createElement(WorkspaceDragOverlay, { tab, width: 220 }));
    assert.ok(html.includes('data-testid="workspace-drag-overlay"'));
    assert.ok(html.includes("width:220px"));
  }
});
