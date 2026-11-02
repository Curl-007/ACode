import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamAcceptanceMetricsRow } from "../src/components/TeamAcceptanceMetricsRow.js";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { buildConversationStatusPanelTeam } from "../src/v4/teamPanelModel.js";

// 与 teamWorkflowCard.test 同款：先把词典求值完成，SSR 才能同步拿到 intl。
const localeResource = getLocaleMessagesResource("en-US");
if (localeResource.state === "pending") await localeResource.promise;

const stateKey = "agent-teams@acode-plugins-official:agent-teams";

function teamWith(metrics: unknown) {
  return buildConversationStatusPanelTeam({
    [stateKey]: {
      v: 1,
      teamId: "team-1",
      goal: "ship",
      status: "active",
      counts: { done: 1, inProgress: 0, todo: 0, inReview: 1, failed: 0, blocked: 0 },
      members: [],
      tasks: [],
      readyTaskIds: [],
      blockedByFailedQuality: [],
      ...(metrics === undefined ? {} : { metrics }),
    },
  })!;
}

function render(metrics: unknown): string {
  return renderToStaticMarkup(
    createElement(ACodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(TeamAcceptanceMetricsRow, { team: teamWith(metrics) }),
    }),
  );
}

const base = {
  generatedAt: "2026-11-02T00:00:00Z",
  tasks: { total: 1, accepted: 1, inReview: 1, open: 1, failed: 0, blocked: 0, cancelled: 0 },
};

test("metrics row is absent entirely when the snapshot has no metrics", () => {
  // 旧插件：整行不渲染，不用 0 冒充。
  assert.equal(render(undefined), "");
  assert.equal(render({ generatedAt: "x" }), "");
});

test("null ratios read as insufficient sample, never as 0", () => {
  const html = render({
    ...base,
    acceptance: {
      acceptedTasks: 0,
      firstPassTasks: 0,
      firstPassRate: null,
      totalAttempts: 0,
      avgAttemptsPerTask: null,
      rejections: 0,
    },
    latency: { sampleSize: 0, avgAcceptLatencyMs: null },
  });
  assert.match(html, /data-testid="team-acceptance-metrics"/u);
  assert.match(html, /Insufficient sample/u);
  assert.doesNotMatch(html, /Insufficient sample.*0%/u);
  // sampleSize 0 → 耗时一律不显示。
  assert.doesNotMatch(html, /Avg review latency/u);
});

test("genuine zero rate is shown as 0%, distinct from a missing sample", () => {
  const html = render({
    ...base,
    acceptance: {
      acceptedTasks: 4,
      firstPassTasks: 0,
      firstPassRate: 0,
      totalAttempts: 8,
      avgAttemptsPerTask: 2,
      rejections: 4,
    },
    latency: { sampleSize: 3, avgAcceptLatencyMs: 1500 },
  });
  assert.match(html, /First-pass rate 0%/u);
  assert.match(html, /Avg attempts 2\.0/u);
  assert.match(html, /Rejections 4/u);
  assert.match(html, /Avg review latency 1\.5s/u);
  assert.doesNotMatch(html, /Insufficient sample/u);
});

test("metrics.tasks.inReview is not displayed (counts.inReview is the single source)", () => {
  const html = render({
    tasks: { total: 9, accepted: 9, inReview: 7, open: 0, failed: 0, blocked: 0, cancelled: 0 },
    generatedAt: "x",
    acceptance: {
      acceptedTasks: 9,
      firstPassTasks: 9,
      firstPassRate: 1,
      totalAttempts: 9,
      avgAttemptsPerTask: 1,
      rejections: 0,
    },
    latency: { sampleSize: 0, avgAcceptLatencyMs: null },
  });
  assert.match(html, /First-pass rate 100%/u);
  // 度量行不重复待验收计数（counts.inReview 是唯一显示源）；因此不出现 7。
  assert.doesNotMatch(html, / 7 ?/u);
});