// 斜杠命令触发回显组件守护（apps/acode-cli/specs/slash-command-echo.md 验收场景 3/4）。
//
// 包内测试全部是 node:test 纯 .ts（无 DOM 套件），这里用 renderToStaticMarkup +
// createElement 直接渲染组件断言 DOM 契约：meta 缺席零渲染、status DOM 与旧实现逐字节
// 一致、plugin source 优先、未知 scope 原样显示。i18n 双语成对键也在本文件守护。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { ConversationUserInputFooter } from "../src/v4/ConversationUserInputCommandEcho.js";

const META = {
  name: "my_prd_speed",
  scope: "user",
  source: "plugin",
  description: "快速修复执行 PRD 文档",
};

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

test("echo shows triggered command name, scope label and description", () => {
  const html = render(createElement(ConversationUserInputFooter, { command: META }));
  assert.match(html, /data-v4-user-input-command-echo="my_prd_speed"/);
  assert.match(html, /已触发命令 \/my_prd_speed/);
  // source=plugin 优先于 scope 标签。
  assert.match(html, /插件命令/);
  assert.match(html, /快速修复执行 PRD 文档/);
});

test("description truncates inline and is wrapped in a tooltip trigger", () => {
  const html = render(
    createElement(ConversationUserInputFooter, {
      command: { name: "long_cmd", scope: "project", description: "很长的描述".repeat(40) },
    }),
  );
  // 描述单行截断；radix Tooltip 的 content 仅在 open 时渲染，静态标记里断言
  // 「回显行被包进 tooltip trigger」这一可静态观测的契约。
  assert.match(html, /min-w-0 truncate/);
  assert.match(html, /data-slot="tooltip-trigger"/);
  assert.match(html, /很长的描述/);
});

test("unknown scope is shown verbatim; known scopes map to labels", () => {
  assert.match(
    render(
      createElement(ConversationUserInputFooter, {
        command: { name: "a", scope: "future-scope" },
      }),
    ),
    /future-scope/,
  );
  assert.match(
    render(
      createElement(ConversationUserInputFooter, { command: { name: "b", scope: "builtin" } }),
    ),
    /内置命令/,
  );
});

test("no echo without command meta; status DOM contract unchanged", () => {
  const html = render(
    createElement(ConversationUserInputFooter, { command: undefined, status: "发送中" }),
  );
  assert.doesNotMatch(html, /data-v4-user-input-command-echo/);
  assert.match(html, /data-v4-user-input-status="true"/);
  // 与 ConversationRowView 旧内联实现逐字节一致的 status 面板契约。
  assert.match(html, /mt-1 text-right text-ui-sm text-foreground-subtlest/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /发送中/);
});

test("slash command echo i18n keys are paired across en-US and zh-CN", () => {
  const keys = [
    "chat.userInput.command.triggered",
    "chat.userInput.command.scope.user",
    "chat.userInput.command.scope.project",
    "chat.userInput.command.scope.system",
    "chat.userInput.command.scope.admin",
    "chat.userInput.command.scope.builtin",
    "chat.userInput.command.scope.plugin",
  ];
  for (const key of keys) {
    assert.ok(enUS[key]?.length > 0, `en-US missing ${key}`);
    assert.ok(zhCN[key]?.length > 0, `zh-CN missing ${key}`);
  }
  // ICU 占位成对：triggered 两侧都用 {name}。
  assert.equal(enUS["chat.userInput.command.triggered"], "Triggered /{name}");
  assert.equal(zhCN["chat.userInput.command.triggered"], "已触发命令 /{name}");
});
