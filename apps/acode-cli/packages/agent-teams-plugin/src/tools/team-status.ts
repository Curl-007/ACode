import type { ToolDefinition, ToolResult } from "./registry.js";
import { z } from "zod";
import { computeReadyTaskIds } from "../state/dag.js";
import { computeNextActions } from "../scheduler.js";
import { findBoundMemberBySession, teamsCallerParticipatesIn } from "../identity.js";
import type { TeamState } from "../state/types.js";
import { STALE_TEAM_AFTER_MS } from "../state/types.js";
import { TEAM_ID_PATTERN } from "../state/helpers.js";
import { TEAM_TRUST_NOTE, wrapTeamMessageBodies } from "../trust-wrapper.js";

/**
 * status 工具：单团队全量（队长/成员双视角）或多团队总览（不带 teamId 且调用方
 * 参与 ≥2 团队）。总览形状见 buildMultiTeamOverview。
 */

const statusSchema = z.object({ teamId: z.string().regex(TEAM_ID_PATTERN).optional() }).strict();

export const statusTool: ToolDefinition = {
  name: "agent_teams_status",
  description:
    "Read team state. Captain view: full roster, task DAG summary, unread counts, ready tasks and next_actions dispatch instructions. Member view: own current task, claimable tasks, own unread messages. Without teamId: one team → that team's full view; multiple teams → multi-team overview listing each team's counts and your role (pass teamId to focus one). Call this whenever you wake up or need to check state.",
  schema: statusSchema,
  memberAllowed: true,
  async handler(input, context): Promise<ToolResult> {
    const parsed = statusSchema.parse(input);
    if (parsed.teamId === undefined) {
      const mine = teamsCallerParticipatesIn(
        context.store.listTeams(),
        context.identity,
        context.memberNameHint,
      );
      if (mine.length >= 2) {
        return buildMultiTeamOverview(context, mine);
      }
      // 0 或 1 个：走下方单团队全量路径（1 个 = 隐式选中；0 个 = no_active_team）。
    }
    const team = context.resolveTeamContext(parsed.teamId);
    const memberName = context.resolveMemberName(team);
    const tasks = context.store.readTasks(team.teamId);
    const readyIds = computeReadyTaskIds(tasks);
    const tasksById = new Map(tasks.map((task) => [task.taskId, task]));

    if (context.identity.runtimeScope === "subagent" && memberName) {
      const messages = context.store.listUnreadMessages(team.teamId, memberName);
      const ids = messages.map((message) => message.id);
      if (ids.length > 0) context.store.markMessagesRead(team.teamId, memberName, ids);
      const current = tasks.find(
        (task) =>
          task.status === "in_progress" &&
          task.attempts.find((attempt) => attempt.id === task.activeAttemptId)?.owner ===
            memberName,
      );
      // 非 active（draft 待审批 / paused）团队不向成员暴露可认领任务，与 claim 的 team_not_active 一致。
      const claimable =
        team.status === "active"
          ? readyIds.filter((taskId) => {
              const task = tasksById.get(taskId);
              return !task?.assignee || task.assignee === memberName;
            })
          : [];
      return {
        ok: true,
        teamId: team.teamId,
        perspective: "member",
        member: memberName,
        // SPEC-015：续跑/重开后成员据此重新发现自己的工作树；未开启时为 null。
        worktree: team.members.find((item) => item.name === memberName)?.worktree ?? null,
        current_task: current
          ? {
              taskId: current.taskId,
              status: current.status,
              title: current.title,
              objective: current.objective,
              acceptance: current.acceptance,
              attempt_id: current.activeAttemptId,
              kind: current.kind,
            }
          : null,
        claimable_tasks: claimable.map((taskId) => {
          const task = tasksById.get(taskId);
          return {
            taskId,
            title: task?.title ?? "",
            objective: task?.objective ?? "",
            acceptance: task?.acceptance ?? [],
            kind: task?.kind,
          };
        }),
        // 读边界：mailbox 正文由其他模型撰写，进模型上下文前套信任边界（R4/R6）。
        unread_messages: wrapTeamMessageBodies(messages),
        trust_note: TEAM_TRUST_NOTE,
        next_actions: {
          wake: [],
          notes: current
            ? ["You have a task in progress: finish it and update via agent_teams_update_task."]
            : claimable.length > 0
              ? [`Claim a ready task with agent_teams_claim_task (first: ${claimable[0]}).`]
              : [
                  "No claimable tasks right now; call agent_teams_wait_for_work to wait for the captain. Do not end your turn — the captain ends members when the team is done.",
                ],
          report_to_captain: false,
        },
        ...context.identityWarning(),
      };
    }

    context.requireCaptain(team);
    const unreadCounts = team.members.map((member) => ({
      member: member.name,
      unread: context.store.listUnreadMessages(team.teamId, member.name).length,
    }));
    const captainUnread = context.store.listUnreadMessages(team.teamId, "captain");
    const captainIds = captainUnread.map((message) => message.id);
    if (captainIds.length > 0) {
      context.store.markMessagesRead(team.teamId, "captain", captainIds);
    }
    const refreshed = context.store.findTeam(team.teamId) ?? team;
    return {
      ok: true,
      teamId: team.teamId,
      perspective: "captain",
      team: {
        teamId: refreshed.teamId,
        goal: refreshed.goal,
        status: refreshed.status,
        members: refreshed.members,
        maxMembers: refreshed.maxMembers,
        seq: refreshed.seq,
        lastCaptainSeenAt: refreshed.lastCaptainSeenAt ?? null,
        captainHistory: refreshed.captainHistory ?? [],
      },
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        kind: task.kind,
        dependencies: task.dependencies,
        assignee: task.assignee ?? null,
        attempt_id: task.activeAttemptId ?? null,
        attempt_owner:
          task.attempts.find((attempt) => attempt.id === task.activeAttemptId)?.owner ?? null,
        summary: task.summary ?? null,
      })),
      ready_tasks: readyIds,
      blocked_by_failed_quality: tasksBlockedCompact(tasks),
      // 队长收件箱同样是读边界：成员/队长模型撰写的正文一律包装，trust_note 定性。
      unread: { captain: wrapTeamMessageBodies(captainUnread), members: unreadCounts },
      trust_note: TEAM_TRUST_NOTE,
      next_actions: computeNextActions({
        team: refreshed,
        tasks,
        perspective: "captain",
      }),
      ...(refreshed.worktreeIsolation ? { worktree_isolation: refreshed.worktreeIsolation } : {}),
      panel_url: context.panelUrl,
      ...context.identityWarning(),
    };
  },
};

/** 不带 teamId 且调用方参与 ≥2 团队时 status 的总览形状。 */
export function buildMultiTeamOverview(
  context: import("./registry.js").ToolContext,
  teams: readonly TeamState[],
): ToolResult {
  const perspective = context.identity.runtimeScope === "subagent" ? "member" : "captain";
  const overview = teams.map((team) => {
    const tasks = context.store.readTasks(team.teamId);
    const counts = { done: 0, inProgress: 0, todo: 0, failed: 0, blocked: 0 };
    for (const task of tasks) {
      if (task.status === "done") counts.done += 1;
      else if (task.status === "in_progress") counts.inProgress += 1;
      else if (task.status === "todo") counts.todo += 1;
      else if (task.status === "failed") counts.failed += 1;
      else if (task.status === "blocked") counts.blocked += 1;
    }
    const myRole =
      perspective === "captain"
        ? "captain"
        : (findBoundMemberBySession(team, context.identity.sessionId)?.name ?? "member");
    const unread =
      perspective === "captain"
        ? context.store.listUnreadMessages(team.teamId, "captain").length
        : context.store.listUnreadMessages(team.teamId, myRole).length;
    const updatedAtMs = Date.parse(team.updatedAt);
    const stale = Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > STALE_TEAM_AFTER_MS;
    return {
      teamId: team.teamId,
      goal: team.goal,
      status: team.status,
      myRole,
      counts,
      unread,
      stale,
      next_actions: computeNextActions({ team, tasks, perspective }),
    };
  });
  const totalMembers = teams.reduce((sum, team) => sum + team.members.length, 0);
  return {
    ok: true,
    perspective,
    teams: overview,
    notes: [
      `${teams.length} active teams; pass teamId to focus one.`,
      ...(totalMembers > 12
        ? [
            `warn: ${totalMembers} roster members across teams; member spawn queues may slow down. Consider archiving finished teams.`,
          ]
        : []),
    ],
    ...context.identityWarning(),
  };
}

function tasksBlockedCompact(tasks: readonly import("../state/types.js").TeamTask[]): Array<{
  taskId: string;
  blockedBy: string[];
  dependsOnStatus: Array<Record<string, string | undefined>>;
}> {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const failedGates = new Set(
    tasks
      .filter(
        (task) =>
          (task.status === "failed" || task.status === "blocked") &&
          (task.kind === "review" || task.kind === "test"),
      )
      .map((task) => task.taskId),
  );
  return tasks
    .filter(
      (task) => task.status === "todo" && task.dependencies.some((dep) => failedGates.has(dep)),
    )
    .map((task) => ({
      taskId: task.taskId,
      blockedBy: task.dependencies.filter((dep) => failedGates.has(dep)),
      dependsOnStatus: task.dependencies.map((dep) => ({ [dep]: byId.get(dep)?.status })),
    }));
}
