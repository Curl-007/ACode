import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { assertNoCycle, isTaskReady } from "../state/dag.js";
import { assertTransition } from "../state/machine.js";
import { computeNextActions } from "../scheduler.js";
import { QUALITY_TASK_KINDS, nowIso, TASK_ID_PATTERN, TeamError } from "../state/helpers.js";
import { reassignCountOf } from "../state/types.js";
import { randomUUID } from "node:crypto";

const createSchema = z
  .object({
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(4000),
    acceptance: z.array(z.string().min(1).max(1000)).min(1).max(10),
    kind: z.enum(["build", "review", "test", "design", "chore"]).default("build"),
    dependencies: z.array(z.string().regex(TASK_ID_PATTERN)).default([]),
    assignee: z.string().min(1).max(64).optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();

const amendSchema = z
  .object({
    taskId: z.string().regex(TASK_ID_PATTERN),
    objective: z.string().min(1).max(4000).optional(),
    acceptance: z.array(z.string().min(1).max(1000)).min(1).max(10).optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();

const claimSchema = z
  .object({ taskId: z.string().regex(TASK_ID_PATTERN) })
  .strict();

const updateSchema = z
  .object({
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

const reassignSchema = z
  .object({
    taskId: z.string().regex(TASK_ID_PATTERN),
    assignee: z.string().min(1).max(64),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const taskTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_create_task",
    description: "Create a task node in the team DAG. Dependencies must reference existing task ids and must not form a cycle; tasks whose dependencies are not done are not claimable. On a paused team, refused unless the team is resumed first.",
    schema: createSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = createSchema.parse(input);
      const team = context.requireTeam();
      context.requireCaptain(team);
      if (team.status === "paused") {
        throw new TeamError(
          "team_not_paused",
          "Team is paused; tasks can only be created after agent_teams_resume.",
        );
      }
      if (team.status === "archived") {
        throw new TeamError("no_active_team", "Team is archived.");
      }
      const tasks = context.store.readTasks();
      const byId = new Map(tasks.map((task) => [task.taskId, task]));
      for (const dep of parsed.dependencies) {
        if (!byId.has(dep)) {
          throw new TeamError("dependency_not_found", `Dependency ${dep} does not exist.`);
        }
      }
      const taskId = context.store.nextTaskId();
      assertNoCycle(tasks, taskId, parsed.dependencies);
      if (parsed.assignee) {
        const member = team.members.find((item) => item.name === parsed.assignee);
        if (!member || member.status === "removed") {
          throw new TeamError(
            "member_not_found",
            `Assignee ${parsed.assignee} is not in the roster.`,
          );
        }
      }
      context.store.upsertTask({
        taskId,
        title: parsed.title,
        objective: parsed.objective,
        acceptance: parsed.acceptance,
        kind: parsed.kind,
        dependencies: parsed.dependencies,
        assignee: parsed.assignee,
        status: "todo",
        attemptSeq: 0,
        attempts: [],
        revisions: [],
        ...(parsed.notes ? { notes: parsed.notes } : {}),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      const refreshed = context.store.readTask(taskId);
      const refreshedTeam = context.store.readTeamFile() ?? team;
      return {
        ok: true,
        taskId,
        task: refreshed,
        next_actions: computeNextActions({
          team: refreshedTeam,
          tasks: context.store.readTasks(),
          perspective: "captain",
        }),
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_amend_task",
    description: "Captain only. Amend objective/acceptance/notes on a non-terminal task. Review-kind tasks freeze acceptance after the reviewed task passes. Every amendment is recorded in a revisions ledger.",
    schema: amendSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = amendSchema.parse(input);
      const team = context.requireTeam();
      context.requireCaptain(team);
      const task = context.store.readTask(parsed.taskId);
      if (!task) {
        throw new TeamError("task_not_found", `Task ${parsed.taskId} not found.`);
      }
      if (task.status === "done" || task.status === "cancelled") {
        throw new TeamError(
          "invalid_input",
          `Task ${parsed.taskId} is ${task.status}; amendment is closed.`,
        );
      }
      if (
        QUALITY_TASK_KINDS.includes(task.kind) &&
        task.status !== "todo" &&
        parsed.acceptance !== undefined
      ) {
        throw new TeamError(
          "acceptance_frozen",
          `Quality task ${parsed.taskId} acceptance is frozen after the attempt started.`,
        );
      }
      const fields: string[] = [];
      context.store.writeTask(parsed.taskId, (target) => {
        if (parsed.objective !== undefined) {
          target.objective = parsed.objective;
          fields.push("objective");
        }
        if (parsed.acceptance !== undefined) {
          target.acceptance = parsed.acceptance;
          fields.push("acceptance");
        }
        if (parsed.notes !== undefined) {
          target.notes = parsed.notes;
          fields.push("notes");
        }
        target.revisions.push({ at: nowIso(), by: "captain", fields });
      });
      return {
        ok: true,
        taskId: parsed.taskId,
        revised_fields: fields,
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_claim_task",
    description: "Claim a ready task after dependencies are validated. Each member may hold at most one in_progress task. Returns the attempt_id required for updates. Members may claim own or unassigned tasks; the captain claims via reassign (takeover).",
    schema: claimSchema,
    memberAllowed: true,
    async handler(input, context): Promise<ToolResult> {
      const parsed = claimSchema.parse(input);
      const team = context.requireTeam();
      const memberName = context.requireMember(team);
      const tasks = context.store.readTasks();
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
      context.store.writeTask(parsed.taskId, (target) => {
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
      const refreshed = context.store.readTask(parsed.taskId);
      const messages = context.store.listUnreadMessages(memberName);
      const messageIds = messages.map((message) => message.id);
      if (messageIds.length > 0) context.store.markMessagesRead(memberName, messageIds);
      return {
        ok: true,
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
      const team = context.requireTeam();
      const memberName = context.requireMember(team, { allowCaptain: true });
      const task = context.store.readTask(parsed.taskId);
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
      context.store.writeTask(parsed.taskId, (target) => {
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
      const refreshedTeam = context.store.readTeamFile() ?? team;
      const refreshedTasks = context.store.readTasks();
      const isMember = memberName !== "captain";
      return {
        ok: true,
        taskId: parsed.taskId,
        status: parsed.status,
        next_actions: isMember
          ? { wake: [], notes: ["Task updated. Report to the captain now."], report_to_captain: true }
          : computeNextActions({ team: refreshedTeam, tasks: refreshedTasks, perspective: "captain" }),
        ...context.identityWarning(),
      };
    },
  },
  {
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
  },
];
