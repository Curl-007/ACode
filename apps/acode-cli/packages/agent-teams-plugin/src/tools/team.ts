import type { ToolDefinition, ToolResult } from "./registry.js";
import { z } from "zod";
import { computeNextActions } from "../scheduler.js";
import type { TeamState } from "../state/types.js";
import { nowIso, TeamError } from "../state/types.js";
import { randomTeamId, TEAM_ID_PATTERN } from "../state/helpers.js";
import { statusTool } from "./team-status.js";
import { adoptTeamTool } from "./team-adopt.js";
import { inspectRepo } from "../worktree/manager.js";
import { cleanupTeamWorktrees } from "../worktree/lifecycle.js";

/**
 * 团队生命周期工具：create / approve_plan / resume / delete。
 * status 在 team-status.ts（单团队全量 + 多团队总览），adopt_team 在 team-adopt.ts。
 */

const teamIdField = z.string().regex(TEAM_ID_PATTERN).optional();

/**
 * 遣散清单：名册中未移除且已绑定 agentId 的成员（含已结束本轮的——对已终态任务回
 * alreadyTerminal，无害）。队长按清单逐个 TaskStop，停掉成员的后台 Agent。
 */
export function collectDisbandRoster(
  team: Pick<TeamState, "members">,
): Array<{ name: string; agentId: string }> {
  return team.members
    .filter((member) => member.status !== "removed" && member.agentId !== undefined)
    .map((member) => ({ name: member.name, agentId: member.agentId as string }));
}

const createSchema = z
  .object({
    goal: z.string().min(1).max(2000),
    approval: z.enum(["required", "automatic"]).default("required"),
    maxMembers: z.number().int().min(1).max(32).optional(),
    // SPEC-015：默认关闭，保持既有共享工作区行为；只在建队时生效。
    worktreeIsolation: z.boolean().default(false),
  })
  .strict();

const approveSchema = z
  .object({
    teamId: teamIdField,
    confirmation: z.string().min(1).max(2000),
  })
  .strict();

const resumeSchema = z
  .object({
    teamId: teamIdField,
    reason: z.string().min(1).max(2000),
  })
  .strict();

const deleteSchema = z
  .object({
    teamId: teamIdField,
    archive: z.boolean().default(true),
  })
  .strict();

export const teamTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_create",
    description:
      "Create an AgentTeams team for the current goal. The calling session becomes the captain. Defaults to draft (approval required); members are not spawned and tasks are not scheduled until agent_teams_approve_plan. A workspace may hold multiple active teams (up to maxActiveTeams, default 4); other teams are addressed by passing teamId.",
    schema: createSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = createSchema.parse(input);
      const activeTeams = context.store.listTeams();
      if (activeTeams.length >= context.maxActiveTeams) {
        throw new TeamError(
          "team_limit_exceeded",
          `Active team limit is ${context.maxActiveTeams} (active: ${activeTeams.length}). Archive a team with agent_teams_delete first.`,
          {
            activeTeams: activeTeams.map((team) => ({ teamId: team.teamId, status: team.status })),
            maxActiveTeams: context.maxActiveTeams,
          },
        );
      }
      // SPEC-015：开启隔离时先解析仓库；失败即拒绝建队，不回落共享工作区。
      const repo = parsed.worktreeIsolation
        ? await inspectRepo(context.workingDirectory)
        : undefined;
      const team = {
        teamId: randomTeamId(),
        goal: parsed.goal,
        status: (parsed.approval === "automatic" ? "active" : "draft") as TeamState["status"],
        captainSessionId: context.identity.sessionId ?? "",
        lastCaptainSeenAt: nowIso(),
        captainHistory: [{ sessionId: context.identity.sessionId ?? "", at: nowIso() }],
        workspaceKey: context.workspaceKey ?? "",
        workspaceKeyDegraded: !context.workspaceKey,
        maxMembers: parsed.maxMembers ?? context.maxMembers,
        ...(repo
          ? {
              worktreeIsolation: {
                enabled: true as const,
                repoRoot: repo.repoRoot,
                baseBranch: repo.baseBranch,
                createdAt: nowIso(),
              },
            }
          : {}),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        seq: 1,
        members: [],
      } satisfies TeamState;
      context.store.createTeam(team);
      return {
        ok: true,
        teamId: team.teamId,
        status: team.status,
        panel_url: context.panelUrl,
        ...(repo
          ? {
              worktree_isolation: {
                enabled: true,
                repoRoot: repo.repoRoot,
                baseBranch: repo.baseBranch,
              },
            }
          : {}),
        protocol: [
          team.status === "draft"
            ? "Draft mode: add members (agent_teams_add_member), create tasks (agent_teams_create_task), present roster+DAG to the user, then agent_teams_approve_plan."
            : "Team is active: create members and tasks, then follow next_actions to dispatch.",
          activeTeams.length > 0
            ? `Workspace now has ${activeTeams.length + 1} active teams; pass teamId on team-level calls to address one explicitly.`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        ...context.identityWarning(),
      };
    },
  },
  {
    name: "agent_teams_approve_plan",
    description:
      "Captain only. Move a draft team to active and start scheduling. Requires a non-empty roster and at least one task. Pass the user's approval wording for the audit log.",
    schema: approveSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = approveSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      if (team.status !== "draft") {
        throw new TeamError("team_not_draft", `Team status is ${team.status}, not draft.`);
      }
      const tasks = context.store.readTasks(team.teamId);
      if (team.members.length === 0 || tasks.length === 0) {
        throw new TeamError(
          "roster_empty",
          "Roster and task DAG must be non-empty before approval.",
        );
      }
      context.store.writeTeam(team.teamId, (draft) => {
        draft.status = "active";
      });
      const refreshed = context.store.findTeam(team.teamId);
      const refreshedTasks = context.store.readTasks(team.teamId);
      return {
        ok: true,
        teamId: team.teamId,
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
    name: "agent_teams_resume",
    description:
      "Captain only. Resume a paused team with a non-empty reason. Cancelled tasks are not rebuilt.",
    schema: resumeSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = resumeSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      if (team.status !== "paused") {
        throw new TeamError("team_not_paused", `Team status is ${team.status}, not paused.`);
      }
      context.store.writeTeam(team.teamId, (paused) => {
        paused.status = "active";
      });
      const refreshed = context.store.findTeam(team.teamId) ?? team;
      return {
        ok: true,
        teamId: team.teamId,
        status: refreshed.status,
        reason: parsed.reason,
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
    name: "agent_teams_delete",
    description:
      "Captain only. End the team. Default archives tasks, dependency graph and mailboxes under .agent-teams/archives/; pass archive:false to discard them. After this, team tools are closed; the panel stays readable for history.",
    schema: deleteSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = deleteSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      // 遣散清单必须在 archiveTeam 前取：归档会移走/删除 team.json（修复原因见 SPEC-012 §3.6）。
      const disband = collectDisbandRoster(team);
      // SPEC-015：清理工作树也必须先于归档——归档会搬走 team.json，之后再无句柄可查。
      // 清理结果写回 team.json 后再归档，保留事后审计所需的分支/路径与结果。
      const worktrees = await cleanupTeamWorktrees(context.store, team);
      const outcome = context.store.archiveTeam(team.teamId, parsed.archive);
      return {
        ok: true,
        archived: parsed.archive,
        teamId: outcome?.teamId ?? team.teamId,
        archive_dir: parsed.archive ? outcome?.archiveDir : undefined,
        disband,
        ...(worktrees ? { worktrees } : {}),
        protocol:
          "Team ended. For EVERY entry in disband[], call TaskStop with task_id = agentId (already-finished agents are fine). Then summarize the combined result to the user.",
        ...context.identityWarning(),
      };
    },
  },
  statusTool,
  adoptTeamTool,
];
