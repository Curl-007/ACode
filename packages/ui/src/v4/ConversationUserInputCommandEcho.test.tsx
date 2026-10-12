import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationUserInputFooter } from "./ConversationUserInputCommandEcho.js";

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{node}</TooltipProvider>
    </ZCodeIntlProvider>,
  );

test("echo shows triggered command name, scope label and description", () => {
  const html = render(
    <ConversationUserInputFooter
      command={{
        name: "my_prd_speed",
        scope: "user",
        source: "zcode",
        description: "快速修复执行 PRD 文档",
      }}
    />,
  );
  assert.match(html, /data-v4-user-input-command-echo="my_prd_speed"/);
  assert.match(html, /已触发命令 \/my_prd_speed/);
  assert.match(html, /用户命令/);
  assert.match(html, /快速修复执行 PRD 文档/);
});

test("plugin source wins over scope; unknown scope is shown verbatim", () => {
  assert.match(
    render(
      <ConversationUserInputFooter command={{ name: "a", scope: "user", source: "plugin" }} />,
    ),
    /插件命令/,
  );
  assert.match(
    render(<ConversationUserInputFooter command={{ name: "b", scope: "future-scope" }} />),
    /future-scope/,
  );
});

test("no echo without command meta; status still renders", () => {
  const html = render(<ConversationUserInputFooter command={undefined} status="发送中" />);
  assert.doesNotMatch(html, /data-v4-user-input-command-echo/);
  assert.match(html, /data-v4-user-input-status="true"/);
});
