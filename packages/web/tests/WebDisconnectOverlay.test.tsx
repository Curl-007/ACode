// specs/web-reconnect.md 验收：断线态 overlay 渲染（renderToStaticMarkup，无 jsdom）。
// overlay 依赖 @acode/ui 的 Button——@acode/ui 图很重（资产/store/provider），用 registerHooks
// 把 `@acode/ui` 短接成最小 Button 桩，只验证 overlay 自身的 DOM 契约与文案/倒计时/焦点语义。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 触发注册后再动态 import 被测模块（顶层 import 会先于 hooks 执行）。
// @acode/ui 图很重（资产/store/provider），解析到磁盘上的真实桩文件（非自定义 scheme，
// 避免 tsx 的 package.json 解析报 Invalid URL），只保留 overlay 需要的 Button DOM 契约。
const uiStubUrl = new URL("./__stubs__/acodeUi.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@acode/ui") {
      return { url: uiStubUrl, shortCircuit: true, format: "module" };
    }
    return nextResolve(specifier, context);
  },
});

const { WebDisconnectOverlay } = await import("../src/reconnect/WebDisconnectOverlay.js");

test("WebDisconnectOverlay: waiting 态渲染标题、说明、倒计时与手动重试按钮", () => {
  const html = renderToStaticMarkup(
    createElement(WebDisconnectOverlay, {
      state: { phase: "waiting", attempt: 2, retryInMs: 5000 },
      onRetry: () => {},
    }),
  );
  // 状态语义：role=status + aria-live（读屏可感知断线态）。
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  // destructive 状态点 + 可读文案（不只靠颜色传义）——中英任一语言都应出现标题与重试按钮。
  assert.match(html, /bg-destructive/);
  assert.match(html, /<button[^>]*type="button"/);
  // waiting 态重试按钮可用（不在 connecting 阶段）：不得渲染 disabled。
  assert.ok(!/<button[^>]*disabled/.test(html), "waiting retry button must be enabled");
  // 倒计时把 5000ms 向上取整成 5 秒并替换占位符（{seconds} 不得残留）。
  assert.ok(!html.includes("{seconds}"), "countdown placeholder must be substituted");
  assert.match(html, /5/);
});

test("WebDisconnectOverlay: exhausted 态渲染达上限说明与手动重试", () => {
  const html = renderToStaticMarkup(
    createElement(WebDisconnectOverlay, {
      state: { phase: "exhausted", attempts: 5 },
      onRetry: () => {},
    }),
  );
  // exhausted 不显示倒计时（无 waiting.retryInMs），但仍提供手动重试按钮。
  assert.match(html, /<button[^>]*type="button"/);
  // exhausted 态重试按钮可用（手动重试正是此态的出口）。
  assert.ok(!/<button[^>]*disabled/.test(html), "exhausted retry button must be enabled");
  assert.ok(!html.includes("{seconds}"));
});

test("WebDisconnectOverlay: connecting 态禁用重试按钮（防 retryNow 换代泄漏孤儿 socket）", () => {
  const html = renderToStaticMarkup(
    createElement(WebDisconnectOverlay, {
      state: { phase: "connecting", attempt: 1 },
      onRetry: () => {},
    }),
  );
  assert.match(html, /<button[^>]*type="button"/);
  // connecting 阶段一次 connect 已在途，重试按钮必须 disabled（specs R3.4/R5.4）。
  assert.match(html, /<button[^>]*disabled/, "connecting retry button must be disabled");
  assert.ok(!html.includes("{seconds}"), "connecting 态不应渲染倒计时模板");
});
