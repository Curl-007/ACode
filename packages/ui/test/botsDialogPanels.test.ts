// BotsDialog 批次 6 外迁（BotsDialogSidebar / BotsDialogCreatePanel）的接缝内渲染契约测试。
// renderToStaticMarkup + ACodeIntlProvider，无 jsdom。渠道图标是静态 .png 导入：用
// module.registerHooks 重定向到 data: 空模块（口径同 pluginListRows.test.ts）；因此
// 组件走 test.before 里的动态 import。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BotConfig, BotServiceStatus } from "@acode/shared";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import type { BotsDialogSidebar as SidebarComponent } from "../src/BotsDialog/BotsDialogSidebar.js";
import type { BotsDialogCreatePanel as CreatePanelComponent } from "../src/BotsDialog/BotsDialogCreatePanel.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".png")) {
      return { url: "data:text/javascript,export default ''", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

let BotsDialogSidebar: typeof SidebarComponent;
let BotsDialogCreatePanel: typeof CreatePanelComponent;

test.before(async () => {
  await getLocaleMessagesResource("zh-CN").promise;
  ({ BotsDialogSidebar } = await import("../src/BotsDialog/BotsDialogSidebar.js"));
  ({ BotsDialogCreatePanel } = await import("../src/BotsDialog/BotsDialogCreatePanel.js"));
});

const render = (node: unknown): string =>
  renderToStaticMarkup(
    createElement(ACodeIntlProvider, { initialLocale: "zh-CN" }, node as React.ReactElement),
  );

const bot = (overrides: Partial<BotConfig> = {}): BotConfig =>
  ({
    id: "bot-1",
    name: "",
    provider: "telegram",
    enabled: true,
    allowedWorkspaces: ["all"],
    allowedCommands: {},
    currentOptions: {},
    replyMode: "assistant_changes",
    ...overrides,
  }) as unknown as BotConfig;

const renderChannelName = (provider: string) =>
  createElement("span", { "data-channel": provider }, `channel:${provider}`);

const sidebarProps = (overrides: Record<string, unknown> = {}) => ({
  bots: [bot()],
  status: null as BotServiceStatus | null,
  selectedBotId: "bot-1",
  creatingBot: false,
  fallbackBotName: "未命名 Bot",
  onBeginAddBot: () => {},
  onSelectBot: () => {},
  renderChannelName,
  ...overrides,
});

test("侧栏：空列表显示新建提示文案，且始终有新建按钮", () => {
  const html = render(
    createElement(BotsDialogSidebar, sidebarProps({ bots: [], selectedBotId: null })),
  );
  assert.match(html, /新建机器人/, "新建按钮文案来自 bots.addBot 词典");
  assert.match(html, /还没有配置机器人/, "空态文案来自 bots.empty 词典");
});

test("侧栏：空列表 + 新建中显示选择渠道提示（不显示空态）", () => {
  const html = render(
    createElement(
      BotsDialogSidebar,
      sidebarProps({ bots: [], selectedBotId: null, creatingBot: true }),
    ),
  );
  assert.match(html, /选择渠道|selectProvider|选择一个/i);
});

test("侧栏：每行渲染显示名兜底、渠道名与选中样式", () => {
  const html = render(createElement(BotsDialogSidebar, sidebarProps()));
  assert.match(html, /未命名 Bot/, "空名回退到 fallbackBotName");
  assert.match(html, /data-channel="telegram"/);
  assert.match(html, /bg-surface-hover/, "选中行带高亮类");
});

test("侧栏：未选中的行不带高亮类", () => {
  const html = render(
    createElement(BotsDialogSidebar, sidebarProps({ selectedBotId: "other" })),
  );
  assert.doesNotMatch(html, /class="mb-1[^"]*bg-surface-hover text-foreground"/);
});

test("侧栏：多个 Bot 各占一行且渠道名分别注入", () => {
  const html = render(
    createElement(
      BotsDialogSidebar,
      sidebarProps({
        bots: [
          bot({ id: "bot-1", name: "A", provider: "telegram" }),
          bot({ id: "bot-2", name: "B", provider: "weixin" }),
        ],
      }),
    ),
  );
  assert.match(html, />A</);
  assert.match(html, />B</);
  assert.match(html, /data-channel="telegram"/);
  assert.match(html, /data-channel="weixin"/);
});

test("新建面板：渠道网格排除 webhook，且未实现的渠道置灰禁用", () => {
  const html = render(
    createElement(BotsDialogCreatePanel, {
      creatingProvider: null,
      onAddBot: () => {},
      renderChannelName,
    }),
  );
  assert.doesNotMatch(html, /data-channel="webhook"/, "webhook 不在新建渠道网格里");
  assert.match(html, /data-channel="telegram"/);
  // dingding 是 implemented:false 的占位渠道：渲染但带 disabled。
  assert.match(html, /disabled/);
});

test("新建面板：正在创建的渠道带 aria-busy 且保持可读文案", () => {
  const html = render(
    createElement(BotsDialogCreatePanel, {
      creatingProvider: "telegram",
      onAddBot: () => {},
      renderChannelName,
    }),
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /animate-spin/);
});
