// AgentTeams 成员工作树的 git 执行面（SPEC-015）。
//
// 全部 git 调用走 execFile（无 shell 拼接、无 shell:true），60s 超时；
// 这里只返回执行结果，错误分类与编排在 manager.ts。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

/**
 * 内容级脏判据：tracked 改动（含已暂存）+ 未跟踪文件。
 *
 * 不用 `git status --porcelain`：Windows 全局 `core.autocrlf=true` 时，检出把索引里的
 * LF 转成 CRLF，agent/编辑器按 LF 原样重写内容后，status 会依据 stat 缓存报 ` M`，
 * 而内容按 git 自己的转换规则与 HEAD 完全相同（`git diff --quiet HEAD` 返回 0）。
 * 用 status 会把「仅换行差异、语义未变」的树判成真实改动，导致主工作区被误拒合并、
 * 成员树永远删不掉、快照提交报 `nothing to commit`。内容比较才是脏的语义事实。
 *
 * 查不出结果（非 1 的退出码、ls-files 失败）一律按 dirty 处理：
 * 清理路径绝不因为「查不出来」而误删。
 */
export async function isWorktreeDirty(path: string): Promise<boolean> {
  const tracked = await runGit(path, ["diff", "--quiet", "HEAD"]);
  if (tracked.exitCode !== 0) return true;
  const untracked = await runGit(path, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.exitCode !== 0) return true;
  return untracked.stdout.trim().length > 0;
}

/**
 * 主工作区是否有内容改动（只看 tracked，沿用既有 `--untracked-files=no` 语义）。
 * 与 isWorktreeDirty 同源理由：stat 缓存里的 autocrlf 幻影不能算脏。
 * 返回 exitCode：0 干净、1 有改动、其它为无法判定（调用方按错误处理）。
 */
export async function mainWorkspaceDiffStatus(repoRoot: string): Promise<GitResult> {
  return runGit(repoRoot, ["diff", "--quiet", "HEAD"]);
}

/**
 * 刷新 tracked 文件的 stat 缓存，不引入新内容、不收集未跟踪文件。
 *
 * `git add -u` 在内容干净时只会重写与 HEAD 相同的索引项，用于清掉 autocrlf 幻影；
 * 之后 `git worktree remove`（不带 --force）与 `git merge` 才不会把幻影当本地改动。
 */
export async function refreshTrackedStat(path: string): Promise<GitResult> {
  return runGit(path, ["add", "-u"]);
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
  if (!registered.some((entry) => resolve(entry.path) === resolve(handle.path))) return false;
  if (!(await isWorktreeDirty(handle.path))) return false;
  const staged = await runGit(handle.path, ["add", "-A"]);
  if (staged.exitCode !== 0) {
    throw new TeamError(
      "worktree_merge_failed",
      describeGitFailure("git add -A (member worktree)", staged),
    );
  }
  // add -A 之后用暂存区内容判定是否真有东西可提交。
  // autocrlf 幻影（仅换行差异）会在这里表现为「status 有改动、staged diff 为空」：
  // 此时提交必然报 nothing to commit，直接返回 false 才是如实结果。
  const stagedDiff = await runGit(handle.path, ["diff", "--cached", "--quiet"]);
  if (stagedDiff.exitCode === 0) return false;
  const committed = await runGit(handle.path, ["commit", "-m", message]);
  if (committed.exitCode !== 0) {
    throw new TeamError(
      "worktree_merge_failed",
      describeGitFailure("git commit (member worktree)", committed),
    );
  }
  return true;
}
