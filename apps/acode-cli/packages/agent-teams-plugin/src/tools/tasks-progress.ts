import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { isTaskReady } from "../state/dag.js";
import { assertTransition } from "../state/machine.js";
import { computeNextActions } from "../scheduler.js";
import { nowIso, TASK_ID_PATTERN, TEAM_ID_PATTERN, TeamError } from "../state/helpers.js";
import { randomUUID } from "node:crypto";

/**
 * 成员侧任务工具：claim_task / update_task（队长兼成员可用）。
 * 队长侧 create/amend/reassign 在 tasks-captain.ts。
 */

const teamIdField = z.string().regex(TEAM_ID_PATTERN).optional();

const claimSchema = z
  .object({
    teamId: teamIdField,
    taskId: z.string().regex(TASK_ID_PATTERN),
  })
  .strict();

const updateSchema = z
  .object({
    teamId: teamIdField,
    taskId: z.string().regex(TASK_ID_PATTERN),
    attemptId: z.string().min(1),
    status: z.enum(["done", "failed", "blocked"]),
    summary: z.string().min(1).max(4000),
    outputs: z.array(z.string().max(500)).max(50).optional(),
    verify: z.string().max(4000).optional(),
    blockedReason: z.string().min(1).max(2000).optional(),
    failReason: z.string().min(1).max(2000).optional(),
  })
  .strict();

export const memberTaskTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_claim_task",
    description: "Claim a ready task after dependencies are validated. Each member may hold at most one in_progress task (per team). Returns the attempt_id required for updates. Members may claim own or unassigned tasks; the captain claims via reassign (takeover).",
    schema: claimSchema,
    memberAllowed: true,
    async handler(input, context): Promise<ToolResult> {
      const parsed = claimSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      const memberName = context.requireMember(team);
      const tasks = context.store.readTasks(team.teamId);
      const task = tasks.find((item) => item.taskId === parsed.taskId);
      if (!task) {
        throw new TeamError("task_not_found", `Task ${parsed.taskId} not found.`);
      }
      const byId = new Map(tasks.map((item) => [item.taskId, item]));
      if (!isTaskReady(task, byId)) {
        throw new TeamError(
          "task_not_ready",
          `Task ${parsed.taskId} is not claimable (status ${task.status} or unfinished dependencies: ${task.dependencies.join(", ")}).`,
          { dependencies: task.dependencies, status: task.status },
        );
      }
      if (task.assignee && task.assignee !== memberName) {
        throw new TeamError(
          "task_not_ready",
          `Task ${parsed.taskId} is assigned to ${task.assignee}.`,
        );
      }
      // 「每成员最多 1 个 in_progress」是团队内约束：成员被绑进多个团队时各自独立计数，
      // 跨团队串行由队长调度纪律承担（协议写明），不做全局锁。
      const holding = tasks.find(
        (item) =>
          item.status === "in_progress" &&
          item.attempts.find((attempt) => attempt.id === item.activeAttemptId)?.owner === memberName,
      );
      if (holding) {
        throw new TeamError(
          "already_claimed",
          `You already hold task ${holding.taskId} in progress. Update it first.`,
          { holdingTaskId: holding.taskId },
        );
      }
      assertTransition(task.status, "claim");
      const attemptId = randomUUID();
      context.store.writeTask(team.teamId, parsed.taskId, (target) => {
        target.status = "in_progress";
        target.attemptSeq += 1;
        target.attempts.push({
          id: attemptId,
          seq: target.attemptSeq,
          owner: memberName,
          startedAt: nowIso(),
        });
        target.activeAttemptId = attemptId;
      });
      const refreshed = context.store.readTask(team.teamId, parsed.taskId);
      const messages = context.store.listUnreadMessages(team.teamId, memberName);
      const messageIds = messages.map((message) => message.id);
      if (messageIds.length > 0) {
        context.store.markMessagesRead(team.teamId, memberName, messageIds);
      }
      return {
        ok: true,
        teamId: team.teamId,
        taskId: parsed.taskId,
        attempt_id: attemptId,
        task: refreshed,
        unread_messages: messages,
        next_actions: {
          wake: [],
          notes: ["Execute the task; update via agent_teams_update_task with attempt_id, then follow the returned report instruction."],
          report_to_captain: true,
        },
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_update_task",
    description: "Advance a task with its current attempt_id (stale attempts are rejected). done requires verify when acceptance is non-empty. failed/blocked do not unlock downstream work; quality-kind failures block dependent tasks until a repair task replaces the failed gate.",
    schema: updateSchema,
    memberAllowed: true,
    async handler(input, context): Promise<ToolResult> {
      const parsed = updateSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      const memberName = context.requireMember(team, { allowCaptain: true });
      const task = context.store.readTask(team.teamId, parsed.taskId);
      if (!task) {
        throw new TeamError("task_not_found", `Task ${parsed.taskId} not found.`);
      }
      if (task.activeAttemptId !== parsed.attemptId) {
        throw new TeamError(
          "stale_attempt",
          `attemptId ${parsed.attemptId} is not the active attempt of ${parsed.taskId} (expected ${task.activeAttemptId ?? "none"}).`,
        );
      }
      const attempt = task.attempts.find((item) => item.id === parsed.attemptId);
      if (attempt && memberName !== "captain" && attempt.owner !== memberName) {
        throw new TeamError(
          "forbidden_for_caller",
          `Attempt ${parsed.attemptId} belongs to ${attempt.owner}.`,
        );
      }
      if (parsed.status === "done" && task.acceptance.length > 0 && !parsed.verify) {
        throw new TeamError(
          "verify_required",
          `Task ${parsed.taskId} has acceptance criteria; done requires the verify field (commands run and their results).`,
        );
      }
      if (parsed.status === "blocked" && !parsed.blockedReason) {
        throw new TeamError(
          "invalid_input",
          "blocked status requires blockedReason.",
        );
      }
      if (parsed.status === "failed" && !parsed.failReason) {
        throw new TeamError(
          "invalid_input",
          "failed status requires failReason.",
        );
      }
      // 幂等：同 attempt 重复 done 直接返回当前事实，不重复 unlock。
      if (attempt?.endedAt && attempt.outcome === parsed.status) {
        return {
          ok: true,
          teamId: team.teamId,
          taskId: parsed.taskId,
          status: task.status,
          idempotent: true,
          next_actions: { wake: [], notes: ["Already recorded."], report_to_captain: false },
          ...context.identityWarning(),
        };
      }
      const action =
        parsed.status === "done" ? "update_done" : parsed.status === "failed" ? "update_failed" : "update_blocked";
      assertTransition(task.status, action);
      context.store.writeTask(team.teamId, parsed.taskId, (target) => {
        target.status = parsed.status;
        target.summary = parsed.summary;
        if (parsed.outputs) target.outputs = parsed.outputs;
        if (parsed.verify) target.verify = parsed.verify;
        if (parsed.blockedReason) target.blockedReason = parsed.blockedReason;
        if (parsed.failReason) target.failReason = parsed.failReason;
        const targetAttempt = target.attempts.find((item) => item.id === parsed.attemptId);
        if (targetAttempt) {
          targetAttempt.endedAt = nowIso();
          targetAttempt.outcome = parsed.status;
        }
      });
      const refreshedTeam = context.store.findTeam(team.teamId) ?? team;
      const refreshedTasks = context.store.readTasks(team.teamId);
      const isMember = memberName !== "captain";
      return {
        ok: true,
        teamId: team.teamId,
        taskId: parsed.taskId,
        status: parsed.status,
        next_actions: isMember
          ? { wake: [], notes: ["Task updated. Report to the captain now."], report_to_captain: true }
          : computeNextActions({ team: refreshedTeam, tasks: refreshedTasks, perspective: "captain" }),
        ...context.identityWarning(),
      };
    },
  },
];
