import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { TeamMessage, TeamState, TeamTask } from "./types.js";
import { ACTIVE_TEAM_STATUSES, CAPTAIN_ADDRESS, nowIso, TeamError } from "./types.js";
import {
  countJsonFiles,
  readLockInfo,
  sanitizeMailboxDir,
  sanitizeTeamId,
  TEAM_LOCK_STALE_MS,
} from "./fs-helpers.js";

/**
 * 文件状态存储：磁盘是唯一真相。
 * - 进程内互斥：所有读写改都进 per-store 的 Promise 链（server 单进程，串行化副作用）。
 * - 原子写：writeFile(tmp) → rename。
 * - 跨进程：lock 文件 + O_EXCL + 5s stale 判定；拿不到锁报结构化错误，不自旋。
 * - 每次写递增 team.seq（面板与冷恢复的进度差量依据）。
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

  findActiveTeam(): TeamState | undefined {
    const team = this.readTeamFile();
    if (team && ACTIVE_TEAM_STATUSES.includes(team.status)) return team;
    return undefined;
  }

  readTeamFile(): TeamState | undefined {
    return this.readJson<TeamState>(join(this.rootDir, "team.json"));
  }

  listArchivedTeams(): string[] {
    const archivesDir = join(this.rootDir, "archives");
    if (!existsSync(archivesDir)) return [];
    return readdirSync(archivesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  }

  readArchivedTeam(teamId: string, unreadMessageLimit = 0): {
    team: TeamState;
    tasks: TeamTask[];
    mailboxes: Array<{ address: string; unread: number; read: number }>;
    unreadMessages: TeamMessage[];
  } | undefined {
    // 归档目录名带时间戳后缀（teamId-<iso>），按前缀解析；同一 teamId 只有一份活跃
    // 归档（archiveTeam 之前必然 active），取字典序最新。
    const safe = sanitizeTeamId(teamId);
    const entry = this.listArchivedTeams().find((name) => name.startsWith(`${safe}-`));
    if (!entry) return undefined;
    const dir = join(this.rootDir, "archives", entry);
    const team = this.readJson<TeamState>(join(dir, "team.json"));
    if (!team) return undefined;
    const mailboxDir = join(dir, "mailbox");
    const mailboxes = this.listMailboxesIn(mailboxDir);
    return {
      team,
      tasks: this.readTasksIn(join(dir, "tasks")),
      mailboxes,
      unreadMessages:
        mailboxes.reduce((sum, mailbox) => sum + mailbox.unread, 0) <= unreadMessageLimit
          ? mailboxes.flatMap((mailbox) =>
              this.readMessagesIn(join(mailboxDir, mailbox.address, "unread")),
            )
          : [],
    };
  }

  writeTeam(mutate: (team: TeamState) => void): void {
    const team = this.readTeamFile();
    if (!team) {
      throw new TeamError("no_active_team", "No team.json found under state root.");
    }
    mutate(team);
    team.updatedAt = nowIso();
    team.seq += 1;
    this.writeJsonAtomic(join(this.rootDir, "team.json"), team);
  }

  nextTaskId(): string {
    const tasks = this.readTasks();
    let max = 0;
    for (const task of tasks) {
      const num = Number.parseInt(task.taskId.slice(2), 10);
      if (Number.isFinite(num) && num > max) max = num;
    }
    return `t-${max + 1}`;
  }

  readTasks(): TeamTask[] {
    return this.readTasksIn(join(this.rootDir, "tasks"));
  }

  readTask(taskId: string): TeamTask | undefined {
    return this.readJson<TeamTask>(join(this.rootDir, "tasks", `${taskId}.json`));
  }

  upsertTask(task: TeamTask): TeamTask {
    const path = join(this.rootDir, "tasks", `${task.taskId}.json`);
    const next: TeamTask = { ...task, updatedAt: nowIso() };
    const team = this.readTeamFile();
    if (team) {
      // 任务写入也推进团队 seq：面板按 team.seq 轮询差量，漏掉任务变化会出现“完成了但
      // 面板不动”的假象。
      team.updatedAt = nowIso();
      team.seq += 1;
      this.writeJsonAtomic(join(this.rootDir, "team.json"), team);
    }
    this.writeJsonAtomic(path, next);
    return next;
  }

  writeTask(taskId: string, mutate: (task: TeamTask) => void): TeamTask {
    const path = join(this.rootDir, "tasks", `${taskId}.json`);
    const task = this.readJson<TeamTask>(path);
    if (!task) {
      throw new TeamError("task_not_found", `Task ${taskId} not found.`);
    }
    mutate(task);
    task.updatedAt = nowIso();
    const team = this.readTeamFile();
    if (team) {
      // 任务写入也推进团队 seq：面板按 team.seq 轮询差量，漏掉任务变化会出现“完成了但
      // 面板不动”的假象。
      team.updatedAt = nowIso();
      team.seq += 1;
      this.writeJsonAtomic(join(this.rootDir, "team.json"), team);
    }
    this.writeJsonAtomic(path, task);
    return task;
  }

  archiveTeam(keepFiles: boolean): { teamId: string; archiveDir: string } | undefined {
    const team = this.readTeamFile();
    if (!team) return undefined;
    if (keepFiles) {
      this.writeTeam((current) => {
        current.status = "archived";
      });
    }
    const dirName = `${team.teamId}-${nowIso().replace(/[:.]/gu, "-")}`;
    const archiveDir = join(this.rootDir, "archives", dirName);
    if (keepFiles) {
      mkdirSync(archiveDir, { recursive: true });
      renameSync(join(this.rootDir, "team.json"), join(archiveDir, "team.json"));
      renameSync(join(this.rootDir, "tasks"), join(archiveDir, "tasks"));
      renameSync(join(this.rootDir, "mailbox"), join(archiveDir, "mailbox"));
    } else {
      rmSync(join(this.rootDir, "team.json"), { force: true });
      rmSync(join(this.rootDir, "tasks"), { recursive: true, force: true });
      rmSync(join(this.rootDir, "mailbox"), { recursive: true, force: true });
    }
    return { teamId: team.teamId, archiveDir };
  }

  deliverMessage(address: string, message: Omit<TeamMessage, "id" | "deliveredAt">): TeamMessage {
    const normalized = address === CAPTAIN_ADDRESS ? CAPTAIN_ADDRESS : sanitizeMailboxDir(address);
    const unreadDir = join(this.rootDir, "mailbox", normalized, "unread");
    mkdirSync(unreadDir, { recursive: true });
    const full: TeamMessage = {
      ...message,
      id: randomUUID(),
      deliveredAt: nowIso(),
    };
    this.writeJsonAtomic(join(unreadDir, `${full.id}.json`), full);
    const team = this.readTeamFile();
    if (team) {
      team.updatedAt = nowIso();
      team.seq += 1;
      this.writeJsonAtomic(join(this.rootDir, "team.json"), team);
    }
    return full;
  }

  listUnreadMessages(address: string): TeamMessage[] {
    const normalized = address === CAPTAIN_ADDRESS ? CAPTAIN_ADDRESS : sanitizeMailboxDir(address);
    const dir = join(this.rootDir, "mailbox", normalized, "unread");
    return this.readMessagesIn(dir);
  }

  /** 读取即置 read：成员 status 视图与队长收件箱消费共用。 */
  markMessagesRead(address: string, ids: readonly string[]): number {
    const normalized = address === CAPTAIN_ADDRESS ? CAPTAIN_ADDRESS : sanitizeMailboxDir(address);
    const unreadDir = join(this.rootDir, "mailbox", normalized, "unread");
    const readDir = join(this.rootDir, "mailbox", normalized, "read");
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
      this.writeTeam(() => undefined);
    }
    return moved;
  }

  /** 面板用：全量消息摘要（unarchived 团队）。 */
  listAllMailboxes(): Array<{ address: string; unread: number; read: number }> {
    return this.listMailboxesIn(join(this.rootDir, "mailbox"));
  }

  private listMailboxesIn(mailboxDir: string): Array<{ address: string; unread: number; read: number }> {
    if (!existsSync(mailboxDir)) return [];
    return readdirSync(mailboxDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        address: entry.name,
        unread: countJsonFiles(join(mailboxDir, entry.name, "unread")),
        read: countJsonFiles(join(mailboxDir, entry.name, "read")),
      }));
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

  writePanelInfo(info: Record<string, unknown>): void {
    this.writeJsonAtomic(join(this.rootDir, "panel.json"), info);
  }

  createTeamDirectories(): void {
    mkdirSync(join(this.rootDir, "tasks"), { recursive: true });
    mkdirSync(join(this.rootDir, "mailbox"), { recursive: true });
  }

  writeTeamFileIfAbsent(team: TeamState): void {
    const path = join(this.rootDir, "team.json");
    if (existsSync(path)) {
      throw new TeamError("team_exists", "team.json already exists under state root.");
    }
    this.writeJsonAtomic(path, team);
  }

  private readTasksIn(dir: string): TeamTask[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readJson<TeamTask>(join(dir, name)))
      .filter((task): task is TeamTask => task !== undefined)
      .sort((left, right) => left.taskId.localeCompare(right.taskId, undefined, { numeric: true }));
  }

  private readJson<T>(path: string): T | undefined {
    try {
      if (!existsSync(path)) return undefined;
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return undefined;
    }
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
