import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamWorkflowCard } from "../src/components/TeamWorkflowCard.js";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { buildConversationStatusPanelTeams } from "../src/v4/teamPanelModel.js";

// SSR 的 Provider 冷启动会挂起等待词典动态 import；先把 en-US 词典求值完成，
// 后续 renderToStaticMarkup 才能同步拿到 intl（目标仓库 Provider 是懒加载，与源仓库不同）。
const localeResource = getLocaleMessagesResource("en-US");
if (localeResource.state === "pending") await localeResource.promise;

const snapshot = {
  v: 1,
  teamId: "team-one",
  goal: "First team",
  status: "active",
  seq: 1,
  counts: { done: 0, inProgress: 8, todo: 6, failed: 0, blocked: 0 },
  members: Array.from({ length: 14 }, (_, i) => ({
    name: `dev-${i}`,
    role: `Reviewer ${i}`,
    status: "bound",
  })),
  tasks: Array.from({ length: 14 }, (_, i) => ({
    taskId: `t-${i + 1}`,
    title: `Review ${i}`,
    status: i < 8 ? "in_progress" : "todo",
    kind: "review",
    assignee: `dev-${i}`,
    dependencies: [],
  })),
};

function teams() {
  return buildConversationStatusPanelTeams({
    "agent-teams@acode-plugins-official:agent-teams": {
      ...snapshot,
      teams: [snapshot, { ...snapshot, teamId: "team-two", goal: "Second team" }],
    },
  });
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(ACodeIntlProvider, { initialLocale: "en-US", children: node }),
  );
}

test("team card uses workflow timeline and bounded roster, without fake controls", () => {
  const html = render(createElement(TeamWorkflowCard, { team: teams()[0]! }));
  assert.match(html, /workflow-timeline/);
  assert.match(html, /9 more/);
  assert.equal((html.match(/data-testid="workflow-agent-pill"/g) ?? []).length, 5);
  assert.doesNotMatch(html, /data-testid="team-card-open"/);
  assert.doesNotMatch(html, /workflow-digest-cancel/);
});

test("draft team renders approval actions and inline task list", () => {
  const draft = {
    ...teams()[0]!,
    status: "draft",
  };
  const html = render(
    createElement(TeamWorkflowCard, {
      team: draft,
      onOpen: () => {},
    }),
  );
  assert.match(html, /data-testid="team-approval-actions"/);
  assert.match(html, /data-testid="team-inline-tasks"/);
  assert.match(html, /data-testid="team-inline-more"/);
});

test("ended team is collapsed by default until the user expands it", () => {
  const ended = {
    ...teams()[0]!,
    status: "archived",
  };
  const html = render(createElement(TeamWorkflowCard, { team: ended }));
  assert.match(html, /data-expanded="false"/);
  assert.doesNotMatch(html, /data-testid="team-inline-tasks"/);
});
