import { randomUUID } from "node:crypto";

/** 工具层公共小工具：避免各文件直接从 types.ts 拉 impure 函数。 */
export {
  ACTIVE_TEAM_STATUSES,
  ADOPTION_COOLDOWN_MS,
  CAPTAIN_ADDRESS,
  DEFAULT_MAX_ACTIVE_TEAMS,
  DEFAULT_MAX_REASSIGN_ROUNDS,
  MAX_ACTIVE_TEAMS_LIMITS,
  MEMBER_NAME_PATTERN,
  QUALITY_TASK_KINDS,
  STALE_TEAM_AFTER_MS,
  TASK_ID_PATTERN,
  TEAM_ERROR_CODES,
  TEAM_ID_PATTERN,
  TERMINAL_TASK_STATUSES,
  TeamError,
  normalizeMaxActiveTeams,
  nowIso,
  type MailboxAddress,
  type MemberStatus,
  type TaskAttempt,
  type TaskKind,
  type TaskRevision,
  type TaskStatus,
  type TeamErrorCode,
  type TeamMember,
  type TeamMessage,
  type TeamState,
  type TeamStatus,
  type TeamTask,
} from "./types.js";

export function randomTeamId(): string {
  return `team-${randomUUID().slice(0, 8)}`;
}

export function randomId(): string {
  return randomUUID();
}
