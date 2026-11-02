import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { layoutTeamTaskGraph, TeamTaskGraph } from "../src/components/TeamTaskGraph.js";
import { groupTasks, TEAM_TASK_STATUS_DOT } from "../src/app-shell/teamPaneParts.js";
import type { ConversationStatusPanelTeam } from "../src/v4/teamPanelModel.js";

const team: ConversationStatusPanelTeam = {
  teamId: "team-1",
  goal: "ship",
  status: "active",
  counts: { done: 1, inProgress: 0, todo: 3, failed: 0, blocked: 0 },
  totalCount: 4,
  members: [],
  tasks: [
    { taskId: "t-1", title: "start", status: "done", kind: "build", dependencies: [] },
    { taskId: "t-2", title: "parallel", status: "todo", kind: "build", dependencies: [] },
    { taskId: "t-3", title: "middle", status: "todo", kind: "build", dependencies: ["t-1"] },
    { taskId: "t-4", title: "join", status: "todo", kind: "test", dependencies: ["t-2", "t-3"] },
  ],
  readyTaskIds: ["t-2", "t-3"],
  hasTaskDerivations: true,
  criticalPathDepth: 3,
  blockedByFailedQuality: [],
  mailboxes: [],
  unreadMessages: [],
  maxMembers: 8,
  // 验收面 additive 投影（批次 4）：本用例聚焦依赖图，验收面为空即可。
  reviews: [],
  reviewsTruncated: false,
};

describe("team task graph", () => {
  it("places a join after its longest dependency and keeps layout stable", () => {
    const first = layoutTeamTaskGraph(team);
    assert.deepEqual(layoutTeamTaskGraph(team), first);
    assert.equal(first.placed.find((entry) => entry.task.taskId === "t-4")?.column, 2);
    assert.equal(first.edges.length, 3);
  });

  it("keeps cancelled tasks out of ready and waiting groups", () => {
    const cancelled = {
      ...team,
      tasks: [
        ...team.tasks,
        { taskId: "t-5", title: "stopped", status: "cancelled", kind: "build", dependencies: [] },
      ],
    };
    assert.deepEqual(
      groupTasks(cancelled).blocked.map((task) => task.taskId),
      ["t-5"],
    );
    assert.equal(groupTasks(cancelled).waiting.length, 1);
  });

  it("groups in_review tasks into their own action-first bucket, not waiting", () => {
    const withReview = {
      ...team,
      tasks: [
        ...team.tasks,
        { taskId: "t-6", title: "await", status: "in_review", kind: "review", dependencies: [] },
      ],
    };
    const groups = groupTasks(withReview);
    assert.deepEqual(
      groups.review.map((task) => task.taskId),
      ["t-6"],
    );
    assert.equal(
      groups.waiting.some((task) => task.taskId === "t-6"),
      false,
    );
    // 待验收取色走 confirmation 家族，不得用 success 冒充等待态（DESIGN.md）。
    assert.match(TEAM_TASK_STATUS_DOT.in_review ?? "", /interaction-confirmation/u);
    assert.doesNotMatch(TEAM_TASK_STATUS_DOT.in_review ?? "", /color-success/u);
  });

  it("uses theme tokens and preserves full-width geometry for horizontal scrolling", () => {
    const html = renderToStaticMarkup(createElement(TeamTaskGraph, { team, variant: "full" }));
    assert.match(html, /viewBox="0 0 656 100" style="width:656px/u);
    assert.match(html, /var\(--color-foreground\)/u);
    assert.match(html, /var\(--color-border\)/u);
    assert.doesNotMatch(html, /#[0-9a-f]{3,8}|rgba\(/iu);
  });
});
