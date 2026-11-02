import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTeamReviewDiffLines,
  deriveTeamWakeHint,
  groupTeamReviews,
  isCaptainSessionStopped,
  projectTeamMetrics,
  projectTeamReviews,
  projectTeamWakeFacts,
  TEAM_REVIEW_DIFF_MAX_LINES,
  teamReviewUnavailableMessageId,
  teamReviewUnavailableRetryable,
  type TeamPanelReview,
} from "../src/v4/teamReviewModel.js";

/** 批次 4 UI 验收面投影（v4/teamReviewModel.ts）的纯逻辑用例。 */

function review(overrides: Partial<TeamPanelReview> = {}): TeamPanelReview {
  return { taskId: "t-1", member: "dev", status: "in_review", ...overrides };
}

test("projectTeamReviews drops malformed rows and keeps the rest", () => {
  const { reviews, truncated } = projectTeamReviews({
    reviews: [
      { taskId: "t-1", member: "dev", status: "in_review", baseCommit: "a1", headCommit: "b2" },
      { taskId: "", member: "dev", status: "in_review" },
      { taskId: "t-2", member: "", status: "merged" },
      { taskId: "t-3", member: "dev", status: "weird" },
      { taskId: "t-4", member: "dev", status: "merged", diffAvailable: false, unavailableReason: "nope" },
      { taskId: "t-5", member: "dev", status: "merged", unavailableReason: "worktree_cleaned" },
    ],
    reviewsTruncated: true,
  });
  assert.deepEqual(
    reviews.map((entry) => entry.taskId),
    ["t-1", "t-4", "t-5"],
  );
  // 闭集外的 unavailableReason 不落成半张卡（该字段缺席，而不是原样透传）。
  assert.equal(reviews[1]!.unavailableReason, undefined);
  assert.equal(reviews[1]!.diffAvailable, false);
  assert.equal(reviews[2]!.unavailableReason, "worktree_cleaned");
  assert.equal(truncated, true);
});

test("projectTeamReviews / projectTeamMetrics are additive-optional", () => {
  assert.deepEqual(projectTeamReviews({}), { reviews: [], truncated: false });
  // 缺 reviewsTruncated 时按 false，不因此判形状不符。
  assert.equal(projectTeamReviews({ reviews: [] }).truncated, false);
  assert.equal(projectTeamMetrics({}), undefined);
  assert.equal(projectTeamMetrics({ metrics: { generatedAt: "now" } }), undefined);
});

test("malformed check never renders a half badge", () => {
  const { reviews } = projectTeamReviews({
    reviews: [
      { taskId: "t-1", member: "dev", status: "merged", check: { command: "pnpm test" } },
      { taskId: "t-2", member: "dev", status: "merged", check: { command: "pnpm test", exitCode: 1, passed: false, truncated: true, ranAt: "t" } },
    ],
  });
  assert.equal(reviews[0]!.check, undefined);
  assert.deepEqual(reviews[1]!.check, {
    command: "pnpm test",
    exitCode: 1,
    passed: false,
    ranAt: "t",
    truncated: true,
  });
});

test("projectTeamMetrics keeps null ratios and rejects bad values", () => {
  const good = projectTeamMetrics({
    metrics: {
      generatedAt: "now",
      tasks: { total: 3, accepted: 1, inReview: 1, open: 1, failed: 0, blocked: 0, cancelled: 0 },
      acceptance: {
        acceptedTasks: 1,
        firstPassTasks: 0,
        firstPassRate: null,
        totalAttempts: 2,
        avgAttemptsPerTask: 2,
        rejections: 1,
      },
      latency: { sampleSize: 0, avgAcceptLatencyMs: null },
    },
  });
  assert.equal(good?.acceptance.firstPassRate, null);
  assert.equal(good?.latency.sampleSize, 0);
  assert.equal(
    projectTeamMetrics({
      metrics: {
        generatedAt: "now",
        tasks: { total: 1, accepted: 0, inReview: 0, open: 1, failed: 0, blocked: 0 },
        acceptance: {
          acceptedTasks: 0,
          firstPassTasks: 0,
          firstPassRate: null,
          totalAttempts: 0,
          avgAttemptsPerTask: null,
          rejections: 0,
        },
        latency: { sampleSize: 0, avgAcceptLatencyMs: null },
      },
    }),
    undefined,
  );
  const bad = projectTeamMetrics({
    metrics: {
      generatedAt: "now",
      tasks: { total: 1, accepted: 1, inReview: 0, open: 0, failed: 0, blocked: 0, cancelled: 0 },
      acceptance: {
        acceptedTasks: 1,
        firstPassTasks: 1,
        firstPassRate: "50%",
        totalAttempts: 1,
        avgAttemptsPerTask: 1,
        rejections: 0,
      },
      latency: { sampleSize: 1, avgAcceptLatencyMs: 10 },
    },
  });
  assert.equal(bad, undefined);
});

test("groupTeamReviews orders action-first and hides empty groups", () => {
  const groups = groupTeamReviews([
    review({ taskId: "m-1", status: "merged" }),
    review({ taskId: "r-1", status: "rejected" }),
    review({ taskId: "p-1", status: "in_review" }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.key),
    ["in_review", "merged", "rejected"],
  );
  assert.deepEqual(
    groups.find((group) => group.key === "in_review")?.reviews.map((entry) => entry.taskId),
    ["p-1"],
  );
  assert.deepEqual(
    groupTeamReviews([review({ status: "merged" })]).map((group) => group.key),
    ["merged"],
  );
});

test("unavailable reason maps to its own message id per code", () => {
  assert.equal(
    teamReviewUnavailableMessageId("pinnedMissing"),
    "teamPanel.review.diffUnavailable.pinnedMissing",
  );
  assert.equal(
    teamReviewUnavailableMessageId("ref_unresolved"),
    "teamPanel.review.diffUnavailable.refUnresolved",
  );
  assert.equal(
    teamReviewUnavailableMessageId("output_too_large"),
    "teamPanel.review.diffUnavailable.tooLarge",
  );
  for (const reason of [
    "disconnected",
    "worktree_disabled",
    "worktree_cleaned",
    "commits_unreachable",
    "not_a_repository",
    "git_unavailable",
    "timeout",
    "unknown",
  ] as const) {
    assert.equal(
      teamReviewUnavailableMessageId(reason),
      `teamPanel.review.diffUnavailable.${reason}`,
    );
  }
});

test("retry exit follows the unavailable reason table", () => {
  assert.equal(teamReviewUnavailableRetryable("ref_unresolved"), true);
  assert.equal(teamReviewUnavailableRetryable("disconnected"), true);
  assert.equal(teamReviewUnavailableRetryable("git_unavailable"), true);
  assert.equal(teamReviewUnavailableRetryable("pinnedMissing"), false);
  assert.equal(teamReviewUnavailableRetryable("worktree_disabled"), false);
});

test("diff text truncates by whole lines and appends the shared marker", () => {
  const short = ["a", "b"];
  assert.deepEqual(buildTeamReviewDiffLines(short.join("\n")), short);
  const long = Array.from({ length: TEAM_REVIEW_DIFF_MAX_LINES + 20 }, (_, i) => `line ${i}`);
  const lines = buildTeamReviewDiffLines(long.join("\n"));
  assert.equal(lines.length, TEAM_REVIEW_DIFF_MAX_LINES);
  assert.equal(lines.at(-1), `\\ __ACODE_DIFF_TRUNCATED__:${long.length - (TEAM_REVIEW_DIFF_MAX_LINES - 1)}`);
  assert.equal(lines[0], "line 0");
});

test("captain session stopped is derived from phase only", () => {
  assert.equal(isCaptainSessionStopped({ phase: "completedSuccess" }), true);
  assert.equal(isCaptainSessionStopped({ phase: "completedInterrupted" }), true);
  assert.equal(isCaptainSessionStopped({ phase: "error" }), true);
  assert.equal(isCaptainSessionStopped({ phase: "running" }), false);
  // stopState 的 "stoppable"/"stopping" 不等于已停止；未知 phase 也不冒充已停止。
  assert.equal(isCaptainSessionStopped({ phase: "prewarming" }), false);
  assert.equal(isCaptainSessionStopped({ stopState: "stoppable" }), undefined);
  assert.equal(isCaptainSessionStopped(null), undefined);
  assert.equal(isCaptainSessionStopped({}), undefined);
});

test("wakeHint derives only for a stopped captain with pending mailbox facts", () => {
  const facts = projectTeamWakeFacts({
    wakePending: {
      generation: 3,
      captainSessionId: "cap",
      messages: [
        { messageId: "m-1", from: "dev", kind: "question", deliveredAt: "t" },
        { messageId: "m-2", from: "qa", kind: "question", deliveredAt: "t" },
      ],
      settledTasks: [],
      counts: { unreadMessages: 2, unsettledMemberTasks: 0 },
      truncated: true,
    },
  });
  assert.deepEqual(facts, {
    unreadMessages: 2,
    unsettledMemberTasks: 0,
    kinds: ["question"],
    truncated: true,
  });
  // 停止 + 有留箱事实 → 显式提示（含去重的 kinds 与截断透传）。
  assert.deepEqual(deriveTeamWakeHint(facts, true), {
    kind: "captain_stopped",
    unreadMessages: 2,
    unsettledMemberTasks: 0,
    kinds: ["question"],
    sampledTruncated: true,
  });
  // 队长在跑 / 未知 → 零行为（不谎报忙碌）。
  assert.equal(deriveTeamWakeHint(facts, false), undefined);
  assert.equal(deriveTeamWakeHint(facts, undefined), undefined);
  // 停止但无留箱事实 → 零行为。
  const empty = projectTeamWakeFacts({
    wakePending: {
      generation: 1,
      captainSessionId: "cap",
      messages: [],
      settledTasks: [],
      counts: { unreadMessages: 0, unsettledMemberTasks: 0 },
    },
  });
  assert.equal(deriveTeamWakeHint(empty, true), undefined);
  // wakePending 缺席 / 形状不符 → 零行为（优雅降级）。
  assert.equal(projectTeamWakeFacts({}), null);
  assert.equal(projectTeamWakeFacts({ wakePending: { counts: { unreadMessages: 1 } } }), null);
  assert.equal(deriveTeamWakeHint(null, true), undefined);
  // 成员任务留箱事实同样触发提示（未读为 0）。
  const settled = projectTeamWakeFacts({
    wakePending: {
      generation: 2,
      captainSessionId: "cap",
      messages: [],
      settledTasks: [{ taskId: "t-1", owner: "dev", status: "done", at: "t" }],
      counts: { unreadMessages: 0, unsettledMemberTasks: 1 },
    },
  });
  assert.equal(deriveTeamWakeHint(settled, true)?.unsettledMemberTasks, 1);
});