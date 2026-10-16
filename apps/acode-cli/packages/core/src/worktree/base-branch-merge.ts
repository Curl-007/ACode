import type { ExecutionPort, TraceContext } from "@acode/contracts";
import { type MergeBaseBranchOutput, type MergeBaseSelection } from "@acode/contracts";

/**
 * base 分支合并（specs/session-worktree-lifecycle.md R5）：把基分支合并进会话分支。
 *
 * **宿主执行裁决**：git 经 ToolExecutionContext.executionPort 以 argv 模式、
 * `sandbox: {enabled:false}` 直跑——不经 Bash 工具的沙箱/只读治理。理由与参考机制
 * 同款：合并常触碰受保护路径（hooks/skills/mcp 配置一类），沙箱面会把它拦死；风险
 * 由写围栏（R4）与「不 push 不删除」兜住。
 *
 * 语义红线：不 push、不删除任何分支/远端引用；冲突**保留现场**（模型可解决后
 * commit，或 action=abort 恢复干净态）；工具自身绝不静默 abort、绝不在冲突态上
 * 叠加新合并。拒绝是普通工具结果（闭集 reason），git 基础设施故障 fail-loud。
 */

export interface HostGitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 宿主执行层的 git 运行面（与 execFile runner 的关键差异：非零退出**返回**而非抛，
 * 因为 merge 冲突正是非零退出 + 有用现场的业务结局）。 */
export type HostGitRunner = (args: readonly string[], cwd: string) => Promise<HostGitRunResult>;

export function createHostGitRunnerFromExecutionPort(
  port: ExecutionPort,
  trace?: TraceContext,
): HostGitRunner {
  return async (args, cwd) => {
    const result = await port.run({
      command: { mode: "argv", file: "git", args: [...args] },
      cwd,
      // 宿主直跑（spec R5）：不进沙箱——合并要能触碰受保护路径。
      sandbox: { enabled: false },
      ...(trace ? { trace } : {}),
    });
    if (result.status === "timed_out" || result.status === "cancelled") {
      throw new Error(
        `git ${args.join(" ")} was ${result.status} before it finished${
          result.error?.message ? `: ${result.error.message}` : ""
        }`,
      );
    }
    if (result.status === "spawn_error") {
      throw new Error(
        `git ${args.join(" ")} could not be spawned on the host execution layer: ${
          result.error?.message ?? "unknown spawn error"
        }`,
      );
    }
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
    };
  };
}

export interface BaseMergeInput {
  action: "merge" | "abort";
  base?: MergeBaseSelection;
  /** 会话 worktree 目录（合并的执行 cwd）。 */
  worktreePath: string;
  /** 会话分支（base_is_current_branch 判定用）。 */
  sessionBranch: string;
  /** enter 时记录的切出分支；detached 起源时缺席（source_branch_unknown）。 */
  sourceBranch?: string;
  /** PR base 解析器（PR 面落地后由装配层注入；缺席 → pr_surface_unavailable）。 */
  resolvePrBase?: () => Promise<string | undefined>;
}

const DEFAULT_MAIN_BRANCH_CANDIDATES = ["main", "master"] as const;

export async function mergeBaseBranchIntoSessionBranch(
  input: BaseMergeInput,
  deps: { git: HostGitRunner },
): Promise<MergeBaseBranchOutput> {
  const git = deps.git;
  const cwd = input.worktreePath;
  const rejected = (
    reason: NonNullable<MergeBaseBranchOutput["reason"]>,
    message: string,
  ): MergeBaseBranchOutput => ({ outcome: "rejected", reason, message });

  // ── abort 语义：只结算既有冲突现场，不产生任何新事实 ──
  if (input.action === "abort") {
    if (!(await mergeInProgress(git, cwd))) {
      return {
        outcome: "no_merge_in_progress",
        message: "No merge is in progress in this session worktree; nothing to abort.",
      };
    }
    await runOrThrow(git, ["merge", "--abort"], cwd);
    return {
      outcome: "aborted",
      message: "Merge aborted; the session worktree is back to a clean state.",
    };
  }

  // ── merge：base 闭集 + 前置拒绝（spec R5，顺序即优先级）──
  if (!input.base) {
    return rejected(
      "base_not_allowed",
      "base is required for action=merge: source_branch | default_branch | pr_base.",
    );
  }
  if (input.base === "pr_base") {
    const prBase = input.resolvePrBase ? await input.resolvePrBase() : undefined;
    if (!prBase) {
      return rejected(
        "pr_surface_unavailable",
        "pr_base needs a PR surface, which this build does not have. Use source_branch or default_branch.",
      );
    }
    return await runMerge(git, cwd, input, prBase);
  }
  if (await mergeInProgress(git, cwd)) {
    return rejected(
      "merge_in_progress",
      "A merge is already in progress in this session worktree. Resolve it and commit, or call this tool with action=abort first.",
    );
  }
  if (await hasUncommittedChanges(git, cwd)) {
    return rejected(
      "uncommitted_changes",
      "The session worktree has uncommitted changes. Commit (or discard) them before merging the base branch — a merge must not swallow work in progress.",
    );
  }

  if (input.base === "source_branch") {
    if (!input.sourceBranch) {
      return rejected(
        "source_branch_unknown",
        "This session worktree was created from a detached HEAD, so there is no source branch on record. Merge default_branch instead.",
      );
    }
    if (!(await refExists(git, cwd, `refs/heads/${input.sourceBranch}`))) {
      return rejected(
        "base_not_found",
        `Source branch ${input.sourceBranch} no longer exists in this repository.`,
      );
    }
    return await runMerge(git, cwd, input, input.sourceBranch);
  }

  // default_branch：解析镜像 git-snapshot 的优先级（origin/HEAD → origin 候选 → 本地候选），
  // 但绝不兜底返回 "main"——merge 需要真实 ref。
  const defaultBranch = await resolveDefaultBranch(git, cwd);
  if (!defaultBranch) {
    return rejected(
      "default_branch_not_found",
      "Could not resolve the repository default branch (no origin/HEAD, no origin or local main/master).",
    );
  }
  const mergeTarget = (await refExists(git, cwd, `refs/heads/${defaultBranch}`))
    ? defaultBranch
    : `origin/${defaultBranch}`;
  if (
    !(await refExists(
      git,
      cwd,
      mergeTarget.startsWith("origin/")
        ? `refs/remotes/${mergeTarget}`
        : `refs/heads/${mergeTarget}`,
    ))
  ) {
    return rejected(
      "base_not_found",
      `Default branch ${defaultBranch} does not resolve to a real ref (${mergeTarget}).`,
    );
  }
  return await runMerge(git, cwd, input, mergeTarget);
}

async function runMerge(
  git: HostGitRunner,
  cwd: string,
  input: BaseMergeInput,
  baseRef: string,
): Promise<MergeBaseBranchOutput> {
  if (baseRef === input.sessionBranch || baseRef.replace(/^origin\//, "") === input.sessionBranch) {
    return {
      outcome: "rejected",
      reason: "base_is_current_branch",
      message: `The base ref ${baseRef} is the session branch itself; there is nothing to merge.`,
    };
  }
  const merge = await git(["merge", "--no-edit", baseRef], cwd);
  if (merge.exitCode === 0) {
    if (/already up[ -]to[ -]date/i.test(merge.stdout)) {
      return {
        outcome: "up_to_date",
        base_ref: baseRef,
        message: `The session branch already contains ${baseRef}; nothing was merged.`,
      };
    }
    const head = await runOrThrow(git, ["rev-parse", "HEAD"], cwd);
    return {
      outcome: "merged",
      base_ref: baseRef,
      merge_commit: head.stdout.trim(),
      message: `Merged ${baseRef} into ${input.sessionBranch} (merge commit ${head.stdout.trim().slice(0, 12)}). Nothing was pushed and no branch was deleted.`,
    };
  }
  // 非零退出：冲突现场保留（MERGE_HEAD 在场）→ conflict；否则是基础设施故障，fail-loud。
  if (await mergeInProgress(git, cwd)) {
    const conflicted = await conflictedFiles(git, cwd);
    return {
      outcome: "conflict",
      base_ref: baseRef,
      conflicted_files: conflicted,
      message: [
        `Merging ${baseRef} hit conflicts in ${conflicted.length} file(s). The conflict state is kept in place:`,
        ...conflicted.map((file) => `- ${file}`),
        "Resolve the conflicts and commit inside the worktree, or call this tool with action=abort to restore a clean state.",
      ].join("\n"),
    };
  }
  throw new Error(
    `git merge --no-edit ${baseRef} failed on the host execution layer (exit ${merge.exitCode}): ${
      merge.stderr.trim() || merge.stdout.trim() || "no git output"
    }`,
  );
}

async function resolveDefaultBranch(git: HostGitRunner, cwd: string): Promise<string | undefined> {
  let originHeadBranch: string | undefined;
  const symbolic = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (symbolic.exitCode === 0) {
    originHeadBranch = symbolic.stdout.trim().replace(/^origin\//, "") || undefined;
  }
  const candidates = originHeadBranch
    ? [originHeadBranch, ...DEFAULT_MAIN_BRANCH_CANDIDATES]
    : [...DEFAULT_MAIN_BRANCH_CANDIDATES];
  for (const candidate of candidates) {
    if (await refExists(git, cwd, `refs/remotes/origin/${candidate}`)) return candidate;
  }
  for (const candidate of candidates) {
    if (await refExists(git, cwd, `refs/heads/${candidate}`)) return candidate;
  }
  return undefined;
}

async function refExists(git: HostGitRunner, cwd: string, ref: string): Promise<boolean> {
  const result = await git(["show-ref", "--verify", "--quiet", ref], cwd);
  return result.exitCode === 0;
}

async function mergeInProgress(git: HostGitRunner, cwd: string): Promise<boolean> {
  const result = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd);
  return result.exitCode === 0 && result.stdout.trim() !== "";
}

async function hasUncommittedChanges(git: HostGitRunner, cwd: string): Promise<boolean> {
  const result = await runOrThrow(git, ["status", "--porcelain"], cwd);
  return result.stdout.trim() !== "";
}

async function conflictedFiles(git: HostGitRunner, cwd: string): Promise<string[]> {
  const result = await runOrThrow(git, ["diff", "--name-only", "--diff-filter=U"], cwd);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function runOrThrow(
  git: HostGitRunner,
  args: readonly string[],
  cwd: string,
): Promise<HostGitRunResult> {
  const result = await git(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed on the host execution layer (exit ${result.exitCode}): ${
        result.stderr.trim() || result.stdout.trim() || "no git output"
      }`,
    );
  }
  return result;
}
