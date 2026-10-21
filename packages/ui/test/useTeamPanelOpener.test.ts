import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useTeamPanelOpener } from "../src/hooks/useTeamPanelOpener.js";
import type { OpenScopedTeamSideTabRequest } from "../src/lib/workspaceSidePane.js";

test("team opener preserves remote identity, session scope, and phase landing", () => {
  let opened: OpenScopedTeamSideTabRequest | undefined;
  function Probe() {
    const open = useTeamPanelOpener({
      workspacePath: "/remote/work",
      workspaceIdentity: "remote:host:work",
      remoteSessionId: "remote-session",
      rootSessionId: "root",
      onOpenTeamPanel: (request) => {
        opened = request;
      },
    });
    open({
      parentSessionId: "parent",
      teamId: "team-two",
      focusPhaseId: "depth-1",
      focusTaskId: "t-3",
    });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.deepEqual(opened, {
    workspacePath: "/remote/work",
    workspaceIdentity: "remote:host:work",
    remoteSessionId: "remote-session",
    rootSessionId: "root",
    parentSessionId: "parent",
    teamId: "team-two",
    focusPhaseId: "depth-1",
    focusTaskId: "t-3",
  });
});
