import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { computeNextActions } from "../scheduler.js";
import { TASK_ID_PATTERN, TEAM_ID_PATTERN, TeamError, nowIso } from "../state/helpers.js";
import { assertKnownTaskStatus, assertTransition } from "../state/machine.js";

/**
 * `agent_teams_accept_task`（批次 1，OQ-1 裁决）：队长显式验收一个待验收（in_review）任务。
 *
 * 为什么需要它：未开启工作树隔离（worktree_disabled）的团队没有合并入口，`accept` 便
 * 没有触发者，任务会永久停在 in_review。本工具补上该入口，保持「done 必经验收」单一语义。
 *
 * 隔离团队**不走**这里：验收与合并耦合（`agent_teams_merge_member_worktree` 成功即
 * 验收），否则会出现「任务已 done 但成员分支未合入」的第二条语义。故隔离团队在此被拒。
 *
 * OQ-7：验收记一条 revision（`by: "captain"` + fields `["status","acceptedBy"]`），
 * 与 amend / 打回共用同一 revisions 台账。
 */

const acceptSchema = z
  .object({
    teamId: z.string().regex(TEAM_ID_PATTERN).optional(),
    taskId: z.string().regex(TASK_ID_PATTERN),
  })
  .strict();

export const acceptTaskTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_accept_task",
    description:
      "Captain only. Accept a delivered task: move a task awaiting acceptance (in_review) to done. This is the acceptance path for teams WITHOUT worktree isolation; when isolation is on, acceptance is coupled to agent_teams_merge_member_worktree (merging the branch is the acceptance), so this tool refuses those teams. Records who accepted it in the revisions ledger. To send the delivery back instead, use agent_teams_reassign_task.",
    schema: acceptSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = acceptSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      const task = context.store.readTask(team.teamId, parsed.taskId);
      if (!task) {
        throw new TeamError("task_not_found", `Task ${parsed.taskId} not found.`);
      }
      assertKnownTaskStatus(task.status, `task ${parsed.taskId}`);
      if (task.status !== "in_review") {
        throw new TeamError(
          "invalid_input",
          `Task ${parsed.taskId} is ${task.status}; only a task awaiting acceptance (in_review) can be accepted.`,
          { taskId: parsed.taskId, status: task.status },
        );
      }
      if (team.worktreeIsolation?.enabled) {
        throw new TeamError(
          "invalid_input",
          `Team ${team.teamId} uses worktree isolation; acceptance is coupled to the merge. Call agent_teams_merge_member_worktree to accept this delivery.`,
          { taskId: parsed.taskId },
        );
      }
      assertTransition("in_review", "accept");
      context.store.writeTask(team.teamId, parsed.taskId, (target) => {
        target.status = "done";
        target.revisions.push({ at: nowIso(), by: "captain", fields: ["status", "acceptedBy"] });
      });
      const refreshedTeam = context.store.findTeam(team.teamId) ?? team;
      return {
        ok: true,
        teamId: team.teamId,
        taskId: parsed.taskId,
        status: "done",
        accepted: true,
        next_actions: computeNextActions({
          team: refreshedTeam,
          tasks: context.store.readTasks(team.teamId),
          perspective: "captain",
        }),
        ...context.identityWarning(),
      };
    },
  },
];