import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { TeamState } from "./types.js";
import { ACTIVE_TEAM_STATUSES, TeamError } from "./types.js";
import { readJsonFile, sanitizeTeamId } from "./fs-helpers.js";

/**
 * 多团队目录布局（SPEC-012 / 0.2）：
 * `<root>/teams/<teamId>/{team.json,tasks/,mailbox/}`；lock、panel.json、archives/
 * 仍在根目录。本模块只做目录定位与团队级查找，不含锁与写入（TeamStore 负责）。
 */

export function teamsDir(rootDir: string): string {
  return join(rootDir, "teams");
}

export function teamDir(rootDir: string, teamId: string): string {
  return join(teamsDir(rootDir), sanitizeTeamId(teamId));
}

/**
 * 旧平铺布局（根直接放 team.json/tasks/mailbox）一次性迁移。必须在 withLock 内调用。
 * 迁移失败（句柄被 panel 进程占用等）抛结构化错误，不静默丢弃、不半迁移——
 * 昨天手工迁移踩过句柄坑，这里显式失败让用户去杀占用进程。
 */
export function migrateFlatLayoutIfNeeded(rootDir: string): void {
  const flatTeamPath = join(rootDir, "team.json");
  if (!existsSync(flatTeamPath)) return;
  const team = readJsonFile<TeamState>(flatTeamPath);
  if (!team) {
    throw new TeamError(
      "invalid_input",
      `Legacy team.json at ${flatTeamPath} is unreadable; fix or remove it manually.`,
    );
  }
  const target = teamDir(rootDir, team.teamId);
  mkdirSync(target, { recursive: true });
  renameSync(flatTeamPath, join(target, "team.json"));
  for (const [source, relative] of [
    [join(rootDir, "tasks"), "tasks"],
    [join(rootDir, "mailbox"), "mailbox"],
  ] as const) {
    if (existsSync(source)) renameSync(source, join(target, relative));
  }
}

/** 活跃（draft/active/paused）团队列表；调用方自行按需排序。 */
export function listTeams(rootDir: string): TeamState[] {
  const dir = teamsDir(rootDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const team = readJsonFile<TeamState>(join(dir, entry.name, "team.json"));
      return team && ACTIVE_TEAM_STATUSES.includes(team.status) ? [team] : [];
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function findTeam(rootDir: string, teamId: string): TeamState | undefined {
  const path = join(teamDir(rootDir, teamId), "team.json");
  const team = readJsonFile<TeamState>(path);
  if (!team || team.teamId !== teamId) return undefined;
  return team;
}

/** 唯一活跃团队的便捷读取；不存在或多于一个时返回 undefined（多团队须显式寻址）。 */
export function findSoleActiveTeam(rootDir: string): TeamState | undefined {
  const teams = listTeams(rootDir);
  return teams.length === 1 ? teams[0] : undefined;
}
