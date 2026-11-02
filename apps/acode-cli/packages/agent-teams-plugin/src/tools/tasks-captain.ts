import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { assertNoCycle } from "../state/dag.js";
import { assertKnownTaskStatus, assertTransition } from "../state/machine.js";
import { computeNextActions } from "../scheduler.js";
import {
  QUALITY_TASK_KINDS,
  nowIso,
  TASK_ID_PATTERN,
  TEAM_ID_PATTERN,
  TeamError,
} from "../state/helpers.js";
import { reassignCountOf } from "../state/types.js";

/**
 * 队长侧任务工具：create_task / amend_task / reassign_task。
 * 成员侧 claim/update 在 task-progress.ts。
 */

const teamIdField = z.string().regex(TEAM_ID_PATTERN).optional();

const createSchema = z
  .object({
    teamId: teamIdField,
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
    teamId: teamIdField,
    taskId: z.string().regex(TASK_ID_PATTERN),
    objective: z.string().min(1).max(4000).optional(),
    acceptance: z.array(z.string().min(1).max(1000)).min(1).max(10).optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();

const reassignSchema = z
  .object({
    teamId: teamIdField,
    taskId: z.string().regex(TASK_ID_PATTERN),
    assignee: z.string().min(1).max(64),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const captainTaskTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_create_task",
    description:
      "Create a task node in the team DAG. Dependencies must reference existing task ids and must not form a cycle; tasks whose dependencies are not done are not claimable. On a paused team, refused unless the team is resumed first.",
    schema: createSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = createSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      if (team.status === "paused") {
        throw new TeamError(
          "team_not_paused",
          "Team is paused; tasks can only be created after agent_teams_resume.",
        );
      }
      if (team.status === "archived") {
        throw new TeamError(
          "team_archived",
          "Team has ended. Stop now: do not retry, do not continue the task, end your turn.",
        );
      }
      const tasks = context.store.readTasks(team.teamId);
      const byId = new Map(tasks.map((task) => [task.taskId, task]));
      for (const dep of parsed.dependencies) {
        if (!byId.has(dep)) {
          throw new TeamError("dependency_not_found", `Dependency ${dep} does not exist.`);
        }
      }
      const taskId = context.store.nextTaskId(team.teamId);
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
      context.store.upsertTask(team.teamId, {
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
      const refreshed = context.store.readTask(team.teamId, taskId);
      const refreshedTeam = context.store.findTeam(team.teamId) ?? team;
      return {
        ok: true,
        teamId: team.teamId,
        taskId,
        task: refreshed,
        next_actions: computeNextActions({
          team: refreshedTeam,
          tasks: context.store.readTasks(team.teamId),
          perspective: "captain",
        }),
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_amend_task",
    description:
      "Captain only. Amend objective/acceptance/notes on a non-terminal task. Acceptance is frozen while a task is in_review (the member's delivery is being judged against the wording it was given — reject it or accept it instead of moving the goalposts), and review-kind tasks freeze acceptance after the attempt started. Every amendment is recorded in a revisions ledger.",
    schema: amendSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = amendSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      const task = context.store.readTask(team.teamId, parsed.taskId);
      if (!task) {
        throw new TeamError("task_not_found", `Task ${parsed.taskId} not found.`);
      }
      assertKnownTaskStatus(task.status, `task ${parsed.taskId}`);
      if (task.status === "done" || task.status === "cancelled") {
        throw new TeamError(
          "invalid_input",
          `Task ${parsed.taskId} is ${task.status}; amendment is closed.`,
        );
      }
      if (task.status === "in_review" && parsed.acceptance !== undefined) {
        // OQ-6：待验收期间冻结验收标准——改掉它会抽掉已交付工作的依据，改用 reassign 更诚实。
        throw new TeamError(
          "acceptance_frozen",
          `Task ${parsed.taskId} is in_review; acceptance is frozen while the delivery is being judged. Accept it or reassign it instead of amending the acceptance criteria.`,
          { taskId: parsed.taskId, status: task.status },
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
      context.store.writeTask(team.teamId, parsed.taskId, (target) => {
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
        teamId: team.teamId,
        taskId: parsed.taskId,
        revised_fields: fields,
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_reassign_task",
    description:
      "Captain only. Atomically reject or reassign a task: the old attempt is revoked, the task returns to todo with the new assignee (from in_progress, in_review, failed or blocked). A task in_review means the member already delivered — reassigning is how you REJECT that delivery (the member's worktree is kept so it can keep working in the same tree); to add requirements without rejecting, use agent_teams_send_message. Reassigning to the captain is refused: the coordinator session does not take over tasks to change code (dispatch to a member instead). Refused with reassign_limit_exceeded once the task has been reassigned maxReassignRounds times (default 3); stop and report to the user at that point.",
    schema: reassignSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = reassignSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      // Q2 裁决（specs/coordinator-readonly-preset.md）：撤销「队长自助接管任务改代码」的
      // 文档化路径——队长会话的文件写工具被宿主按团队协议禁用，接管后也无从改代码。
      // 中性文案列明该怎么做（派成员 / 追加指令），不描述为错误（EI-17）。
      if (parsed.assignee === "captain") {
        throw new TeamError(
          "invalid_input",
          'Reassigning to "captain" is not supported: the coordinator session does not take over a task to change code. Reassign to a member, or use agent_teams_send_message to add instructions to the original member.',
        );
      }
      const task = context.store.readTask(team.teamId, parsed.taskId);
      if (!task) {
        throw new TeamError("task_not_found", `Task ${parsed.taskId} not found.`);
      }
      assertKnownTaskStatus(task.status, `task ${parsed.taskId}`);
      if (task.status === "done" || task.status === "cancelled") {
        throw new TeamError(
          "invalid_input",
          `Task ${parsed.taskId} is ${task.status}; reassignment is closed.`,
        );
      }
      {
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
      context.store.writeTask(team.teamId, parsed.taskId, (target) => {
        target.status = "todo";
        target.assignee = parsed.assignee;
        target.attempts.forEach((attempt) => {
          if (!attempt.endedAt) {
            attempt.endedAt = nowIso();
          }
        });
        target.activeAttemptId = undefined;
        // R2.3：打回审计——与 amend 共用同一 revisions 台账，不新增结构；
        // 在所有 reassign 来源上统一生效（EI-2）。attemptSeq 不在此递增（OQ-3：认领计数器，
        // 下一次 claim 才 +1 并生成新 attempt）。
        target.revisions.push({ at: nowIso(), by: "captain", fields: ["status", "assignee"] });
      });
      // Q2 裁决（specs/coordinator-readonly-preset.md）：撤销队长自助接管——不再为
      // 「assignee: captain」创建进行中 attempt（该入参已在入口拒绝）。任务回 todo，
      // 由被指派的成员认领。
      const refreshedTeam = context.store.findTeam(team.teamId) ?? team;
      const refreshedTasks = context.store.readTasks(team.teamId);
      return {
        ok: true,
        teamId: team.teamId,
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
