import type { ToolDefinition, ToolResult } from "./registry.js";
import { z } from "zod";
import { computeReadyTaskIds } from "../state/dag.js";
import { computeNextActions } from "../scheduler.js";
import type { TeamState } from "../state/types.js";
import { nowIso, TeamError } from "../state/types.js";
import { randomTeamId } from "../state/helpers.js";
import { TEAM_TRUST_NOTE, wrapTeamMessageBodies } from "../trust-wrapper.js";

const createSchema = z
  .object({
    goal: z.string().min(1).max(2000),
    approval: z.enum(["required", "automatic"]).default("required"),
    maxMembers: z.number().int().min(1).max(32).optional(),
  })
  .strict();

const approveSchema = z
  .object({ confirmation: z.string().min(1).max(2000) })
  .strict();

const resumeSchema = z
  .object({ reason: z.string().min(1).max(2000) })
  .strict();

const deleteSchema = z
  .object({ archive: z.boolean().default(true) })
  .strict();

const statusSchema = z
  .object({})
  .strict();

export const teamTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_create",
    description: "Create an AgentTeams team for the current goal. The calling session becomes the captain. Defaults to draft (approval required); members are not spawned and tasks are not scheduled until agent_teams_approve_plan.",
    schema: createSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = createSchema.parse(input);
      const existing = context.store.findActiveTeam();
      if (existing) {
        throw new TeamError(
          "team_exists",
          "An active team already exists for this workspace. Continue it via agent_teams_status or archive it via agent_teams_delete first.",
          { teamId: existing.teamId, status: existing.status, goal: existing.goal },
        );
      }
      const team = {
        teamId: randomTeamId(),
        goal: parsed.goal,
        status: (parsed.approval === "automatic" ? "active" : "draft") as TeamState["status"],
        captainSessionId: context.identity.sessionId ?? "",
        workspaceKey: context.workspaceKey ?? "",
        workspaceKeyDegraded: !context.workspaceKey,
        maxMembers: parsed.maxMembers ?? context.maxMembers,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        seq: 1,
        members: [],
      } satisfies TeamState;
      context.store.createTeamDirectories();
      context.store.writeTeamFileIfAbsent(team);
      return {
        ok: true,
        teamId: team.teamId,
        status: team.status,
        panel_url: context.panelUrl,
        protocol: [
          team.status === "draft"
            ? "Draft mode: add members (agent_teams_add_member), create tasks (agent_teams_create_task), present roster+DAG to the user, then agent_teams_approve_plan."
            : "Team is active: create members and tasks, then follow next_actions to dispatch.",
        ].join("\n"),
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_approve_plan",
    description: "Captain only. Move a draft team to active and start scheduling. Requires a non-empty roster and at least one task. Pass the user's approval wording for the audit log.",
    schema: approveSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = approveSchema.parse(input);
      const team = context.requireTeam();
      context.requireCaptain(team);
      if (team.status !== "draft") {
        throw new TeamError("team_not_draft", `Team status is ${team.status}, not draft.`);
      }
      const tasks = context.store.readTasks();
      if (team.members.length === 0 || tasks.length === 0) {
        throw new TeamError(
          "roster_empty",
          "Roster and task DAG must be non-empty before approval.",
        );
      }
      context.store.writeTeam((draft) => {
        draft.status = "active";
      });
      const refreshed = context.store.readTeamFile();
      const refreshedTasks = context.store.readTasks();
      return {
        ok: true,
        status: refreshed?.status,
        approved_with: parsed.confirmation,
        next_actions: computeNextActions({
          team: refreshed ?? team,
          tasks: refreshedTasks,
          perspective: "captain",
        }),
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_status",
    description: "Read current team state. Captain view: full roster, task DAG summary, unread counts, ready tasks and next_actions dispatch instructions. Member view: own current task, claimable tasks, own unread messages. Call this whenever you wake up or need to check state.",
    schema: statusSchema,
    memberAllowed: true,
    async handler(_input, context): Promise<ToolResult> {
      const team = context.requireTeam();
      const memberName = context.resolveMemberName(team);
      const tasks = context.store.readTasks();
      const readyIds = computeReadyTaskIds(tasks);
      const tasksById = new Map(tasks.map((task) => [task.taskId, task]));

      if (context.identity.runtimeScope === "subagent" && memberName) {
        const messages = context.store.listUnreadMessages(memberName);
        const ids = messages.map((message) => message.id);
        if (ids.length > 0) context.store.markMessagesRead(memberName, ids);
        const current = tasks.find(
          (task) =>
            task.status === "in_progress" &&
            task.attempts.find((attempt) => attempt.id === task.activeAttemptId)?.owner === memberName,
        );
        const claimable = readyIds.filter((taskId) => {
          const task = tasksById.get(taskId);
          return !task?.assignee || task.assignee === memberName;
        });
        return {
          ok: true,
          perspective: "member",
          member: memberName,
          current_task: current ? { taskId: current.taskId, status: current.status, title: current.title, objective: current.objective, acceptance: current.acceptance, attempt_id: current.activeAttemptId, kind: current.kind } : null,
          claimable_tasks: claimable.map((taskId) => {
            const task = tasksById.get(taskId);
            return { taskId, title: task?.title ?? "", objective: task?.objective ?? "", acceptance: task?.acceptance ?? [], kind: task?.kind };
          }),
          // 信任包装（specs/error-taxonomy-injection-defense.md R4/R6）：mailbox 正文
          // 是其他模型产出，读边界统一套「模型输出、非用户消息」框架 + 缩进协议；
          // trust_note 覆盖任务标题/目标/验收标准（队长模型撰写）的数据非指令定性。
          unread_messages: wrapTeamMessageBodies(messages),
          trust_note: TEAM_TRUST_NOTE,
          next_actions: {
            wake: [],
            notes: current
              ? ["You have a task in progress: finish it and update via agent_teams_update_task."]
              : claimable.length > 0
                ? [`Claim a ready task with agent_teams_claim_task (first: ${claimable[0]}).`]
                : ["No claimable tasks right now; end this turn and wait for the next wake."],
            report_to_captain: false,
          },
          ...context.identityWarning(),
        };
      }

      context.requireCaptain(team);
      const unreadCounts = team.members.map((member) => ({
        member: member.name,
        unread: context.store.listUnreadMessages(memberName ? memberName : member.name).length,
      }));
      const captainUnread = context.store.listUnreadMessages("captain");
      const captainIds = captainUnread.map((message) => message.id);
      if (captainIds.length > 0) context.store.markMessagesRead("captain", captainIds);
      const refreshed = context.store.readTeamFile() ?? team;
      return {
        ok: true,
        perspective: "captain",
        team: {
          teamId: refreshed.teamId,
          goal: refreshed.goal,
          status: refreshed.status,
          members: refreshed.members,
          maxMembers: refreshed.maxMembers,
          seq: refreshed.seq,
        },
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          kind: task.kind,
          dependencies: task.dependencies,
          assignee: task.assignee ?? null,
          attempt_id: task.activeAttemptId ?? null,
          attempt_owner: task.attempts.find((attempt) => attempt.id === task.activeAttemptId)?.owner ?? null,
          summary: task.summary ?? null,
        })),
        ready_tasks: readyIds,
        blocked_by_failed_quality: tasksBlockedCompact(tasks),
        // 队长收到的成员报告同为模型产出：同款读边界包装（R4）；
        // 任务 summary 由成员模型撰写，trust_note 一并定性（R6）。
        unread: { captain: wrapTeamMessageBodies(captainUnread), members: unreadCounts },
        trust_note: TEAM_TRUST_NOTE,
        next_actions: computeNextActions({
          team: refreshed,
          tasks,
          perspective: "captain",
        }),
        panel_url: context.panelUrl,
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_resume",
    description: "Captain only. Resume a paused team with a non-empty reason. Cancelled tasks are not rebuilt.",
    schema: resumeSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = resumeSchema.parse(input);
      const team = context.requireTeam();
      context.requireCaptain(team);
      if (team.status !== "paused") {
        throw new TeamError("team_not_paused", `Team status is ${team.status}, not paused.`);
      }
      context.store.writeTeam((paused) => {
        paused.status = "active";
      });
      const refreshed = context.store.readTeamFile() ?? team;
      return {
        ok: true,
        status: refreshed.status,
        reason: parsed.reason,
        next_actions: computeNextActions({
          team: refreshed,
          tasks: context.store.readTasks(),
          perspective: "captain",
        }),
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_delete",
    description: "Captain only. End the team. Default archives tasks, dependency graph and mailboxes under .agent-teams/archives/; pass archive:false to discard them. After this, team tools are closed; the panel stays readable for history.",
    schema: deleteSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = deleteSchema.parse(input);
      const team = context.requireTeam();
      context.requireCaptain(team);
      const outcome = context.store.archiveTeam(parsed.archive);
      return {
        ok: true,
        archived: parsed.archive,
        teamId: outcome?.teamId ?? team.teamId,
        archive_dir: parsed.archive ? outcome?.archiveDir : undefined,
        protocol: "Team ended. Summarize the combined result to the user now.",
        ...context.identityWarning(),
      };
    },
  },
];

function tasksBlockedCompact(tasks: readonly import("../state/types.js").TeamTask[]): Array<{
  taskId: string;
  blockedBy: string[];
  dependsOnStatus: Array<Record<string, string | undefined>>;
}> {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const failedGates = new Set(
    tasks
      .filter((task) => (task.status === "failed" || task.status === "blocked") && (task.kind === "review" || task.kind === "test"))
      .map((task) => task.taskId),
  );
  return tasks
    .filter((task) => task.status === "todo" && task.dependencies.some((dep) => failedGates.has(dep)))
    .map((task) => ({
      taskId: task.taskId,
      blockedBy: task.dependencies.filter((dep) => failedGates.has(dep)),
      dependsOnStatus: task.dependencies.map((dep) => ({ [dep]: byId.get(dep)?.status })),
    }));
}
