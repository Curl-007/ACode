import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamSidePaneMembers } from "../src/app-shell/TeamSidePanePeople.js";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { buildConversationStatusPanelTeam } from "../src/v4/teamPanelModel.js";

// SSR 的 Provider 冷启动会挂起等待词典动态 import；先把 en-US 词典求值完成，
// renderToStaticMarkup 才能同步拿到 intl（与 teamWorkflowCard.test.ts 同款手法）。
const localeResource = getLocaleMessagesResource("en-US");
if (localeResource.state === "pending") await localeResource.promise;

const stateKey = "agent-teams@acode-plugins-official:agent-teams";

function teamWith(members: unknown[]) {
  return buildConversationStatusPanelTeam({
    [stateKey]: {
      v: 1,
      teamId: "team-1",
      goal: "ship",
      status: "active",
      counts: { done: 0, inProgress: 0, todo: 0, failed: 0, blocked: 0 },
      members,
      tasks: [],
    },
  })!;
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(ACodeIntlProvider, { initialLocale: "en-US", children: node }),
  );
}

test("member row renders the roleRef badge verbatim, only for members that carry it", () => {
  const html = render(
    createElement(TeamSidePaneMembers, {
      team: teamWith([
        { name: "dev", role: "Developer", status: "bound", roleRef: "agent-teams:member" },
        { name: "rev", role: "Reviewer", status: "registered" },
      ]),
    }),
  );
  // 恰一处徽标：有 roleRef 的成员渲染，缺席的成员不渲染（不以 role 文本冒充）。
  assert.equal((html.match(/data-testid="team-member-role-ref"/g) ?? []).length, 1);
  // 逐字显示不透明引用，title 走 i18n 文案给全文（en-US 词典）。
  assert.match(html, />agent-teams:member</);
  assert.match(html, /title="Role pack: agent-teams:member"/);
});

test("legacy snapshots without roleRef render no badge at all", () => {
  const html = render(
    createElement(TeamSidePaneMembers, {
      team: teamWith([{ name: "dev", role: "Developer", status: "bound" }]),
    }),
  );
  assert.doesNotMatch(html, /team-member-role-ref/);
  // 成员行本身照常渲染（徽标缺席不影响既有行）。
  assert.match(html, />dev</);
});
