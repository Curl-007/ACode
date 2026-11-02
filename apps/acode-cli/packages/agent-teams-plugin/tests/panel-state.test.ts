import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildTeamPanelState } from "../src/panel-state.js";
import { MAX_PANEL_REVIEWS } from "../src/panel-reviews.js";
import { countTasksByStatus } from "../src/state/task-counts.js";
import type { TaskAttempt, TeamMember, TeamState, TeamTask } from "../src/state/types.js";

/**
 * 批次 1 面板投影（R2.7/R2.9）：counts.inReview（唯一计数源 countTasksByStatus）、
 * reviews[] 坐标/可用性/截断、v 仍为 1（additive）。纯内存 + 临时目录，固定时钟。
 */

const CLOCK = "2020-01-01T00:00:00.000Z";

function attempt(id: string, owner: string, outcome?: TaskAttempt["outcome"]): TaskAttempt {
  return { id, seq: 1, owner, startedAt: CLOCK, endedAt: CLOCK, ...(outcome ? { outcome } : {}) };
}

function task(overrides: { taskId: string } & Partial<TeamTask>): TeamTask {
  return {
    title: "t",
    objective: "o",
    acceptance: [],
    kind: "build",
    dependencies: [],
    status: "todo",
    attemptSeq: 0,
    attempts: [],
    revisions: [],
    createdAt: CLOCK,
    updatedAt: CLOCK,
    ...overrides,
  };
}

function member(name: string, worktree?: TeamMember["worktree"]): TeamMember {
  return {
    name,
    role: "dev",
    charter: "c",
    status: "bound",
    addedAt: CLOCK,
    ...(worktree ? { worktree } : {}),
  };
}

function isolatedMember(name: string, overrides: Partial<NonNullable<TeamMember["worktree"]>> = {}): TeamMember {
  return member(name, {
    path: join(tmpdir(), name),
    branch: `acode/wt/${name}`,
    baseBranch: "main",
    baseCommit: "base000",
    status: "active",
    ...overrides,
  });
}

function team(members: TeamMember[], isolation = true): TeamState {
  return {
    teamId: "team-panel0001",
    goal: "g",
    status: "active",
    captainSessionId: "s",
    workspaceKey: "w",
    workspaceKeyDegraded: false,
    maxMembers: 8,
    ...(isolation
      ? {
          worktreeIsolation: {
            enabled: true as const,
            repoRoot: "/repo",
            baseBranch: "main",
            createdAt: CLOCK,
          },
        }
      : {}),
    createdAt: CLOCK,
    updatedAt: CLOCK,
    seq: 1,
    members,
  };
}

describe("panel state projection (batch 1)", () => {
  it("counts in_review additively (v stays 1) and keeps it the single count source", () => {
    const tasks = [
      task({ taskId: "t-1", status: "in_review" }),
      task({ taskId: "t-2", status: "done" }),
      task({ taskId: "t-3", status: "todo" }),
    ];
    const state = buildTeamPanelState({ team: team([]), tasks });
    assert.equal(state.v, 1);
    assert.equal(state.counts.inReview, 1);
    assert.equal(state.counts.done, 1);
    // metrics 与 counts 同源（同一 countTasksByStatus 实现）。
    assert.equal(state.metrics?.tasks.inReview, state.counts.inReview);
    assert.equal(countTasksByStatus(tasks).inReview, 1);
  });

  it("projects an in_review review with pinned coordinates, check and availability", () => {
    const members = [isolatedMember("dev-1")];
    const tasks = [
      task({
        taskId: "t-1",
        status: "in_review",
        assignee: "dev-1",
        activeAttemptId: "a1",
        attempts: [attempt("a1", "dev-1", "done")],
        lastReview: { baseCommit: "base000", headCommit: "head111", reviewedAt: CLOCK },
        lastCheck: {
          attemptId: "a1",
          command: "pnpm test",
          exitCode: 0,
          passed: true,
          ranAt: CLOCK,
        },
      }),
    ];
    const state = buildTeamPanelState({ team: team(members), tasks });
    const review = state.reviews?.find((entry) => entry.taskId === "t-1");
    assert.ok(review);
    assert.equal(review?.status, "in_review");
    assert.equal(review?.member, "dev-1");
    assert.equal(review?.baseCommit, "base000");
    assert.equal(review?.headCommit, "head111");
    assert.equal(review?.diffAvailable, true);
    assert.equal(review?.unavailableReason, undefined);
    assert.equal(review?.check?.passed, true);
    assert.equal(review?.check?.command, "pnpm test");
  });

  it("omits a check that belongs to a different (older) attempt", () => {
    const members = [isolatedMember("dev-1")];
    const tasks = [
      task({
        taskId: "t-1",
        status: "in_review",
        assignee: "dev-1",
        activeAttemptId: "a2",
        attempts: [attempt("a1", "dev-1", "done"), attempt("a2", "dev-1", "done")],
        lastReview: { baseCommit: "base000", headCommit: "head222", reviewedAt: CLOCK },
        lastCheck: { attemptId: "a1", command: "pnpm test", exitCode: 0, passed: true, ranAt: CLOCK },
      }),
    ];
    const state = buildTeamPanelState({ team: team(members), tasks });
    const review = state.reviews?.find((entry) => entry.taskId === "t-1");
    assert.equal(review?.check, undefined, "a stale check must not be attached to the new delivery");
  });

  it("flags a non-isolated in_review task as worktree_disabled (no diff to read)", () => {
    const tasks = [
      task({
        taskId: "t-1",
        status: "in_review",
        assignee: "dev-1",
        activeAttemptId: "a1",
        attempts: [attempt("a1", "dev-1", "done")],
      }),
    ];
    const state = buildTeamPanelState({ team: team([member("dev-1")], false), tasks });
    const review = state.reviews?.find((entry) => entry.taskId === "t-1");
    assert.equal(review?.status, "in_review");
    assert.equal(review?.diffAvailable, false);
    assert.equal(review?.unavailableReason, "worktree_disabled");
  });

  it("projects a merged review from the member worktree facts", () => {
    const members = [
      isolatedMember("dev-1", {
        status: "merged",
        mergedAt: "2020-01-02T00:00:00.000Z",
        lastMergedCommit: "merged999",
      }),
    ];
    const tasks = [
      task({
        taskId: "t-1",
        status: "done",
        assignee: "dev-1",
        activeAttemptId: "a1",
        attempts: [attempt("a1", "dev-1", "done")],
      }),
    ];
    const state = buildTeamPanelState({ team: team(members), tasks });
    const review = state.reviews?.find((entry) => entry.taskId === "t-1");
    assert.equal(review?.status, "merged");
    assert.equal(review?.headCommit, "merged999");
    assert.equal(review?.mergedAt, "2020-01-02T00:00:00.000Z");
    assert.equal(review?.diffAvailable, true);
  });

  it("drops reviews whole past MAX_PANEL_REVIEWS and sets reviewsTruncated", () => {
    const members = [isolatedMember("dev-1")];
    const tasks = Array.from({ length: MAX_PANEL_REVIEWS + 1 }, (_, index) =>
      task({
        taskId: `t-${index + 1}`,
        status: "in_review",
        assignee: "dev-1",
        activeAttemptId: `a${index + 1}`,
        attempts: [attempt(`a${index + 1}`, "dev-1", "done")],
      }),
    );
    const state = buildTeamPanelState({ team: team(members), tasks });
    assert.equal(state.reviews?.length, MAX_PANEL_REVIEWS);
    assert.equal(state.reviewsTruncated, true);
  });

  it("keeps the snapshot shape stable and additive when there is nothing to review", () => {
    const state = buildTeamPanelState({
      team: team([]),
      tasks: [task({ taskId: "t-1", status: "todo" })],
    });
    assert.equal(state.v, 1);
    assert.deepEqual(state.reviews, []);
    assert.equal(state.reviewsTruncated, undefined);
    assert.equal(state.counts.inReview, 0);
  });
});