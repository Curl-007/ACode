import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildTeamAcceptanceMetrics } from "../src/metrics.js";
import { buildTeamPanelState } from "../src/panel-state.js";
import { TeamStore } from "../src/state/store.js";
import type {
  TaskAttempt,
  TeamMember,
  TeamState,
  TeamTask,
  TaskStatus,
} from "../src/state/types.js";

/**
 * R0 验收度量（批次 M0）：纯函数、固定时钟、内存态；钉死分母与 null 语义（无数据 → null，
 * 不是 0），并断言计算前后磁盘文件集合不变（不落第二份台账，EI-48）。
 */

const CLOCK = "2020-01-01T00:00:00.000Z";

function attempt(
  id: string,
  owner: string,
  startedAt: string,
  outcome?: TaskAttempt["outcome"],
): TaskAttempt {
  return { id, seq: 0, owner, startedAt, endedAt: CLOCK, ...(outcome ? { outcome } : {}) };
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

function member(name: string, mergedAt?: string): TeamMember {
  return {
    name,
    role: "dev",
    charter: "c",
    status: "bound",
    addedAt: CLOCK,
    ...(mergedAt
      ? {
          worktree: {
            path: join(tmpdir(), name),
            branch: `acode/wt/${name}`,
            baseBranch: "main",
            baseCommit: "base000",
            status: "merged" as const,
            mergedAt,
          },
        }
      : {}),
  };
}

function team(members: TeamMember[]): TeamState {
  return {
    teamId: "team-metrics1",
    goal: "g",
    status: "active",
    captainSessionId: "s",
    workspaceKey: "w",
    workspaceKeyDegraded: false,
    maxMembers: 8,
    createdAt: CLOCK,
    updatedAt: CLOCK,
    seq: 1,
    members,
  };
}

describe("TeamAcceptanceMetrics (R0)", () => {
  it("returns nulls (not zeros) when there is no data", () => {
    const metrics = buildTeamAcceptanceMetrics(team([]), [], CLOCK);
    assert.equal(metrics.generatedAt, CLOCK);
    assert.equal(metrics.tasks.total, 0);
    assert.equal(metrics.acceptance.acceptedTasks, 0);
    assert.equal(metrics.acceptance.firstPassRate, null);
    assert.equal(metrics.acceptance.avgAttemptsPerTask, null);
    assert.equal(metrics.acceptance.totalAttempts, 0);
    assert.equal(metrics.acceptance.rejections, 0);
    assert.equal(metrics.latency.sampleSize, 0);
    assert.equal(metrics.latency.avgAcceptLatencyMs, null);
    assert.deepEqual(metrics.byTask, []);
  });

  it("computes first-pass rate, average attempts and rejections per task", () => {
    const tasks = [
      task({ taskId: "t-1", status: "done", attempts: [attempt("a1", "dev-1", CLOCK, "done")] }),
      task({
        taskId: "t-2",
        status: "done",
        attempts: [
          attempt("a2", "dev-1", CLOCK, "failed"),
          attempt("a3", "dev-1", CLOCK, "failed"),
          attempt("a4", "dev-1", CLOCK, "done"),
        ],
        revisions: [{ at: CLOCK, by: "captain", fields: ["objective"] }],
      }),
      task({ taskId: "t-3", status: "in_progress", attempts: [attempt("a5", "dev-2", CLOCK)] }),
      task({ taskId: "t-4", status: "todo" }),
    ];
    const metrics = buildTeamAcceptanceMetrics(team([]), tasks, CLOCK);
    assert.equal(metrics.tasks.total, 4);
    assert.equal(metrics.tasks.accepted, 2);
    assert.equal(metrics.tasks.open, 2); // todo + in_progress
    assert.equal(metrics.acceptance.firstPassTasks, 1);
    assert.equal(metrics.acceptance.firstPassRate, 0.5);
    assert.equal(metrics.acceptance.totalAttempts, 5);
    assert.equal(metrics.acceptance.avgAttemptsPerTask, 5 / 3); // 3 claimed tasks
    assert.equal(metrics.acceptance.rejections, 2); // t-2 has 3 attempts → 2 rejections
    assert.equal(metrics.byTask[1]?.revisions, 1);
    assert.equal(metrics.byTask[1]?.rejections, 2);
  });

  it("counts in_review as its own bucket without touching other buckets", () => {
    const tasks = [
      // 批次 1 才会产生该状态；这里按字符串分桶验证前向兼容。
      task({ taskId: "t-1", status: "in_review" as TaskStatus }),
      task({ taskId: "t-2", status: "failed" }),
      task({ taskId: "t-3", status: "blocked" }),
      task({ taskId: "t-4", status: "cancelled" }),
    ];
    const metrics = buildTeamAcceptanceMetrics(team([]), tasks, CLOCK);
    assert.equal(metrics.tasks.inReview, 1);
    assert.equal(metrics.tasks.failed, 1);
    assert.equal(metrics.tasks.blocked, 1);
    assert.equal(metrics.tasks.cancelled, 1);
    assert.equal(metrics.tasks.accepted, 0);
    assert.equal(metrics.tasks.open, 0);
  });

  it("derives accept latency from the authoritative attempt and the member's mergedAt", () => {
    const members = [member("dev-1", "2020-01-01T00:00:10.000Z")];
    const tasks = [
      task({
        taskId: "t-1",
        status: "done",
        attempts: [
          attempt("a1", "dev-1", "2020-01-01T00:00:00.000Z", "failed"),
          attempt("a2", "dev-1", "2020-01-01T00:00:05.000Z", "done"),
        ],
      }),
      // mergedAt 早于 startedAt → null，且不计入平均
      task({
        taskId: "t-2",
        status: "done",
        attempts: [attempt("a3", "dev-1", "2020-01-01T00:00:20.000Z", "done")],
      }),
      // 无成员 worktree 记录（owner 非成员 / 未合并）→ null
      task({
        taskId: "t-3",
        status: "done",
        attempts: [attempt("a4", "ghost", CLOCK, "done")],
      }),
    ];
    const metrics = buildTeamAcceptanceMetrics(team(members), tasks, CLOCK);
    // t-1: authoritative = the done attempt (started 00:00:05) → merged 00:00:10 → 5000ms
    assert.equal(metrics.byTask[0]?.acceptLatencyMs, 5000);
    assert.equal(metrics.byTask[1]?.acceptLatencyMs, null);
    assert.equal(metrics.byTask[2]?.acceptLatencyMs, null);
    assert.equal(metrics.latency.sampleSize, 1);
    assert.equal(metrics.latency.avgAcceptLatencyMs, 5000);
  });

  it("projects additively into the panel state without bumping v", () => {
    const state = buildTeamPanelState({
      team: team([]),
      tasks: [task({ taskId: "t-1", status: "in_progress", attempts: [attempt("a1", "dev-1", CLOCK)] })],
    });
    assert.equal(state.v, 1);
    assert.ok(state.metrics, "metrics must be present on the panel projection");
    assert.equal(state.metrics?.tasks.total, 1);
    assert.equal(state.metrics?.acceptance.acceptedTasks, 0);
  });
});

describe("TeamAcceptanceMetrics read-only discipline (EI-48)", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-teams-metrics-"));
  });

  after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  async function listTree(dir: string, prefix = ""): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...(await listTree(join(dir, entry.name), relative)));
      else out.push(relative);
    }
    return out.sort();
  }

  it("computes metrics without writing any file (no second ledger)", async () => {
    const store = new TeamStore(root);
    const source = team([member("dev-1", CLOCK)]);
    store.createTeam(source);
    store.upsertTask(
      source.teamId,
      task({ taskId: "t-1", status: "done", attempts: [attempt("a1", "dev-1", CLOCK, "done")] }),
    );
    const before = await listTree(root);
    const teamJsonPath = join(root, "teams", source.teamId, "team.json");
    const teamJsonBefore = await readFile(teamJsonPath, "utf8");

    buildTeamAcceptanceMetrics(
      store.findTeam(source.teamId)!,
      store.readTasks(source.teamId),
      CLOCK,
    );

    assert.deepEqual(await listTree(root), before);
    assert.equal(await readFile(teamJsonPath, "utf8"), teamJsonBefore);
  });
});