// assistant 完成态动作行的实际渲染断言（packages/ui/specs/chat-row-facts.md 第 1/3 节）。
// 形态对照 conversationUserInputCommandEcho.test.ts：renderToStaticMarkup + createElement，
// 无 jsdom。守护上游 review 的同源缺陷——「只计算未渲染」：速率标签必须真的出现在
// 动作行 DOM 里；常驻动作行不得再带 opacity 门控类。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ConversationRowView 的模块图经 provider/plugin 图标表拉到 .svg/.png 等静态资产
//（vite 资产、node 加载器不认识）。渲染断言只关心 DOM 契约，图标内容无关：用
// node:module 同步 hooks 把资产桩成空模块（仅本测试文件内生效，不触生产代码）。
const ASSET_EXTENSIONS = [".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"];
registerHooks({
  load(url, context, nextLoad) {
    if (ASSET_EXTENSIONS.some((extension) => url.endsWith(extension))) {
      return { format: "module", source: "export default undefined;", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
// 触发注册后再拉组件模块图（顶层 import 会先于 hooks 注册执行，必须用动态 import）。
const { TooltipProvider } = await import("../src/components/ui/tooltip.js");
const { ACodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { getLocaleMessagesResource } = await import("../src/i18n/localeMessages.js");
const { ConversationAssistantTextActions } = await import("../src/v4/ConversationRowView.js");

// 词典是懒加载资源，Provider 在 pending 态会 suspend；renderToStaticMarkup 不支持异步，
// 先把 zh-CN 词典预热成 fulfilled，再静态渲染。
test.before(async () => {
  await getLocaleMessagesResource("zh-CN").promise;
});

const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(
    createElement(
      ACodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TooltipProvider, null, node),
    ),
  );

const STATS = {
  inputTokens: 12004,
  outputTokens: 886,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  timeToFirstTokenMs: 10000,
  generationMs: 10000,
  modelRequestCount: 1,
};

function renderActions(props: { stats?: typeof STATS | null }): string {
  return render(
    createElement(ConversationAssistantTextActions, {
      rowId: 7,
      text: "回复正文",
      createdAt: Date.UTC(2026, 9, 20, 1, 2, 3),
      ...props,
    }),
  );
}

test("事实齐全时动作行渲染 ↑prefill 与 ↓decode（真实 DOM，非只计算）", () => {
  const html = renderActions({ stats: STATS });
  assert.match(html, /↑1,200\.4 tok\/s/);
  assert.match(html, /↓88\.6 tok\/s/);
  // 时间标签仍在前（既有契约不回归）。
  assert.match(html, /select-none text-ui-sm text-foreground-subtlest/);
});

test("stats 缺席（旧投影/内联兜底路径）时速率段整段隐藏，不显示 0、不报错", () => {
  for (const absent of [null, undefined]) {
    const html = renderActions({ stats: absent });
    assert.doesNotMatch(html, /↑/);
    assert.doesNotMatch(html, /↓/);
    assert.doesNotMatch(html, /tok\/s/);
  }
});

test("TTFT=0（全缓存直出）只显示 ↓decode", () => {
  const html = renderActions({ stats: { ...STATS, timeToFirstTokenMs: 0 } });
  assert.doesNotMatch(html, /↑/);
  assert.match(html, /↓88\.6 tok\/s/);
});

test("动作行常驻：渲染结果不含任何 hover 透明门控类", () => {
  const html = renderActions({ stats: STATS });
  assert.doesNotMatch(html, /opacity-0/);
  assert.doesNotMatch(html, /group-hover/);
});
