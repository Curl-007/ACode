import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { assertTransition } from "../state/machine.js";
import { computeNextActions } from "../scheduler.js";
import { nowIso, TASK_ID_PATTERN, TeamError } from "../state/helpers.js";
import { reassignCountOf } from "../state/types.js";

/**
 * 队长侧重派工具（架构 ratchet 400 行上限的最小抽取：从 tasks.ts 原样迁出，
 * 行为逐字节一致）。taskTools 数组把它排在 update_task 之后，注册顺序不变。
 */

const reassignSchema = z
  .object({
    taskId: z.string().regex(TASK_ID_PATTERN),
    assignee: z.string().min(1).max(64),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const reassignTaskTool: ToolDefinition = {
  name: "agent_teams_reassign_task",
  description: "Captain only. Atomically retry or reassign a task: the old attempt is revoked, the task returns to todo with the new assignee (use \"captain\" for captain takeover). If the new owner is idle and ready, the dispatch instruction wakes them. Use this only to change the owner or to take over — to send a rejected task back with more instructions, use agent_teams_send_message instead (the original member keeps its context). Refused with reassign_limit_exceeded once the task has been reassigned maxReassignRounds times (default 3); stop and report to the user at that point.",
  schema: reassignSchema,
  memberAllowed: false,
  async handler(input, context): Promise<ToolResult> {
    const parsed = reassignSchema.parse(input);
    const team = context.requireTeam();
    context.requireCaptain(team);
    const task = context.store.readTask(parsed.taskId);
    if (!task) {
      throw new TeamError("task_not_found", `Task ${parsed.taskId} not found.`);
    }
    if (task.status === "done" || task.status === "cancelled") {
      throw new TeamError(
        "invalid_input",
        `Task ${parsed.taskId} is ${task.status}; reassignment is closed.`,
      );
    }
    if (parsed.assignee !== "captain") {
      const member = team.members.find((item) => item.name === parsed.assignee);
      if (!member || member.status === "removed") {
        throw new TeamError(
          "member_not_found",
          `Assignee ${parsed.assignee} is not in the roster.`,
        );
      }
    }
    // 最大重派轮次：读已落盘的 attempts（认领次数），重派次数 = 认领次数 - 1。
    // 判定排在 done/cancelled 与名册校验之后、assertTransition 之前：终态封闭与「人不存在」
    // 是更基础的错误，优先级不变；这里只拦「同一个任务被反复重派」。
    const reassignCount = reassignCountOf(task);
    const maxReassignRounds = context.maxReassignRounds;
    if (reassignCount >= maxReassignRounds) {
      throw new TeamError(
        "reassign_limit_exceeded",
        `Task ${parsed.taskId} has been reassigned ${reassignCount} time(s), reaching the limit of ${maxReassignRounds}. Stop and report to the user instead of retrying.`,
        {
          taskId: parsed.taskId,
          reassignCount,
          maxReassignRounds,
          attempts: task.attempts.map((attempt) => ({
            seq: attempt.seq,
            owner: attempt.owner,
            outcome: attempt.outcome,
          })),
        },
      );
    }
    assertTransition(task.status, "reassign");
    context.store.writeTask(parsed.taskId, (target) => {
      target.status = "todo";
      target.assignee = parsed.assignee;
      target.attempts.forEach((attempt) => {
        if (!attempt.endedAt) {
          attempt.endedAt = nowIso();
        }
      });
      target.activeAttemptId = undefined;
    });
    const refreshedTeam = context.store.readTeamFile() ?? team;
    const refreshedTasks = context.store.readTasks();
    return {
      ok: true,
      taskId: parsed.taskId,
      assignee: parsed.assignee,
      reason: parsed.reason,
      next_actions: computeNextActions({
        team: refreshedTeam,
        tasks: refreshedTasks,
        perspective: "captain",
      }),
      ...context.identityWarning(),
    };
  },
};
