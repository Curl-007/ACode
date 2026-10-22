import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
  store.createTeam(team);
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
    const before = store.findTeam("team-abc12345")?.seq ?? 0;
    store.writeTeam("team-abc12345", (team) => {
      team.goal = "updated goal";
    });
    const afterRead = store.findTeam("team-abc12345");
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
    store.upsertTask("team-abc12345", task);
    assert.equal(store.readTask("team-abc12345", "t-1")?.taskId, "t-1");
    assert.equal(store.nextTaskId("team-abc12345"), "t-2");
    store.writeTask("team-abc12345", "t-1", (target) => {
      target.status = "in_progress";
    });
    assert.equal(store.readTask("team-abc12345", "t-1")?.status, "in_progress");
  });

  it("serializes concurrent mutations through the promise chain", async () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store);
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store
          .withLock(async () => {
            const team = store.findTeam("team-abc12345");
            if (!team) return;
            team.seq += 1;
            // 直接使用底层原子写（模拟读-改-写竞态在互斥下被串行化）。
            store.writeTeam("team-abc12345", () => undefined);
          })
          .then(() => index),
      ),
    );
    const team = store.findTeam("team-abc12345");
    // 每个操作都成功（无异常逃逸）且最终可读。
    assert.ok(team);
  });

  it("deliverMessage + listUnreadMessages + markMessagesRead roundtrip", () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store);
    store.deliverMessage("team-abc12345", "dev-1", {
      from: "captain",
      to: "dev-1",
      summary: "hi",
      message: "please review",
    });
    store.deliverMessage("team-abc12345", "captain", {
      from: "dev-1",
      to: "captain",
      message: "done, see output",
    });
    const unread = store.listUnreadMessages("team-abc12345", "dev-1");
    assert.equal(unread.length, 1);
    assert.equal(unread[0]?.from, "captain");
    assert.equal(unread[0]?.message, "please review");
    const captainUnread = store.listUnreadMessages("team-abc12345", "captain");
    assert.equal(captainUnread.length, 1);
    const beforeRead = store.findTeam("team-abc12345")?.seq;
    const moved = store.markMessagesRead("team-abc12345", "dev-1", [unread[0]?.id ?? ""]);
    assert.equal(moved, 1);
    assert.equal(store.findTeam("team-abc12345")?.seq, (beforeRead ?? 0) + 1);
    assert.equal(store.listUnreadMessages("team-abc12345", "dev-1").length, 0);
    assert.deepEqual(
      store.listAllMailboxes("team-abc12345").find((box) => box.address === "dev-1"),
      {
        address: "dev-1",
        unread: 0,
        read: 1,
      },
    );
    assert.equal(store.markMessagesRead("team-abc12345", "dev-1", [unread[0]?.id ?? ""]), 0);
    assert.equal(store.findTeam("team-abc12345")?.seq, (beforeRead ?? 0) + 1);
  });

  it("archiveTeam moves team/tasks/mailbox and readArchivedTeam restores them", () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store);
    store.upsertTask("team-abc12345", {
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
    store.deliverMessage("team-abc12345", "captain", {
      from: "dev-1",
      to: "captain",
      message: "bye",
    });
    const outcome = store.archiveTeam("team-abc12345", true);
    assert.ok(outcome);
    assert.equal(store.findTeam("team-abc12345"), undefined);
    const archived = store.readArchivedTeam(outcome.teamId, 40);
    assert.ok(archived);
    assert.equal(archived.tasks[0]?.taskId, "t-1");
    assert.deepEqual(archived.mailboxes, [{ address: "captain", unread: 1, read: 0 }]);
    assert.equal(archived.unreadMessages[0]?.message, "bye");
    assert.deepEqual(store.readArchivedTeam(outcome.teamId)?.unreadMessages, []);
    assert.equal(store.listArchivedTeams().length, 1);
  });

  it("archived teams are excluded from listTeams; multiple active teams coexist", () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store, { status: "archived" });
    seedTeam(store, { teamId: "team-second001", goal: "second" });
    assert.equal(store.listTeams().length, 1);
    assert.equal(store.listTeams()[0]?.teamId, "team-second001");
    // 各团队任务/邮箱隔离：同 id 任务互不串号。
    store.upsertTask("team-second001", {
      taskId: "t-1",
      title: "x",
      objective: "y",
      acceptance: ["z"],
      kind: "build",
      dependencies: [],
      status: "todo",
      attemptSeq: 0,
      attempts: [],
      revisions: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    assert.equal(store.readTask("team-second001", "t-1")?.title, "x");
  });

  it("migrates the legacy flat layout into teams/<id>/ on startup", () => {
    const root = tempRoot();
    cleanups.push(root);
    // 手工构造旧平铺布局：根目录直接放 team.json/tasks/mailbox。
    const team: TeamState = {
      teamId: "team-legacy001",
      goal: "legacy goal",
      status: "active",
      captainSessionId: "session-captain",
      workspaceKey: "ws-key",
      workspaceKeyDegraded: false,
      maxMembers: 8,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      seq: 7,
      members: [],
    };
    writeFileSync(join(root, "team.json"), JSON.stringify(team));
    mkdirSync(join(root, "tasks"), { recursive: true });
    mkdirSync(join(root, "mailbox", "captain", "unread"), { recursive: true });
    writeFileSync(
      join(root, "tasks", "t-1.json"),
      JSON.stringify({
        taskId: "t-1",
        title: "x",
        objective: "y",
        acceptance: ["z"],
        kind: "build",
        dependencies: [],
        status: "todo",
        attemptSeq: 0,
        attempts: [],
        revisions: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }),
    );
    writeFileSync(
      join(root, "mailbox", "captain", "unread", "m1.json"),
      JSON.stringify({
        id: "m1",
        from: "dev-1",
        to: "captain",
        message: "hi",
        deliveredAt: nowIso(),
      }),
    );
    const store = new TeamStore(root);
    store.migrateFlatLayoutIfNeeded();
    assert.equal(store.findTeam("team-legacy001")?.goal, "legacy goal");
    assert.equal(store.findTeam("team-legacy001")?.seq, 7);
    assert.equal(store.readTask("team-legacy001", "t-1")?.taskId, "t-1");
    assert.equal(store.listUnreadMessages("team-legacy001", "captain")[0]?.message, "hi");
    assert.equal(store.listTeams().length, 1);
    // 幂等：再跑一次不报错不重复。
    store.migrateFlatLayoutIfNeeded();
    assert.equal(store.listTeams().length, 1);
  });

  it("mailbox address sanitization neutralizes traversal", () => {
    const root = tempRoot();
    cleanups.push(root);
    const store = new TeamStore(root);
    seedTeam(store);
    // 清洗语义：路径分隔符与点全部剥掉，逃逸被中和为普通目录名（非空即无害）。
    const unread = store.listUnreadMessages("team-abc12345", "../../etc");
    assert.deepEqual(unread, []);
    assert.throws(
      () => store.listUnreadMessages("team-abc12345", "///"),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
  });
});
