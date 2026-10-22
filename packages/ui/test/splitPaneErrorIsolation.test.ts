// 分屏 pane per-pane 错误隔离守护（packages/ui/specs/split-pane-error-isolation.md 场景 1/2/3）。
//
// ui 测试无 jsdom 套件（对齐 queueGuideFellbackNotice.test.ts / chatRowFactsSurface.test.ts）：
// 用源码契约钉住 per-pane ScopedErrorBoundary 的接线与嵌套层次。React 错误边界的真实捕获
// 行为由 ErrorBoundary.tsx 的 class 组件语义保证（已在其它区域使用），此处只钉分屏 pane
// 这一新接入点的结构，防回归到「全窗口只有一个 workspace-chat 边界」的缺陷态。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const WORKBENCH_PANE = "../src/v4/WorkbenchPane.tsx";
const SHELL_LAYOUT = "../src/app-shell/WorkspaceShellLayout.tsx";

/** 取从 <ChatPaneShell 到其闭合 </ChatPaneShell> 的 return 子串（WorkbenchLeafPane 唯一 return）。 */
function chatPaneShellBlock(source: string): string {
  const start = source.indexOf("<ChatPaneShell");
  assert.ok(start >= 0, "WorkbenchLeafPane 必须渲染 <ChatPaneShell>");
  const end = source.indexOf("</ChatPaneShell>", start);
  assert.ok(end >= 0, "ChatPaneShell 必须闭合");
  return source.slice(start, end + "</ChatPaneShell>".length);
}

test("场景1: 每个叶子 pane 在 ChatPaneShell 内包 per-pane ScopedErrorBoundary", () => {
  const block = chatPaneShellBlock(readSource(WORKBENCH_PANE));
  // per-pane 边界存在，且 scope 用 paneId 模板（每 pane 唯一，日志可区分哪个面板崩了）。
  assert.match(block, /<ScopedErrorBoundary/);
  assert.match(block, /scope=\{`v4-pane:\$\{paneId\}`\}/);
  // R3: resetKeys 用 [sessionId, paneWorkspaceKey(scope)]，pane 改绑/换 scope 时清空旧错误。
  assert.match(block, /resetKeys=\{\[sessionId, paneWorkspaceKey\(scope\)\]\}/);
  assert.match(block, /variant="panel"/);
});

test("场景2: 边界在 ChatPaneShell 之内、V4PaneConversationProvider 之外（R1/R2 层次）", () => {
  const block = chatPaneShellBlock(readSource(WORKBENCH_PANE));
  const shellOpen = block.indexOf("<ChatPaneShell");
  const boundaryOpen = block.indexOf("<ScopedErrorBoundary");
  const providerOpen = block.indexOf("<V4PaneConversationProvider");
  const providerClose = block.indexOf("</V4PaneConversationProvider>");
  const boundaryClose = block.indexOf("</ScopedErrorBoundary>");
  const shellClose = block.indexOf("</ChatPaneShell>");

  // ChatPaneShell > ScopedErrorBoundary > V4PaneConversationProvider > SessionPane。
  // 放 ChatPaneShell 内使 fallback 落在 pane rect 里（R2）；provider 在边界内使 provider
  // 与 SessionPane 两层抛错都被本 pane 边界捕获（R1）。
  assert.ok(
    shellOpen < boundaryOpen &&
      boundaryOpen < providerOpen &&
      providerOpen < providerClose &&
      providerClose < boundaryClose &&
      boundaryClose < shellClose,
    `嵌套层次错误: shell=${shellOpen} boundary=${boundaryOpen} provider=${providerOpen} ` +
      `providerClose=${providerClose} boundaryClose=${boundaryClose} shellClose=${shellClose}`,
  );
});

test("场景3: 外层 workspace-chat 兜底边界保留（R4 加法隔离，不替换外层）", () => {
  const shellLayout = readSource(SHELL_LAYOUT);
  // per-pane 边界是加法层；对话区外层兜底边界不删除，仍是 sidebar 之外整块的最后一道防线。
  assert.match(shellLayout, /scope="workspace-chat"/);
});
