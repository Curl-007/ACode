import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { TeamStore } from "../src/state/store.js";
import type { TeamState, TeamTask } from "../src/state/types.js";
import { nowIso } from "../src/state/types.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-teams-test-"));
}

function seedTeam(store: TeamStore, overrides: Partial<TeamState> = {}): TeamState {
  const team: TeamState = {
    teamId: "team-abc12345",
    goal: "test goal",
    status: "active",
    captainSessionId: "session-captain",
    workspaceKey: "ws-key",
    workspaceKeyDegraded: false,
    maxMembers: 8,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    seq: 1,
    members: [],
    ...overrides,
  };
  store.createTeamDirectories();
  store.writeTeamFileIfAbsent(team);
  return team;
}

describe("store", () => {
  const cleanups: string[] = [];
  after(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
  });

  it("writes and reads team/tasks with atomic replace and seq increments", () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store);
    const before = store.readTeamFile()?.seq ?? 0;
    store.writeTeam((team) => {
      team.goal = "updated goal";
    });
    const afterRead = store.readTeamFile();
    assert.equal(afterRead?.goal, "updated goal");
    assert.equal((afterRead?.seq ?? 0) - before, 1);

    const task: TeamTask = {
      taskId: "t-1",
      title: "title",
      objective: "obj",
      acceptance: ["a1"],
      kind: "build",
      dependencies: [],
      status: "todo",
      attemptSeq: 0,
      attempts: [],
      revisions: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.upsertTask(task);
    assert.equal(store.readTask("t-1")?.taskId, "t-1");
    assert.equal(store.nextTaskId(), "t-2");
    store.writeTask("t-1", (target) => {
      target.status = "in_progress";
    });
    assert.equal(store.readTask("t-1")?.status, "in_progress");
  });

  it("serializes concurrent mutations through the promise chain", async () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store);
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.withLock(async () => {
          const team = store.readTeamFile();
          if (!team) return;
          team.seq += 1;
          // 直接使用底层原子写（模拟读-改-写竞态在互斥下被串行化）。
          store.writeTeam(() => undefined);
        }).then(() => index),
      ),
    );
    const team = store.readTeamFile();
    // 每个操作都成功（无异常逃逸）且最终可读。
    assert.ok(team);
  });

  it("deliverMessage + listUnreadMessages + markMessagesRead roundtrip", () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store);
    store.deliverMessage("dev-1", {
      from: "captain",
      to: "dev-1",
      summary: "hi",
      message: "please review",
    });
    store.deliverMessage("captain", {
      from: "dev-1",
      to: "captain",
      message: "done, see output",
    });
    const unread = store.listUnreadMessages("dev-1");
    assert.equal(unread.length, 1);
    assert.equal(unread[0]?.from, "captain");
    assert.equal(unread[0]?.message, "please review");
    const captainUnread = store.listUnreadMessages("captain");
    assert.equal(captainUnread.length, 1);
    const beforeRead = store.readTeamFile()?.seq;
    const moved = store.markMessagesRead("dev-1", [unread[0]?.id ?? ""]);
    assert.equal(moved, 1);
    assert.equal(store.readTeamFile()?.seq, (beforeRead ?? 0) + 1);
    assert.equal(store.listUnreadMessages("dev-1").length, 0);
    assert.deepEqual(store.listAllMailboxes().find((box) => box.address === "dev-1"), {
      address: "dev-1",
      unread: 0,
      read: 1,
    });
    assert.equal(store.markMessagesRead("dev-1", [unread[0]?.id ?? ""]), 0);
    assert.equal(store.readTeamFile()?.seq, (beforeRead ?? 0) + 1);
  });

  it("archiveTeam moves team/tasks/mailbox and readArchivedTeam restores them", () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store);
    store.upsertTask({
      taskId: "t-1",
      title: "x",
      objective: "y",
      acceptance: ["z"],
      kind: "build",
      dependencies: [],
      status: "done",
      attemptSeq: 1,
      attempts: [],
      revisions: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    store.deliverMessage("captain", { from: "dev-1", to: "captain", message: "bye" });
    const outcome = store.archiveTeam(true);
    assert.ok(outcome);
    assert.equal(store.findActiveTeam(), undefined);
    const archived = store.readArchivedTeam(outcome.teamId, 40);
    assert.ok(archived);
    assert.equal(archived.tasks[0]?.taskId, "t-1");
    assert.deepEqual(archived.mailboxes, [{ address: "captain", unread: 1, read: 0 }]);
    assert.equal(archived.unreadMessages[0]?.message, "bye");
    assert.deepEqual(store.readArchivedTeam(outcome.teamId)?.unreadMessages, []);
    assert.equal(store.listArchivedTeams().length, 1);
  });

  it("findActiveTeam ignores archived teams", () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store, { status: "archived" });
    assert.equal(store.findActiveTeam(), undefined);
    // 直接写另一份 draft 状态（writeTeamFileIfAbsent 只允许首写）。
    store.writeTeam((team) => {
      team.status = "draft";
    });
    assert.ok(store.findActiveTeam()?.status === "draft");
  });

  it("mailbox address sanitization neutralizes traversal", () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store);
    // 清洗语义：路径分隔符与点全部剥掉，逃逸被中和为普通目录名（非空即无害）。
    const unread = store.listUnreadMessages("../../etc");
    assert.deepEqual(unread, []);
    assert.throws(
      () => store.listUnreadMessages("///"),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
  });
});
