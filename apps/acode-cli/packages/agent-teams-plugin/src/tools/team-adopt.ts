import type { ToolDefinition, ToolResult } from "./registry.js";
import { z } from "zod";
import type { TeamState } from "../state/types.js";
import { ADOPTION_COOLDOWN_MS, nowIso, TeamError } from "../state/types.js";
import { TEAM_ID_PATTERN } from "../state/helpers.js";

/**
 * adopt_team：孤儿团队接管（PRD M2）。原队长会话已死/不活跃的团队，允许当前
 * main 会话把 captainSessionId 转移给自己——此前唯一出路是手工搬目录。
 * 冷静期：lastCaptainSeenAt 距今 < 10 分钟且未带 force 时拒绝，防两个活队长互抢。
 */

const adoptSchema = z
  .object({
    teamId: z.string().regex(TEAM_ID_PATTERN),
    reason: z.string().min(1).max(2000),
    force: z.boolean().default(false),
  })
  .strict();

export const adoptTeamTool: ToolDefinition = {
  name: "agent_teams_adopt_team",
  description:
    "Take over an orphaned team (its captain session is gone or inactive). Main-scope callers only: rebinds captainSessionId of a draft/active/paused team to the calling session, appending to the captainHistory ledger. Refused with adoption_conflict while the current captain was active within the last 10 minutes unless force=true. After adoption the previous captain's captain-only tools are refused. Use this when a previous session left a team behind and agent_teams_create reports it blocks your work.",
  schema: adoptSchema,
  memberAllowed: false,
  async handler(input, context): Promise<ToolResult> {
    const parsed = adoptSchema.parse(input);
    if (context.identity.runtimeScope !== "main") {
      throw new TeamError(
        "forbidden_for_caller",
        "agent_teams_adopt_team requires a main-scope caller.",
      );
    }
    const team = context.store.findTeam(parsed.teamId);
    if (!team || !isTeamActive(team)) {
      throw new TeamError("team_not_found", `Team ${parsed.teamId} is not an active team.`);
    }
    if (team.captainSessionId === context.identity.sessionId) {
      return {
        ok: true,
        teamId: team.teamId,
        adopted: false,
        protocol:
          "You are already the captain of this team; continue via agent_teams_status with its teamId.",
        ...context.identityWarning(),
      };
    }
    const lastSeen = team.lastCaptainSeenAt ? Date.parse(team.lastCaptainSeenAt) : NaN;
    const captainRecentlyActive =
      Number.isFinite(lastSeen) && Date.now() - lastSeen < ADOPTION_COOLDOWN_MS;
    if (captainRecentlyActive && !parsed.force) {
      throw new TeamError(
        "adoption_conflict",
        `Team ${parsed.teamId}'s captain was active within the last ${Math.round(ADOPTION_COOLDOWN_MS / 60000)} minutes; pass force=true to take over anyway.`,
        { teamId: team.teamId, lastCaptainSeenAt: team.lastCaptainSeenAt },
      );
    }
    const sessionId = context.identity.sessionId ?? "";
    context.store.writeTeam(team.teamId, (current) => {
      current.captainSessionId = sessionId;
      current.lastCaptainSeenAt = nowIso();
      current.captainHistory = [...(current.captainHistory ?? []), { sessionId, at: nowIso() }];
    });
    return {
      ok: true,
      teamId: team.teamId,
      adopted: true,
      reason: parsed.reason,
      forced: captainRecentlyActive,
      protocol:
        "Team adopted: you are now the captain. Call agent_teams_status with this teamId to continue dispatching.",
      ...context.identityWarning(),
    };
  },
};

function isTeamActive(team: TeamState): boolean {
  return team.status === "draft" || team.status === "active" || team.status === "paused";
}
