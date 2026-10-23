// AgentTeams 成员工作树的 git 执行面（SPEC-015）。
//
// 全部 git 调用走 execFile（无 shell 拼接、无 shell:true），60s 超时；
// 这里只返回执行结果，错误分类与编排在 manager.ts。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { TeamError } from "../state/types.js";

const execFileAsync = promisify(execFile);

export const GIT_TIMEOUT_MS = 60_000;

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 执行 git；失败不抛错，调用方按 exitCode 分类。 */
export async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const typed = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
    return {
      stdout: typeof typed.stdout === "string" ? typed.stdout : "",
      stderr: typeof typed.stderr === "string" ? typed.stderr : "",
      exitCode: typeof typed.code === "number" ? typed.code : 1,
    };
  }
}

export function describeGitFailure(label: string, result: GitResult): string {
  const reason = result.stderr.trim() || `exit ${result.exitCode}`;
  return `${label} failed: ${reason}`;
}

/** 解析 `git merge-tree --write-tree --name-only --no-messages` 的冲突文件段。 */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const lines = stdout.replace(/\r\n/gu, "\n").split("\n");
  const conflicts: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0) break;
    conflicts.push(line);
  }
  return [...new Set(conflicts)].sort();
}

/** 解析 `git merge` 失败输出里的 `CONFLICT (...): ... <path>` 行。 */
export function parseMergeCommandConflicts(output: string): string[] {
  const conflicts = new Set<string>();
  for (const line of output.replace(/\r\n/gu, "\n").split("\n")) {
    const match = /^CONFLICT \([^)]*\): (?:Merge conflict in )?(.+?)(?: deleted in .*)?$/u.exec(
      line.trim(),
    );
    if (match?.[1]) conflicts.add(match[1].trim());
  }
  return [...conflicts].sort();
}

/** 同一仓库的 `git worktree add` 串行执行，避免并发争抢 .git 内部锁。 */
const creationQueues = new Map<string, Promise<unknown>>();

export function serializeWorktreeCreation<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  const previous = creationQueues.get(repoRoot) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  creationQueues.set(repoRoot, tail);
  void tail.then(() => {
    if (creationQueues.get(repoRoot) === tail) creationQueues.delete(repoRoot);
  });
  return next;
}

/** 已登记的 worktree（路径为平台分隔符，分支去掉 refs/heads/）。 */
export async function listRegisteredWorktrees(
  repoRoot: string,
): Promise<Array<{ path: string; branch?: string }>> {
  const listed = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (listed.exitCode !== 0) return [];
  const entries: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of listed.stdout.replace(/\r\n/gu, "\n").split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: resolve(line.slice("worktree ".length)) };
      entries.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
    }
  }
  return entries;
}

/** 查不到状态时按 dirty 处理：清理路径绝不因为「查不出来」而误删。 */
export async function isWorktreeDirty(path: string): Promise<boolean> {
  const status = await runGit(path, ["status", "--porcelain", "--untracked-files=all"]);
  return status.exitCode !== 0 || status.stdout.trim().length > 0;
}

/**
 * 路径比较前的规范化：realpath 还原符号链接与 **Windows 8.3 短名**，再 resolve + win32
 * 折叠大小写。
 *
 * 为什么必须 realpath：`git worktree list --porcelain` 输出的是文件系统规范化后的**长名**
 * （`C:\Users\Administrator\...`），而调用方持有的句柄路径可能来自 `os.tmpdir()` /
 * `mkdtemp`，在部分 Windows 机器上是 8.3 **短名**（`C:\Users\ADMINI~1\...`）。裸
 * `resolve()===resolve()` 不还原短名 → 同一目录被判为不同路径 → snapshotPendingChanges
 * 跳过成员树未提交改动的快照提交 → 随后 cleanup 删树时**改动真实丢失**；cleanup 的
 * `entry` 匹配也会失配、把已合并树误留。故与 bash-cwd-policy.ts 的 realpathSync.native
 * 同一策略（那里因是同步判定用 sync，这里是 async 路径故用 fs/promises 的 realpath）。
 *
 * realpath 失败（路径不存在/无权限）时回退到 resolve：调用方另有 existsSync 前置判定，
 * 回退值只用于「找不到即按不同处理」的保守方向，不会误判为相同而删数据。
 */
export async function normalizePathForCompare(path: string): Promise<string> {
  const resolved = resolve(path);
  let real = resolved;
  try {
    real = await realpath(resolved);
  } catch {
    // 路径不存在或不可读：保留 resolve 结果，交由调用方 existsSync 判据处理。
  }
  const final = resolve(real);
  return process.platform === "win32" ? final.toLowerCase() : final;
}

/** 分支相对基线的独有提交数；数不出来按 1 处理（宁可保留）。 */
export async function countAhead(
  repoRoot: string,
  baseBranch: string,
  branch: string,
): Promise<number> {
  const counted = await runGit(repoRoot, ["rev-list", "--count", `${baseBranch}..${branch}`]);
  if (counted.exitCode !== 0) return 1;
  const value = Number.parseInt(counted.stdout.trim(), 10);
  return Number.isNaN(value) ? 1 : value;
}

/** 把成员树里的未提交改动（含未跟踪文件）快照提交到成员分支；只动成员分支。 */
export async function snapshotPendingChanges(
  repoRoot: string,
  handle: { path: string; branch: string },
  message: string,
): Promise<boolean> {
  if (!existsSync(handle.path)) return false;
  const registered = await listRegisteredWorktrees(repoRoot);
  // 路径比较必须走 realpath 规范化：git worktree list 输出长名，handle.path 可能是
  // mkdtemp/tmpdir 的 8.3 短名，裸 resolve 比较会失配 → 跳过快照 → 成员树未提交改动
  // 在随后 cleanup 删树时真实丢失（见 normalizePathForCompare 注释）。
  const handleReal = await normalizePathForCompare(handle.path);
  const registeredReals = await Promise.all(
    registered.map((entry) => normalizePathForCompare(entry.path)),
  );
  if (!registeredReals.includes(handleReal)) return false;
  if (!(await isWorktreeDirty(handle.path))) return false;
  const staged = await runGit(handle.path, ["add", "-A"]);
  if (staged.exitCode !== 0) {
    throw new TeamError(
      "worktree_merge_failed",
      describeGitFailure("git add -A (member worktree)", staged),
    );
  }
  const committed = await runGit(handle.path, ["commit", "-m", message]);
  if (committed.exitCode !== 0) {
    throw new TeamError(
      "worktree_merge_failed",
      describeGitFailure("git commit (member worktree)", committed),
    );
  }
  return true;
}
