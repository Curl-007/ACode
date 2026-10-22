// 分屏 pane per-pane 错误隔离守护（packages/ui/specs/split-pane-error-isolation.md 场景 1/2/3）。
//
// ui 测试无 jsdom 套件（node:test + renderToStaticMarkup 纯 .ts）。**关键约束**：
// renderToStaticMarkup 走 React SSR，SSR **不运行错误边界**（子树抛错直接冒泡，不会渲染 fallback），
// 所以无法用「渲染一个会抛错的子树 + 边界」这种客户端范式断言捕获行为。
//
// 本文件因此分两层：
// A) **真实行为断言**——直接驱动 ScopedErrorBoundary 的捕获状态机（React 真实捕获钩子
//    getDerivedStateFromError + componentDidCatch + componentDidUpdate 的 resetKeys 清错 +
//    render 的 children/fallback 分支），用 renderToStaticMarkup 渲染 instance.render() 的结果
//    拿到真实 fallback markup。这验证「子组件抛错 → 归一化 → fallback 渲染出 role=alert、不白屏；
//    无错时 children 透传；resetKeys 变化清空旧错误」的**真实行为**，而非源码字符串匹配。
// B) **结构守护测试（非行为验证）**——边界在 WorkbenchPane/WorkspaceShellLayout 树中的**放置层次**
//    （ChatPaneShell > ScopedErrorBoundary > Provider > SessionPane；外层 workspace-chat 兜底保留）。
//    观察 React 树的真实嵌套需要 jsdom，无 DOM 环境下只能读源码钉住接线，防回归到
//    「全窗口只有一个 workspace-chat 边界」的缺陷态。这部分明确标注为结构守护。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScopedErrorBoundary } from "../src/ErrorBoundary.js";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

// ── A) 真实行为断言：ScopedErrorBoundary 捕获状态机 ──

/** 驱动一个 boundary 实例：seed 捕获态后 SSR 它的 render() 结果（SSR 本身不触发边界，故手动 seed）。 */
function mountBoundary(
  props: {
    scope: string;
    variant?: "panel" | "inline" | "compact" | "silent";
    resetKeys?: readonly unknown[];
    children?: ReactNode;
  },
  caughtError?: unknown,
): ScopedErrorBoundary {
  const boundary = new ScopedErrorBoundary({
    scope: props.scope,
    ...(props.variant ? { variant: props.variant } : {}),
    ...(props.resetKeys ? { resetKeys: props.resetKeys } : {}),
    children: props.children ?? null,
  });
  // React 真实捕获钩子：无 jsdom 也能直测 getDerivedStateFromError 的归一化契约。
  if (caughtError !== undefined) {
    boundary.state = ScopedErrorBoundary.getDerivedStateFromError(caughtError);
  }
  return boundary;
}

test("行为1: 子组件抛错被捕获 → getDerivedStateFromError 归一化，fallback 渲染出 role=alert（不白屏）", () => {
  // getDerivedStateFromError 是 React 错误边界真实的捕获入口；抛出的 Error 被归一化进 state。
  const derived = ScopedErrorBoundary.getDerivedStateFromError(new Error("pane crashed"));
  assert.equal(derived.error?.message, "pane crashed");
  assert.equal(derived.componentStack, "");

  const boundary = mountBoundary({ scope: "v4-pane:p1", variant: "panel" }, new Error("pane crashed"));
  const html = renderToStaticMarkup(boundary.render());
  // fallback 真实渲染：role=alert 容器 + 错误摘要文本在场 → 用户看到可恢复卡片而非空白。
  assert.match(html, /role="alert"/);
  assert.match(html, /pane crashed/);
  // section 兜底文案在场（错误被限制在当前区域）。
  assert.match(html, /这块界面出了点问题/);
});

test("行为2: 非 Error 抛出值被归一化为 Error（字符串/未知值不导致 fallback 崩溃）", () => {
  const fromString = ScopedErrorBoundary.getDerivedStateFromError("boom-string");
  assert.ok(fromString.error instanceof Error);
  assert.equal(fromString.error.message, "boom-string");

  const boundary = mountBoundary({ scope: "s", variant: "compact" }, "boom-string");
  const html = renderToStaticMarkup(boundary.render());
  assert.match(html, /role="alert"/);
  assert.match(html, /boom-string/);
});

test("行为3: 无错误时 children 原样透传（边界不误伤正常渲染）", () => {
  const boundary = mountBoundary(
    { scope: "s", children: createElement("div", null, "PANE-CONTENT") },
    undefined,
  );
  assert.equal(boundary.state.error, null);
  const html = renderToStaticMarkup(boundary.render());
  assert.match(html, /PANE-CONTENT/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("行为4: silent variant 捕获后渲染空（不外显 fallback，但仍拦住白屏）", () => {
  const boundary = mountBoundary({ scope: "s", variant: "silent" }, new Error("quiet"));
  assert.equal(boundary.state.error?.message, "quiet");
  assert.equal(renderToStaticMarkup(boundary.render()), "");
});

test("行为5: resetKeys 变化清空旧错误，边界重渲染 children（离开出错区域再回来不看旧错误）", () => {
  const child = createElement("div", null, "RECOVERED");
  const boundary = mountBoundary({ scope: "s", resetKeys: ["sessB", "wsKey"], children: child });
  // 手动 setState 补丁（无 React renderer，模拟 componentDidCatch 后的 state 落地）。
  boundary.setState = (patch) => {
    const next = typeof patch === "function" ? patch(boundary.state) : patch;
    Object.assign(boundary.state, next);
  };
  boundary.state = { error: new Error("old"), componentStack: "" };

  // componentDidUpdate 收到 resetKeys 变化（sessA → sessB）→ 清空 error。
  boundary.componentDidUpdate({ scope: "s", resetKeys: ["sessA", "wsKey"], children: child });
  assert.equal(boundary.state.error, null, "resetKeys 变化必须清空捕获态");
  assert.match(renderToStaticMarkup(boundary.render()), /RECOVERED/);

  // resetKeys 未变 → 保留错误（不误清）。
  const kept = mountBoundary({ scope: "s", resetKeys: ["sessA"], children: child });
  kept.setState = (patch) => {
    const next = typeof patch === "function" ? patch(kept.state) : patch;
    Object.assign(kept.state, next);
  };
  kept.state = { error: new Error("still"), componentStack: "" };
  kept.componentDidUpdate({ scope: "s", resetKeys: ["sessA"], children: child });
  assert.notEqual(kept.state.error, null, "resetKeys 未变必须保留捕获态");
});

// ── B) 结构守护测试（非行为验证）：树中放置层次需 jsdom 才能真实断言，这里读源码钉接线 ──

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

// 结构守护测试，非行为验证：断言 JSX 源码里的嵌套/属性接线，不驱动 React 树。
test("结构守护 场景1: 每个叶子 pane 在 ChatPaneShell 内包 per-pane ScopedErrorBoundary", () => {
  const block = chatPaneShellBlock(readSource(WORKBENCH_PANE));
  // per-pane 边界存在，且 scope 用 paneId 模板（每 pane 唯一，日志可区分哪个面板崩了）。
  assert.match(block, /<ScopedErrorBoundary/);
  assert.match(block, /scope=\{`v4-pane:\$\{paneId\}`\}/);
  // R3: resetKeys 用 [sessionId, paneWorkspaceKey(scope)]，pane 改绑/换 scope 时清空旧错误。
  assert.match(block, /resetKeys=\{\[sessionId, paneWorkspaceKey\(scope\)\]\}/);
  assert.match(block, /variant="panel"/);
});

// 结构守护测试，非行为验证：断言 JSX 标签在源码里的先后次序，不驱动 React 树。
test("结构守护 场景2: 边界在 ChatPaneShell 之内、V4PaneConversationProvider 之外（R1/R2 层次）", () => {
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

// 结构守护测试，非行为验证：断言外层兜底边界的 scope 字面量仍在源码里。
test("结构守护 场景3: 外层 workspace-chat 兜底边界保留（R4 加法隔离，不替换外层）", () => {
  const shellLayout = readSource(SHELL_LAYOUT);
  // per-pane 边界是加法层；对话区外层兜底边界不删除，仍是 sidebar 之外整块的最后一道防线。
  assert.match(shellLayout, /scope="workspace-chat"/);
});
