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
import { DEFAULT_MAX_REASSIGN_ROUNDS, TEAM_ERROR_CODES } from "../src/state/types.js";

/**
 * 协调者只读预设 · 插件侧（specs/coordinator-readonly-preset.md Q2 裁决）：
 * 撤销「队长自助接管任务改代码」的已文档化路径——
 * ① reassign_task 拒绝 assignee:"captain"；② 队长不再是成员（update_task 拒绝队长）；
 * ③ 队长发信能力保留（send_message from = captain）；④ identity_missing 与 TEAM_ERROR_CODES 对齐。
 */

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
function agentIdFor(name: string): string {
  return `agent_${name}`;
}
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
    maxReassignRounds: DEFAULT_MAX_REASSIGN_ROUNDS,
    maxActiveTeams: 4,
    panelUrl: "http://127.0.0.1:0/",
  });
}

describe("coordinator read-only preset: captain takeover revoked (Q2)", () => {
  let root: string;
  let store: TeamStore;
  const captain = () => makeContext({ store, role: "captain" });
  const member = (name: string) => makeContext({ store, role: "member", memberName: name });

  before(() => {
    root = mkdtempSync(join(tmpdir(), "agent-teams-coordinator-readonly-"));
    store = new TeamStore(root);
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reassign_task rejects assignee:\"captain\" with invalid_input", async () => {
    await tool("agent_teams_create").handler({ goal: "g" }, captain());
    await tool("agent_teams_add_member").handler(
      { name: "dev-1", role: "dev", charter: "c" },
      captain(),
    );
    // 成员身份必须经真实 bind 推导（与 tools.test.ts 一致）。
    await tool("agent_teams_bind_member").handler(
      { name: "dev-1", agentId: agentIdFor("dev-1") },
      captain(),
    );
    await tool("agent_teams_create_task").handler(
      { title: "t", objective: "o", acceptance: ["a"], kind: "build" },
      captain(),
    );
    const teamId = store.listTeams()[0]!.teamId;
    await tool("agent_teams_approve_plan").handler({ confirmation: "go" }, captain());
    await assert.rejects(
      tool("agent_teams_reassign_task").handler(
        { teamId, taskId: "t-1", assignee: "captain", reason: "take over" },
        captain(),
      ),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
    // 对成员的重派仍工作（换人路径保留）
    const reassigned = (await tool("agent_teams_reassign_task").handler(
      { teamId, taskId: "t-1", assignee: "dev-1", reason: "handover" },
      captain(),
    )) as { ok: boolean; assignee: string };
    assert.equal(reassigned.ok, true);
    assert.equal(reassigned.assignee, "dev-1");
  });

  it("update_task no longer accepts the captain as a member caller", async () => {
    const teamId = store.listTeams()[0]!.teamId;
    await assert.rejects(
      tool("agent_teams_update_task").handler(
        { teamId, taskId: "t-1", attemptId: "whatever", status: "done", summary: "done" },
        captain(),
      ),
      (error: unknown) => (error as { code?: string }).code === "caller_not_member",
    );
  });

  it("send_message keeps working for the captain (from = captain)", async () => {
    const teamId = store.listTeams()[0]!.teamId;
    const sent = (await tool("agent_teams_send_message").handler(
      { teamId, to: "dev-1", message: "please retry with MARKER_XYZ" },
      captain(),
    )) as { from: string };
    assert.equal(sent.from, "captain");
    // 成员发信照常（对照）
    const memberSent = (await tool("agent_teams_send_message").handler(
      { teamId, to: "captain", message: "done" },
      member("dev-1"),
    )) as { from: string };
    assert.equal(memberSent.from, "dev-1");
  });

  it("identity_missing stays part of the plugin TEAM_ERROR_CODES closed set", () => {
    assert.ok(
      TEAM_ERROR_CODES.includes("identity_missing"),
      "core COORDINATOR_IDENTITY_MISSING_TOKEN 的 parity 依赖此值在场",
    );
  });
});