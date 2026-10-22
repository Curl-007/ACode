import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversationStatusPanelEndedTeams,
  buildConversationStatusPanelTeam,
  buildConversationStatusPanelTeams,
  isTeamEnded,
} from "../src/v4/teamPanelModel.js";

const stateKey = "agent-teams@acode-plugins-official:agent-teams";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    teamId: "team-1",
    goal: "ship",
    status: "active",
    counts: { done: 1, inProgress: 1, todo: 1, failed: 0, blocked: 0 },
    members: [{ name: "dev", role: "Developer", status: "bound" }],
    tasks: [
      { taskId: "t-1", title: "start", status: "done", kind: "build", dependencies: [] },
      { taskId: "t-2", title: "next", status: "todo", kind: "review", dependencies: ["t-1"] },
    ],
    ...overrides,
  };
}

test("rejects snapshots that do not match the v1 TeamPanelState shape", () => {
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: snapshot({ v: 2 }) }), null);
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: snapshot({ teamId: "" }) }), null);
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: snapshot({ goal: 42 }) }), null);
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: snapshot({ counts: null }) }), null);
  assert.equal(buildConversationStatusPanelTeam({ [stateKey]: "bad" }), null);
  assert.equal(buildConversationStatusPanelTeam(null), null);
  assert.deepEqual(buildConversationStatusPanelTeams({ "other@market:agent-teams": {} }), []);
});

test("additive derivation fields default instead of rejecting the card", () => {
  const team = buildConversationStatusPanelTeam({ [stateKey]: snapshot() })!;
  assert.deepEqual(team.readyTaskIds, []);
  assert.equal(team.hasTaskDerivations, false);
  assert.equal(team.criticalPathDepth, 0);
  assert.deepEqual(team.blockedByFailedQuality, []);
  assert.deepEqual(team.mailboxes, []);
  assert.deepEqual(team.unreadMessages, []);
  assert.equal(team.maxMembers, 0);
  assert.equal(team.totalCount, 3);
});

test("multi-team snapshots keep order and filter by captain session", () => {
  const teams = buildConversationStatusPanelTeams({
    [stateKey]: snapshot({
      teams: [
        snapshot({ teamId: "team-a", captainSessionId: "session-a" }),
        snapshot({ teamId: "team-b", captainSessionId: "session-b" }),
        snapshot({ teamId: "team-c" }),
      ],
    }),
  });
  assert.deepEqual(
    teams.map((team) => team.teamId),
    ["team-a", "team-b", "team-c"],
  );
  assert.deepEqual(
    buildConversationStatusPanelTeams({ [stateKey]: snapshot({ teams: [] }) }, "session-a").map(
      (team) => team.teamId,
    ),
    ["team-1"],
  );
  assert.deepEqual(
    buildConversationStatusPanelTeams(
      { [stateKey]: snapshot({ teams: [snapshot({ teamId: "team-a", captainSessionId: "x" })] }) },
      "session-a",
    ),
    [],
  );
});

test("ended teams come from recentEnded and keep endedAt", () => {
  const ended = buildConversationStatusPanelEndedTeams({
    [stateKey]: snapshot({
      recentEnded: [
        { ...snapshot({ teamId: "team-old", status: "archived" }), endedAt: "2026-01-01" },
        { teamId: "bad" },
      ],
    }),
  });
  assert.deepEqual(
    ended.map((team) => [team.teamId, team.endedAt]),
    [["team-old", "2026-01-01"]],
  );
});

test("ended predicate: archived, or all tasks done/cancelled; failures keep a team open", () => {
  assert.equal(isTeamEnded({ status: "archived", tasks: [] }), true);
  assert.equal(isTeamEnded({ status: "active", tasks: [] }), false);
  assert.equal(
    isTeamEnded({
      status: "active",
      tasks: [{ status: "done" }, { status: "cancelled" }],
    }),
    true,
  );
  assert.equal(
    isTeamEnded({ status: "active", tasks: [{ status: "done" }, { status: "failed" }] }),
    false,
  );
});
