// AgentTeams 成员工作树生命周期（SPEC-015）。
//
// 复用 CLI 工作流隔离（acode/wt/）的目录、分支与清理判据，但本插件不能依赖
// @acode/bootstrap（会改依赖与锁文件），因此在插件内实现同一套 git 编排：
// create / snapshot / precheck / merge / cleanup。判据与顺序以 spec 为准。
//
// 架构 ratchet 400 行：合并与清理（mergeMemberWorktree/cleanupMemberWorktree）
// 拆到 merge.ts；本文件保留仓库解析、exclude 写入、建树与派工说明，并 re-export
// 合并面以保持既有 import 路径不变。
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MemberWorktree } from "../state/types.js";
import { TeamError } from "../state/types.js";
import { describeGitFailure, runGit, serializeWorktreeCreation } from "./git.js";
import {
  WORKTREES_EXCLUDE_PATTERN,
  WORKTREES_RELATIVE_DIR,
  buildMemberWorktreeBranch,
  buildMemberWorktreePath,
  planMemberWorktreeName,
} from "./naming.js";

export type { CleanupResult, MergeMethod, MergeResult } from "./merge.js";
export { cleanupMemberWorktree, mergeMemberWorktree } from "./merge.js";

export interface RepoInfo {
  repoRoot: string;
  baseBranch: string;
  baseCommit: string;
}

/** 解析仓库根、当前分支与 HEAD；不满足隔离前提时抛 worktree_unavailable。 */
export async function inspectRepo(dir: string): Promise<RepoInfo> {
  const root = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (root.exitCode !== 0) {
    throw new TeamError(
      "worktree_unavailable",
      `Worktree isolation requires a git repository; ${dir} is not inside one.`,
    );
  }
  const repoRoot = resolve(root.stdout.trim());
  const head = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head.exitCode !== 0) {
    throw new TeamError(
      "worktree_unavailable",
      `Worktree isolation requires at least one commit in ${repoRoot}.`,
    );
  }
  const branch = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseBranch = branch.exitCode === 0 ? branch.stdout.trim() : "";
  if (!baseBranch || baseBranch === "HEAD") {
    throw new TeamError(
      "worktree_unavailable",
      "Worktree isolation requires a checked-out branch (detached HEAD is not supported).",
    );
  }
  return { repoRoot, baseBranch, baseCommit: head.stdout.trim() };
}

/** 幂等地把 `.acode/worktrees/` 写进共享的 `.git/info/exclude`。 */
async function ensureWorktreesExcluded(repoRoot: string): Promise<void> {
  const gitPath = await runGit(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (gitPath.exitCode !== 0) {
    throw new TeamError("worktree_create_failed", describeGitFailure("git rev-parse", gitPath));
  }
  const excludePath = resolve(repoRoot, gitPath.stdout.trim());
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const covered = existing
    .split(/\r?\n/gu)
    .some(
      (line) => line.trim() === WORKTREES_EXCLUDE_PATTERN || line.trim() === ".acode/worktrees/",
    );
  if (covered) return;
  await mkdir(resolve(excludePath, ".."), { recursive: true });
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await appendFile(excludePath, `${prefix}${WORKTREES_EXCLUDE_PATTERN}\n`, "utf8");
}

/** 建一棵成员工作树；失败抛 worktree_create_failed，调用方不得登记成员。 */
export async function createMemberWorktree(params: {
  repoRoot: string;
  baseBranch: string;
  teamId: string;
  memberName: string;
}): Promise<MemberWorktree> {
  const current = await runGit(params.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.exitCode !== 0 || current.stdout.trim() !== params.baseBranch) {
    throw new TeamError(
      "worktree_not_on_base_branch",
      `Main workspace is on ${current.stdout.trim() || "<unknown>"}, expected ${params.baseBranch}.`,
    );
  }
  const head = await runGit(params.repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head.exitCode !== 0) {
    throw new TeamError(
      "worktree_unavailable",
      `Cannot create a member worktree: ${params.repoRoot} has no commits.`,
    );
  }
  await ensureWorktreesExcluded(params.repoRoot);
  const name = planMemberWorktreeName(
    params.teamId,
    params.memberName,
    randomUUID().replace(/-/gu, "").slice(0, 8),
  );
  const path = buildMemberWorktreePath(params.repoRoot, name);
  const branch = buildMemberWorktreeBranch(name);
  await mkdir(resolve(params.repoRoot, WORKTREES_RELATIVE_DIR), { recursive: true });
  const added = await serializeWorktreeCreation(params.repoRoot, () =>
    runGit(params.repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]),
  );
  if (added.exitCode !== 0) {
    throw new TeamError("worktree_create_failed", describeGitFailure("git worktree add", added));
  }
  return {
    path,
    branch,
    baseBranch: params.baseBranch,
    baseCommit: head.stdout.trim(),
    status: "active",
  };
}

/** 派工/状态里给成员的工作树说明（路径与分支是唯一事实）。 */
export function describeMemberWorktree(
  handle: Pick<MemberWorktree, "path" | "branch" | "baseBranch">,
): string {
  return [
    `Worktree isolation is ON for this team.`,
    `Work only inside this worktree: ${handle.path}`,
    `Branch: ${handle.branch} (base: ${handle.baseBranch}).`,
    `Use absolute paths under the worktree for every file operation and command.`,
    `Do not commit or merge; the captain merges your branch when you deliver.`,
  ].join("\n");
}
