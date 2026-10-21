import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeVisibleOtherSidePaneTabs,
  closeVisibleSidePaneTabs,
  getVisibleSidePaneTabs,
  openTeamSidePane,
  resolveSidePaneScopeState,
} from "../src/lib/workspaceSidePane.js";

const workspaceKey = "workspace-a";

function openTeam(parentSessionId: string) {
  return {
    workspaceKey,
    workspacePath: "/workspace-a",
    parentSessionId,
  };
}

testTeamLanding();
function testTeamLanding() {
  it("reuses the session tab while updating the selected team and phase landing", () => {
    const first = openTeamSidePane(null, { ...openTeam("session-a"), teamId: "team-one" });
    const second = openTeamSidePane(first, {
      ...openTeam("session-a"),
      teamId: "team-two",
      focusPhaseId: "depth-1",
      focusTaskId: "t-3",
    });
    assert.equal(second.tabs.length, 1);
    const tab = second.tabs[0]!;
    assert.equal(tab.type, "team");
    if (tab.type !== "team") throw new Error("Expected a team tab");
    assert.equal(tab.teamId, "team-two");
    assert.equal(tab.focusPhaseId, "depth-1");
    assert.equal(tab.focusTaskId, "t-3");
    const reopened = openTeamSidePane(second, openTeam("session-a"));
    const reset = reopened.tabs[0]!;
    if (reset.type !== "team") throw new Error("Expected a team tab");
    assert.equal(reset.focusPhaseId, undefined);
    assert.equal(reset.focusTaskId, undefined);
  });
}

describe("team side pane session visibility", () => {
  it("shows only the matching team's tab and activates it again on repeated open", () => {
    const a = openTeamSidePane(null, openTeam("session-a"));
    const both = openTeamSidePane(a, openTeam("session-b"));
    assert.equal(
      getVisibleSidePaneTabs(both, "session-a").filter((tab) => tab.type === "team").length,
      1,
    );
    assert.equal(
      getVisibleSidePaneTabs(both, "session-b").filter((tab) => tab.type === "team").length,
      1,
    );
    assert.equal(
      getVisibleSidePaneTabs(both.tabs, { workspaceKey, ownerTaskId: "session-a" }).filter(
        (tab) => tab.type === "team",
      ).length,
      1,
    );
    const reopened = openTeamSidePane(both, openTeam("session-a"));
    assert.equal(reopened.tabs.length, 2);
    assert.equal(reopened.activeTabId, a.activeTabId);
    assert.equal(
      resolveSidePaneScopeState(reopened, { workspaceKey, ownerTaskId: "session-b" }).sidePaneState
        ?.activeTabId,
      both.activeTabId,
    );
  });

  it("does not close another session's team when closing the current session", () => {
    const a = openTeamSidePane(null, openTeam("session-a"));
    const both = openTeamSidePane(a, openTeam("session-b"));
    const onlyA = closeVisibleOtherSidePaneTabs(both, a.activeTabId, "session-a");
    assert.equal(onlyA?.tabs.length, 2);
    const afterCloseAllA = closeVisibleSidePaneTabs(both, "session-a");
    assert.deepEqual(
      afterCloseAllA?.tabs.map((tab) => tab.id),
      [both.activeTabId],
    );
  });
});
