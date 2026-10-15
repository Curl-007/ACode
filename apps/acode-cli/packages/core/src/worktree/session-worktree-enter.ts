import {
  SessionGitError,
  gitIsInsideLinkedWorktree,
  gitLocalBranchExists,
} from "./session-worktree-git.js";
import { SessionWorktreeLedger, type SessionWorktreeBinding } from "./session-worktree-ledger.js";
import {
  bindSessionWorktreeFence,
  lookupSessionWorktreeFenceBinding,
} from "./session-worktree-fence.js";
import {
  getSessionWorktreeManager,
  type SessionWorktreeHandle,
  type SessionWorktreeManager,
} from "./session-worktree-manager.js";
import {
  buildSessionBranchName,
  normalizeForCompare,
  repoFingerprint,
  sessionWorktreeDirFor,
} from "./session-worktree-paths.js";

/**
 * enter 编排（specs/session-worktree-lifecycle.md R2）：git/目录事实（manager）+
 * 台账（ledger）+ 围栏绑定（fence）的唯一汇合点。工具 handler 只负责把结果投影成
 * 契约输出并切 cwd（经既有 setWorkingDirectory 漏斗）。
 *
 * 关键裁决：
 * - **不携带未提交改动**：worktree 自 commit（HEAD sha）建立，用户 checkout 的
 *   dirty 材料留在原地，绝不搬走也绝不清掉（git 天然语义，测试钉住）。
 * - **重开重挂**：tombstone/目录丢失的绑定按台账用 `worktree add <path> <branch>`
 *   重挂既有分支——分支 tip 就是材料，绝不从 HEAD 重建覆盖。
 * - **绝不劫持分支**：目标分支已存在且不是本会话的重挂形态 → branch_in_use。
 * - fail-loud：git 基础设施故障照抛（SessionGitError 的业务 reason 转闭集拒绝，
 *   其余异常上抛），绝不静默降级回共享 cwd。
 */

export type EnterSessionWorktreeRejectReason =
  | "not_git_repo"
  | "unborn_head"
  | "inside_linked_worktree"
  | "already_in_session_worktree"
  | "branch_in_use";

export type EnterSessionWorktreeResult =
  | {
      outcome: "entered" | "reused" | "reattached";
      handle: SessionWorktreeHandle;
      fingerprint: string;
    }
  | { outcome: "rejected"; reason: EnterSessionWorktreeRejectReason; message: string };

export interface EnterSessionWorktreeDeps {
  manager?: SessionWorktreeManager;
  ledger?: SessionWorktreeLedger;
  now?: () => number;
  /** 心跳落台账的节流间隔（测试注入小值）。 */
  fenceFlushIntervalMs?: number;
}

export async function enterSessionWorktree(
  input: { repoDir: string; sessionId: string; branchName?: string },
  deps: EnterSessionWorktreeDeps = {},
): Promise<EnterSessionWorktreeResult> {
  const manager = deps.manager ?? getSessionWorktreeManager();
  const ledger = deps.ledger ?? new SessionWorktreeLedger();
  const rejected = (
    reason: EnterSessionWorktreeRejectReason,
    message: string,
  ): EnterSessionWorktreeResult => ({ outcome: "rejected", reason, message });

  // 0) 本会话已在自己的受管 worktree 里（进程内事实优先于 git 探测——linked 检测
  //    分不出「自己的」与「别人的」worktree，而拒绝理由必须分得出来）。
  const selfBinding = lookupSessionWorktreeFenceBinding(input.repoDir);
  if (selfBinding && selfBinding.sessionId === input.sessionId) {
    return rejected(
      "already_in_session_worktree",
      `This session is already inside its managed worktree (${selfBinding.worktreePath}, branch ${selfBinding.branch}). Commit or merge from here; there is nothing to enter.`,
    );
  }

  // 1) 仓库事实（非 git 仓 / 空仓 → 闭集拒绝，fail-loud 语义由 SessionGitError 承载）。
  let context;
  try {
    context = await manager.resolveRepoContext(input.repoDir);
  } catch (error) {
    if (error instanceof SessionGitError) {
      return rejected(
        error.reason === "unborn_head" ? "unborn_head" : "not_git_repo",
        error.message,
      );
    }
    throw error;
  }
  const { repoRoot, head, registeredWorktrees } = context;

  // 2) cwd 在任何 linked worktree 内（别人的会话 worktree / workflow 域 / 用户自建）→ 拒绝。
  if (await gitIsInsideLinkedWorktree(manager.git, repoRoot)) {
    return rejected(
      "inside_linked_worktree",
      `The current directory is inside a linked git worktree (${repoRoot}), not the repository's main checkout. Session worktree isolation starts from the main checkout only.`,
    );
  }

  const fingerprint = repoFingerprint(repoRoot);
  const bindings = await ledger.load();
  const own = bindings.find(
    (binding) => binding.sessionId === input.sessionId && binding.repoFingerprint === fingerprint,
  );

  // 3) 既有绑定：复用（切回去）或重挂（分支 tip 就是材料）。
  if (own && own.worktreePath !== "") {
    const reuseResult = await reattachOrReuse(own, {
      manager,
      ledger,
      fingerprint,
      registeredWorktrees,
      head,
      repoRoot,
      sessionId: input.sessionId,
      deps,
    });
    if (reuseResult) return reuseResult;
  }

  // 4) 全新进入：分支名 → 冲突检查 → 从 HEAD 建 worktree。
  const slugSource = input.branchName ?? input.sessionId;
  const branch = buildSessionBranchName(slugSource);
  const path = sessionWorktreeDirFor(manager.tmpRoot, repoRoot, slugSource);

  const registeredAtComputedPath = registeredWorktrees.find(
    (entry) => entry.normalizedPath === normalizeForCompare(path),
  );
  if (registeredAtComputedPath) {
    // crash 残留（git 已登记、台账没记下）：分支一致 → 领养；不一致 → 绝不劫持。
    if (registeredAtComputedPath.branch === branch) {
      return await adoptRegistered({
        manager,
        ledger,
        fingerprint,
        repoRoot,
        path,
        branch,
        head,
        sessionId: input.sessionId,
        sourceBranch: context.currentBranch,
        deps,
      });
    }
    return rejected(
      "branch_in_use",
      `The planned worktree path is occupied by another registered worktree on branch ${registeredAtComputedPath.branch ?? "(unknown)"}. Choose a different branch_name.`,
    );
  }
  if (await gitLocalBranchExists(manager.git, repoRoot, branch)) {
    // 分支已存在但不是本会话的重挂形态（own 缺席或分支不匹配）：绝不劫持既有分支。
    return rejected(
      "branch_in_use",
      `Branch ${branch} already exists and is not a session-worktree branch of this session. Choose a different branch_name.`,
    );
  }

  try {
    await manager.createWorktree({ repoRoot, path, branch, startRef: head });
  } catch (error) {
    if (/already exists/.test((error as Error).message)) {
      return rejected(
        "branch_in_use",
        `Branch ${branch} was created concurrently and is now in use. Choose a different branch_name.`,
      );
    }
    throw error;
  }
  await ledger.bind({
    sessionId: input.sessionId,
    repoFingerprint: fingerprint,
    repoRoot,
    worktreePath: path,
    branch,
    baseRef: head,
    ...(context.currentBranch === undefined ? {} : { sourceBranch: context.currentBranch }),
  });
  bindFenceForSession({
    ledger,
    fingerprint,
    repoRoot,
    worktreePath: path,
    branch,
    sessionId: input.sessionId,
    ...(context.currentBranch === undefined ? {} : { sourceBranch: context.currentBranch }),
    deps,
  });
  return {
    outcome: "entered",
    fingerprint,
    handle: {
      path,
      branch,
      baseRef: head,
      repoRoot,
      ...(context.currentBranch === undefined ? {} : { sourceBranch: context.currentBranch }),
    },
  };
}

interface ReattachContext {
  manager: SessionWorktreeManager;
  ledger: SessionWorktreeLedger;
  fingerprint: string;
  registeredWorktrees: { normalizedPath: string }[];
  head: string;
  repoRoot: string;
  sessionId: string;
  deps: EnterSessionWorktreeDeps;
}

async function reattachOrReuse(
  own: SessionWorktreeBinding,
  ctx: ReattachContext,
): Promise<EnterSessionWorktreeResult | undefined> {
  const registered = ctx.registeredWorktrees.some(
    (entry) => entry.normalizedPath === normalizeForCompare(own.worktreePath),
  );
  const dirExists = await ctx.manager.directoryExists(own.worktreePath);
  if (own.state === "active" && registered && dirExists) {
    // 复用：cwd 飘走后切回去（幂等，材料原样）。台账只记心跳，不重复 bind。
    await ctx.ledger.touch(own.sessionId, own.repoFingerprint);
    bindFenceForSession({
      ledger: ctx.ledger,
      fingerprint: ctx.fingerprint,
      repoRoot: own.repoRoot,
      worktreePath: own.worktreePath,
      branch: own.branch,
      sessionId: ctx.sessionId,
      ...(own.sourceBranch === undefined ? {} : { sourceBranch: own.sourceBranch }),
      deps: ctx.deps,
    });
    return {
      outcome: "reused",
      fingerprint: ctx.fingerprint,
      handle: {
        path: own.worktreePath,
        branch: own.branch,
        baseRef: own.baseRef,
        repoRoot: own.repoRoot,
        ...(own.sourceBranch === undefined ? {} : { sourceBranch: own.sourceBranch }),
      },
    };
  }
  // 目录/登记丢失（被收割、tmp 清理、外部删除）：台账先落 worktree-missing 墓碑，
  // 再按分支存活决定重挂或新建。
  if (own.state === "active") {
    await ctx.ledger.tombstone(own.sessionId, own.repoFingerprint, "worktree-missing");
  }
  const branchAlive = await gitLocalBranchExists(ctx.manager.git, ctx.repoRoot, own.branch);
  if (own.branch !== "" && branchAlive) {
    await ctx.manager.mountBranch({
      repoRoot: ctx.repoRoot,
      path: own.worktreePath,
      branch: own.branch,
    });
    await ctx.ledger.bind({
      sessionId: own.sessionId,
      repoFingerprint: own.repoFingerprint,
      repoRoot: ctx.repoRoot,
      worktreePath: own.worktreePath,
      branch: own.branch,
      baseRef: ctx.head,
      ...(own.sourceBranch === undefined ? {} : { sourceBranch: own.sourceBranch }),
    });
    bindFenceForSession({
      ledger: ctx.ledger,
      fingerprint: ctx.fingerprint,
      repoRoot: ctx.repoRoot,
      worktreePath: own.worktreePath,
      branch: own.branch,
      sessionId: ctx.sessionId,
      ...(own.sourceBranch === undefined ? {} : { sourceBranch: own.sourceBranch }),
      deps: ctx.deps,
    });
    return {
      outcome: "reattached",
      fingerprint: ctx.fingerprint,
      handle: {
        path: own.worktreePath,
        branch: own.branch,
        baseRef: ctx.head,
        repoRoot: ctx.repoRoot,
        ...(own.sourceBranch === undefined ? {} : { sourceBranch: own.sourceBranch }),
      },
    };
  }
  return undefined; // 分支也没了 → 调用方走全量新建流程
}

async function adoptRegistered(input: {
  manager: SessionWorktreeManager;
  ledger: SessionWorktreeLedger;
  fingerprint: string;
  repoRoot: string;
  path: string;
  branch: string;
  head: string;
  sessionId: string;
  sourceBranch?: string;
  deps: EnterSessionWorktreeDeps;
}): Promise<EnterSessionWorktreeResult> {
  await input.ledger.bind({
    sessionId: input.sessionId,
    repoFingerprint: input.fingerprint,
    repoRoot: input.repoRoot,
    worktreePath: input.path,
    branch: input.branch,
    baseRef: input.head,
    ...(input.sourceBranch === undefined ? {} : { sourceBranch: input.sourceBranch }),
  });
  bindFenceForSession({
    ledger: input.ledger,
    fingerprint: input.fingerprint,
    repoRoot: input.repoRoot,
    worktreePath: input.path,
    branch: input.branch,
    sessionId: input.sessionId,
    ...(input.sourceBranch === undefined ? {} : { sourceBranch: input.sourceBranch }),
    deps: input.deps,
  });
  return {
    outcome: "reattached",
    fingerprint: input.fingerprint,
    handle: {
      path: input.path,
      branch: input.branch,
      baseRef: input.head,
      repoRoot: input.repoRoot,
      ...(input.sourceBranch === undefined ? {} : { sourceBranch: input.sourceBranch }),
    },
  };
}

/** 围栏绑定 + 心跳回台账（节流在 fence 模块；这里只给回调与间隔）。 */
function bindFenceForSession(input: {
  ledger: SessionWorktreeLedger;
  fingerprint: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  sessionId: string;
  sourceBranch?: string;
  deps: EnterSessionWorktreeDeps;
}): void {
  const { ledger, fingerprint, sessionId } = input;
  bindSessionWorktreeFence(
    {
      sessionId,
      repoFingerprint: fingerprint,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branch: input.branch,
      ...(input.sourceBranch === undefined ? {} : { sourceBranch: input.sourceBranch }),
    },
    {
      flushTouch: () => ledger.touch(sessionId, fingerprint),
      ...(input.deps.fenceFlushIntervalMs === undefined
        ? {}
        : { flushIntervalMs: input.deps.fenceFlushIntervalMs }),
      ...(input.deps.now ? { now: input.deps.now } : {}),
    },
  );
}
