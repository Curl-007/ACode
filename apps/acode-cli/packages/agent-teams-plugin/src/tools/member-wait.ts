import type { ToolContext, ToolDefinition, ToolResult } from "./registry.js";
import { z } from "zod";
import { computeReadyTaskIds } from "../state/dag.js";
import { TEAM_ID_PATTERN } from "../state/helpers.js";

/**
 * 成员等活（常驻成员模型）：成员交付后不结束自己的后台 Agent，而是阻塞在这里等队长
 * 派活；团队结束（归档）或被移出名册时工具报错，成员随之收工——成员的生命周期统一由
 * 队长掌握。
 *
 * 阻塞期间不能占着 server 的互斥锁（所有工具调用共用一把锁），所以本工具声明
 * manageOwnLock，按「锁内探测一次 → 锁外睡一会」循环。等待上限须小于 .mcp.json 的
 * timeoutMs（600s），超时返回 ready:false，由成员再调一次继续等。
 */

const WAIT_MAX_MS = 8 * 60 * 1000;
const WAIT_POLL_INTERVAL_MS = 2_000;

const waitSchema = z.object({ teamId: z.string().regex(TEAM_ID_PATTERN).optional() }).strict();

interface WorkProbe {
  reasons: string[];
  currentTaskId?: string;
  claimable: string[];
  unread: number;
}

function probeWork(context: ToolContext, teamId: string, member: string): WorkProbe {
  // resolveTeamContext 对已归档团队抛 team_archived、requireMember 对已移出成员抛
  // caller_not_member：这两条就是「队长结束了你」的信号，原样冒泡给成员。
  const team = context.resolveTeamContext(teamId);
  context.requireMember(team);
  const tasks = context.store.readTasks(team.teamId);
  const current = tasks.find(
    (task) =>
      task.status === "in_progress" &&
      task.attempts.find((attempt) => attempt.id === task.activeAttemptId)?.owner === member,
  );
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const claimable =
    team.status === "active"
      ? computeReadyTaskIds(tasks).filter((taskId) => {
          const task = tasksById.get(taskId);
          return !task?.assignee || task.assignee === member;
        })
      : [];
  const unread = context.store.listUnreadMessages(team.teamId, member).length;
  const reasons: string[] = [];
  if (current) reasons.push("current_task");
  if (claimable.length > 0) reasons.push("claimable_tasks");
  if (unread > 0) reasons.push("unread_messages");
  return {
    reasons,
    ...(current ? { currentTaskId: current.taskId } : {}),
    claimable,
    unread,
  };
}

function markWaiting(
  context: ToolContext,
  teamId: string,
  member: string,
  until: string | undefined,
): void {
  context.store.writeTeam(teamId, (team) => {
    const entry = team.members.find((item) => item.name === member);
    if (!entry) return;
    if (until === undefined) delete entry.waitingUntil;
    else entry.waitingUntil = until;
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const waitForWorkTool: ToolDefinition = {
  name: "agent_teams_wait_for_work",
  description:
    "Member only. Block until the captain gives you work: returns as soon as you have a task in progress, a claimable task (assigned to you or unassigned and ready), or unread mailbox messages. Returns ready:false after ~8 minutes with nothing new — call it again to keep waiting. Do NOT end your turn while the team is active; the captain ends members. Errors team_archived / caller_not_member mean the captain ended the team or removed you: stop then.",
  schema: waitSchema,
  memberAllowed: true,
  manageOwnLock: true,
  async handler(input, context): Promise<ToolResult> {
    const parsed = waitSchema.parse(input);
    const deadline = Date.now() + WAIT_MAX_MS;
    const { teamId, member } = await context.store.withLock(() => {
      const team = context.resolveTeamContext(parsed.teamId);
      const name = context.requireMember(team);
      return { teamId: team.teamId, member: name };
    });
    let marked = false;
    try {
      for (;;) {
        const probe = await context.store.withLock(() => {
          const result = probeWork(context, teamId, member);
          if (result.reasons.length === 0 && !marked) {
            markWaiting(context, teamId, member, new Date(deadline).toISOString());
            marked = true;
          }
          return result;
        });
        if (probe.reasons.length > 0) {
          return {
            ok: true,
            ready: true,
            teamId,
            member,
            reasons: probe.reasons,
            ...(probe.currentTaskId ? { current_task: probe.currentTaskId } : {}),
            claimable_tasks: probe.claimable,
            unread_messages: probe.unread,
            next_actions: {
              wake: [],
              notes: [
                "Work is available: call agent_teams_status (reads your messages and task details), then claim/continue. After reporting, call agent_teams_wait_for_work again.",
              ],
              report_to_captain: false,
            },
            ...context.identityWarning(),
          };
        }
        if (Date.now() + WAIT_POLL_INTERVAL_MS >= deadline) {
          return {
            ok: true,
            ready: false,
            teamId,
            member,
            next_actions: {
              wake: [],
              notes: [
                "No work yet. Call agent_teams_wait_for_work again to keep waiting — do not end your turn; the captain ends members when the team is done.",
              ],
              report_to_captain: false,
            },
            ...context.identityWarning(),
          };
        }
        await sleep(WAIT_POLL_INTERVAL_MS);
      }
    } finally {
      if (marked) {
        await context.store
          .withLock(() => markWaiting(context, teamId, member, undefined))
          // 团队已在等待期间被归档（目录搬走）时清理标记会失败：标记随归档一起失效，忽略。
          .catch(() => undefined);
      }
    }
  },
};
