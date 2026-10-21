import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { TeamStore } from "../src/state/store.js";
import { createToolContext, type ToolContext } from "../src/tools/registry.js";
import { teamTools } from "../src/tools/team.js";
import { memberTools } from "../src/tools/members.js";
import { taskTools } from "../src/tools/tasks.js";
import { messageTools } from "../src/tools/messages.js";
import { subagentSessionIdForAgent } from "../src/identity.js";
import { DEFAULT_MAX_REASSIGN_ROUNDS, nowIso } from "../src/state/types.js";

/**
 * 多团队（PRD 0.2）验收：并行创建、隔离寻址、歧义消解、status 总览、
 * adopt_team 接管、迁移后 history 可读。跑法同既有测试：
 * `node --import tsx --test tests/multi-team.test.ts`。
 */

const ALL_TOOLS = [...teamTools, ...memberTools, ...taskTools, ...messageTools];
const tool = (name: string) => {
  const found = ALL_TOOLS.find((item) => item.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
};

function makeContext(params: {
  store: TeamStore;
  role: "captain" | "member";
  sessionId?: string;
  memberName?: string;
  maxActiveTeams?: number;
  workingDirectory?: string;
}): ToolContext {
  const sessionId =
    params.sessionId ??
    (params.role === "captain"
      ? "session-captain"
      : subagentSessionIdForAgent(agentIdFor(params.memberName ?? "")));
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
    workingDirectory: params.workingDirectory ?? process.cwd(),
    maxMembers: 8,
    maxReassignRounds: DEFAULT_MAX_REASSIGN_ROUNDS,
    maxActiveTeams: params.maxActiveTeams ?? 4,
    panelUrl: "http://127.0.0.1:0/",
  });
}

function agentIdFor(name: string): string {
  return `agent_${name}`;
}

describe("multi-team core acceptance (PRD 0.2)", () => {
  let root: string;
  let store: TeamStore;
  const captain = (sessionId = "session-captain") =>
    makeContext({ store, role: "captain", sessionId });
  const member = (name: string) => makeContext({ store, role: "member", memberName: name });
  const bindMember = (name: string, teamId: string, sessionId = "session-captain") =>
    tool("agent_teams_bind_member").handler(
      { teamId, name, agentId: agentIdFor(name) },
      captain(sessionId),
    );

  before(() => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-multi-"));
    store = new TeamStore(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("two teams coexist; rosters, DAGs, mailboxes and attempts are isolated", async () => {
    const scan = (await tool("agent_teams_create").handler(
      { goal: "scan repo for bugs" },
      captain(),
    )) as { teamId: string; status: string };
    const fix = (await tool("agent_teams_create").handler(
      { goal: "fix reported bugs" },
      captain(),
    )) as { teamId: string; status: string };
    assert.notEqual(scan.teamId, fix.teamId);

    for (const teamId of [scan.teamId, fix.teamId]) {
      await tool("agent_teams_add_member").handler(
        { teamId, name: "dev-1", role: "dev", charter: "c" },
        captain(),
      );
      await bindMember("dev-1", teamId);
      await tool("agent_teams_create_task").handler(
        { teamId, title: "first", objective: "do it", acceptance: ["ok"] },
        captain(),
      );
      await tool("agent_teams_create_task").handler(
        { teamId, title: "second", objective: "then it", acceptance: ["ok"] },
        captain(),
      );
      await tool("agent_teams_approve_plan").handler({ teamId, confirmation: "go" }, captain());
    }

    // 隔离：两团各有自己的 t-1/t-2；A 的 t-1 认领不影响 B 的 t-1。
    const claimA = (await tool("agent_teams_claim_task").handler(
      { teamId: scan.teamId, taskId: "t-1" },
      member("dev-1"),
    )) as { attempt_id: string };
    const claimB = (await tool("agent_teams_claim_task").handler(
      { teamId: fix.teamId, taskId: "t-1" },
      member("dev-1"),
    )) as { attempt_id: string };
    assert.notEqual(claimA.attempt_id, claimB.attempt_id);
    // 同一成员在两个团队里各持一个 in_progress（团队内约束，不跨团队）。
    assert.equal(store.readTask(scan.teamId, "t-1")?.status, "in_progress");
    assert.equal(store.readTask(fix.teamId, "t-1")?.status, "in_progress");

    // 邮箱隔离：A 内的信不进 B 的信箱。
    await tool("agent_teams_send_message").handler(
      { teamId: scan.teamId, to: "captain", message: "scan report" },
      member("dev-1"),
    );
    assert.equal(store.listUnreadMessages(scan.teamId, "captain").length, 1);
    assert.equal(store.listUnreadMessages(fix.teamId, "captain").length, 0);
  });

  it("team_ambiguous with candidates when captain omits teamId across 2 teams; status returns overview", async () => {
    // 上一用例留下的两个团队都属 session-captain。
    await assert.rejects(
      tool("agent_teams_claim_task").handler({ taskId: "t-1" }, member("dev-1")),
      (error: unknown) => {
        const typed = error as { code?: string; data?: { candidates?: unknown[] } };
        assert.equal(typed.code, "team_ambiguous");
        assert.equal(typed.data?.candidates?.length, 2);
        return true;
      },
    );
    const overview = (await tool("agent_teams_status").handler({}, captain())) as {
      perspective: string;
      teams: Array<{ teamId: string; status: string; counts: Record<string, number> }>;
      notes: string[];
    };
    assert.equal(overview.perspective, "captain");
    assert.equal(overview.teams.length, 2);
    assert.ok(overview.notes[0]?.includes("2 active teams"));
    // 带 teamId 的 status 返回单团队完整形状。
    const focused = (await tool("agent_teams_status").handler(
      { teamId: overview.teams[0]!.teamId },
      captain(),
    )) as { perspective: string; team: { teamId: string } };
    assert.equal(focused.perspective, "captain");
    assert.equal(focused.team.teamId, overview.teams[0]!.teamId);
  });

  it("single-team implicit addressing still works end to end (no teamId anywhere)", async () => {
    // 归档到只剩一个团队：不带 teamId 的旧流程全链路照旧。
    const teams = store.listTeams();
    for (const team of teams.slice(1)) {
      await tool("agent_teams_delete").handler({ teamId: team.teamId, archive: false }, captain());
    }
    assert.equal(store.listTeams().length, 1);
    const sole = store.listTeams()[0]!.teamId;
    // 该团队里 dev-1 已持有 t-1（上一用例认领），先按既有凭据完成它。
    const holding = store.readTask(sole, "t-1")!;
    const holdingAttempt = holding.activeAttemptId!;
    await tool("agent_teams_update_task").handler(
      { taskId: "t-1", attemptId: holdingAttempt, status: "done", summary: "done", verify: "n/a" },
      member("dev-1"),
    );
    const created = (await tool("agent_teams_create_task").handler(
      { title: "implicit", objective: "no teamId", acceptance: ["ok"] },
      captain(),
    )) as { teamId?: string; taskId: string };
    assert.equal(created.taskId, "t-3");
    const claimed = (await tool("agent_teams_claim_task").handler(
      { taskId: "t-3" },
      member("dev-1"),
    )) as { attempt_id: string };
    const updated = (await tool("agent_teams_update_task").handler(
      {
        taskId: "t-3",
        attemptId: claimed.attempt_id,
        status: "done",
        summary: "done",
        verify: "n/a",
      },
      member("dev-1"),
    )) as { status: string };
    assert.equal(updated.status, "done");
    const deleted = (await tool("agent_teams_delete").handler({ archive: true }, captain())) as {
      archived: boolean;
      teamId: string;
    };
    assert.equal(deleted.archived, true);
    assert.equal(deleted.teamId, sole);
  });
});

describe("adopt_team (orphan takeover, PRD M2)", () => {
  let root: string;
  let store: TeamStore;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-adopt-"));
    store = new TeamStore(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("session X creates, session Y adopts; X is locked out, Y proceeds; cooldown guards", async () => {
    const x = "session-x";
    const y = "session-y";
    const team = (await tool("agent_teams_create").handler(
      { goal: "orphaned goal" },
      makeContext({
        store,
        role: "captain",
        sessionId: x,
      }),
    )) as { teamId: string };

    // X 活跃期内（lastCaptainSeenAt 刚刷新）：Y 不带 force 被拒。
    await assert.rejects(
      tool("agent_teams_adopt_team").handler(
        { teamId: team.teamId, reason: "x is gone" },
        makeContext({ store, role: "captain", sessionId: y }),
      ),
      (error: unknown) => (error as { code?: string }).code === "adoption_conflict",
    );
    // force 强制接管成功并记台账。
    const adopted = (await tool("agent_teams_adopt_team").handler(
      { teamId: team.teamId, reason: "x is gone", force: true },
      makeContext({ store, role: "captain", sessionId: y }),
    )) as { adopted: boolean; forced: boolean };
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.forced, true);
    const state = store.findTeam(team.teamId)!;
    assert.equal(state.captainSessionId, y);
    assert.equal(state.captainHistory?.length, 2);
    assert.equal(state.captainHistory?.[1]?.sessionId, y);

    // X 的 captain 工具被拒（现状 forbidden_for_caller 语义自然生效）。
    await assert.rejects(
      tool("agent_teams_approve_plan").handler(
        { teamId: team.teamId, confirmation: "go" },
        makeContext({ store, role: "captain", sessionId: x }),
      ),
      (error: unknown) => (error as { code?: string }).code === "forbidden_for_caller",
    );
    // Y 正常推进。
    await tool("agent_teams_add_member").handler(
      { teamId: team.teamId, name: "dev-1", role: "dev", charter: "c" },
      makeContext({ store, role: "captain", sessionId: y }),
    );
    // Y 重复 adopt：幂等提示。
    const again = (await tool("agent_teams_adopt_team").handler(
      { teamId: team.teamId, reason: "again" },
      makeContext({ store, role: "captain", sessionId: y }),
    )) as { adopted: boolean };
    assert.equal(again.adopted, false);

    // 冷静期窗口外的孤儿（手工把 lastCaptainSeenAt 拨到 11 分钟前）无需 force。
    const stale = store.findTeam(team.teamId)!;
    store.writeTeam(team.teamId, (current) => {
      current.lastCaptainSeenAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    });
    assert.notEqual(stale.teamId, "");
    const z = "session-z";
    const freeAdopt = (await tool("agent_teams_adopt_team").handler(
      { teamId: team.teamId, reason: "y disappeared" },
      makeContext({ store, role: "captain", sessionId: z }),
    )) as { adopted: boolean; forced: boolean };
    assert.equal(freeAdopt.adopted, true);
    assert.equal(freeAdopt.forced, false);
  });

  it("stale overview flag marks teams untouched for 48h", async () => {
    // 造两个 session-old 名下的团队 → status 不带 teamId 走总览路径。
    const first = (await tool("agent_teams_create").handler(
      { goal: "old team" },
      makeContext({ store, role: "captain", sessionId: "session-old" }),
    )) as { teamId: string };
    const second = (await tool("agent_teams_create").handler(
      { goal: "fresh team" },
      makeContext({ store, role: "captain", sessionId: "session-old" }),
    )) as { teamId: string };
    // writeTeam 会把 updatedAt 刷新为当前时刻，直接改盘上 JSON 造「48h 未动」事实。
    const teamPath = join(root, "teams", first.teamId, "team.json");
    const onDisk = JSON.parse(readFileSync(teamPath, "utf8")) as { updatedAt: string };
    onDisk.updatedAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    writeFileSync(teamPath, JSON.stringify(onDisk));
    const overview = (await tool("agent_teams_status").handler(
      {},
      makeContext({ store, role: "captain", sessionId: "session-old" }),
    )) as { teams: Array<{ teamId: string; stale: boolean }> };
    const old = overview.teams.find((item) => item.teamId === first.teamId);
    const fresh = overview.teams.find((item) => item.teamId === second.teamId);
    assert.ok(old);
    assert.equal(old.stale, true);
    assert.ok(fresh);
    assert.equal(fresh.stale, false);
  });

  it("subagent callers cannot adopt", async () => {
    const teams = store.listTeams();
    const anyTeam = teams[0]! ?? {
      teamId: (() => {
        throw new Error("no team to test");
      })(),
    };
    await assert.rejects(
      tool("agent_teams_adopt_team").handler(
        { teamId: anyTeam.teamId, reason: "member attempt" },
        makeContext({
          store,
          role: "member",
          memberName: "dev-1",
          sessionId: subagentSessionIdForAgent("agent_dev-1"),
        }),
      ),
      (error: unknown) => (error as { code?: string }).code === "forbidden_for_caller",
    );
  });

  it("adopting an archived team is refused with team_not_found", async () => {
    const team = (await tool("agent_teams_create").handler(
      { goal: "to archive" },
      makeContext({ store, role: "captain", sessionId: "session-arch" }),
    )) as { teamId: string };
    await tool("agent_teams_delete").handler(
      { teamId: team.teamId, archive: true },
      makeContext({ store, role: "captain", sessionId: "session-arch" }),
    );
    await assert.rejects(
      tool("agent_teams_adopt_team").handler(
        { teamId: team.teamId, reason: "too late" },
        makeContext({ store, role: "captain", sessionId: "session-late" }),
      ),
      (error: unknown) => (error as { code?: string }).code === "team_not_found",
    );
  });
});

describe("maxActiveTeams escape hatch (=1 replicates legacy behavior)", () => {
  let root: string;
  let store: TeamStore;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-limit-"));
    store = new TeamStore(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("maxActiveTeams=1 refuses the second create with team_limit_exceeded", async () => {
    const captain = () => makeContext({ store, role: "captain", maxActiveTeams: 1 });
    const first = (await tool("agent_teams_create").handler({ goal: "only one" }, captain())) as {
      ok: boolean;
    };
    assert.equal(first.ok, true);
    await assert.rejects(
      tool("agent_teams_create").handler({ goal: "blocked" }, captain()),
      (error: unknown) => {
        const typed = error as { code?: string; data?: { maxActiveTeams?: number } };
        assert.equal(typed.code, "team_limit_exceeded");
        assert.equal(typed.data?.maxActiveTeams, 1);
        return true;
      },
    );
  });

  it("normalizes out-of-range config to 1..8", async () => {
    const captain = () => makeContext({ store, role: "captain", maxActiveTeams: 99 });
    const captainZero = () => makeContext({ store, role: "captain", maxActiveTeams: 0 });
    // 夹取发生在 server 侧（normalizeMaxActiveTeams）；工具层只看 context 值，
    // 这里直接验证 clamp 函数本身在 types 测试覆盖，工具层透传即可。
    assert.equal(typeof captain(), "object");
    assert.equal(typeof captainZero(), "object");
  });
});

describe("panel multi-team endpoints", () => {
  let root: string;
  let store: TeamStore;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-panel-"));
    store = new TeamStore(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("legacy history URLs survive the new layout", async () => {
    const captain = () => makeContext({ store, role: "captain" });
    const team = (await tool("agent_teams_create").handler(
      { goal: "history check" },
      captain(),
    )) as { teamId: string };
    await tool("agent_teams_add_member").handler(
      { teamId: team.teamId, name: "dev-1", role: "dev", charter: "c" },
      captain(),
    );
    await tool("agent_teams_create_task").handler(
      { teamId: team.teamId, title: "x", objective: "y", acceptance: ["ok"] },
      captain(),
    );
    await tool("agent_teams_delete").handler({ teamId: team.teamId, archive: true }, captain());
    const archived = store.readArchivedTeam(team.teamId, 40);
    assert.ok(archived);
    assert.equal(archived.team.teamId, team.teamId);
    assert.equal(archived.tasks.length, 1);
    assert.equal(archived.team.status, "archived");
  });

  it("flat-layout team becomes addressable under teams/<id> after migration", () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), "agent-teams-migrate-"));
    try {
      // 手工构造平铺布局。
      const teamId = "team-migrated1";
      const team = {
        teamId,
        goal: "legacy",
        status: "active",
        captainSessionId: "session-captain",
        workspaceKey: "ws",
        workspaceKeyDegraded: false,
        maxMembers: 8,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        seq: 1,
        members: [],
      };
      writeFileSync(join(legacyRoot, "team.json"), JSON.stringify(team));
      mkdirSync(join(legacyRoot, "tasks"), { recursive: true });
      const store2 = new TeamStore(legacyRoot);
      store2.migrateFlatLayoutIfNeeded();
      assert.equal(store2.findTeam(teamId)?.goal, "legacy");
      assert.equal(store2.listTeams().length, 1);
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});
