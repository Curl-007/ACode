import type { CallerIdentity } from "../identity.js";
import { findBoundMemberBySession } from "../identity.js";
import type { TeamStore } from "../state/store.js";
import type { TeamState } from "../state/types.js";
import { TeamError } from "../state/types.js";
import type { z } from "zod";

/**
 * 工具注册表：tools/list 对所有会话返回全量（ACode 的 tools/list 无法按调用者裁剪），
 * 权限在每次 call 时校验（memberAllowed=false 的工具由成员调用时返回 forbidden_for_caller）。
 */

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  /** 成员是否可调用（false = 队长专属）。 */
  readonly memberAllowed: boolean;
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
  maxMembers: number;
  /** 同一任务的最大重派轮次（userConfig maxReassignRounds，已归一化）。 */
  maxReassignRounds: number;
  panelUrl: string | undefined;
  /** 降级身份（手动冒烟）时在返回值上带警告，生产路径恒空对象。 */
  identityWarning(): Record<string, unknown>;
  requireTeam(): TeamState;
  requireCaptain(team: TeamState): void;
  requireMember(team: TeamState, options?: { allowCaptain?: boolean }): string;
  resolveMemberName(team: TeamState): string | undefined;
}

export function createToolContext(params: {
  store: TeamStore;
  identity: CallerIdentity;
  memberNameHint?: string;
  workspaceKey: string | undefined;
  maxMembers: number;
  maxReassignRounds: number;
  panelUrl: string | undefined;
}): ToolContext {
  const { store, identity, workspaceKey, maxMembers, maxReassignRounds, panelUrl } = params;
  const identityWarning = (): Record<string, unknown> =>
    identity.degraded
      ? { identity_degraded: "Caller identity not provided by the host (manual JSON-RPC smoke?); production calls carry _meta request context." }
      : {};
  return {
    store,
    identity,
    workspaceKey,
    maxMembers,
    maxReassignRounds,
    panelUrl,
    identityWarning,
    requireTeam(): TeamState {
      const team = store.findActiveTeam();
      if (!team) {
        throw new TeamError("no_active_team", "No active team under the workspace state root. Create one with agent_teams_create.");
      }
      return team;
    },
    requireCaptain(team: TeamState): void {
      if (identity.runtimeScope !== "main" || (!identity.degraded && team.captainSessionId !== identity.sessionId)) {
        throw new TeamError(
          "forbidden_for_caller",
          "This tool is captain-only; the calling session does not own the team.",
        );
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

export function isMemberCall(identity: CallerIdentity): boolean {
  return identity.runtimeScope === "subagent";
}
