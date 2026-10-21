import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { applyGitPostureGateway, type GitPosture } from "@acode/shared";
import { getCliGitInvocationEnv } from "@acode/shared/node";
import { normalizeForCompare } from "./session-worktree-paths.js";

/**
 * 会话 worktree 域的 git 执行面（specs/session-worktree-lifecycle.md R2）。
 *
 * 与 workflow 域同一裁决：git 走内部 execFile 执行面（注入点 deps.git 供测试），
 * 与模型可见的 Bash 工具面分离——模型面里 `git worktree add` 仍走审批，系统面不借道。
 * cli-workflow → core 的依赖方向禁止复用 workflow 域的 runner 实现，本文件是同一
 * 惯例在会话域的镜像（spec R1「词汇一致即是互通」）。
 */

const execFileAsync = promisify(execFile);

export interface SessionGitCommandResult {
  stdout: string;
  stderr: string;
}

/** git 执行面注入点（测试替身）；缺省 execFile("git")。 */
export type SessionGitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<SessionGitCommandResult>;

/**
 * argv posture 网关接线（apps/acode-cli/specs/git-invocation-hardening.md R6）：
 * 包装 runner，spawn 前把 argv 过 shared 判定器——通过时按网关输出执行（read 档
 * 可能注入 `--ignore-submodules=dirty` 等确定性旗标），拒绝时抛 GitPostureError
 * （EGITPOSTURE，调用点编程错误 fail-closed 冒泡，不降级为命令失败）。
 */
export function withSessionGitPosture(
  posture: GitPosture,
  git: SessionGitRunner,
): SessionGitRunner {
  // async 包装：判定器的同步拒绝必须成为 runner 契约的 promise 拒绝，而非同步抛出。
  return async (args, cwd) => git(applyGitPostureGateway(posture, args), cwd);
}

export const defaultSessionGitRunner: SessionGitRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      // git 调用硬化漏斗（specs/git-invocation-hardening.md 消费点 #3）：
      // 会话 worktree 生命周期面在无人值守路径执行，防弹窗挂死/hooks 停用/防串仓。
      env: getCliGitInvocationEnv(),
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    // execFile 对非零退出 reject：stderr 优先入错误文本（调用方按文本判别
    // already-exists/lock 形态，与 workflow 域同款）。
    throw new Error(
      String(failure.stderr?.trim() || failure.message || "git command failed").trim(),
    );
  }
};

/** git 失败的业务分类（fail-loud 前先用它把可预期拒绝转成闭集 reason）。 */
export type SessionGitFailureReason = "not_git_repo" | "unborn_head";

export class SessionGitError extends Error {
  readonly reason: SessionGitFailureReason;
  constructor(reason: SessionGitFailureReason, message: string) {
    super(message);
    this.name = "SessionGitError";
    this.reason = reason;
  }
}

export async function gitRepoRoot(git: SessionGitRunner, repoDir: string): Promise<string> {
  const read = withSessionGitPosture("read", git);
  try {
    const { stdout } = await read(["rev-parse", "--show-toplevel"], repoDir);
    const root = stdout.trim();
    if (root === "") throw new Error("empty toplevel");
    return resolve(root);
  } catch (error) {
    throw new SessionGitError(
      "not_git_repo",
      `session worktree isolation requires a git repository (working directory: ${repoDir}): ${(error as Error).message}`,
    );
  }
}

export async function gitHeadSha(git: SessionGitRunner, repoRoot: string): Promise<string> {
  const read = withSessionGitPosture("read", git);
  try {
    const { stdout } = await read(["rev-parse", "HEAD"], repoRoot);
    const ref = stdout.trim();
    if (ref === "") throw new Error("empty HEAD");
    return ref;
  } catch (error) {
    throw new SessionGitError(
      "unborn_head",
      `session worktree isolation requires at least one commit (unborn HEAD in ${repoRoot}): ${(error as Error).message}`,
    );
  }
}

export interface GitWorktreeListEntry {
  path: string;
  /** 归一化（真实路径 + win32 小写）后的登记路径，用于比对。 */
  normalizedPath: string;
  branch?: string;
  bare: boolean;
}

export async function gitWorktreeList(
  git: SessionGitRunner,
  repoRoot: string,
): Promise<GitWorktreeListEntry[]> {
  const read = withSessionGitPosture("read", git);
  const { stdout } = await read(["worktree", "list", "--porcelain"], repoRoot);
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> | undefined;
  const flush = () => {
    if (current?.path) {
      entries.push({
        path: current.path,
        normalizedPath: normalizeForCompare(current.path),
        bare: current.bare === true,
        ...(current.branch ? { branch: current.branch } : {}),
      });
    }
    current = undefined;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }
    if (!current) continue;
    if (line === "bare") {
      current.bare = true;
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return entries;
}

/**
 * cwd 是否位于某个 linked worktree（非主 checkout）内——enter 的拒绝判据（spec R2）。
 *
 * 判据说明：`rev-parse --show-toplevel`（即调用方传入的 repoRoot）在 linked worktree
 * 内返回的是**该 worktree 的根**而不是主 checkout；因此只需比对 worktree list 的主
 * 条目——repoRoot 与主 worktree 登记路径不一致 = cwd 在 linked worktree 里（含
 * workflow 域 worktree 与用户自建 worktree，一视同仁拒绝）。
 */
export async function gitIsInsideLinkedWorktree(
  git: SessionGitRunner,
  repoRoot: string,
): Promise<boolean> {
  const entries = await gitWorktreeList(git, repoRoot);
  const main = entries.find((entry) => !entry.bare);
  if (!main) return false;
  return main.normalizedPath !== normalizeForCompare(repoRoot);
}

export async function gitCurrentBranch(
  git: SessionGitRunner,
  dir: string,
): Promise<string | undefined> {
  const read = withSessionGitPosture("read", git);
  try {
    const { stdout } = await read(["branch", "--show-current"], dir);
    const branch = stdout.trim();
    return branch === "" ? undefined : branch;
  } catch {
    return undefined;
  }
}

/** 本地分支是否存在（show-ref 非零退出 = 不存在，不抛）。 */
export async function gitLocalBranchExists(
  git: SessionGitRunner,
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  const read = withSessionGitPosture("read", git);
  try {
    await read(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/** 工作区是否有未提交改动（含未跟踪文件——porcelain 非空即 dirty）。 */
export async function gitHasUncommittedChanges(
  git: SessionGitRunner,
  dir: string,
): Promise<boolean> {
  const read = withSessionGitPosture("read", git);
  const { stdout } = await read(["status", "--porcelain"], dir);
  return stdout.trim() !== "";
}

/** 合并是否正在进行（MERGE_HEAD 在场）。 */
export async function gitMergeInProgress(git: SessionGitRunner, dir: string): Promise<boolean> {
  const read = withSessionGitPosture("read", git);
  try {
    const { stdout } = await read(["rev-parse", "-q", "--verify", "MERGE_HEAD"], dir);
    return stdout.trim() !== "";
  } catch {
    return false;
  }
}

/** 冲突（未合并）文件清单。 */
export async function gitConflictedFiles(git: SessionGitRunner, dir: string): Promise<string[]> {
  const read = withSessionGitPosture("read", git);
  const { stdout } = await read(["diff", "--name-only", "--diff-filter=U"], dir);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

const DEFAULT_MAIN_BRANCH_CANDIDATES = ["main", "master"] as const;

/**
 * 仓库默认分支解析（镜像 adapters/src/context/git-snapshot.ts 的 resolveMainBranch，
 * 但**不兜底返回 "main"**——merge 需要真实 ref，解析不出就返回 undefined 让调用方
 * 以闭集 reason 拒绝，而不是合并进一个不存在的分支名）。
 */
export async function gitResolveDefaultBranch(
  git: SessionGitRunner,
  repoRoot: string,
): Promise<string | undefined> {
  const read = withSessionGitPosture("read", git);
  let originHeadBranch: string | undefined;
  try {
    const { stdout } = await read(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      repoRoot,
    );
    originHeadBranch = stdout.trim().replace(/^origin\//, "") || undefined;
  } catch {
    originHeadBranch = undefined;
  }
  const candidates = originHeadBranch
    ? [originHeadBranch, ...DEFAULT_MAIN_BRANCH_CANDIDATES]
    : [...DEFAULT_MAIN_BRANCH_CANDIDATES];
  const refExists = async (ref: string): Promise<boolean> => {
    try {
      await read(["show-ref", "--verify", "--quiet", ref], repoRoot);
      return true;
    } catch {
      return false;
    }
  };
  for (const candidate of candidates) {
    if (await refExists(`refs/remotes/origin/${candidate}`)) return candidate;
  }
  for (const candidate of candidates) {
    if (await refExists(`refs/heads/${candidate}`)) return candidate;
  }
  return undefined;
}
