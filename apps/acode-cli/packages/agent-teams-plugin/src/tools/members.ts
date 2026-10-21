import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { computeNextActions } from "../scheduler.js";
import { MEMBER_NAME_PATTERN, nowIso, TEAM_ID_PATTERN, TeamError } from "../state/helpers.js";
import { createMemberWorktree, describeMemberWorktree } from "../worktree/manager.js";
import { cleanupMemberWorktreeRecord } from "../worktree/lifecycle.js";

const teamIdField = z.string().regex(TEAM_ID_PATTERN).optional();

const addSchema = z
  .object({
    teamId: teamIdField,
    name: z.string().regex(MEMBER_NAME_PATTERN),
    role: z.string().min(1).max(200),
    charter: z.string().min(1).max(4000),
    spawn: z.boolean().default(true),
  })
  .strict();

const bindSchema = z
  .object({
    teamId: teamIdField,
    name: z.string().regex(MEMBER_NAME_PATTERN),
    agentId: z.string().min(3).max(100),
  })
  .strict();

const removeSchema = z
  .object({
    teamId: teamIdField,
    name: z.string().regex(MEMBER_NAME_PATTERN),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const memberTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_add_member",
    description:
      "Captain only. Register a team member (does NOT spawn it). The tool returns a spawn_instruction: use the native Agent tool with subagent_type 'agent-teams:member', run_in_background true, and the provided prompt; then call agent_teams_bind_member with the returned agentId.",
    schema: addSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = addSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      if (
        team.members.some((member) => member.name === parsed.name && member.status !== "removed")
      ) {
        throw new TeamError("member_exists", `Member ${parsed.name} already exists.`);
      }
      const activeMembers = team.members.filter((member) => member.status !== "removed").length;
      if (activeMembers + 1 > team.maxMembers) {
        throw new TeamError(
          "member_limit_exceeded",
          `Team roster limit is ${team.maxMembers} (active: ${activeMembers}).`,
        );
      }
      // SPEC-015：开启隔离时先建树再登记。建树失败不登记成员——不回落共享工作区。
      const worktree = team.worktreeIsolation?.enabled
        ? await createMemberWorktree({
            repoRoot: team.worktreeIsolation.repoRoot,
            baseBranch: team.worktreeIsolation.baseBranch,
            teamId: team.teamId,
            memberName: parsed.name,
          })
        : undefined;
      context.store.writeTeam(team.teamId, (current) => {
        current.members.push({
          name: parsed.name,
          role: parsed.role,
          charter: parsed.charter,
          status: "registered",
          addedAt: nowIso(),
          ...(worktree ? { worktree } : {}),
        });
      });
      const spawnPrompt = [
        `你是 AgentTeams 团队成员 ${parsed.name}，角色：${parsed.role}。`,
        `职责（charter）：${parsed.charter}`,
        `团队目标：${team.goal}`,
        `团队 ID：${team.teamId}。名下有多个团队时，团队级工具调用请带上这个 teamId。`,
        ...(worktree ? [describeMemberWorktree(worktree)] : []),
        `先调用 agent_teams_status 查看你的当前任务与未读消息，然后按任务契约执行。`,
        `完成后必须调用 agent_teams_update_task 更新任务，再按返回指令回报。`,
        `回报后不要结束自己：调用 agent_teams_wait_for_work 等队长派下一件活；只有团队工具返回 team_archived 或 caller_not_member（队长结束团队 / 把你移出）时才结束。`,
      ].join("\n\n");
      return {
        ok: true,
        teamId: team.teamId,
        member: parsed.name,
        ...(worktree ? { worktree } : {}),
        spawn_instruction: parsed.spawn
          ? {
              tool: "Agent",
              subagent_type: "agent-teams:member",
              description: `AgentTeams member ${parsed.name} (${parsed.role})`,
              prompt: spawnPrompt,
              run_in_background: true,
              followup: `After spawn, call agent_teams_bind_member with name="${parsed.name}" and the returned agentId.`,
            }
          : undefined,
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_bind_member",
    description:
      "Captain only. Bind a registered member to the agentId returned by the native Agent tool spawn. Required before dispatch instructions can address that member.",
    schema: bindSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = bindSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      const other = team.members.find(
        (member) =>
          member.agentId === parsed.agentId &&
          member.name !== parsed.name &&
          member.status !== "removed",
      );
      if (other) {
        throw new TeamError(
          "invalid_input",
          `agentId ${parsed.agentId} is already bound to member ${other.name}.`,
        );
      }
      const member = findActiveMember(team, parsed.name);
      if (!member) {
        throw new TeamError("member_not_found", `Member ${parsed.name} is not in the roster.`);
      }
      context.store.writeTeam(team.teamId, (current) => {
        // 修复原因（D-1）：remove 只把条目标成 removed 不删除，同名重加后 push 到末尾；按名取第一条会复活旧条目，
        // 新条目永远停在 registered。修复依据：bind/remove 的按名查找一律排除 removed 条目。
        const target = findActiveMember(current, parsed.name);
        if (target) {
          target.agentId = parsed.agentId;
          target.status = "bound";
          target.boundSessionId = undefined;
        }
      });
      const refreshed = context.store.findTeam(team.teamId) ?? team;
      return {
        ok: true,
        teamId: team.teamId,
        member: parsed.name,
        agentId: parsed.agentId,
        next_actions: computeNextActions({
          team: refreshed,
          tasks: context.store.readTasks(team.teamId),
          perspective: "captain",
        }),
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_remove_member",
    description:
      "Captain only. Safely remove a member: unfinished tasks are reclaimed to unassigned, the roster is marked removed, later wakeups are ignored. Pass a reason for the audit log.",
    schema: removeSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = removeSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      const member = findActiveMember(team, parsed.name);
      if (!member) {
        throw new TeamError("member_not_found", `Member ${parsed.name} is not in the roster.`);
      }
      // 遣散清单（SPEC-012 R20）：该成员已绑定时给出 agentId，队长 TaskStop 停其后台 Agent。
      const disband = member.agentId ? [{ name: member.name, agentId: member.agentId }] : [];
      const reclaimed: string[] = [];
      for (const task of context.store.readTasks(team.teamId)) {
        // 修复原因（D-2）：claim 只写 attempt.owner 不写 assignee，原先按 assignee 判断回收，
        // 「未指派但已被认领」的任务会永久卡在 in_progress。修复依据：按活动 attempt 的 owner 或 assignee 任一命中回收。
        const activeOwner = task.attempts.find(
          (attempt) => attempt.id === task.activeAttemptId,
        )?.owner;
        if (
          task.status === "in_progress" &&
          (activeOwner === parsed.name || task.assignee === parsed.name)
        ) {
          context.store.writeTask(team.teamId, task.taskId, (target) => {
            target.status = "todo";
            target.assignee = undefined;
            target.activeAttemptId = undefined;
            target.attempts.forEach((attempt) => {
              if (!attempt.endedAt) {
                attempt.endedAt = nowIso();
              }
            });
          });
          reclaimed.push(task.taskId);
        } else if (task.status === "todo" && task.assignee === parsed.name) {
          // 指派给被移除成员的待办任务也清掉 assignee，否则无人可认领。
          context.store.writeTask(team.teamId, task.taskId, (target) => {
            target.assignee = undefined;
          });
          reclaimed.push(task.taskId);
        }
      }
      context.store.writeTeam(team.teamId, (current) => {
        const target = findActiveMember(current, parsed.name);
        if (target) {
          target.status = "removed";
          target.removedAt = nowIso();
          target.removedReason = parsed.reason;
        }
      });
      // SPEC-015：先标记 removed，再清理工作树（cleanup 的「成员仍有进行中任务」判据
      // 按 attempt owner 判断，任务已在上面回收为 todo，所以这里能删干净树）。
      const worktree = await cleanupMemberWorktreeRecord(
        context.store,
        context.store.findTeam(team.teamId) ?? team,
        parsed.name,
      );
      if (worktree) {
        context.store.writeTeam(team.teamId, (current) => {
          const target = current.members.find((item) => item.name === parsed.name);
          if (!target?.worktree) return;
          target.worktree.lastCleanup = {
            at: nowIso(),
            removed: worktree.removed,
            branchRemoved: worktree.branchRemoved,
            ...(worktree.keptReason ? { keptReason: worktree.keptReason } : {}),
            ...(worktree.error ? { error: worktree.error } : {}),
          };
        });
      }
      const refreshed = context.store.findTeam(team.teamId) ?? team;
      return {
        ok: true,
        teamId: team.teamId,
        member: parsed.name,
        disband,
        ...(worktree ? { worktree } : {}),
        ...(disband.length > 0
          ? {
              protocol:
                "For each entry in disband[], call TaskStop with task_id = agentId (already-finished agents are fine), then continue.",
            }
          : {}),
        reclaimed_tasks: reclaimed,
        next_actions: computeNextActions({
          team: refreshed,
          tasks: context.store.readTasks(team.teamId),
          perspective: "captain",
        }),
        notes: [
          `Member ${parsed.name} removed (${parsed.reason}). If it is still running host-side, ignore its later reports.`,
        ],
        ...context.identityWarning(),
      };
    },
  },
];

function findActiveMember<T extends { name: string; status: string }>(
  team: { members: T[] },
  name: string,
): T | undefined {
  return team.members.find((member) => member.name === name && member.status !== "removed");
}
