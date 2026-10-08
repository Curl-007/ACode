// 通用「锁定 JSON 文件存储」机制（锁 / 原子写 / 损坏恢复），从 Workspace Hook
// Trust store 的既有实现对称提炼，供安全类小文件存储复用（当前消费者：
// workspace-mcp-trust-store.ts；hook store 的迁移是后续工作，两者行为语义一致）。
//
// 并发正确性语义（与 workspace-hook-trust-store.ts 逐条对齐）：
// - 锁内容 = pid + 进程实例启动时间 + 不可预测 token；裸 pid 会被系统复用，
//   stale 回收必须用启动时间区分「原 owner 存活」与「pid 已易主」；
// - 释放前验证所有权，防止删掉新持有者的锁；
// - 写入 = 临时文件 wx 独占 + fsync + rename（Windows 杀软短暂占用时有界重试）；
// - 读取损坏 = fail-closed 返回 corrupt，并把损坏文件改名 *.corrupt-<ts> 留证。
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { uptime } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;
const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
// 进程启动时间的比较容差：ps/proc 的秒级精度 + 调度延迟，2s 足以覆盖且不放过复用。
const LOCK_START_TIME_TOLERANCE_MS = 2_000;
const PROC_CLOCK_TICKS_PER_SECOND = 100;

const execFileAsync = promisify(execFile);

export interface LockedJsonStoreFileCodec<TFile> {
  /** 解析文件内容；非法时抛错（触发 corrupt 恢复路径）。 */
  parse(value: unknown): TFile;
  /** 文件缺失/损坏时 mutate 的基底值。 */
  empty(): TFile;
}

export interface LockedJsonStoreFileOptions {
  filePath: string;
  now?: () => number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  /** 测试注入。 */
  renameFile?: typeof rename;
  renameRetryDelaysMs?: readonly number[];
  /** 测试注入：查询 pid 当前实例启动时间；默认按平台实现（/proc / ps / powershell）。 */
  probeProcessStartTime?: (pid: number) => Promise<number | null>;
}

export type LockedJsonStoreFileLoadResult<TFile> =
  | { status: "missing" }
  | { status: "ok"; file: TFile }
  | { status: "corrupt"; recoveredCorruptPath: string };

interface LockOwnerMetadata {
  pid: number;
  token: string;
  /** 进程实例启动时间（墙钟 ms）；旧格式锁可能缺失（undefined）。 */
  startTime?: number;
}

/** 本进程启动时间的墙钟毫秒（惰性缓存：进程生命周期内不变）。 */
let ownStartTimeMs: number | undefined;
function currentProcessStartTimeMs(): number {
  if (ownStartTimeMs === undefined) {
    ownStartTimeMs = Math.round(Date.now() - uptime() * 1_000);
  }
  return ownStartTimeMs;
}

/**
 * 查询指定 pid 的当前进程实例启动时间（墙钟毫秒）；无法确定时返回 null。
 * - linux: /proc/<pid>/stat 字段 22（boot 后 ticks）
 * - darwin: ps -o lstart=
 * - win32: powershell Get-Process StartTime（成本较高，只在超龄回收路径触发）
 * - 失败/不支持 → null，调用方保守视为原 owner 存活（不回收）。
 */
async function probeProcessStartTimeDefault(pid: number): Promise<number | null> {
  if (pid === process.pid) return currentProcessStartTimeMs();
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // ')' 之后 token[0] 是状态（字段 3）；starttime 是字段 22 → token[19]。
      const tokens = stat.slice(close + 2).split(" ");
      const ticks = Number(tokens[19]);
      if (!Number.isFinite(ticks)) return null;
      const bootMs = Date.now() - uptime() * 1_000;
      return Math.round(bootMs + (ticks * 1_000) / PROC_CLOCK_TICKS_PER_SECOND);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`,
      ]);
      const parsed = Number(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

export class LockedJsonStoreFile<TFile> {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly codec: LockedJsonStoreFileCodec<TFile>;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly renameFile: typeof rename;
  private readonly renameRetryDelaysMs: readonly number[];
  private readonly probeProcessStartTime: (pid: number) => Promise<number | null>;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: LockedJsonStoreFileOptions, codec: LockedJsonStoreFileCodec<TFile>) {
    this.filePath = resolve(options.filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.codec = codec;
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.renameFile = options.renameFile ?? rename;
    this.renameRetryDelaysMs = options.renameRetryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS;
    this.probeProcessStartTime = options.probeProcessStartTime ?? probeProcessStartTimeDefault;
  }

  load(): Promise<LockedJsonStoreFileLoadResult<TFile>> {
    return this.enqueue(async () => {
      await this.ensureDirectory();
      return this.withLock(() => this.readCurrent(true));
    });
  }

  mutate(update: (current: TFile) => TFile): Promise<TFile> {
    return this.enqueue(async () => {
      await this.ensureDirectory();
      return this.withLock(async () => {
        const loaded = await this.readCurrent(true);
        const current = loaded.status === "ok" ? loaded.file : this.codec.empty();
        const next = this.codec.parse(update(current));
        await this.atomicWrite(next);
        return next;
      });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const { handle, token } = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      // 释放前必须验证所有权：本进程的锁可能已被 stale 回收并归属新持有者，
      // 无条件 unlink 会删掉新持有者的锁，让后续 writer 并发进入临界区。
      await this.releaseLockIfOwned(token);
    }
  }

  private async acquireLock(): Promise<{ handle: FileHandle; token: string }> {
    const startedAt = Date.now();
    while (true) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        const token = randomUUID();
        const owner = `${JSON.stringify({
          pid: process.pid,
          startTime: currentProcessStartTimeMs(),
          token,
        })}\n`;
        await handle.writeFile(owner, "utf8");
        return { handle, token };
      } catch (error) {
        // open(wx) 成功但 metadata 写失败时，必须关闭句柄并删除自己刚创建的锁——
        // 残留空锁会被后续 writer 当作无主锁回收，破坏互斥。
        if (handle) {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
        }
        if (!isNodeError(error, "EEXIST")) throw error;
        await this.removeStaleLock();
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`Timed out acquiring locked store file lock: ${this.lockPath}`);
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  /** 仅当锁仍属于 token 对应持有者时才删除；无主（缺失/他人）一律不动。 */
  private async releaseLockIfOwned(token: string): Promise<void> {
    const owner = await this.readLockOwner();
    if (!owner || owner.token !== token) return;
    await unlink(this.lockPath).catch(() => undefined);
  }

  private async readLockOwner(): Promise<LockOwnerMetadata | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { pid?: unknown }).pid === "number" &&
        typeof (parsed as { token?: unknown }).token === "string"
      ) {
        return {
          pid: (parsed as { pid: number }).pid,
          token: (parsed as { token: string }).token,
          startTime:
            typeof (parsed as { startTime?: unknown }).startTime === "number"
              ? (parsed as { startTime: number }).startTime
              : undefined,
        };
      }
      return null;
    } catch {
      // 旧版本空锁/损坏锁 → 无主。
      return null;
    }
  }

  /** pid 存活检测：signal 0 探测。EPERM（Windows 无权限）视为存活，ESRCH/EINVAL 视为死亡。 */
  private isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isNodeError(error, "EPERM");
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const lockStats = await stat(this.lockPath);
      if (Date.now() - lockStats.mtimeMs <= this.staleLockMs) return;
      // 超龄但持有进程仍存活（休眠/调试暂停/杀毒拖慢 IO）→ 不回收。
      const owner = await this.readLockOwner();
      if (!owner) {
        await rm(this.lockPath, { force: true });
        return;
      }
      if (owner.pid === process.pid) return;
      if (!this.isProcessAlive(owner.pid)) {
        await rm(this.lockPath, { force: true });
        return;
      }
      // pid 存活 ≠ 原 owner 存活：用进程实例启动时间核验；probe 不可用或锁记录
      // 无 startTime 时保守视为原 owner 存活，不回收。
      const currentStart = await this.probeProcessStartTime(owner.pid);
      if (currentStart === null || owner.startTime === undefined) return;
      if (Math.abs(currentStart - owner.startTime) > LOCK_START_TIME_TOLERANCE_MS) {
        await rm(this.lockPath, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  private async readCurrent(
    recoverCorrupt: boolean,
  ): Promise<LockedJsonStoreFileLoadResult<TFile>> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { status: "missing" };
      throw error;
    }

    try {
      const file = this.codec.parse(JSON.parse(content) as unknown);
      // chmod 是权限加固副作用：只读目录/EROFS 下失败只降级为忽略，
      // 不得让一次加固失败把整个 load 打掉。
      await chmod(this.filePath, 0o600).catch(() => undefined);
      return { status: "ok", file };
    } catch (error) {
      if (!recoverCorrupt) throw error;
      const recoveredCorruptPath = `${this.filePath}.corrupt-${this.now()}`;
      // 改名失败仍按 corrupt 返回：corrupt 语义即全部记录不可信（fail-closed），
      // 原文件残留不会让任何记录被当作可信。
      try {
        await rename(this.filePath, recoveredCorruptPath);
        await chmod(recoveredCorruptPath, 0o600).catch(() => undefined);
      } catch {
        // 保留原损坏文件；下次 load 仍判 corrupt。
      }
      return { status: "corrupt", recoveredCorruptPath };
    }
  }

  private async atomicWrite(file: TFile): Promise<void> {
    const directory = dirname(this.filePath);
    const tempPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await renameWithRetry(this.renameFile, tempPath, this.filePath, this.renameRetryDelaysMs);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function renameWithRetry(
  renameFile: typeof rename,
  tempPath: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(tempPath, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
      // Windows 杀软/索引器可能短暂占用目标文件；仅对已知短暂占用错误做有界重试。
      await sleep(delayMs);
    }
  }
}

function isRetryableRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
