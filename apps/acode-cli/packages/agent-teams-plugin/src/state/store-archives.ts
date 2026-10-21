import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TeamMessage, TeamState, TeamTask } from "./types.js";
import { nowIso } from "./types.js";
import { countJsonFiles, readJsonFile, sanitizeTeamId } from "./fs-helpers.js";
import { findTeam, teamDir } from "./store-teams.js";

/**
 * 归档读写（SPEC-012）：archiveTeam 把 teams/<id>/ 搬到 archives/<id>-<iso>/，
 * 归档目录不可变。多团队面板与「已归档 → team_archived」判定共用这里。
 */

export function listArchivedTeams(rootDir: string): string[] {
  const archivesDir = join(rootDir, "archives");
  if (!existsSync(archivesDir)) return [];
  return readdirSync(archivesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/**
 * 最近结束的团队（归档目录名内嵌 `nowIso()` 时间戳，listArchivedTeams 已按字典序
 * 倒序 = 时间倒序）。`archiveName` 是目录名（readArchivedTeam 支持精确匹配）；
 * `endedAt` 解析不出时置空串（UI 缺省不显示时间）。
 */
export function listRecentArchivedTeams(
  rootDir: string,
  limit: number,
): Array<{ teamId: string; endedAt: string; archiveName: string }> {
  const out: Array<{ teamId: string; endedAt: string; archiveName: string }> = [];
  for (const name of listArchivedTeams(rootDir)) {
    const match = /^(.+)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/u.exec(name);
    out.push({
      teamId: match?.[1] ?? name,
      endedAt: match?.[2] ?? "",
      archiveName: name,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 归档团队的终态快照（读 team.json），字典序倒序 = 时间倒序。
 * 供「成员所属团队已归档 → team_archived」判定使用；损坏目录跳过。
 */
export function listArchivedTeamStates(rootDir: string): TeamState[] {
  const out: TeamState[] = [];
  for (const name of listArchivedTeams(rootDir)) {
    const team = readJsonFile<TeamState>(join(rootDir, "archives", name, "team.json"));
    if (team) out.push(team);
  }
  return out;
}

export interface ArchivedTeamRecord {
  team: TeamState;
  tasks: TeamTask[];
  mailboxes: Array<{ address: string; unread: number; read: number }>;
  unreadMessages: TeamMessage[];
}

export function readArchivedTeam(
  rootDir: string,
  teamId: string,
  unreadMessageLimit = 0,
): ArchivedTeamRecord | undefined {
  // 归档目录名带时间戳后缀（teamId-<iso>），按前缀解析；同一 teamId 只有一份活跃
  // 归档（archiveTeam 之前必然 active），取字典序最新。
  const safe = sanitizeTeamId(teamId);
  // 面板历史链接传的是完整目录名，先精确匹配目录名，再按 teamId 前缀回退（D-6）。
  const archived = listArchivedTeams(rootDir);
  const entry =
    archived.find((name) => name === safe) ?? archived.find((name) => name.startsWith(`${safe}-`));
  if (!entry) return undefined;
  const dir = join(rootDir, "archives", entry);
  const team = readJsonFile<TeamState>(join(dir, "team.json"));
  if (!team) return undefined;
  const mailboxDir = join(dir, "mailbox");
  const mailboxes = listMailboxesIn(mailboxDir);
  return {
    team,
    tasks: readTasksIn(join(dir, "tasks")),
    mailboxes,
    unreadMessages:
      mailboxes.reduce((sum, mailbox) => sum + mailbox.unread, 0) <= unreadMessageLimit
        ? mailboxes.flatMap((mailbox) =>
            readMessagesIn(join(mailboxDir, mailbox.address, "unread")),
          )
        : [],
  };
}

/**
 * 归档一个团队。keepFiles=true 时先把终态写盘，再把 team.json/tasks/mailbox 搬入
 * archives/<teamId>-<iso>/；false 时直接删目录。返回归档目录（审计用）。
 */
export function archiveTeam(
  rootDir: string,
  teamId: string,
  keepFiles: boolean,
  writeTeam: (teamId: string, mutate: (team: TeamState) => void) => TeamState,
): { teamId: string; archiveDir: string } | undefined {
  const team = findTeam(rootDir, teamId);
  if (!team) return undefined;
  const source = teamDir(rootDir, teamId);
  if (keepFiles) {
    writeTeam(teamId, (current) => {
      current.status = "archived";
    });
  }
  const dirName = `${team.teamId}-${nowIso().replace(/[:.]/gu, "-")}`;
  const archiveDir = join(rootDir, "archives", dirName);
  if (keepFiles) {
    mkdirSync(archiveDir, { recursive: true });
    renameSync(join(source, "team.json"), join(archiveDir, "team.json"));
    renameSync(join(source, "tasks"), join(archiveDir, "tasks"));
    renameSync(join(source, "mailbox"), join(archiveDir, "mailbox"));
  } else {
    rmSync(source, { recursive: true, force: true });
  }
  return { teamId: team.teamId, archiveDir };
}

// 归档目录与活跃团队目录同构：这里保留一份只读遍历实现，避免把 store.ts 的
// 私有方法暴露成公共 API（面板与归档读取共用同一形状）。
function listMailboxesIn(
  mailboxDir: string,
): Array<{ address: string; unread: number; read: number }> {
  if (!existsSync(mailboxDir)) return [];
  return readdirSync(mailboxDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      address: entry.name,
      unread: countJsonFiles(join(mailboxDir, entry.name, "unread")),
      read: countJsonFiles(join(mailboxDir, entry.name, "read")),
    }));
}

function readTasksIn(dir: string): TeamTask[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonFile<TeamTask>(join(dir, name)))
    .filter((task): task is TeamTask => task !== undefined)
    .sort((left, right) => left.taskId.localeCompare(right.taskId, undefined, { numeric: true }));
}

function readMessagesIn(dir: string): TeamMessage[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonFile<TeamMessage>(join(dir, name)))
    .filter((message): message is TeamMessage => message !== undefined)
    .sort(
      (left, right) =>
        left.deliveredAt.localeCompare(right.deliveredAt) || left.id.localeCompare(right.id),
    );
}
