import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { computeNextActions } from "../scheduler.js";
import { MEMBER_NAME_PATTERN, nowIso, TeamError } from "../state/helpers.js";

const addSchema = z
  .object({
    name: z.string().regex(MEMBER_NAME_PATTERN),
    role: z.string().min(1).max(200),
    charter: z.string().min(1).max(4000),
    spawn: z.boolean().default(true),
  })
  .strict();

const bindSchema = z
  .object({
    name: z.string().regex(MEMBER_NAME_PATTERN),
    agentId: z.string().min(3).max(100),
  })
  .strict();

const removeSchema = z
  .object({
    name: z.string().regex(MEMBER_NAME_PATTERN),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const memberTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_add_member",
    description: "Captain only. Register a team member (does NOT spawn it). The tool returns a spawn_instruction: use the native Agent tool with subagent_type 'agent-teams:member', run_in_background true, and the provided prompt; then call agent_teams_bind_member with the returned agentId.",
    schema: addSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = addSchema.parse(input);
      const team = context.requireTeam();
      context.requireCaptain(team);
      if (team.members.some((member) => member.name === parsed.name && member.status !== "removed")) {
        throw new TeamError("member_exists", `Member ${parsed.name} already exists.`);
      }
      const activeMembers = team.members.filter((member) => member.status !== "removed").length;
      if (activeMembers + 1 > team.maxMembers) {
        throw new TeamError(
          "member_limit_exceeded",
          `Team roster limit is ${team.maxMembers} (active: ${activeMembers}).`,
        );
      }
      context.store.writeTeam((current) => {
        current.members.push({
          name: parsed.name,
          role: parsed.role,
          charter: parsed.charter,
          status: "registered",
          addedAt: nowIso(),
        });
      });
      const spawnPrompt = [
        `你是 AgentTeams 团队成员 ${parsed.name}，角色：${parsed.role}。`,
        `职责（charter）：${parsed.charter}`,
        `团队目标：${team.goal}`,
        `先调用 agent_teams_status 查看你的当前任务与未读消息，然后按任务契约执行。`,
        `完成后必须调用 agent_teams_update_task 更新任务，再按返回指令回报。`,
      ].join("\n\n");
      return {
        ok: true,
        member: parsed.name,
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
    description: "Captain only. Bind a registered member to the agentId returned by the native Agent tool spawn. Required before dispatch instructions can address that member.",
    schema: bindSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = bindSchema.parse(input);
      const team = context.requireTeam();
      context.requireCaptain(team);
      const other = team.members.find(
        (member) => member.agentId === parsed.agentId && member.name !== parsed.name,
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
      context.store.writeTeam((current) => {
        const target = current.members.find((item) => item.name === parsed.name);
        if (target) {
          target.agentId = parsed.agentId;
          target.status = "bound";
          target.boundSessionId = undefined;
        }
      });
      const refreshed = context.store.readTeamFile() ?? team;
      return {
        ok: true,
        member: parsed.name,
        agentId: parsed.agentId,
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
    name: "agent_teams_remove_member",
    description: "Captain only. Safely remove a member: unfinished tasks are reclaimed to unassigned, the roster is marked removed, later wakeups are ignored. Pass a reason for the audit log.",
    schema: removeSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = removeSchema.parse(input);
      const team = context.requireTeam();
      context.requireCaptain(team);
      const member = team.members.find((item) => item.name === parsed.name);
      if (!member || member.status === "removed") {
        throw new TeamError("member_not_found", `Member ${parsed.name} is not in the roster.`);
      }
      const reclaimed: string[] = [];
      for (const task of context.store.readTasks()) {
        if (task.status === "in_progress" && task.assignee === parsed.name) {
          context.store.writeTask(task.taskId, (target) => {
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
        }
      }
      context.store.writeTeam((current) => {
        const target = current.members.find((item) => item.name === parsed.name);
        if (target) {
          target.status = "removed";
          target.removedAt = nowIso();
          target.removedReason = parsed.reason;
        }
      });
      const refreshed = context.store.readTeamFile() ?? team;
      return {
        ok: true,
        member: parsed.name,
        reclaimed_tasks: reclaimed,
        next_actions: computeNextActions({
          team: refreshed,
          tasks: context.store.readTasks(),
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

function findActiveMember(team: { members: Array<{ name: string; status: string }> }, name: string) {
  return team.members.find((member) => member.name === name && member.status !== "removed");
}
