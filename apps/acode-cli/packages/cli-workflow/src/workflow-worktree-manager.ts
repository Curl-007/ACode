import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * Workflow agent 的 git worktree 隔离（S1，specs/workflow-worktree-isolation.md）。
 *
 * 本模块是 worktree 生命周期的**唯一所有者**（R2）：ensure / release / prune 三原语，
 * 别处不得直接 spawn `git worktree`。git 走内部 execFile 执行面（与模型可见的 Bash
 * 工具面分离——模型面里 `git worktree add` 仍走审批）。
 *
 * 核心裁决（R5）：**材料优先**——activity 终态时 clean 才回收（worktree+分支都删），
 * dirty（未提交改动或领先 baseRef 的提交）一律保留并把 path/branch 登记进 activity
 * result 信封，绝不销毁 agent 产物；回收失败同样保留（reclaim-failed-kept）。
 *
 * 失败语义（R7）：非 git 仓 / 空仓 unborn HEAD / git 缺失 / add 重试后仍失败 →
 * 抛错让 activity fail-loud，**绝不**静默降级回共享 cwd（那等于假装隔离）。
 */

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

/** git 执行面注入点（测试替身）；缺省 execFile("git")。 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitCommandResult>;

const defaultGitRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    // execFile 对非零退出 reject：stderr 优先入错误文本（调用方按文本判别 already-exists/lock 形态）。
    throw new Error(
      String(failure.stderr?.trim() || failure.message || "git command failed").trim(),
    );
  }
};

export interface WorkflowWorktreeHandle {
  /** worktree 工作目录（actor 的 workingDirectory）。 */
  path: string;
  /** 专属分支名（acode/workflow/<runId>/<slug>）。 */
  branch: string;
  /** 建 worktree 时的主 checkout HEAD（dirty 判定的基线）。 */
  baseRef: string;
  /** 主仓库顶层目录。 */
  repoRoot: string;
}

export type WorkflowWorktreeReleaseReason =
  | "clean-reclaimed"
  | "dirty-kept"
  | "reclaim-failed-kept";

export interface WorkflowWorktreeReleaseResult {
  kept: boolean;
  reason: WorkflowWorktreeReleaseReason;
  path: string;
  branch: string;
}

export interface WorkflowWorktreeManagerDeps {
  git?: GitRunner;
  /** 缺省 `os.tmpdir()/acode-workflow-worktrees`（R3：不放仓库内也不放仓库父目录）。 */
  tmpRoot?: string;
  now?: () => number;
}

/** 分支/目录名 slug（R3）：git ref 与文件系统双安全。 */
function slugSegment(value: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/\.lock$/i, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "agent" : slug;
}

export function buildWorktreeBranchName(
  runId: string,
  labelOrActivityId: string,
  activityId?: string,
): string {
  const label = slugSegment(labelOrActivityId);
  // label 只是人类可读片段；生产调用总是追加 activityId 作为唯一业务身份，
  // 因而同一 run 下重复 label 不会复用或抢占另一个 actor 的分支。保留两参数形态
  // 供旧调用方/工具读取已有分支名，迁移边界由 ensureWorktree 的第三参数封口。
  return `acode/workflow/${slugSegment(runId)}/${label}${
    activityId === undefined ? "" : `-${slugSegment(activityId)}`
  }`;
}

/** Windows 大小写不敏感 + 分隔符归一，用于 worktree list 的路径比对。 */
function normalizeForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const LOCK_RETRY_DELAY_MS = 250;
const ORPHAN_AGE_THRESHOLD_MS = 60 * 60 * 1000;

export class WorkflowWorktreeManager {
  readonly #git: GitRunner;
  readonly #tmpRoot: string;
  readonly #now: () => number;
  /** 进程内串行化队列（R6）：git worktree add/remove 对 .git/worktrees 有锁。 */
  #tail: Promise<unknown> = Promise.resolve();
  /** pruneOrphans 每 repoRoot 进程内至多一次（R8 机会式）。 */
  readonly #prunedRoots = new Set<string>();

  constructor(deps: WorkflowWorktreeManagerDeps = {}) {
    this.#git = deps.git ?? defaultGitRunner;
    this.#tmpRoot = deps.tmpRoot ?? join(tmpdir(), "acode-workflow-worktrees");
    this.#now = deps.now ?? Date.now;
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async ensureWorktree(input: {
    repoDir: string;
    runId: string;
    activityId: string;
    label?: string;
  }): Promise<WorkflowWorktreeHandle> {
    return this.#serialized(async () => {
      const repoRoot = await this.#repoRoot(input.repoDir);
      await this.#pruneOnce(repoRoot);
      const baseRef = await this.#head(repoRoot);
      const branch = buildWorktreeBranchName(input.runId, input.label ?? "agent", input.activityId);
      const path = join(
        this.#namespaceDir(repoRoot),
        `${slugSegment(input.runId)}-${slugSegment(input.activityId)}`,
      );
      // 幂等复用（resume/重试形态）：git 已登记且目录在场 → 直接返回既有 handle。
      if (
        existsSync(path) &&
        (await this.#registeredPaths(repoRoot)).has(normalizeForCompare(path))
      ) {
        // 兼容 R19.4 之前只由 label 命名的存量分支：句柄必须登记实际分支，不能用
        // 新规则推导出的名字覆盖它，否则 release 会带错 branch 而留下旧分支。
        const existingBranch = await this.#branchAtPath(path);
        return { path, branch: existingBranch || branch, baseRef, repoRoot };
      }
      // 未登记的残骸（failed-add 遗留）：清掉重建，否则 git worktree add 报目录已存在。
      rmSync(path, { recursive: true, force: true });
      await this.#addWithRetry(repoRoot, path, branch, baseRef);
      return { path, branch, baseRef, repoRoot };
    });
  }

  async releaseWorktree(handle: WorkflowWorktreeHandle): Promise<WorkflowWorktreeReleaseResult> {
    return this.#serialized(async () => {
      const base = { path: handle.path, branch: handle.branch };
      let dirty: boolean;
      try {
        dirty = await this.#isDirty(handle);
      } catch {
        // 检视失败（目录被外部删除等）：不能声称已回收，按保留上报（诚实语义，R5）。
        return { ...base, kept: true, reason: "reclaim-failed-kept" };
      }
      if (dirty) {
        return { ...base, kept: true, reason: "dirty-kept" };
      }
      try {
        // 不带 --force：clean 判定后仍移除失败（句柄占用/并发写入）→ 保留上报。
        await this.#git(["worktree", "remove", handle.path], handle.repoRoot);
        try {
          await this.#git(["branch", "-D", handle.branch], handle.repoRoot);
        } catch {
          // 分支删除失败不影响回收结论（worktree 已移除；分支零信息量，留着无害）。
        }
        return { ...base, kept: false, reason: "clean-reclaimed" };
      } catch {
        return { ...base, kept: true, reason: "reclaim-failed-kept" };
      }
    });
  }

  /** 机会式孤儿清理（R8）：git prune + 命名空间内未登记且老龄的残骸目录。 */
  async pruneOrphans(repoDir: string): Promise<void> {
    let repoRoot: string;
    try {
      repoRoot = await this.#repoRoot(repoDir);
    } catch {
      return; // 非 git 仓：prune 是 janitor，不是失败点。
    }
    await this.#serialized(() => this.#prune(repoRoot));
  }

  async #pruneOnce(repoRoot: string): Promise<void> {
    const key = normalizeForCompare(repoRoot);
    if (this.#prunedRoots.has(key)) return;
    this.#prunedRoots.add(key);
    await this.#prune(repoRoot);
  }

  async #prune(repoRoot: string): Promise<void> {
    try {
      await this.#git(["worktree", "prune"], repoRoot);
    } catch {
      // prune 失败不阻断（下次再试）。
    }
    const namespace = this.#namespaceDir(repoRoot);
    if (!existsSync(namespace)) return;
    const registered = await this.#registeredPaths(repoRoot);
    for (const entry of readdirSync(namespace)) {
      const full = join(namespace, entry);
      try {
        if (registered.has(normalizeForCompare(full))) continue; // git 仍登记 = 活材料，绝不动
        const age = this.#now() - statSync(full).mtimeMs;
        if (age < ORPHAN_AGE_THRESHOLD_MS) continue; // 龄期门槛避开并发进程刚建的目录
        rmSync(full, { recursive: true, force: true });
      } catch {
        // best-effort：单个残骸清理失败不影响其余。
      }
    }
  }

  async #repoRoot(repoDir: string): Promise<string> {
    try {
      const { stdout } = await this.#git(["rev-parse", "--show-toplevel"], repoDir);
      const root = stdout.trim();
      if (root === "") throw new Error("empty toplevel");
      return resolve(root);
    } catch (error) {
      throw new Error(
        `workflow agent isolation "worktree" requires a git repository (working directory: ${repoDir}): ${(error as Error).message}`,
      );
    }
  }

  async #head(repoRoot: string): Promise<string> {
    try {
      const { stdout } = await this.#git(["rev-parse", "HEAD"], repoRoot);
      const ref = stdout.trim();
      if (ref === "") throw new Error("empty HEAD");
      return ref;
    } catch (error) {
      throw new Error(
        `workflow agent isolation "worktree" requires at least one commit (unborn HEAD in ${repoRoot}): ${(error as Error).message}`,
      );
    }
  }

  #namespaceDir(repoRoot: string): string {
    const fingerprint = createHash("sha256")
      .update(normalizeForCompare(repoRoot), "utf-8")
      .digest("hex")
      .slice(0, 12);
    const dir = join(this.#tmpRoot, fingerprint);
    // 0700：worktree 内容是用户仓库材料的副本（Linux 共享 /tmp 的窥探面，R3）。
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async #registeredPaths(repoRoot: string): Promise<Set<string>> {
    const { stdout } = await this.#git(["worktree", "list", "--porcelain"], repoRoot);
    const paths = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        paths.add(normalizeForCompare(line.slice("worktree ".length).trim()));
      }
    }
    return paths;
  }

  async #branchAtPath(path: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.#git(["branch", "--show-current"], path);
      const branch = stdout.trim();
      return branch === "" ? undefined : branch;
    } catch {
      return undefined;
    }
  }

  async #isDirty(handle: WorkflowWorktreeHandle): Promise<boolean> {
    const status = await this.#git(["status", "--porcelain"], handle.path);
    if (status.stdout.trim() !== "") return true;
    const ahead = await this.#git(["rev-list", "--count", `${handle.baseRef}..HEAD`], handle.path);
    return Number.parseInt(ahead.stdout.trim(), 10) > 0;
  }

  async #addWithRetry(
    repoRoot: string,
    path: string,
    branch: string,
    baseRef: string,
  ): Promise<void> {
    // git worktree add 的参数形态（usage：[(-b|-B) <new-branch>] <path> [<commit-ish>]）：
    // -b 必须在 path 之前，且 add 不支持 --porcelain（那是 list 的旗标）——真机探针
    // 2026-10-04 实证的 git 拒绝面。
    const add = async (args: readonly string[]) => {
      await this.#git(["worktree", "add", ...args], repoRoot);
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        try {
          await add(["-b", branch, path, baseRef]);
        } catch (error) {
          // 分支已存在（同 run resume / 同 label 重试）：直接挂既有分支。
          if (/already exists/.test((error as Error).message)) {
            await add([path, branch]);
          } else {
            throw error;
          }
        }
        return;
      } catch (error) {
        const message = (error as Error).message;
        // 进程间竞争 .git/worktrees 锁：一次退避重试（R6），再失败 fail-loud（R7）。
        if (attempt >= 1 || !/lock/i.test(message)) {
          throw new Error(
            `failed to create workflow worktree at ${path} (branch ${branch}): ${message}`,
          );
        }
        await new Promise((sleep) => setTimeout(sleep, LOCK_RETRY_DELAY_MS));
      }
    }
  }
}
