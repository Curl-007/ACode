import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { TeamStore } from "../src/state/store.js";
import { createToolContext, type ToolContext } from "../src/tools/registry.js";
import { teamTools } from "../src/tools/team.js";
import { memberTools } from "../src/tools/members.js";
import { buildTeamPanelState } from "../src/panel-state.js";
import { ROLE_REF_PATTERN } from "../src/state/types.js";
import { subagentSessionIdForAgent } from "../src/identity.js";

/**
 * 批次 5 角色能力包（`roleRef`）验收（specs/agent-teams-role-packs.md 场景 1-11）。
 *
 * 纪律：不新增工具（工具面穷举由 tests/tools.test.ts 的 registry describe 钉死，
 * 本文件只做行为级断言，避免把同一份 21 名单复制成第二真源——EI-2）；负向用例断言
 * 「不该写入就一定没写」（EI-120）。
 */

const TOOLS = [...teamTools, ...memberTools];
const tool = (name: string) => {
  const found = TOOLS.find((item) => item.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
};

const DEFAULT_MEMBER_TYPE = "agent-teams:member";
const agentIdFor = (name: string): string => `agent_${name}`;

function makeContext(params: {
  store: TeamStore;
  role: "captain" | "member";
  memberName?: string;
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
    maxReassignRounds: 3,
    maxActiveTeams: 4,
    panelUrl: "http://127.0.0.1:0/",
  });
}

interface AddResult {
  ok: boolean;
  teamId: string;
  member: string;
  roleRef?: string;
  profile_source?: string;
  notes?: string[];
  spawn_instruction?: {
    tool: string;
    subagent_type: string;
    prompt: string;
    run_in_background: boolean;
    followup: string;
  };
}

describe("role packs: roleRef on add_member (batch 5)", () => {
  let root: string;
  let store: TeamStore;
  let teamId: string;
  const captain = () => makeContext({ store, role: "captain" });
  const memberCtx = (name: string) => makeContext({ store, role: "member", memberName: name });
  const add = async (input: Record<string, unknown>): Promise<AddResult> =>
    (await tool("agent_teams_add_member").handler(input, captain())) as AddResult;
  const rosterSize = (): number => store.findTeam(teamId)?.members.length ?? -1;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-role-packs-"));
    store = new TeamStore(root);
    const created = (await tool("agent_teams_create").handler(
      { goal: "role packs" },
      captain(),
    )) as { teamId: string };
    teamId = created.teamId;
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // 场景 4：缺省回退现状（逐字节一致）。
  it("default: no roleRef, spawns the plugin member profile and stores no field", async () => {
    const result = await add({
      teamId,
      name: "def-dev",
      role: "dev",
      charter: "implements",
    });
    assert.equal(result.ok, true);
    assert.equal(result.spawn_instruction?.subagent_type, DEFAULT_MEMBER_TYPE);
    assert.ok(result.spawn_instruction?.prompt.includes("def-dev"));
    // 断言 prompt 未夹带角色能力包说明（缺省时文案不变）。
    assert.ok(!/角色能力包 spawn/.test(result.spawn_instruction?.prompt ?? ""));
    assert.equal("roleRef" in result, false);
    const stored = store.findTeam(teamId)?.members.find((item) => item.name === "def-dev");
    assert.ok(stored);
    assert.equal("roleRef" in (stored as object), false, "absent roleRef must not be written");
  });

  // 场景 1：显式指向插件自带成员 profile。
  it("explicit roleRef=agent-teams:member is passed through and persisted", async () => {
    const result = await add({
      teamId,
      name: "self-dev",
      role: "dev",
      charter: "c",
      roleRef: "agent-teams:member",
    });
    assert.equal(result.spawn_instruction?.subagent_type, "agent-teams:member");
    assert.equal(result.roleRef, "agent-teams:member");
    assert.equal(result.profile_source, "host");
    const stored = store.findTeam(teamId)?.members.find((item) => item.name === "self-dev");
    assert.equal(stored?.roleRef, "agent-teams:member");
  });

  // 场景 2 + 6：宿主侧 profile 逐字透传；不存在的引用也不回退（无「换默认值」分支）。
  it("custom roleRef is verbatim and never silently falls back (unresolvable refs too)", async () => {
    const result = await add({
      teamId,
      name: "auditor",
      role: "independent audit",
      charter: "c",
      roleRef: "my-reviewer",
    });
    assert.equal(result.spawn_instruction?.subagent_type, "my-reviewer");
    // 宿主解析责任如实登记：notes 明示不静默回退 + profile 必须自带团队 MCP（EI-9/EI-17）。
    assert.ok(
      result.notes?.some(
        (note) => note.includes("resolved by the host") && note.includes("agent-teams:team"),
      ),
    );
    assert.ok(result.spawn_instruction?.prompt.includes("my-reviewer"));
    assert.ok(/角色能力包 spawn/.test(result.spawn_instruction?.prompt ?? ""));

    // 任意输入逐字相等 → 不存在「解析不到就改用默认成员类型」的分支。
    const refs = ["definitely-not-a-profile:zzz", "user-made-role", "plugin-x:role.v2"];
    for (const [index, ref] of refs.entries()) {
      const outcome = await add({
        teamId,
        name: `pass-through-${index}`,
        role: "r",
        charter: "c",
        roleRef: ref,
      });
      assert.equal(outcome.spawn_instruction?.subagent_type, ref);
      assert.notEqual(outcome.spawn_instruction?.subagent_type, DEFAULT_MEMBER_TYPE);
    }
  });

  // 场景 3：稳定 id 允许命名空间/分隔符，逐字透传（EI-144）。
  it("stable-id separators (colon/dot/dash/underscore) survive verbatim", async () => {
    const ref = "team_x:auditor.v2-beta";
    assert.ok(ROLE_REF_PATTERN.test(ref));
    const result = await add({ teamId, name: "sep-role", role: "r", charter: "c", roleRef: ref });
    assert.equal(result.spawn_instruction?.subagent_type, ref);
    assert.equal(
      store.findTeam(teamId)?.members.find((item) => item.name === "sep-role")?.roleRef,
      ref,
    );
  });

  it("trims surrounding whitespace instead of rejecting padding", async () => {
    const result = await add({
      teamId,
      name: "trim-role",
      role: "r",
      charter: "c",
      roleRef: "  user-made-role\t",
    });
    assert.equal(result.spawn_instruction?.subagent_type, "user-made-role");
  });

  // 场景 5：形状非法 → 拒绝且名册未变（负向断言「不该写入就一定没写」）。
  it("malformed roleRef is rejected before any write; roster unchanged", async () => {
    const before = rosterSize();
    const badRefs: unknown[] = [
      "",
      "   ",
      "a b",
      "a\nb",
      "a\u0000b",
      "-lead",
      "a$b",
      "x".repeat(65),
      123,
    ];
    for (const [index, roleRef] of badRefs.entries()) {
      await assert.rejects(
        add({ teamId, name: `bad-ref-${index}`, role: "r", charter: "c", roleRef }),
        // 直调 handler 时 zod 抛 ZodError；经 server 的 errorResult 映射为 invalid_input（公开错误码）。
        (error: unknown) => error instanceof Error && error.name === "ZodError",
        `roleRef=${JSON.stringify(roleRef)} must be rejected`,
      );
    }
    assert.equal(rosterSize(), before, "rejected add_member must not change the roster");
  });

  // 场景 10（行为面）：权限矩阵不变；成员仍不能调 add_member。
  it("add_member stays captain-only; members get forbidden_for_caller", async () => {
    assert.equal(tool("agent_teams_add_member").memberAllowed, false);
    await assert.rejects(
      tool("agent_teams_add_member").handler(
        { teamId, name: "sneaky", role: "r", charter: "c", roleRef: "x" },
        memberCtx("def-dev"),
      ),
      (error: unknown) => (error as { code?: string }).code === "forbidden_for_caller",
    );
  });

  // 场景 11：remove → 同名重加后新条目带新引用，旧（removed）条目保留自己的引用。
  it("re-adding a removed member keeps each entry's own roleRef", async () => {
    await tool("agent_teams_remove_member").handler(
      { teamId, name: "auditor", reason: "switching role" },
      captain(),
    );
    const result = await add({
      teamId,
      name: "auditor",
      role: "audit v2",
      charter: "c",
      roleRef: "agent-teams:member",
    });
    assert.equal(result.roleRef, "agent-teams:member");
    const members = store.findTeam(teamId)?.members.filter((item) => item.name === "auditor") ?? [];
    assert.equal(members.length, 2);
    const removed = members.find((item) => item.status === "removed");
    assert.equal(removed?.roleRef, "my-reviewer", "the removed entry keeps its own reference");
    const active = members.find((item) => item.status !== "removed");
    assert.equal(active?.roleRef, "agent-teams:member");
  });

  // 场景 8 + 9：投影 additive（面板 members[].roleRef，缺省键缺席）；status 原样可见。
  it("panel projection carries roleRef additively; status exposes it on raw members", async () => {
    const team = store.findTeam(teamId);
    assert.ok(team);
    const panel = buildTeamPanelState({ team, tasks: store.readTasks(teamId) });
    assert.equal(panel.v, 1);
    const byName = new Map(panel.members.map((item) => [item.name, item]));
    assert.equal(byName.get("self-dev")?.roleRef, "agent-teams:member");
    assert.equal("roleRef" in (byName.get("def-dev") as object), false, "absent must stay absent");
    assert.equal(byName.get("trim-role")?.roleRef, "user-made-role");

    const status = (await tool("agent_teams_status").handler({ teamId }, captain())) as {
      team: { members: Array<{ name: string; roleRef?: string }> };
    };
    assert.equal(
      status.team.members.find((item) => item.name === "self-dev")?.roleRef,
      "agent-teams:member",
    );
    assert.equal(
      "roleRef" in (status.team.members.find((item) => item.name === "def-dev") as object),
      false,
    );
  });
});

describe("role packs: legacy team state without roleRef", () => {
  let root: string;
  let store: TeamStore;
  const LEGACY_TEAM_ID = "team-legacy1";
  const captain = () => makeContext({ store, role: "captain" });

  before(() => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-role-legacy-"));
    store = new TeamStore(root);
    const dir = join(root, "teams", LEGACY_TEAM_ID);
    mkdirSync(dir, { recursive: true });
    // 旧插件（< 0.6.0）写的团队状态：成员没有 roleRef 字段 → 直接可读，不需要迁移。
    const legacy = {
      teamId: LEGACY_TEAM_ID,
      goal: "legacy goal",
      status: "active",
      captainSessionId: "session-captain",
      workspaceKey: "ws-key",
      workspaceKeyDegraded: false,
      maxMembers: 8,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: 1,
      members: [
        {
          name: "legacy-dev",
          role: "dev",
          charter: "c",
          status: "registered",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(join(dir, "team.json"), JSON.stringify(legacy, null, 2), "utf8");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads an old team file directly and projects members without a roleRef key", async () => {
    const team = store.findTeam(LEGACY_TEAM_ID);
    assert.ok(team, "legacy team.json must be readable without migration");
    const panel = buildTeamPanelState({ team, tasks: [] });
    assert.equal(panel.members.length, 1);
    assert.equal("roleRef" in (panel.members[0] as object), false);
    const status = (await tool("agent_teams_status").handler({}, captain())) as {
      ok: boolean;
      team: { members: Array<{ name: string }> };
    };
    assert.equal(status.ok, true);
    assert.ok(status.team.members.some((item) => item.name === "legacy-dev"));
  });
});