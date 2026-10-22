import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { TeamStore } from "../src/state/store.js";
import { createToolContext, type ToolContext } from "../src/tools/registry.js";
import { teamTools } from "../src/tools/team.js";
import { memberTools } from "../src/tools/members.js";
import { taskTools } from "../src/tools/tasks.js";
import { messageTools } from "../src/tools/messages.js";
import { worktreeTools } from "../src/tools/worktree.js";
import { waitForWorkTool } from "../src/tools/member-wait.js";
import { subagentSessionIdForAgent } from "../src/identity.js";
import {
  DEFAULT_MAX_REASSIGN_ROUNDS,
  TEAM_ERROR_CODES,
  nowIso,
  normalizeMaxReassignRounds,
  reassignCountOf,
} from "../src/state/types.js";
import { randomUUID } from "node:crypto";

const ALL_TOOLS = [
  ...teamTools,
  ...memberTools,
  ...taskTools,
  ...messageTools,
  ...worktreeTools,
  waitForWorkTool,
];
const tool = (name: string) => {
  const found = ALL_TOOLS.find((item) => item.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
};

function makeContext(params: {
  store: TeamStore;
  role: "captain" | "member";
  memberName?: string;
  maxActiveTeams?: number;
}): ToolContext {
  const sessionId =
    params.role === "captain"
      ? "session-captain"
      : subagentSessionIdForAgent(agentIdFor(params.memberName ?? ""));
  return createToolContext({
    store: params.store,
    identity: {
      sessionId,
      runtimeScope: params.role === "captain" ? "main" : "subagent",
      workspaceKey: "ws-key",
      degraded: false,
    },
    memberNameHint: params.memberName,
    workspaceKey: "ws-key",
    workingDirectory: process.cwd(),
    maxMembers: 8,
    maxReassignRounds: DEFAULT_MAX_REASSIGN_ROUNDS,
    maxActiveTeams: params.maxActiveTeams ?? 4,
    panelUrl: "http://127.0.0.1:0/",
  });
}

describe("tool identity matrix and happy path", () => {
  let root: string;
  let store: TeamStore;
  const captain = () => makeContext({ store, role: "captain" });
  const member = (name: string) => makeContext({ store, role: "member", memberName: name });
  // 只走真实 bind_member：成员身份必须由宿主注入的 child session id 推导，不能手改 team.json。
  const bindMember = (name: string) =>
    tool("agent_teams_bind_member").handler({ name, agentId: agentIdFor(name) }, captain());

  before(() => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-tools-"));
    store = new TeamStore(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("create → draft team with protocol", async () => {
    const result = await tool("agent_teams_create").handler(
      { goal: "ship the feature" },
      captain(),
    );
    assert.equal((result as { ok: boolean }).ok, true);
    assert.equal((result as { status: string }).status, "draft");
  });

  it("second create succeeds; exceeding maxActiveTeams is refused with team_limit_exceeded", async () => {
    // 0.2：同一工作区允许多个活跃团队（上限 maxActiveTeams，默认 4）。
    const second = (await tool("agent_teams_create").handler({ goal: "another" }, captain())) as {
      ok: boolean;
      teamId: string;
    };
    assert.equal(second.ok, true);
    const third = (await tool("agent_teams_create").handler({ goal: "third" }, captain())) as {
      ok: boolean;
      teamId: string;
    };
    assert.equal(third.ok, true);
    const fourth = (await tool("agent_teams_create").handler({ goal: "fourth" }, captain())) as {
      ok: boolean;
      teamId: string;
    };
    assert.equal(fourth.ok, true);
    // 满 4 个后再建 → team_limit_exceeded（语义等价旧 team_exists 的「坑位被占」）。
    await assert.rejects(
      tool("agent_teams_create").handler({ goal: "fifth" }, captain()),
      (error: unknown) => (error as { code?: string }).code === "team_limit_exceeded",
    );
    // 清场：显式按 teamId 归档新建的三个，留首个团队给后续用例。
    for (const teamId of [second.teamId, third.teamId, fourth.teamId]) {
      await tool("agent_teams_delete").handler({ teamId, archive: false }, captain());
    }
  });

  it("members cannot call captain-only tools", async () => {
    // 先绑定一个成员（bind 后 member scope 的调用可走 requireMember）。
    await tool("agent_teams_add_member").handler(
      { name: "dev-1", role: "dev", charter: "implements" },
      captain(),
    );
    await bindMember("dev-1");
    await assert.rejects(
      tool("agent_teams_create_task").handler(
        { title: "x", objective: "y", acceptance: ["a"] },
        member("dev-1"),
      ),
      (error: unknown) => (error as { code?: string }).code === "forbidden_for_caller",
    );
  });

  it("full happy path: draft → roster → DAG → approve → claim → update → message → delete", async () => {
    // 新团队（前一个用例的团队还在，先归档）。
    await tool("agent_teams_delete").handler({ archive: false }, captain());

    const createdTeam = (await tool("agent_teams_create").handler(
      { goal: "goal-2" },
      captain(),
    )) as { teamId: string };
    const added = (await tool("agent_teams_add_member").handler(
      { name: "dev-1", role: "dev", charter: "implements" },
      captain(),
    )) as { spawn_instruction: { prompt: string } };
    assert.ok(added.spawn_instruction.prompt.includes("dev-1"));
    await bindMember("dev-1");

    const created = (await tool("agent_teams_create_task").handler(
      {
        title: "implement",
        objective: "write the module",
        acceptance: ["module exists", "tests pass"],
      },
      captain(),
    )) as { taskId: string };
    assert.equal(created.taskId, "t-1");

    const second = (await tool("agent_teams_create_task").handler(
      {
        title: "review",
        objective: "review the module",
        acceptance: ["reviewed"],
        kind: "review",
        dependencies: [created.taskId],
      },
      captain(),
    )) as { taskId: string };
    assert.equal(second.taskId, "t-2");

    // draft 状态依赖未完成时下游不可认领由 approve 后的 ready 集保证。
    const approved = (await tool("agent_teams_approve_plan").handler(
      { confirmation: "user said go" },
      captain(),
    )) as { status: string; next_actions: { wake: Array<{ taskId: string }> } };
    assert.equal(approved.status, "active");
    assert.equal(approved.next_actions.wake[0]?.taskId, "t-1");

    const claim = (await tool("agent_teams_claim_task").handler(
      { taskId: "t-1" },
      member("dev-1"),
    )) as { attempt_id: string };
    assert.ok(claim.attempt_id.length > 0);

    // done 需要 verify。
    await assert.rejects(
      tool("agent_teams_update_task").handler(
        { attemptId: claim.attempt_id, taskId: "t-1", status: "done", summary: "ok" },
        member("dev-1"),
      ),
      (error: unknown) => (error as { code?: string }).code === "verify_required",
    );

    const updated = (await tool("agent_teams_update_task").handler(
      {
        taskId: "t-1",
        attemptId: claim.attempt_id,
        status: "done",
        summary: "implemented",
        verify: "node --test tests/… 2 pass",
      },
      member("dev-1"),
    )) as { status: string };
    assert.equal(updated.status, "done");

    const sent = (await tool("agent_teams_send_message").handler(
      { to: "captain", message: "task done", summary: "t-1 done" },
      member("dev-1"),
    )) as { from: string; message_id: string };
    assert.equal(sent.from, "dev-1");
    assert.equal(store.listUnreadMessages(createdTeam.teamId, "captain").length, 1);

    // 队长 status 读走 captain 邮箱，且 t-2 就绪。
    const status = (await tool("agent_teams_status").handler({}, captain())) as {
      perspective: string;
      ready_tasks: string[];
      unread: { captain: unknown[] };
    };
    assert.equal(status.perspective, "captain");
    assert.deepEqual(status.ready_tasks, ["t-2"]);
    assert.equal(store.listUnreadMessages(createdTeam.teamId, "captain").length, 0);

    const deleted = (await tool("agent_teams_delete").handler({ archive: true }, captain())) as {
      archived: boolean;
    };
    assert.equal(deleted.archived, true);
    assert.equal(store.findTeam(createdTeam.teamId), undefined);
  });

  it("concurrent member claims of one task admit exactly one attempt", async () => {
    await tool("agent_teams_create").handler({ goal: "parallel claim" }, captain());
    for (const name of ["dev-1", "dev-2"]) {
      await tool("agent_teams_add_member").handler({ name, role: "dev", charter: "c" }, captain());
      await bindMember(name);
    }
    await tool("agent_teams_create_task").handler(
      { title: "shared", objective: "implement", acceptance: ["verified"] },
      captain(),
    );
    await tool("agent_teams_approve_plan").handler({ confirmation: "approved" }, captain());
    const calls = await Promise.allSettled(
      ["dev-1", "dev-2"].map((name) =>
        tool("agent_teams_claim_task").handler({ taskId: "t-1" }, member(name)),
      ),
    );
    assert.equal(calls.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(store.readTask(soleTeamId(store), "t-1")?.attempts.length, 1);
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("stale attempt is rejected", async () => {
    await tool("agent_teams_create").handler({ goal: "goal-3" }, captain());
    await tool("agent_teams_add_member").handler(
      { name: "dev-1", role: "dev", charter: "c" },
      captain(),
    );
    await bindMember("dev-1");
    await tool("agent_teams_create_task").handler(
      { title: "x", objective: "y", acceptance: ["a"] },
      captain(),
    );
    await tool("agent_teams_approve_plan").handler({ confirmation: "go" }, captain());
    const claim = (await tool("agent_teams_claim_task").handler(
      { taskId: "t-1" },
      member("dev-1"),
    )) as { attempt_id: string };
    await tool("agent_teams_reassign_task").handler(
      { taskId: "t-1", assignee: "dev-1", reason: "retry" },
      captain(),
    );
    await assert.rejects(
      tool("agent_teams_update_task").handler(
        {
          attemptId: claim.attempt_id,
          taskId: "t-1",
          status: "done",
          summary: "late",
          verify: "x",
        },
        member("dev-1"),
      ),
      (error: unknown) => (error as { code?: string }).code === "stale_attempt",
    );
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("message from is derived; spoofed from param is rejected by strict schema", async () => {
    await tool("agent_teams_create").handler({ goal: "goal-4" }, captain());
    await tool("agent_teams_add_member").handler(
      { name: "dev-1", role: "dev", charter: "c" },
      captain(),
    );
    // from 不可作为参数传递（strict schema 拒绝），from 只由身份推导。
    await assert.rejects(
      tool("agent_teams_send_message").handler(
        { to: "dev-1", message: "hello", from: "someone-else" },
        captain(),
      ),
      (error: unknown) => error instanceof Error && error.name === "ZodError",
    );
    const sent = (await tool("agent_teams_send_message").handler(
      { to: "dev-1", message: "hello" },
      captain(),
    )) as { from: string };
    assert.equal(sent.from, "captain");
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("unknown subagent caller is rejected (not bound)", async () => {
    await tool("agent_teams_create").handler({ goal: "goal-5" }, captain());
    await tool("agent_teams_add_member").handler(
      { name: "dev-1", role: "dev", charter: "c" },
      captain(),
    );
    // session 不匹配的 subagent 调用：requireMember 拒绝。
    const strangerContext = createToolContext({
      store,
      identity: {
        sessionId: "session-stranger",
        runtimeScope: "subagent",
        workspaceKey: "ws-key",
        degraded: false,
      },
      workspaceKey: "ws-key",
      workingDirectory: process.cwd(),
      maxMembers: 8,
      maxActiveTeams: 4,
      panelUrl: undefined,
    });
    await assert.rejects(
      tool("agent_teams_claim_task").handler({ taskId: "t-999" }, strangerContext),
      (error: unknown) => (error as { code?: string }).code === "caller_not_member",
    );
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("bound member resolves via real bind path; members never cross-match", async () => {
    await tool("agent_teams_create").handler({ goal: "goal-6" }, captain());
    for (const name of ["dev-1", "dev-2", "dev-3"]) {
      await tool("agent_teams_add_member").handler({ name, role: "dev", charter: "c" }, captain());
    }
    // 只注册未 bind：从未绑定过任何团队的成员调用必须被拒为 caller_not_member。
    await assert.rejects(
      tool("agent_teams_send_message").handler({ to: "captain", message: "hi" }, member("dev-3")),
      (error: unknown) => (error as { code?: string }).code === "caller_not_member",
    );
    // dev-1 的会话在先前用例里已绑定到已归档团队：按 SPEC-012 R18 报 team_archived
    // （成员据此立即收工），而不是把它当成新团队里的未绑定成员。
    await assert.rejects(
      tool("agent_teams_send_message").handler({ to: "captain", message: "hi" }, member("dev-1")),
      (error: unknown) => (error as { code?: string }).code === "team_archived",
    );
    await bindMember("dev-1");
    await bindMember("dev-2");

    const status = (await tool("agent_teams_status").handler({}, member("dev-2"))) as {
      perspective: string;
      member: string;
    };
    assert.equal(status.perspective, "member");
    assert.equal(status.member, "dev-2");

    const sent = (await tool("agent_teams_send_message").handler(
      { to: "captain", message: "hi" },
      member("dev-1"),
    )) as { from: string };
    assert.equal(sent.from, "dev-1");
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });
});

function agentIdFor(name: string): string {
  return `agent_${name}`;
}

/** 取当前唯一活跃团队的 teamId（这些用例每次只留一个活跃团队）。 */
function soleTeamId(store: TeamStore): string {
  const teams = store.listTeams();
  assert.equal(teams.length, 1, "expected exactly one active team in test store");
  return teams[0]!.teamId;
}

/**
 * 最大重派轮次（PRD 原则 5）：上限只约束 reassign，不约束 send_message——
 * 锁死追加指令这条通道会把队长逼回「回 todo 重派」，正好丢掉上下文。
 */
describe("reassign limit (max reassign rounds)", () => {
  let root: string;
  let store: TeamStore;
  const captain = () => makeContext({ store, role: "captain" });
  const member = (name: string) => makeContext({ store, role: "member", memberName: name });
  const bindMember = (name: string) =>
    tool("agent_teams_bind_member").handler({ name, agentId: agentIdFor(name) }, captain());

  before(() => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-reassign-"));
    store = new TeamStore(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 建一个新团队 + 一个任务，并把它认领 claimTimes 次（每次认领前 reassign 释放）。 */
  async function seedTask(goal: string, claimTimes: number): Promise<void> {
    await tool("agent_teams_create").handler({ goal }, captain());
    for (const name of ["dev-1", "dev-2"]) {
      await tool("agent_teams_add_member").handler({ name, role: "dev", charter: "c" }, captain());
      await bindMember(name);
    }
    await tool("agent_teams_create_task").handler(
      { title: "x", objective: "y", acceptance: ["a"] },
      captain(),
    );
    await tool("agent_teams_approve_plan").handler({ confirmation: "go" }, captain());
    for (let index = 0; index < claimTimes; index += 1) {
      await tool("agent_teams_claim_task").handler({ taskId: "t-1" }, member("dev-1"));
      if (index < claimTimes - 1) {
        // 直接把 attempt 补结束再回 todo，只为了造出「已认领 N 次」的落盘事实。
        store.writeTask(soleTeamId(store), "t-1", (target) => {
          target.status = "todo";
          target.attempts.forEach((attempt) => {
            if (!attempt.endedAt) attempt.endedAt = nowIso();
          });
          target.activeAttemptId = undefined;
        });
      }
    }
  }

  it("reassign succeeds at attempts.length = 1 (reassignCount 0)", async () => {
    await seedTask("reassign-ok-1", 1);
    const result = (await tool("agent_teams_reassign_task").handler(
      { taskId: "t-1", assignee: "dev-2", reason: "hand over" },
      captain(),
    )) as { ok: boolean; assignee: string };
    assert.equal(result.ok, true);
    assert.equal(result.assignee, "dev-2");
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("reassign succeeds at attempts.length = 2 (reassignCount 1)", async () => {
    await seedTask("reassign-ok-2", 2);
    assert.equal(store.readTask(soleTeamId(store), "t-1")?.attempts.length, 2);
    const result = (await tool("agent_teams_reassign_task").handler(
      { taskId: "t-1", assignee: "dev-2", reason: "hand over" },
      captain(),
    )) as { ok: boolean };
    assert.equal(result.ok, true);
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("reassign at attempts.length = 4 throws reassign_limit_exceeded with data", async () => {
    await seedTask("reassign-limit", 4);
    assert.equal(reassignCountOf(store.readTask(soleTeamId(store), "t-1")!), 3);
    await assert.rejects(
      tool("agent_teams_reassign_task").handler(
        { taskId: "t-1", assignee: "dev-2", reason: "again" },
        captain(),
      ),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string; data?: Record<string, unknown> };
        assert.equal(typed.code, "reassign_limit_exceeded");
        assert.match(typed.message ?? "", /reaching the limit of 3/);
        assert.equal(typed.data?.reassignCount, 3);
        assert.equal(typed.data?.maxReassignRounds, 3);
        assert.equal(typed.data?.taskId, "t-1");
        assert.equal((typed.data?.attempts as unknown[] | undefined)?.length, 4);
        return true;
      },
    );
    // 幂等：超限后重试同一个调用仍是同一个错误，且不产生副作用（attempts 不增长）。
    await assert.rejects(
      tool("agent_teams_reassign_task").handler(
        { taskId: "t-1", assignee: "dev-2", reason: "again" },
        captain(),
      ),
      (error: unknown) => (error as { code?: string }).code === "reassign_limit_exceeded",
    );
    assert.equal(store.readTask(soleTeamId(store), "t-1")?.attempts.length, 4);
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("send_message is not limited: the rejection channel stays open past the cap", async () => {
    await seedTask("reassign-limit-message", 4);
    await assert.rejects(
      tool("agent_teams_reassign_task").handler(
        { taskId: "t-1", assignee: "dev-2", reason: "again" },
        captain(),
      ),
      (error: unknown) => (error as { code?: string }).code === "reassign_limit_exceeded",
    );
    const sent = (await tool("agent_teams_send_message").handler(
      { to: "dev-1", message: "上次产出不合格：缺少 MARKER_XYZ。请补上，不要动别的文件。" },
      captain(),
    )) as { ok: boolean; from: string };
    assert.equal(sent.ok, true);
    assert.equal(sent.from, "captain");
    assert.equal(store.listUnreadMessages(soleTeamId(store), "dev-1").length, 1);
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("done/cancelled tasks still report invalid_input, not the limit", async () => {
    await seedTask("reassign-terminal", 1);
    store.writeTask(soleTeamId(store), "t-1", (target) => {
      target.status = "done";
    });
    await assert.rejects(
      tool("agent_teams_reassign_task").handler(
        { taskId: "t-1", assignee: "dev-2", reason: "late" },
        captain(),
      ),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("unknown assignee still reports member_not_found, not the limit", async () => {
    await seedTask("reassign-unknown-member", 4);
    await assert.rejects(
      tool("agent_teams_reassign_task").handler(
        { taskId: "t-1", assignee: "nobody", reason: "x" },
        captain(),
      ),
      (error: unknown) => (error as { code?: string }).code === "member_not_found",
    );
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });

  it("context.maxReassignRounds is honoured (configurable per team)", async () => {
    await seedTask("reassign-configurable", 4);
    const strict = createToolContext({
      store,
      identity: {
        sessionId: "session-captain",
        runtimeScope: "main",
        workspaceKey: "ws-key",
        degraded: false,
      },
      workspaceKey: "ws-key",
      workingDirectory: process.cwd(),
      maxMembers: 8,
      maxReassignRounds: 10,
      maxActiveTeams: 4,
      panelUrl: undefined,
    });
    const relaxed = (await tool("agent_teams_reassign_task").handler(
      { taskId: "t-1", assignee: "dev-2", reason: "within relaxed cap" },
      strict,
    )) as { ok: boolean };
    assert.equal(relaxed.ok, true);
    await tool("agent_teams_delete").handler({ archive: false }, captain());
  });
});

describe("max reassign rounds normalization", () => {
  it("clamps out-of-range values to 1..10", () => {
    assert.equal(normalizeMaxReassignRounds(0), 1);
    assert.equal(normalizeMaxReassignRounds(-5), 1);
    assert.equal(normalizeMaxReassignRounds(11), 10);
    assert.equal(normalizeMaxReassignRounds(100), 10);
    assert.equal(normalizeMaxReassignRounds(3), 3);
    assert.equal(normalizeMaxReassignRounds(1), 1);
    assert.equal(normalizeMaxReassignRounds(10), 10);
  });

  it("falls back to the default for missing or unparsable values (old plugin config)", () => {
    assert.equal(normalizeMaxReassignRounds(undefined), DEFAULT_MAX_REASSIGN_ROUNDS);
    assert.equal(normalizeMaxReassignRounds(null), DEFAULT_MAX_REASSIGN_ROUNDS);
    assert.equal(normalizeMaxReassignRounds(""), DEFAULT_MAX_REASSIGN_ROUNDS);
    assert.equal(normalizeMaxReassignRounds("not-a-number"), DEFAULT_MAX_REASSIGN_ROUNDS);
    assert.equal(normalizeMaxReassignRounds("4"), 4);
  });

  it("TEAM_ERROR_CODES includes the new code", () => {
    assert.ok((TEAM_ERROR_CODES as readonly string[]).includes("reassign_limit_exceeded"));
  });

  it("reassignCountOf counts attempts minus the first claim", () => {
    assert.equal(reassignCountOf({ attempts: [] }), 0);
    assert.equal(reassignCountOf({ attempts: [{}, {}] as never }), 1);
    assert.equal(reassignCountOf({ attempts: [{}, {}, {}, {}] as never }), 3);
  });
});

void randomUUID;

describe("tool registry (0.4.0 surface)", () => {
  it("exposes exactly the 17 agent_teams_* tools, no duplicates and no extra", () => {
    const names = ALL_TOOLS.map((item) => item.name).sort();
    assert.deepEqual(names, [
      "agent_teams_add_member",
      "agent_teams_adopt_team",
      "agent_teams_amend_task",
      "agent_teams_approve_plan",
      "agent_teams_bind_member",
      "agent_teams_claim_task",
      "agent_teams_create",
      "agent_teams_create_task",
      "agent_teams_delete",
      "agent_teams_merge_member_worktree",
      "agent_teams_reassign_task",
      "agent_teams_remove_member",
      "agent_teams_resume",
      "agent_teams_send_message",
      "agent_teams_status",
      "agent_teams_update_task",
      "agent_teams_wait_for_work",
    ]);
    assert.equal(new Set(names).size, names.length, "tool names must be unique");
  });

  it("keeps the captain-only / member-allowed permission matrix", () => {
    const memberAllowed = ALL_TOOLS.filter((item) => item.memberAllowed)
      .map((item) => item.name)
      .sort();
    assert.deepEqual(memberAllowed, [
      "agent_teams_claim_task",
      "agent_teams_send_message",
      "agent_teams_status",
      "agent_teams_update_task",
      "agent_teams_wait_for_work",
    ]);
  });
});
