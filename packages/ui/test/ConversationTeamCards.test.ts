import assert from "node:assert/strict";
import test from "node:test";
import { conversationTeamCardsSlot } from "../src/v4/ConversationTeamCards.js";
import { buildConversationStatusPanelTeams } from "../src/v4/teamPanelModel.js";

const teams = buildConversationStatusPanelTeams({
  "agent-teams@acode-plugins-official:agent-teams": {
    v: 1,
    teamId: "team-test",
    goal: "Team",
    status: "active",
    counts: { done: 0, inProgress: 0, todo: 0, failed: 0, blocked: 0 },
    tasks: [],
    members: [],
  },
});
test("timeline slot is absent for hidden, unscoped, and empty team cards", () => {
  const scope = { parentSessionId: "session-test" };
  assert.equal(conversationTeamCardsSlot(teams, scope, undefined, undefined, true), null);
  assert.equal(
    conversationTeamCardsSlot(teams, { parentSessionId: null }, undefined, undefined, false),
    null,
  );
  assert.equal(conversationTeamCardsSlot([], scope, undefined, undefined, false), null);
  assert.notEqual(conversationTeamCardsSlot(teams, scope, undefined, undefined, false), null);
});
