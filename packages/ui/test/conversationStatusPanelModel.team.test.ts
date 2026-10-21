import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";

const TEAM_STATE = {
  v: 1,
  teamId: "team-abc",
  goal: "ship the feature",
  status: "active",
  seq: 12,
  counts: { done: 1, inProgress: 1, todo: 2, failed: 0, blocked: 0 },
  members: [
    { name: "dev-1", role: "implementer", status: "bound", currentTaskId: "t-2" },
    { name: "reviewer-1", role: "reviewer", status: "bound" },
  ],
  tasks: [
    { taskId: "t-1", title: "梳理", status: "done", kind: "build", dependencies: [] },
    {
      taskId: "t-2",
      title: "实现",
      status: "in_progress",
      kind: "build",
      dependencies: ["t-1"],
      assignee: "dev-1",
    },
    { taskId: "t-3", title: "评审", status: "todo", kind: "review", dependencies: ["t-2"] },
    { taskId: "t-4", title: "测试", status: "todo", kind: "test", dependencies: ["t-2"] },
  ],
};

const stateKey = "agent-teams@acode-plugins-official:agent-teams";

function build(pluginStates: Record<string, unknown> | null | undefined) {
  return buildConversationStatusPanelModel({ pluginStates });
}

describe("buildTeamModel（pluginStates → 团队卡）", () => {
  it("projects a well-formed v1 snapshot", () => {
    const model = build({ [stateKey]: TEAM_STATE });
    assert.ok(model.team);
    assert.equal(model.team.teamId, "team-abc");
    assert.equal(model.team.goal, "ship the feature");
    assert.equal(model.team.status, "active");
    assert.equal(model.team.totalCount, 4);
    assert.equal(model.team.tasks.length, 4);
    assert.equal(model.team.tasks[1]?.assignee, "dev-1");
    assert.deepEqual(model.team.tasks[1]?.dependencies, ["t-1"]);
    assert.equal(model.team.members[0]?.currentTaskId, "t-2");
    assert.equal(model.team.members[1]?.currentTaskId, undefined);
    assert.equal(model.team.hasTaskDerivations, false);
    assert.equal(model.hasContent, true);
  });

  it("keeps additive task derivations optional for older plugin snapshots", () => {
    const model = build({
      [stateKey]: { ...TEAM_STATE, readyTaskIds: ["t-3"], criticalPathDepth: 3 },
    });
    assert.equal(model.team?.hasTaskDerivations, true);
    assert.deepEqual(model.team?.readyTaskIds, ["t-3"]);
    assert.equal(model.team?.criticalPathDepth, 3);
  });

  it("absent when pluginStates is null or lacks the key", () => {
    assert.equal(build(null).team, null);
    assert.equal(build({}).team, null);
    assert.equal(build({ "other-plugin:topic": { v: 1 } }).team, null);
  });

  it("absent on malformed snapshots（宁缺不残）", () => {
    assert.equal(build({ [stateKey]: null }).team, null);
    assert.equal(build({ [stateKey]: "string" }).team, null);
    assert.equal(build({ [stateKey]: { v: 2 } }).team, null);
    assert.equal(build({ [stateKey]: { v: 1 } }).team, null);
    assert.equal(
      build({ [stateKey]: { v: 1, teamId: "", goal: "g", status: "active", counts: {} } }).team,
      null,
    );
  });

  it("tolerates partial tasks/members rows（坏行丢弃，好行保留）", () => {
    const state = {
      ...TEAM_STATE,
      tasks: [...TEAM_STATE.tasks, { taskId: "" }, { nope: 1 }, "bad"],
      members: [...TEAM_STATE.members, { name: "" }, { role: "x" }],
    };
    const model = build({ [stateKey]: state });
    assert.ok(model.team);
    assert.equal(model.team.tasks.length, 4);
    assert.equal(model.team.members.length, 2);
  });

  it("requires counts（宁缺不残：缺 counts 的快照整卡缺席）", () => {
    const state = { v: 1, teamId: "t", goal: "g", status: "draft" };
    const model = build({ [stateKey]: state });
    assert.equal(model.team, null);
    const emptyCounts = build({
      [stateKey]: { v: 1, teamId: "t", goal: "g", status: "draft", counts: {} },
    });
    assert.ok(emptyCounts.team);
    assert.deepEqual(emptyCounts.team?.counts, {
      done: 0,
      inProgress: 0,
      todo: 0,
      failed: 0,
      blocked: 0,
    });
    assert.equal(emptyCounts.team?.totalCount, 0);
  });

  it("keeps panelUrl only when it is an http url", () => {
    const withUrl = build({ [stateKey]: { ...TEAM_STATE, panelUrl: "http://127.0.0.1:1/" } });
    assert.equal(withUrl.team?.panelUrl, "http://127.0.0.1:1/");
    const withBadUrl = build({ [stateKey]: { ...TEAM_STATE, panelUrl: "javascript:alert(1)" } });
    assert.equal(withBadUrl.team?.panelUrl, undefined);
    const withRemoteUrl = build({
      [stateKey]: { ...TEAM_STATE, panelUrl: "https://example.org/team" },
    });
    assert.equal(withRemoteUrl.team?.panelUrl, undefined);
    const withHistoryUrl = build({
      [stateKey]: { ...TEAM_STATE, panelUrl: "http://127.0.0.1:1/history/team-abc" },
    });
    assert.equal(withHistoryUrl.team?.panelUrl, "http://127.0.0.1:1/history/team-abc");
  });

  it("picks the first key when multiple marketplaces carry agent-teams", () => {
    const other = "agent-teams@claude-plugins-official:agent-teams";
    // 键字典序：acode- < claude-，取 acode 侧。
    const model = build({
      [stateKey]: TEAM_STATE,
      [other]: { v: 1, teamId: "other", goal: "o", status: "active", counts: { done: 1 } },
    });
    assert.ok(model.team);
    assert.equal(model.team.teamId, "team-abc");
  });
});

describe("buildTeamModel 多团队（插件 0.2 additive teams[]）", () => {
  const secondTeam = {
    ...TEAM_STATE,
    teamId: "team-xyz",
    goal: "fix the bugs",
    stale: true,
    counts: { done: 3, inProgress: 0, todo: 1, failed: 0, blocked: 0 },
  };

  it("projects teams[] into multiple cards when present", () => {
    const model = build({ [stateKey]: { ...TEAM_STATE, teams: [TEAM_STATE, secondTeam] } });
    assert.equal(model.teams.length, 2);
    assert.equal(model.teams[0]?.teamId, "team-abc");
    assert.equal(model.teams[1]?.teamId, "team-xyz");
    assert.equal(model.teams[1]?.stale, true);
    assert.equal(model.teams[0]?.stale, undefined);
    // primary 单卡仍是第一张（最近更新者）。
    assert.equal(model.team?.teamId, "team-abc");
  });

  it("falls back to the single primary card when teams[] is absent (legacy plugin)", () => {
    const model = build({ [stateKey]: TEAM_STATE });
    assert.equal(model.teams.length, 1);
    assert.equal(model.teams[0]?.teamId, "team-abc");
  });

  it("falls back to the primary card when every teams[] entry is malformed", () => {
    const model = build({
      [stateKey]: { ...TEAM_STATE, teams: [{ v: 2 }, "bad", null] },
    });
    assert.equal(model.teams.length, 1);
    assert.equal(model.teams[0]?.teamId, "team-abc");
  });

  it("drops malformed member cards（宁缺不残：不渲染半张卡）", () => {
    const model = build({
      [stateKey]: {
        ...TEAM_STATE,
        teams: [TEAM_STATE, { v: 1, teamId: "team-bad", goal: "g", status: "draft" }],
      },
    });
    // team-bad 缺 counts → 整卡丢弃；只剩合法的 team-abc。
    assert.equal(model.teams.length, 1);
    assert.equal(model.teams[0]?.teamId, "team-abc");
  });

  it("teams stays empty when the snapshot has no team at all", () => {
    assert.equal(build(null).teams.length, 0);
    assert.equal(build({}).teams.length, 0);
  });
});
