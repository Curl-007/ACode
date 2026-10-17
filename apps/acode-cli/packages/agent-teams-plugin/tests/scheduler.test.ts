import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeNextActions } from "../src/scheduler.js";
import type { TeamState, TeamTask } from "../src/state/types.js";
import { nowIso } from "../src/state/types.js";

function team(overrides: Partial<TeamState> = {}): TeamState {
  return {
    teamId: "team-x",
    goal: "g",
    status: "active",
    captainSessionId: "s",
    workspaceKey: "k",
    workspaceKeyDegraded: false,
    maxMembers: 8,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    seq: 1,
    members: [],
    ...overrides,
  };
}

function task(overrides: Partial<TeamTask> & { taskId: string }): TeamTask {
  return {
    title: "t",
    objective: "o",
    acceptance: ["a1", "a2"],
    kind: "build",
    dependencies: [],
    status: "todo",
    attemptSeq: 0,
    attempts: [],
    revisions: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

describe("scheduler next_actions", () => {
  it("draft/paused produce no wake instructions", () => {
    for (const status of ["draft", "paused", "archived"] as const) {
      const actions = computeNextActions({
        team: team({ status }),
        tasks: [task({ taskId: "t-1" })],
        perspective: "captain",
      });
      assert.equal(actions.wake.length, 0);
      assert.ok(actions.notes.length > 0);
    }
  });

  it("wakes bound idle members for unassigned ready tasks (id order)", () => {
    const squad = team({
      members: [
        { name: "dev-1", role: "dev", charter: "c", status: "bound", agentId: "agent-1", addedAt: nowIso() },
        { name: "dev-2", role: "dev", charter: "c", status: "bound", agentId: "agent-2", addedAt: nowIso() },
      ],
    });
    const tasks = [task({ taskId: "t-1" }), task({ taskId: "t-2" })];
    const actions = computeNextActions({ team: squad, tasks, perspective: "captain" });
    assert.equal(actions.wake.length, 2);
    assert.equal(actions.wake[0]?.member, "dev-1");
    assert.equal(actions.wake[0]?.taskId, "t-1");
    assert.equal(actions.wake[0]?.to, "agent-1");
    assert.ok(actions.wake[0]?.message.includes("a1"));
    assert.ok(actions.wake[0]?.message.includes("agent_teams_claim_task"));
  });

  it("busy members are not woken; assigned ready tasks wake their assignee", () => {
    const squad = team({
      members: [
        { name: "dev-1", role: "dev", charter: "c", status: "bound", agentId: "agent-1", addedAt: nowIso() },
        { name: "dev-2", role: "dev", charter: "c", status: "bound", agentId: "agent-2", addedAt: nowIso() },
      ],
    });
    const tasks = [
      task({
        taskId: "t-1",
        status: "in_progress",
        activeAttemptId: "att-1",
        attempts: [{ id: "att-1", seq: 1, owner: "dev-1", startedAt: nowIso() }],
      }),
      task({ taskId: "t-2", assignee: "dev-2" }),
    ];
    const actions = computeNextActions({ team: squad, tasks, perspective: "captain" });
    assert.equal(actions.wake.length, 1);
    assert.equal(actions.wake[0]?.member, "dev-2");
    assert.equal(actions.wake[0]?.taskId, "t-2");
  });

  it("unbound members produce a spawn/bind note instead of wake", () => {
    const squad = team({
      members: [{ name: "dev-1", role: "dev", charter: "c", status: "registered", addedAt: nowIso() }],
    });
    const actions = computeNextActions({ team: squad, tasks: [task({ taskId: "t-1" })], perspective: "captain" });
    assert.equal(actions.wake.length, 0);
    assert.ok(actions.notes.some((note) => note.includes("not bound yet")));
    assert.ok(actions.notes.some((note) => note.includes("captain may claim")));
  });

  it("failed quality gate produces repair guidance, no wake for dependents", () => {
    const squad = team({
      members: [{ name: "dev-1", role: "dev", charter: "c", status: "bound", agentId: "agent-1", addedAt: nowIso() }],
    });
    const tasks = [
      task({ taskId: "t-1", kind: "review", status: "failed" }),
      task({ taskId: "t-2", dependencies: ["t-1"] }),
      task({ taskId: "t-3" }),
    ];
    const actions = computeNextActions({ team: squad, tasks, perspective: "captain" });
    // t-3 可派；t-2 不派并给修复指导。
    assert.ok(actions.wake.every((wake) => wake.taskId !== "t-2"));
    assert.ok(actions.notes.some((note) => note.includes("repair task")));
  });

  it("member perspective asks to report to captain", () => {
    const actions = computeNextActions({
      team: team(),
      tasks: [],
      perspective: "member",
      viewerMemberName: "dev-1",
    });
    assert.equal(actions.report_to_captain, true);
  });
});
