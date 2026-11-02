import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversationStatusPanelEndedTeams,
  buildConversationStatusPanelTeam,
  buildConversationStatusPanelTeams,
  isTeamEnded,
} from "../src/v4/teamPanelModel.js";

const stateKey = "agent-teams@acode-plugins-official:agent-teams";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    teamId: "team-1",
    goal: "ship",
    status: "active",
    counts: { done: 1, inProgress: 1, todo: 1, failed: 0, blocked: 0 },
    members: [{ name: "dev", role: "Developer", status: "bound" }],
    tasks: [
      { taskId: "t-1", title: "start", status: "done", kind: "build", dependencies: [] },
      { taskId: "t-2", title: "next", status: "todo", kind: "review", dependencies: ["t-1"] },
    ],
    ...overrides,
  };
}

test("rejects snapshots that do not match the v1 TeamPanelState shape", () => {
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: snapshot({ v: 2 }) }), null);
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: snapshot({ teamId: "" }) }), null);
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: snapshot({ goal: 42 }) }), null);
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: snapshot({ counts: null }) }), null);
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: "bad" }), null);
  assert.equal(buildConversationStatusPanelTeam(null), null);
  assert.deepEqual(buildConversationStatusPanelTeams({ "other@market:agent-teams": {} }), []);
});

test("additive derivation fields default instead of rejecting the card", () => {
  const team = buildConversationStatusPanelTeam({ [stateKey]: snapshot() })!;
  assert.deepEqual(team.readyTaskIds, []);
  assert.equal(team.hasTaskDerivations, false);
  assert.equal(team.criticalPathDepth, 0);
  assert.deepEqual(team.blockedByFailedQuality, []);
  assert.deepEqual(team.mailboxes, []);
  assert.deepEqual(team.unreadMessages, []);
  assert.equal(team.maxMembers, 0);
  assert.equal(team.totalCount, 3);
});

test("in_review counts additively (old snapshots default to 0) and the team stays unfinished", () => {
  const team = buildConversationStatusPanelTeam({
    [stateKey]: snapshot({
      counts: { done: 1, inProgress: 0, todo: 0, inReview: 2, failed: 0, blocked: 0 },
      tasks: [
        { taskId: "t-1", title: "a", status: "done", kind: "build", dependencies: [] },
        { taskId: "t-2", title: "b", status: "in_review", kind: "build", dependencies: [] },
      ],
    }),
  })!;
  assert.equal(team.counts.inReview, 2);
  assert.equal(team.totalCount, 3);
  // 待验收仍需处理 → 不算「已结束」（不落进只读桶）。
  assert.equal(isTeamEnded(team), false);
  // 旧插件快照缺席 counts.inReview → 0，不因此判形状不符。
  const legacy = buildConversationStatusPanelTeam({ [stateKey]: snapshot() })!;
  assert.equal(legacy.counts.inReview, 0);
});

test("member roleRef projects verbatim when present; absent/bad/empty leave no key (role-packs R5.1)", () => {
  const team = buildConversationStatusPanelTeam({
    [stateKey]: snapshot({
      members: [
        { name: "dev", role: "Developer", status: "bound", roleRef: "agent-teams:member" },
        { name: "rev", role: "Reviewer", status: "registered" },
        { name: "bad", role: "Auditor", status: "bound", roleRef: 42 },
        { name: "empty", role: "Auditor", status: "bound", roleRef: "" },
      ],
    }),
  })!;
  // 逐字透传：不做映射/归一化（不透明 AgentProfile 引用）。
  assert.equal(team.members[0]!.roleRef, "agent-teams:member");
  // 缺席（缺省/旧插件）与坏值/空串一律无键——不参与形状判定，也不渲染空徽标。
  assert.equal("roleRef" in team.members[1]!, false);
  assert.equal("roleRef" in team.members[2]!, false);
  assert.equal("roleRef" in team.members[3]!, false);
  // 坏 roleRef 只丢字段不丢成员条目（白名单口径）。
  assert.equal(team.members.length, 4);
});

test("multi-team snapshots keep order and filter by captain session", () => {
  const teams = buildConversationStatusPanelTeams({
    [stateKey]: snapshot({
      teams: [
        snapshot({ teamId: "team-a", captainSessionId: "session-a" }),
        snapshot({ teamId: "team-b", captainSessionId: "session-b" }),
        snapshot({ teamId: "team-c" }),
      ],
    }),
  });
  assert.deepEqual(
    teams.map((team) => team.teamId),
    ["team-a", "team-b", "team-c"],
  );
  assert.deepEqual(
    buildConversationStatusPanelTeams({ [stateKey]: snapshot({ teams: [] }) }, "session-a").map(
      (team) => team.teamId,
    ),
    ["team-1"],
  );
  assert.deepEqual(
    buildConversationStatusPanelTeams(
      { [stateKey]: snapshot({ teams: [snapshot({ teamId: "team-a", captainSessionId: "x" })] }) },
      "session-a",
    ),
    [],
  );
});

test("ended teams come from recentEnded and keep endedAt", () => {
  const ended = buildConversationStatusPanelEndedTeams({
    [stateKey]: snapshot({
      recentEnded: [
        { ...snapshot({ teamId: "team-old", status: "archived" }), endedAt: "2026-01-01" },
        { teamId: "bad" },
      ],
    }),
  });
  assert.deepEqual(
    ended.map((team) => [team.teamId, team.endedAt]),
    [["team-old", "2026-01-01"]],
  );
});

test("ended predicate: archived, or all tasks done/cancelled; failures keep a team open", () => {
  assert.equal(isTeamEnded({ status: "archived", tasks: [] }), true);
  assert.equal(isTeamEnded({ status: "active", tasks: [] }), false);
  assert.equal(
    isTeamEnded({
      status: "active",
      tasks: [{ status: "done" }, { status: "cancelled" }],
    }),
    true,
  );
  assert.equal(
    isTeamEnded({ status: "active", tasks: [{ status: "done" }, { status: "failed" }] }),
    false,
  );
});

test("reviews[] narrows additively: bad rows dropped, absence keeps the card renderable", () => {
  const withReviews = buildConversationStatusPanelTeam({
    [stateKey]: snapshot({
      reviews: [
        { taskId: "t-9", member: "dev", status: "in_review", baseCommit: "a1", headCommit: "b2" },
        { taskId: "", member: "dev", status: "in_review" },
        { taskId: "t-10", member: "dev", status: "weird" },
        {
          taskId: "t-11",
          member: "dev",
          status: "merged",
          check: { command: "pnpm test", exitCode: 0, passed: true, ranAt: "now" },
        },
      ],
      reviewsTruncated: true,
    }),
  })!;
  assert.deepEqual(
    withReviews.reviews.map((review) => review.taskId),
    ["t-9", "t-11"],
  );
  assert.equal(withReviews.reviewsTruncated, true);
  assert.equal(withReviews.reviews[1]!.check?.passed, true);
});

test("reviews / metrics / wakeHint are absent by default (old plugin regression)", () => {
  const legacy = buildConversationStatusPanelTeam({ [stateKey]: snapshot() })!;
  assert.deepEqual(legacy.reviews, []);
  assert.equal(legacy.reviewsTruncated, false);
  assert.equal(legacy.metrics, undefined);
  assert.equal(legacy.wakeHint, undefined);
});

test("metrics passes through the same single projection the card uses", () => {
  const team = buildConversationStatusPanelTeam({
    [stateKey]: snapshot({
      metrics: {
        generatedAt: "now",
        tasks: { total: 3, accepted: 2, inReview: 1, open: 0, failed: 0, blocked: 0, cancelled: 0 },
        acceptance: {
          acceptedTasks: 2,
          firstPassTasks: 2,
          firstPassRate: 1,
          totalAttempts: 2,
          avgAttemptsPerTask: 1,
          rejections: 0,
        },
        latency: { sampleSize: 0, avgAcceptLatencyMs: null },
      },
    }),
  })!;
  assert.equal(team.metrics?.acceptance.firstPassRate, 1);
  assert.equal(team.metrics?.latency.sampleSize, 0);
});

test("wakeHint matrix: only a stopped captain with pending mailbox facts shows a hint", () => {
  const wakePending = {
    generation: 2,
    captainSessionId: "session-a",
    messages: [{ messageId: "m-1", from: "dev", kind: "report", deliveredAt: "t" }],
    settledTasks: [],
    counts: { unreadMessages: 1, unsettledMemberTasks: 0 },
  };
  const build = (wakeInput?: { sessionControl?: { phase?: string } }) =>
    buildConversationStatusPanelTeam(
      { [stateKey]: snapshot({ wakePending }) },
      wakeInput,
    )!;
  // 停止 + 有留箱事实 → 提示。
  assert.equal(build({ sessionControl: { phase: "completedSuccess" } }).wakeHint?.kind, "captain_stopped");
  // 在跑 → 不谎报忙碌（零行为）。
  assert.equal(build({ sessionControl: { phase: "running" } }).wakeHint, undefined);
  // 缺 sessionControl / wakePending 缺席 → 零行为。
  assert.equal(build().wakeHint, undefined);
  assert.equal(
    buildConversationStatusPanelTeam({ [stateKey]: snapshot() }, { sessionControl: { phase: "error" } })!
      .wakeHint,
    undefined,
  );
});
