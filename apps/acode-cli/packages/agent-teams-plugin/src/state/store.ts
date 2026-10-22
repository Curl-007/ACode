import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { TeamMessage, TeamState, TeamTask } from "./types.js";
import { CAPTAIN_ADDRESS, nowIso, TeamError } from "./types.js";
import {
  countJsonFiles,
  readJsonFile,
  readLockInfo,
  sanitizeMailboxDir,
  sanitizeTeamId,
  TEAM_LOCK_STALE_MS,
} from "./fs-helpers.js";
import {
  findSoleActiveTeam as findSoleActiveTeamIn,
  findTeam as findTeamIn,
  listTeams as listTeamsIn,
  migrateFlatLayoutIfNeeded as migrateFlatLayout,
  teamDir,
  teamsDir,
} from "./store-teams.js";
import {
  archiveTeam as archiveTeamIn,
  listArchivedTeams as listArchivedTeamsIn,
  listArchivedTeamStates as listArchivedTeamStatesIn,
  listRecentArchivedTeams as listRecentArchivedTeamsIn,
  readArchivedTeam as readArchivedTeamIn,
  type ArchivedTeamRecord,
} from "./store-archives.js";

/**
 * 文件状态存储：磁盘是唯一真相。
 * - 进程内互斥：所有读写改都进 per-store 的 Promise 链（server 单进程，串行化副作用）。
 * - 原子写：writeFile(tmp) → rename。
 * - 跨进程：lock 文件 + O_EXCL + 5s stale 判定；拿不到锁报结构化错误，不自旋。
 * - 每次写递增 team.seq（团队内单调，面板与冷恢复的进度差量依据）。
 *
 * 多团队布局（0.2）：`teams/<teamId>/{team.json, tasks/, mailbox/}`；lock 与 panel.json
 * 仍在根。目录定位与团队/归档查找拆到 store-teams.ts / store-archives.ts，
 * 本文件只保留锁、原子 JSON 与 team/task/mailbox 的基础读写。
 * 锁保持全根一把：工具调用是模型节奏（秒级），分团队锁换来的是「多把锁的写序」
 * 复杂度，收益不成比例。
 */
export class TeamStore {
  private readonly rootDir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private lockHeld = false;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  get root(): string {
    return this.rootDir;
  }

  /** 互斥段：同进程内所有读-改-写串行；返回值透传。 */
  async withLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.acquireProcessLock();
      try {
        return await operation();
      } finally {
        this.releaseProcessLock();
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private acquireProcessLock(): void {
    const lockPath = join(this.rootDir, "lock");
    mkdirSync(this.rootDir, { recursive: true });
    if (this.lockHeld) return;
    if (!existsSync(lockPath)) {
      try {
        writeFileSync(lockPath, `${process.pid} ${nowIso()}\n`, { flag: "wx" });
        this.lockHeld = true;
        return;
      } catch {
        // 创建失败 → 落入 stale 判定。
      }
    }
    const info = readLockInfo(lockPath);
    if (info?.pid === process.pid) {
      this.lockHeld = true;
      return;
    }
    if (info && Date.now() - info.at < TEAM_LOCK_STALE_MS) {
      throw new TeamError(
        "another_process_holds_team_lock",
        `Another process (pid ${info.pid}) holds the team lock at ${lockPath}.`,
        { holderPid: info.pid, lockPath },
      );
    }
    // 过期锁：接管。
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, `${process.pid} ${nowIso()}\n`, { flag: "wx" });
    this.lockHeld = true;
  }

  private releaseProcessLock(): void {
    if (!this.lockHeld) return;
    const lockPath = join(this.rootDir, "lock");
    const info = readLockInfo(lockPath);
    if (info?.pid === process.pid) rmSync(lockPath, { force: true });
    this.lockHeld = false;
  }

  /** 进程退出时释放（server shutdown 钩子调用；磁盘上的状态不动）。 */
  releaseLockOnShutdown(): void {
    this.releaseProcessLock();
  }

  // ---- 多团队目录 / 归档（实现见 store-teams.ts / store-archives.ts） ----

  migrateFlatLayoutIfNeeded(): void {
    migrateFlatLayout(this.rootDir);
  }

  listTeams(): TeamState[] {
    return listTeamsIn(this.rootDir);
  }

  findTeam(teamId: string): TeamState | undefined {
    return findTeamIn(this.rootDir, teamId);
  }

  findSoleActiveTeam(): TeamState | undefined {
    return findSoleActiveTeamIn(this.rootDir);
  }

  listArchivedTeams(): string[] {
    return listArchivedTeamsIn(this.rootDir);
  }

  listRecentArchivedTeams(limit: number): Array<{
    teamId: string;
    endedAt: string;
    archiveName: string;
  }> {
    return listRecentArchivedTeamsIn(this.rootDir, limit);
  }

  listArchivedTeamStates(): TeamState[] {
    return listArchivedTeamStatesIn(this.rootDir);
  }

  readArchivedTeam(teamId: string, unreadMessageLimit = 0): ArchivedTeamRecord | undefined {
    return readArchivedTeamIn(this.rootDir, teamId, unreadMessageLimit);
  }

  archiveTeam(
    teamId: string,
    keepFiles: boolean,
  ): { teamId: string; archiveDir: string } | undefined {
    return archiveTeamIn(this.rootDir, teamId, keepFiles, (id, mutate) =>
      this.writeTeam(id, mutate),
    );
  }

  // ---- team / task / mailbox 基础读写 ---------------------------------

  writeTeam(teamId: string, mutate: (team: TeamState) => void): TeamState {
    const path = join(teamDir(this.rootDir, teamId), "team.json");
    const team = this.readJson<TeamState>(path);
    if (!team) {
      throw new TeamError("team_not_found", `Team ${teamId} not found under state root.`);
    }
    mutate(team);
    team.updatedAt = nowIso();
    team.seq += 1;
    this.writeJsonAtomic(path, team);
    return team;
  }

  nextTaskId(teamId: string): string {
    const tasks = this.readTasks(teamId);
    let max = 0;
    for (const task of tasks) {
      const num = Number.parseInt(task.taskId.slice(2), 10);
      if (Number.isFinite(num) && num > max) max = num;
    }
    return `t-${max + 1}`;
  }

  readTasks(teamId: string): TeamTask[] {
    const dir = join(teamDir(this.rootDir, teamId), "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readJson<TeamTask>(join(dir, name)))
      .filter((task): task is TeamTask => task !== undefined)
      .sort((left, right) => left.taskId.localeCompare(right.taskId, undefined, { numeric: true }));
  }

  readTask(teamId: string, taskId: string): TeamTask | undefined {
    return this.readJson<TeamTask>(join(teamDir(this.rootDir, teamId), "tasks", `${taskId}.json`));
  }

  upsertTask(teamId: string, task: TeamTask): TeamTask {
    const path = join(teamDir(this.rootDir, teamId), "tasks", `${task.taskId}.json`);
    const next: TeamTask = { ...task, updatedAt: nowIso() };
    // 任务写入也推进团队 seq：面板按 team.seq 轮询差量，漏掉任务变化会出现“完成了但
    // 面板不动”的假象。
    this.writeTeam(teamId, () => undefined);
    this.writeJsonAtomic(path, next);
    return next;
  }

  writeTask(teamId: string, taskId: string, mutate: (task: TeamTask) => void): TeamTask {
    const path = join(teamDir(this.rootDir, teamId), "tasks", `${taskId}.json`);
    const task = this.readJson<TeamTask>(path);
    if (!task) {
      throw new TeamError("task_not_found", `Task ${taskId} not found.`);
    }
    mutate(task);
    task.updatedAt = nowIso();
    // 任务写入也推进团队 seq：面板按 team.seq 轮询差量，漏掉任务变化会出现“完成了但
    // 面板不动”的假象。
    this.writeTeam(teamId, () => undefined);
    this.writeJsonAtomic(path, task);
    return task;
  }

  deliverMessage(
    teamId: string,
    address: string,
    message: Omit<TeamMessage, "id" | "deliveredAt">,
  ): TeamMessage {
    const normalized = address === CAPTAIN_ADDRESS ? CAPTAIN_ADDRESS : sanitizeMailboxDir(address);
    const unreadDir = join(teamDir(this.rootDir, teamId), "mailbox", normalized, "unread");
    mkdirSync(unreadDir, { recursive: true });
    const full: TeamMessage = {
      ...message,
      id: randomUUID(),
      deliveredAt: nowIso(),
    };
    this.writeJsonAtomic(join(unreadDir, `${full.id}.json`), full);
    this.writeTeam(teamId, () => undefined);
    return full;
  }

  listUnreadMessages(teamId: string, address: string): TeamMessage[] {
    const normalized = address === CAPTAIN_ADDRESS ? CAPTAIN_ADDRESS : sanitizeMailboxDir(address);
    const dir = join(teamDir(this.rootDir, teamId), "mailbox", normalized, "unread");
    return this.readMessagesIn(dir);
  }

  /** 读取即置 read：成员 status 视图与队长收件箱消费共用。 */
  markMessagesRead(teamId: string, address: string, ids: readonly string[]): number {
    const normalized = address === CAPTAIN_ADDRESS ? CAPTAIN_ADDRESS : sanitizeMailboxDir(address);
    const base = join(teamDir(this.rootDir, teamId), "mailbox", normalized);
    const unreadDir = join(base, "unread");
    const readDir = join(base, "read");
    let moved = 0;
    for (const id of ids) {
      const unreadPath = join(unreadDir, `${id}.json`);
      if (!existsSync(unreadPath)) continue;
      mkdirSync(readDir, { recursive: true });
      const message = this.readJson<TeamMessage>(unreadPath);
      if (message) {
        message.readAt = nowIso();
        this.writeJsonAtomic(join(readDir, `${id}.json`), message);
      }
      rmSync(unreadPath, { force: true });
      moved += 1;
    }
    if (moved > 0) {
      // 读信也改变面板投影；不推进 seq 会让未读数停留在送达时的旧快照。
      this.writeTeam(teamId, () => undefined);
    }
    return moved;
  }

  /** 面板用：指定团队的全量消息摘要（unarchived 团队）。 */
  listAllMailboxes(teamId: string): Array<{ address: string; unread: number; read: number }> {
    const mailboxDir = join(teamDir(this.rootDir, teamId), "mailbox");
    if (!existsSync(mailboxDir)) return [];
    return readdirSync(mailboxDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        address: entry.name,
        unread: countJsonFiles(join(mailboxDir, entry.name, "unread")),
        read: countJsonFiles(join(mailboxDir, entry.name, "read")),
      }));
  }

  writePanelInfo(info: Record<string, unknown>): void {
    this.writeJsonAtomic(join(this.rootDir, "panel.json"), info);
  }

  /** 建团队目录（teams/<id>/tasks + mailbox）。 */
  createTeamDirectories(teamId: string): void {
    const dir = teamDir(this.rootDir, teamId);
    mkdirSync(join(dir, "tasks"), { recursive: true });
    mkdirSync(join(dir, "mailbox"), { recursive: true });
  }

  createTeam(team: TeamState): void {
    const path = join(teamDir(this.rootDir, team.teamId), "team.json");
    if (existsSync(path)) {
      throw new TeamError("team_exists", `Team ${team.teamId} already exists.`);
    }
    this.createTeamDirectories(team.teamId);
    this.writeJsonAtomic(path, team);
  }

  /** 兼容旧调用（测试与 smoke）：确保 teams/ 根目录存在。 */
  ensureTeamsDirectory(): void {
    mkdirSync(teamsDir(this.rootDir), { recursive: true });
  }

  private readMessagesIn(dir: string): TeamMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readJson<TeamMessage>(join(dir, name)))
      .filter((message): message is TeamMessage => message !== undefined)
      .sort(
        (left, right) =>
          left.deliveredAt.localeCompare(right.deliveredAt) || left.id.localeCompare(right.id),
      );
  }

  private readJson<T>(path: string): T | undefined {
    return readJsonFile<T>(path);
  }

  private writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmpPath = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    writeFileSync(tmpPath, `${JSON.stringify(value)}\n`, "utf8");
    renameSync(tmpPath, path);
  }
}

export function resolveStateRoot(input: {
  envStateDir?: string;
  workingDirectory: string;
}): string {
  const override = input.envStateDir?.trim();
  if (override) return resolve(override);
  return resolve(input.workingDirectory, ".agent-teams");
}

export function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

// 供需要直接拼接团队目录的模块（panel 只读路径等）复用；避免各自手写字符串。
export { teamDir, teamsDir, sanitizeTeamId };
