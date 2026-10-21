import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationStatusPanelTeams } from "../src/v4/teamPanelModel.js";
import {
  buildTeamWorkflowPresentation,
  teamTaskStatus,
} from "../src/v4/teamWorkflowPresentation.js";

const stateKey = "agent-teams@acode-plugins-official:agent-teams";
function project(tasks: unknown[], members: unknown[] = []) {
  return buildConversationStatusPanelTeams({
    [stateKey]: {
      v: 1,
      teamId: "team-test",
      goal: "A team",
      status: "active",
      counts: { done: 1, inProgress: 1, todo: 1, failed: 0, blocked: 0 },
      tasks,
      members,
      readyTaskIds: [],
      blockedByFailedQuality: [],
    },
  })[0]!;
}
const task = (taskId: string, dependencies: string[], status = "todo", assignee?: string) => ({
  taskId,
  title: `Task ${taskId}`,
  kind: "build",
  status,
  dependencies,
  assignee,
});

test("team phases reuse longest dependency layers without inventing adjacent edges", () => {
  const team = project(
    [
      task("t-1", [], "done", "dev"),
      task("t-2", ["t-1"], "in_progress", "dev"),
      task("t-3", ["t-1"], "todo", "review"),
      task("t-4", ["t-2", "t-3"], "todo", "dev"),
      task("t-5", ["t-1", "t-4"], "todo", "dev"),
    ],
    [
      { name: "dev", role: "Developer", status: "bound" },
      { name: "review", role: "Reviewer", status: "bound" },
    ],
  );
  const result = buildTeamWorkflowPresentation(team);
  assert.deepEqual(
    result.phases.map((phase) => phase.tasks.map((item) => item.taskId)),
    [["t-1"], ["t-2", "t-3"], ["t-4"], ["t-5"]],
  );
  assert.deepEqual(
    result.model.rails.map(({ from, to }) => [from, to]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  );
  assert.deepEqual(
    result.model.arcs.map(({ from, to }) => [from, to]),
    [[0, 3]],
  );
  assert.equal(result.model.runningIndex, 1);
  assert.equal(
    result.model.stations[0]!.pills[0]!.avatarIndex,
    result.model.stations[2]!.pills[0]!.avatarIndex,
  );
});

test("one member pill represents all of their tasks in a phase", () => {
  const result = buildTeamWorkflowPresentation(
    project(
      [task("t-1", [], "done", "dev"), task("t-2", [], "in_progress", "dev"), task("t-3", [])],
      [{ name: "dev", role: "Developer", status: "bound" }],
    ),
  );
  assert.equal(result.model.stations[0]!.pills.length, 2);
  assert.deepEqual(result.model.stations[0]!.pills[0]!.stepIds, ["t-1", "t-2"]);
  assert.equal(result.model.stations[0]!.pills[0]!.status, "running");
  assert.equal(result.model.stations[0]!.fraction?.observed, 3);
  assert.equal(result.model.stations[0]!.fraction?.settled, 1);
});

test("cancelled and quality-blocked tasks never become successful", () => {
  assert.equal(teamTaskStatus("cancelled"), "failed");
  const team = project([task("t-1", [], "done"), task("t-2", ["t-1"], "todo", "review")]);
  team.blockedByFailedQuality = [{ taskId: "t-2", blockedBy: ["t-1"] }];
  const result = buildTeamWorkflowPresentation({ ...team, status: "archived" });
  assert.equal(result.model.stations[1]!.status, "failed");
  assert.equal(result.model.stations[1]!.fraction?.settled, 0);
});

test("unassigned work and captain work do not impersonate team members", () => {
  const result = buildTeamWorkflowPresentation(
    project([task("t-1", []), task("t-2", [], "todo", "captain")]),
  );
  assert.deepEqual(
    result.model.stations[0]!.pills.map((pill) => pill.laneClass),
    ["unresolved", "workspace"],
  );
});

test("large team phases retain every participant for shared roster folding", () => {
  const members = Array.from({ length: 14 }, (_, index) => ({
    name: `dev-${index}`,
    role: `Reviewer ${index}`,
    status: "bound",
  }));
  const result = buildTeamWorkflowPresentation(
    project(
      members.map((member, index) =>
        task(`t-${index + 1}`, [], index < 8 ? "in_progress" : "todo", member.name),
      ),
      members,
    ),
  );
  assert.equal(result.model.stations[0]!.pills.length, 14);
  assert.equal(result.model.stations[0]!.fraction?.observed, 14);
  assert.deepEqual(
    result.model.stations[0]!.pills.map((pill) => pill.avatarIndex),
    members.map((_, index) => index),
  );
});
