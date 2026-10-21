import type { CallerIdentity } from "../identity.js";
import { findBoundMemberBySession, teamsCallerParticipatesIn } from "../identity.js";
import type { TeamStore } from "../state/store.js";
import type { TeamState } from "../state/types.js";
import { nowIso, TeamError } from "../state/types.js";
import type { z } from "zod";

/**
 * 工具注册表：tools/list 对所有会话返回全量（ACode 的 tools/list 无法按调用者裁剪），
 * 权限在每次 call 时校验（memberAllowed=false 的工具由成员调用时返回 forbidden_for_caller）。
 *
 * 多团队寻址（0.2）：所有团队级工具新增可选参数 teamId。解析顺序：
 * 1. 显式 teamId → 校验存在（team_not_found）；
 * 2. 未传：调用方参与的活跃团队恰好 1 个 → 隐式选中（单团队旧流程 100% 兼容）；
 *    0 个 → no_active_team；≥2 个 → team_ambiguous（data.candidates 列出团队）。
 * status 工具在 ≥2 时例外：返回多团队总览，不报歧义。
 */

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  /** 成员是否可调用（false = 队长专属）。 */
  readonly memberAllowed: boolean;
  /**
   * true：server 不替它持有互斥锁，handler 自行用 store.withLock 分段读写。只给长时间
   * 阻塞的工具（agent_teams_wait_for_work）用——它若在锁内等待会卡死所有其他调用。
   */
  readonly manageOwnLock?: boolean;
  readonly handler: (input: unknown, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface ToolResult {
  ok: boolean;
  [key: string]: unknown;
}

export interface ToolContext {
  store: TeamStore;
  identity: CallerIdentity;
  workspaceKey: string | undefined;
  /** 插件启动时的工作区目录（ACODE_PROJECT_DIR）；工作树隔离的仓库解析起点。 */
  workingDirectory: string;
  maxMembers: number;
  /** 同一任务的最大重派轮次（userConfig maxReassignRounds，已归一化）。 */
  maxReassignRounds: number;
  /** 同时活跃团队数上限（userConfig maxActiveTeams，已归一化）。 */
  maxActiveTeams: number;
  panelUrl: string | undefined;
  /** 降级身份（手动冒烟）时的成员名线索；生产路径恒 undefined。 */
  memberNameHint: string | undefined;
  /** 降级身份（手动冒烟）时在返回值上带警告，生产路径恒空对象。 */
  identityWarning(): Record<string, unknown>;
  /** 工具 handler 首行调用：把（可能缺省的）teamId 解析成确定的 TeamState。 */
  resolveTeamContext(teamId: unknown): TeamState;
  requireCaptain(team: TeamState): void;
  requireMember(team: TeamState, options?: { allowCaptain?: boolean }): string;
  resolveMemberName(team: TeamState): string | undefined;
}

export function createToolContext(params: {
  store: TeamStore;
  identity: CallerIdentity;
  memberNameHint?: string;
  workspaceKey: string | undefined;
  workingDirectory: string;
  maxMembers: number;
  maxReassignRounds: number;
  maxActiveTeams: number;
  panelUrl: string | undefined;
}): ToolContext {
  const { store, identity, workspaceKey, maxMembers, maxReassignRounds, maxActiveTeams, panelUrl } =
    params;
  const identityWarning = (): Record<string, unknown> =>
    identity.degraded
      ? {
          identity_degraded:
            "Caller identity not provided by the host (manual JSON-RPC smoke?); production calls carry _meta request context.",
        }
      : {};
  /** 显式 teamId 落空时判断它是否已归档（与「不存在」区分，SPEC-012 R18）。 */
  const isArchivedTeamId = (teamId: string): boolean =>
    store.listArchivedTeamStates().some((team) => team.teamId === teamId);
  /** 调用方（subagent）绑定的团队已归档？用于把 no_active_team 升级成 team_archived。 */
  const findArchivedTeamBoundToCaller = (): TeamState | undefined =>
    store
      .listArchivedTeamStates()
      .find((team) => findBoundMemberBySession(team, identity.sessionId));
  return {
    store,
    identity,
    workspaceKey,
    workingDirectory: params.workingDirectory,
    maxMembers,
    maxReassignRounds,
    maxActiveTeams,
    panelUrl,
    memberNameHint: params.memberNameHint,
    identityWarning,
    resolveTeamContext(teamId: unknown): TeamState {
      if (typeof teamId === "string" && teamId.length > 0) {
        const team = store.findTeam(teamId);
        if (!team || !isTeamActive(team)) {
          // 已归档的团队与「不存在」分开报：成员据此立即收工，不再重试（SPEC-012 R18）。
          if (isArchivedTeamId(teamId)) {
            throw new TeamError(
              "team_archived",
              `Team ${teamId} has ended. Stop now: do not retry, do not continue the task, end your turn.`,
            );
          }
          throw new TeamError("team_not_found", `Team ${teamId} is not an active team.`);
        }
        return team;
      }
      const allTeams = store.listTeams();
      if (allTeams.length === 0) {
        throw new TeamError(
          "no_active_team",
          "No active team under the workspace state root. Create one with agent_teams_create.",
        );
      }
      const mine = teamsCallerParticipatesIn(allTeams, identity, params.memberNameHint);
      if (mine.length === 1) return mine[0]!;
      if (mine.length === 0) {
        // subagent 未绑定进任何团队：与旧语义一致报 caller_not_member（而不是
        // no_active_team——团队明明存在，缺的是这个调用者的成员身份）。
        if (identity.runtimeScope === "subagent") {
          // 该成员绑定的团队已归档 → team_archived（收工信号）；未被任何团队绑定才报
          // caller_not_member（SPEC-012 R18）。
          const endedTeam = findArchivedTeamBoundToCaller();
          if (endedTeam) {
            throw new TeamError(
              "team_archived",
              `Team ${endedTeam.teamId} has ended. Stop now: do not retry, do not continue the task, end your turn.`,
            );
          }
          throw new TeamError(
            "caller_not_member",
            "Calling subagent is not bound to any active team's roster; the captain must call agent_teams_bind_member with this subagent's agentId.",
          );
        }
        throw new TeamError(
          "no_active_team",
          "No active team owned by this session. Create one with agent_teams_create or adopt one with agent_teams_adopt_team.",
        );
      }
      throw new TeamError(
        "team_ambiguous",
        `You participate in ${mine.length} active teams; pass an explicit teamId. (status without teamId returns the multi-team overview.)`,
        {
          candidates: mine.map((team) => ({
            teamId: team.teamId,
            goal: team.goal,
            status: team.status,
          })),
        },
      );
    },
    requireCaptain(team: TeamState): void {
      if (
        identity.runtimeScope !== "main" ||
        (!identity.degraded && team.captainSessionId !== identity.sessionId)
      ) {
        throw new TeamError(
          "forbidden_for_caller",
          "This tool is captain-only; the calling session does not own the team.",
        );
      }
      // 队长鉴权通过即刷新活跃时间戳（adopt_team 冷静期判据）。写盘失败不阻断工具调用：
      // 刷新是尽力而为的信号，工具语义本身已通过鉴权。
      try {
        store.writeTeam(team.teamId, (current) => {
          current.lastCaptainSeenAt = nowIso();
        });
      } catch {
        // 团队被并发归档等竞态：鉴权已按读到的快照通过，静默放弃刷新。
      }
    },
    requireMember(team: TeamState, options?: { allowCaptain?: boolean }): string {
      // 队长兼成员（takeover 后更新任务）：main scope + 严格 sessionId 匹配。
      if (
        options?.allowCaptain &&
        identity.runtimeScope === "main" &&
        (identity.degraded || team.captainSessionId === identity.sessionId)
      ) {
        return "captain";
      }
      if (identity.degraded && params.memberNameHint) {
        const member = team.members.find(
          (item) => item.name === params.memberNameHint && item.status !== "removed",
        );
        if (member) return member.name;
      }
      if (identity.runtimeScope !== "subagent") {
        throw new TeamError(
          "caller_not_member",
          "This tool requires a member (subagent) caller or the captain.",
        );
      }
      const bound = findBoundMemberBySession(team, identity.sessionId);
      if (bound) return bound.name;
      throw new TeamError(
        "caller_not_member",
        "Calling subagent is not bound to a roster member; the captain must call agent_teams_bind_member with this subagent's agentId.",
      );
    },
    resolveMemberName(team: TeamState): string | undefined {
      if (identity.runtimeScope !== "subagent") return undefined;
      if (identity.degraded && params.memberNameHint) {
        const member = team.members.find(
          (item) => item.name === params.memberNameHint && item.status !== "removed",
        );
        return member?.name;
      }
      return findBoundMemberBySession(team, identity.sessionId)?.name;
    },
  };
}

function isTeamActive(team: TeamState): boolean {
  return team.status === "draft" || team.status === "active" || team.status === "paused";
}

export function isMemberCall(identity: CallerIdentity): boolean {
  return identity.runtimeScope === "subagent";
}
