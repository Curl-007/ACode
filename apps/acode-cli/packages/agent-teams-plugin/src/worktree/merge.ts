// AgentTeams 成员工作树的合并与清理（SPEC-015）。
//
// 从 manager.ts 拆出（架构 ratchet 400 行上限）：本文件只处理「已有工作树句柄」
// 的合并与保守清理；仓库解析、建树与 exclude 写入仍在 manager.ts。
// 判据与顺序以 spec 为准：冲突不自动解决，主工作区脏/不在基线分支时拒绝。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MemberWorktree } from "../state/types.js";
import { TeamError } from "../state/types.js";
import {
  countAhead,
  describeGitFailure,
  isWorktreeDirty,
  listRegisteredWorktrees,
  mainWorkspaceDiffStatus,
  parseMergeCommandConflicts,
  parseMergeTreeConflicts,
  refreshTrackedStat,
  runGit,
  snapshotPendingChanges,
} from "./git.js";
import {
  MEMBER_WORKTREE_BRANCH_PREFIX,
  isManagedWorktreeBranch,
  isManagedWorktreePath,
} from "./naming.js";

export type MergeMethod = "merge" | "squash";

export interface CleanupResult {
  branchRemoved: boolean;
  error?: string;
  keptReason?: "dirty" | "unmerged" | "foreign_worktree" | "missing" | "unregistered";
  removed: boolean;
}

export interface MergeResult {
  alreadyMerged: boolean;
  cleanup?: CleanupResult;
  commit: string;
  noChanges: boolean;
}

async function detectConflicts(
  repoRoot: string,
  baseBranch: string,
  branch: string,
): Promise<string[]> {
  const merged = await runGit(repoRoot, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    baseBranch,
    branch,
  ]);
  if (merged.exitCode === 0) return [];
  if (merged.exitCode === 1) return parseMergeTreeConflicts(merged.stdout);
  throw new TeamError("worktree_merge_failed", describeGitFailure("git merge-tree", merged));
}

async function abortMerge(repoRoot: string): Promise<boolean> {
  const aborted = await runGit(repoRoot, ["merge", "--abort"]);
  if (aborted.exitCode === 0) return true;
  // squash 不写 MERGE_HEAD，merge --abort 不适用；reset --merge 是兜底。
  const reset = await runGit(repoRoot, ["reset", "--merge", "HEAD"]);
  return reset.exitCode === 0;
}

/**
 * 合并成员分支到 baseBranch。冲突不自动解决：预检或实际合并失败都回滚主工作区后抛错。
 * 幂等：分支无独有提交时返回 alreadyMerged/noChanges。
 */
export async function mergeMemberWorktree(params: {
  repoRoot: string;
  baseBranch: string;
  handle: MemberWorktree;
  method: MergeMethod;
  message?: string;
  cleanup?: boolean;
}): Promise<MergeResult> {
  const { repoRoot, baseBranch, handle } = params;
  if (!isManagedWorktreeBranch(handle.branch) || !isManagedWorktreePath(repoRoot, handle.path)) {
    throw new TeamError(
      "worktree_not_found",
      `Worktree ${handle.branch} at ${handle.path} is not managed by AgentTeams.`,
    );
  }
  const branchHead = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    `refs/heads/${handle.branch}`,
  ]);
  if (branchHead.exitCode !== 0) {
    throw new TeamError("worktree_not_found", `Branch not found: ${handle.branch}`);
  }
  await snapshotPendingChanges(
    repoRoot,
    handle,
    `Snapshot AgentTeams member worktree ${handle.branch.slice(MEMBER_WORKTREE_BRANCH_PREFIX.length)}`,
  );

  // 主工作区脏判据用内容比较而非 `git status`：Windows 全局 core.autocrlf=true 时，
  // CRLF 检出被按 LF 原样重写后 status 会报 ` M`，但 `git diff --quiet HEAD` 为 0
  // （内容按 git 的转换规则与 HEAD 相同）。用 status 会把语义无变化的树误判为脏，
  // 让用户看到无法自洽的 worktree_dirty_workspace（提示「commit 或 revert」，
  // 而 git 自己又报 nothing to commit）。语义沿用既有的「只看 tracked」。
  const status = await mainWorkspaceDiffStatus(repoRoot);
  if (status.exitCode === 0) {
    // 干净：顺带刷新 stat 缓存，避免后续 git merge 把 autocrlf 幻影当成本地改动而拒绝。
    const refreshed = await refreshTrackedStat(repoRoot);
    if (refreshed.exitCode !== 0) {
      throw new TeamError("worktree_merge_failed", describeGitFailure("git add -u", refreshed));
    }
  } else if (status.exitCode === 1) {
    throw new TeamError(
      "worktree_dirty_workspace",
      "Main workspace has uncommitted changes; commit or revert them before merging.",
    );
  } else {
    throw new TeamError("worktree_merge_failed", describeGitFailure("git diff", status));
  }
  const current = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.exitCode !== 0 || current.stdout.trim() !== baseBranch) {
    throw new TeamError(
      "worktree_not_on_base_branch",
      `Main workspace is on ${current.stdout.trim() || "<unknown>"}, expected ${baseBranch}.`,
    );
  }

  const ahead = await countAhead(repoRoot, baseBranch, handle.branch);
  if (ahead === 0) {
    const cleanup = params.cleanup
      ? await cleanupMemberWorktree({ repoRoot, baseBranch, handle })
      : undefined;
    return {
      alreadyMerged: true,
      commit: (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim(),
      noChanges: true,
      ...(cleanup ? { cleanup } : {}),
    };
  }

  const conflicts = await detectConflicts(repoRoot, baseBranch, handle.branch);
  if (conflicts.length > 0) {
    throw new TeamError(
      "worktree_conflict",
      `Merging ${handle.branch} into ${baseBranch} would conflict in ${conflicts.length} file(s); the main workspace was not modified. Resolve them in the member worktree and deliver again.`,
      { conflicts },
    );
  }

  const message =
    params.message?.trim() ||
    `Merge AgentTeams member worktree ${handle.branch.slice(MEMBER_WORKTREE_BRANCH_PREFIX.length)} into ${baseBranch}`;
  const headBefore = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const merged =
    params.method === "squash"
      ? await runGit(repoRoot, ["merge", "--squash", handle.branch])
      : await runGit(repoRoot, ["merge", "--no-ff", "-m", message, handle.branch]);
  if (merged.exitCode !== 0) {
    const commandConflicts = parseMergeCommandConflicts(`${merged.stdout}\n${merged.stderr}`);
    const aborted = await abortMerge(repoRoot);
    const detail = describeGitFailure(
      params.method === "squash" ? "git merge --squash" : "git merge --no-ff",
      merged,
    );
    if (!aborted) {
      throw new TeamError(
        "worktree_merge_failed",
        `${detail}; automatic abort failed, inspect the main workspace before continuing.`,
        { conflicts: commandConflicts, abortFailed: true },
      );
    }
    if (commandConflicts.length > 0) {
      throw new TeamError("worktree_conflict", detail, { conflicts: commandConflicts });
    }
    throw new TeamError("worktree_merge_failed", detail, { conflicts: [] });
  }

  let noChanges = false;
  let commit = headBefore;
  if (params.method === "squash") {
    const staged = await runGit(repoRoot, ["diff", "--cached", "--quiet"]);
    if (staged.exitCode === 0) {
      noChanges = true;
    } else {
      const committed = await runGit(repoRoot, ["commit", "-m", message]);
      if (committed.exitCode !== 0) {
        const aborted = await abortMerge(repoRoot);
        throw new TeamError(
          "worktree_merge_failed",
          `${describeGitFailure("git commit", committed)}${aborted ? "" : "; automatic abort failed"}`,
          { abortFailed: !aborted },
        );
      }
      commit = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    }
  } else {
    commit = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    noChanges = commit === headBefore;
  }

  const cleanup = params.cleanup
    ? await cleanupMemberWorktree({ repoRoot, baseBranch, handle })
    : undefined;
  return {
    alreadyMerged: false,
    commit,
    noChanges,
    ...(cleanup ? { cleanup } : {}),
  };
}

/**
 * 保守清理：只有「路径/分支归属我们、树干净、分支无独有提交」才删；
 * 一律用 `git branch -d`，绝不 `-D`。
 */
export async function cleanupMemberWorktree(params: {
  repoRoot: string;
  baseBranch: string;
  handle: Pick<MemberWorktree, "path" | "branch">;
}): Promise<CleanupResult> {
  const { repoRoot, baseBranch, handle } = params;
  if (!isManagedWorktreeBranch(handle.branch) || !isManagedWorktreePath(repoRoot, handle.path)) {
    return { removed: false, branchRemoved: false, keptReason: "foreign_worktree" };
  }
  // 仓库根都不在了：无法核对任何事实，如实报告而不是声称删除成功。
  if (!existsSync(repoRoot)) {
    return {
      removed: false,
      branchRemoved: false,
      keptReason: "missing",
      error: `Repository root not found: ${repoRoot}`,
    };
  }
  const pathExists = existsSync(handle.path);
  if (!pathExists) {
    // 目录先被手工删掉时，git 仍保留失效登记；先 prune 再按分支判断。
    await runGit(repoRoot, ["worktree", "prune"]);
  }
  const registered = await listRegisteredWorktrees(repoRoot);
  const entry = registered.find(
    (item) => resolve(item.path) === resolve(handle.path) || item.branch === handle.branch,
  );
  if (pathExists && !entry) {
    // 目录在但 git 没登记：不能在它里面跑 git（会回落到上层主仓库的状态），
    // 也不能 worktree remove；如实保留，交给人工或 prune。
    return {
      removed: false,
      branchRemoved: false,
      keptReason: "unregistered",
    };
  }
  const branchPresent =
    (await runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${handle.branch}`])).exitCode ===
    0;
  if (!branchPresent && !entry && !pathExists) {
    return { removed: true, branchRemoved: true };
  }
  if (entry && (await isWorktreeDirty(handle.path))) {
    return { removed: false, branchRemoved: false, keptReason: "dirty" };
  }
  if (branchPresent && (await countAhead(repoRoot, baseBranch, handle.branch)) > 0) {
    return { removed: false, branchRemoved: false, keptReason: "unmerged" };
  }

  let removed = !pathExists && !entry;
  if (entry || pathExists) {
    // 内容判定为干净后，先刷新 tracked 文件的 stat 缓存：autocrlf 幻影会让
    // `git worktree remove`（不带 --force）误以为还有未提交改动而拒绝删除。
    // `git add -u` 不收集未跟踪文件、不改变内容，未跟踪文件仍由 git 自己拒绝删除。
    // 目录已不存在（只剩失效登记）时没有可刷新的工作区，跳过。
    if (entry && pathExists) {
      const refreshed = await refreshTrackedStat(handle.path);
      if (refreshed.exitCode !== 0) {
        return {
          removed: false,
          branchRemoved: false,
          error: describeGitFailure("git add -u", refreshed),
        };
      }
    }
    // 不带 --force：git 自己也会拒绝删除含未提交改动的树，作为第二道保险。
    const removal = await runGit(repoRoot, ["worktree", "remove", handle.path]);
    if (removal.exitCode !== 0) {
      return {
        removed: false,
        branchRemoved: false,
        error: describeGitFailure("git worktree remove", removal),
      };
    }
    removed = true;
  }
  let branchRemoved = false;
  if (branchPresent) {
    // -d 而非 -D：分支上若仍有未合并提交，git 会拒绝删除。
    const deleted = await runGit(repoRoot, ["branch", "-d", handle.branch]);
    if (deleted.exitCode === 0) {
      branchRemoved = true;
    } else {
      return {
        removed,
        branchRemoved: false,
        error: describeGitFailure("git branch -d", deleted),
      };
    }
  } else {
    branchRemoved = true;
  }
  return { removed, branchRemoved };
}
