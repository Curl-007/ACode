import { mkdir, rm, stat } from "node:fs/promises";
import {
  defaultSessionGitRunner,
  gitCurrentBranch,
  gitHeadSha,
  gitRepoRoot,
  gitWorktreeList,
  type GitWorktreeListEntry,
  type SessionGitRunner,
} from "./session-worktree-git.js";
import {
  defaultSessionWorktreeTmpRoot,
  normalizeForCompare,
  sessionWorktreeNamespaceDir,
} from "./session-worktree-paths.js";

/**
 * 会话 worktree 的 git/文件系统原语（specs/session-worktree-lifecycle.md R2）。
 *
 * 本模块是**会话域** worktree 生命周期的唯一所有者：别处不得为会话目的直接 spawn
 * `git worktree`。编排（台账/围栏/工具语义）在 session-worktree-enter.ts 与
 * session-worktree-reap.ts；这里只有 git 与目录事实。
 *
 * 惯例与 workflow 域（cli-workflow/src/workflow-worktree-manager.ts）逐字对齐：
 * 注入式 GitRunner、进程内串行队列（git worktree add/remove 对 .git/worktrees 有
 * 锁）、锁冲突一次退避重试、真实路径归一比对、fail-loud（SessionGitError 带闭集
 * reason，绝不静默降级回共享 cwd）。
 */

const LOCK_RETRY_DELAY_MS = 250;

/** 模块级串行化队列：跨实例生效（handler 每次调用可能新建 manager 实例）。 */
let serializationTail: Promise<unknown> = Promise.resolve();

export function serializeSessionWorktreeGit<T>(operation: () => Promise<T>): Promise<T> {
  const result = serializationTail.then(operation);
  serializationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export interface SessionRepoContext {
  repoRoot: string;
  head: string;
  /** 主 checkout 当前分支；detached HEAD 时缺席（ledger 的 sourceBranch 同步缺席）。 */
  currentBranch?: string;
  registeredWorktrees: GitWorktreeListEntry[];
}

export interface SessionWorktreeHandle {
  path: string;
  branch: string;
  baseRef: string;
  repoRoot: string;
  sourceBranch?: string;
}

export interface SessionWorktreeManagerDeps {
  git?: SessionGitRunner;
  /** 缺省 `os.tmpdir()/acode-session-worktrees`（与 workflow 域命名空间平级分域）。 */
  tmpRoot?: string;
}

export class SessionWorktreeManager {
  readonly #git: SessionGitRunner;
  readonly #tmpRoot: string;

  constructor(deps: SessionWorktreeManagerDeps = {}) {
    this.#git = deps.git ?? defaultSessionGitRunner;
    this.#tmpRoot = deps.tmpRoot ?? defaultSessionWorktreeTmpRoot();
  }

  get git(): SessionGitRunner {
    return this.#git;
  }

  get tmpRoot(): string {
    return this.#tmpRoot;
  }

  /** 仓库事实一次性取齐；非 git 仓 / 空仓抛 SessionGitError（闭集 reason）。 */
  async resolveRepoContext(repoDir: string): Promise<SessionRepoContext> {
    const repoRoot = await gitRepoRoot(this.#git, repoDir);
    const head = await gitHeadSha(this.#git, repoRoot);
    const [currentBranch, registeredWorktrees] = await Promise.all([
      gitCurrentBranch(this.#git, repoRoot),
      gitWorktreeList(this.#git, repoRoot),
    ]);
    return {
      repoRoot,
      head,
      ...(currentBranch === undefined ? {} : { currentBranch }),
      registeredWorktrees,
    };
  }

  namespaceDir(repoRoot: string): string {
    return sessionWorktreeNamespaceDir(this.#tmpRoot, repoRoot);
  }

  /** 命名空间目录确保在场（0700：worktree 内容是用户仓库材料的副本，防共享 tmp 窥探）。 */
  async ensureNamespaceDir(repoRoot: string): Promise<string> {
    const dir = this.namespaceDir(repoRoot);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async isWorktreeRegistered(repoRoot: string, path: string): Promise<boolean> {
    try {
      const entries = await gitWorktreeList(this.#git, repoRoot);
      const normalized = normalizeForCompare(path);
      return entries.some((entry) => entry.normalizedPath === normalized);
    } catch {
      return false;
    }
  }

  /** 从 startRef 新建分支 + worktree（enter 的 created 路径；不携带未提交改动是 git 天然语义）。 */
  async createWorktree(input: {
    repoRoot: string;
    path: string;
    branch: string;
    startRef: string;
  }): Promise<void> {
    await serializeSessionWorktreeGit(async () => {
      await this.ensureNamespaceDir(input.repoRoot);
      await this.#removeUnregisteredLeftover(input.repoRoot, input.path);
      await this.#addWithRetry(["-b", input.branch, input.path, input.startRef], input.repoRoot);
    });
  }

  /** 重挂既有分支（tombstone 重开路径：分支 tip 就是材料，绝不从 HEAD 重建覆盖）。 */
  async mountBranch(input: { repoRoot: string; path: string; branch: string }): Promise<void> {
    await serializeSessionWorktreeGit(async () => {
      await this.ensureNamespaceDir(input.repoRoot);
      await this.#removeUnregisteredLeftover(input.repoRoot, input.path);
      await this.#addWithRetry([input.path, input.branch], input.repoRoot);
    });
  }

  /** 收割用：不带 --force（clean 判定在调用方；移除失败如实上报，绝不强删材料）。 */
  async removeWorktree(input: { repoRoot: string; path: string }): Promise<void> {
    await serializeSessionWorktreeGit(async () => {
      await this.#git(["worktree", "remove", input.path], input.repoRoot);
    });
  }

  /** 台账卫生：git worktree prune（清 .git/worktrees 里指向已消失目录的登记）。 */
  async prune(repoRoot: string): Promise<void> {
    try {
      await serializeSessionWorktreeGit(async () => {
        await this.#git(["worktree", "prune"], repoRoot);
      });
    } catch {
      // prune 失败不阻断（下次再试，与 workflow 域同款 janitor 语义）。
    }
  }

  async directoryExists(path: string): Promise<boolean> {
    try {
      const stats = await stat(path);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /** 未登记残骸（crash 遗留）：清掉重建，否则 git worktree add 报目录已存在。 */
  async #removeUnregisteredLeftover(repoRoot: string, path: string): Promise<void> {
    if (!(await this.directoryExists(path))) return;
    if (await this.isWorktreeRegistered(repoRoot, path)) return;
    await rm(path, { recursive: true, force: true });
  }

  async #addWithRetry(args: readonly string[], repoRoot: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#git(["worktree", "add", ...args], repoRoot);
        return;
      } catch (error) {
        const message = (error as Error).message;
        // 进程间竞争 .git/worktrees 锁：一次退避重试，再失败 fail-loud（对齐 workflow 域 R6/R7）。
        if (attempt >= 1 || !/lock/i.test(message)) {
          throw new Error(`failed to create session worktree (${args.join(" ")}): ${message}`);
        }
        await new Promise((sleep) => setTimeout(sleep, LOCK_RETRY_DELAY_MS));
      }
    }
  }
}

let defaultManager: SessionWorktreeManager | undefined;

/** 进程级缺省 manager（handler 无注入时用）；测试经 createSessionWorktreeManager 注入替身。 */
export function getSessionWorktreeManager(): SessionWorktreeManager {
  defaultManager ??= new SessionWorktreeManager();
  return defaultManager;
}

export function createSessionWorktreeManager(
  deps: SessionWorktreeManagerDeps = {},
): SessionWorktreeManager {
  return new SessionWorktreeManager(deps);
}
