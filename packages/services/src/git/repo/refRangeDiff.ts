import type {
  GitDiffAvailability,
  GitRefRangeDiffReason,
  GitRefRangeDiffRequest,
  GitRefRangeDiffResult,
  GitRefRangeDiffStat,
  GitRefRangeFileChange,
} from "@acode/shared";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_DIFF_BYTES,
  DEFAULT_GIT_DIFF_TIMEOUT_MS,
  DEFAULT_GIT_OUTPUT_BYTES,
} from "../config.js";
import type {
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../providers/gitCommandProvider.js";
import {
  inferKindFromNumstat,
  normalizeInputPath,
  parseNumstat,
  toDiffResult,
} from "./gitCliHelpers.js";
import type { GitLineStat, GitResolvedRepository } from "./gitCliTypes.js";

/**
 * ref-range diff 读取（team-acceptance-review-contract.md 契约 B）。
 *
 * 语义：`git diff <baseRef> <headRef>`（只含已提交内容，不含工作区/暂存），与插件
 * `agent_teams_review_member_diff`（apps/acode-cli/specs/agent-teams-acceptance-loop.md R1.1）
 * 一致。两端都是调用方钉住的显式 rev；本模块只解析这两个显式 rev，
 * **绝不回落 HEAD / 分支名 / 工作区状态**——回落会把「审的那一份」悄悄换成「现在的那一份」，
 * 这正是 Fynvra 修过、契约 B 附录 C 明令禁止的坑（EI-9：能力声明必须诚实）。
 *
 * 任何解析失败都返回 `availability:"unavailable"` + 机器可判 `reason`，不编造空结果冒充成功。
 */

type CommitResolveOutcome =
  | { status: "resolved"; sha: string }
  | { status: "unresolved" }
  | { status: "timeout" };

function commandMessage(result: GitCommandExecutionResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exitCode=${result.exitCode ?? "null"}`;
}

/** 构造字段齐全的空结果：所有失败路径共用，保证 `files` 恒为数组、不出现 undefined。 */
function emptyResult(params: {
  baseRef: string;
  headRef: string;
  reason: GitRefRangeDiffReason;
  availability: GitDiffAvailability;
  resolvedBase?: string | null;
  resolvedHead?: string | null;
  filesTruncated?: boolean;
  summary: string | null;
}): GitRefRangeDiffResult {
  return {
    baseRef: params.baseRef,
    headRef: params.headRef,
    resolvedBase: params.resolvedBase ?? null,
    resolvedHead: params.resolvedHead ?? null,
    availability: params.availability,
    reason: params.reason,
    files: [],
    filesTruncated: params.filesTruncated ?? false,
    stat: null,
    patch: null,
    summary: params.summary,
  };
}

/**
 * 把显式 rev 解析成提交 SHA。`<rev>^{commit}` 只接受能解引用成提交对象的 rev：
 * 不存在的 SHA / 分支名会以非零退出、无输出返回，这里如实归为 unresolved，绝不改写为 HEAD。
 */
async function resolveCommitSha(
  commandProvider: GitCommandProvider,
  repoRoot: string,
  ref: string,
): Promise<CommitResolveOutcome> {
  const result = await commandProvider.run({
    cwd: repoRoot,
    args: ["rev-parse", "--verify", `${ref}^{commit}`],
    posture: "read",
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
  });
  if (result.timedOut) {
    return { status: "timeout" };
  }

  const sha = result.stdout.trim();
  // SHA-1(40) / SHA-256(64) 十六进制；不匹配即视为未解析（不空手编造）。
  if (result.exitCode === 0 && /^[0-9a-f]{40,64}$/i.test(sha)) {
    return { status: "resolved", sha };
  }
  return { status: "unresolved" };
}

function toRefRangeFiles(stats: Map<string, GitLineStat>): GitRefRangeFileChange[] {
  return Array.from(stats.entries()).map(([path, stat]) => ({
    path,
    originalPath: stat.originalPath ?? null,
    kind: inferKindFromNumstat(stat),
    added: stat.added,
    removed: stat.removed,
  }));
}

function summarizeStat(files: readonly GitRefRangeFileChange[]): GitRefRangeDiffStat {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  return { added, removed, fileCount: files.length };
}

export async function readRefRangeDiff(options: {
  commandProvider: GitCommandProvider;
  resolution: GitResolvedRepository;
  params: GitRefRangeDiffRequest;
}): Promise<GitRefRangeDiffResult> {
  const { commandProvider, resolution, params } = options;
  const baseRef = params.baseRef;
  const headRef = params.headRef;

  if (!resolution.isGitAvailable) {
    return emptyResult({
      baseRef,
      headRef,
      reason: "git_unavailable",
      availability: "unavailable",
      summary: "Git binary is not available in the current environment.",
    });
  }

  if (!resolution.isRepository) {
    return emptyResult({
      baseRef,
      headRef,
      reason: "not_a_repository",
      availability: "unavailable",
      summary: "Workspace is not inside a Git repository.",
    });
  }

  const base = await resolveCommitSha(commandProvider, resolution.repoRoot, baseRef);
  const head = await resolveCommitSha(commandProvider, resolution.repoRoot, headRef);
  const resolvedBase = base.status === "resolved" ? base.sha : null;
  const resolvedHead = head.status === "resolved" ? head.sha : null;

  if (base.status === "timeout" || head.status === "timeout") {
    return emptyResult({
      baseRef,
      headRef,
      resolvedBase,
      resolvedHead,
      reason: "timeout",
      availability: "unavailable",
      summary: "Resolving the base/head revision timed out.",
    });
  }

  if (base.status !== "resolved" || head.status !== "resolved") {
    const unresolved = [
      base.status !== "resolved" ? `baseRef "${baseRef}"` : null,
      head.status !== "resolved" ? `headRef "${headRef}"` : null,
    ].filter((value): value is string => value !== null);
    return emptyResult({
      baseRef,
      headRef,
      resolvedBase,
      resolvedHead,
      reason: "ref_unresolved",
      availability: "unavailable",
      summary: `${unresolved.join(" and ")} cannot be resolved to a commit in this repository; the commits may have been cleaned up and garbage-collected.`,
    });
  }

  // 两端已钉成 SHA：后续命令逐字使用这两个 SHA，命令行中不出现 HEAD 或分支名。
  // （契约 B 验收场景 7：命令行必须逐字含这两个 SHA；EI-9：不回落 HEAD。）
  let repoRelativePath: string | null = null;
  if (params.path) {
    repoRelativePath = await normalizeInputPath(resolution, params.path);
  }
  const pathArgs = repoRelativePath ? ["--", repoRelativePath] : ["--"];

  const numstatArgs = [
    "diff",
    "--numstat",
    "-z",
    "--find-renames",
    base.sha,
    head.sha,
    ...pathArgs,
  ];
  const numstatResult = await commandProvider.run({
    cwd: resolution.repoRoot,
    args: numstatArgs,
    posture: "read",
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
  });

  if (numstatResult.timedOut) {
    return emptyResult({
      baseRef,
      headRef,
      resolvedBase,
      resolvedHead,
      reason: "timeout",
      availability: "unavailable",
      summary: "Listing changed files timed out.",
    });
  }
  if (!numstatResult.outputTruncated && numstatResult.exitCode !== 0) {
    return emptyResult({
      baseRef,
      headRef,
      resolvedBase,
      resolvedHead,
      reason: "git_unavailable",
      availability: "unavailable",
      summary: commandMessage(numstatResult),
    });
  }

  // 结构化文件清单超上限 → 整段丢弃 + 失步标记（EI-97：绝不从中间截断结构化序列）。
  const filesTruncated = numstatResult.outputTruncated;
  const files = filesTruncated
    ? []
    : toRefRangeFiles(parseNumstat(numstatResult.stdout));
  // 文件清单已成立时，stat 由它精确算出；整段丢弃后无法诚实求和，置 null。
  const stat = filesTruncated ? null : summarizeStat(files);

  // patch 单独取一次；展示层行级截断由 UI 落地，服务侧沿用既有 toDiffResult 溢出语义。
  const patchResult = await commandProvider.run({
    cwd: resolution.repoRoot,
    args: [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--binary",
      "--find-renames",
      base.sha,
      head.sha,
      ...pathArgs,
    ],
    posture: "read",
    timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
  });

  if (patchResult.timedOut) {
    return {
      baseRef,
      headRef,
      resolvedBase,
      resolvedHead,
      availability: "unavailable",
      reason: "timeout",
      files,
      filesTruncated,
      stat,
      patch: null,
      summary: "Computing the diff timed out.",
    };
  }

  const patchLabel = repoRelativePath ?? `${base.sha}..${head.sha}`;
  const patchParsed = toDiffResult(patchLabel, patchResult, {
    emptySummary: "No changes between the resolved base and head commits.",
  });

  if (patchParsed.availability === "truncated") {
    // patch 溢出：patch 置 null，但文件清单/stat 来自独立的 numstat，仍如实保留。
    return {
      baseRef,
      headRef,
      resolvedBase,
      resolvedHead,
      availability: "truncated",
      reason: "output_too_large",
      files,
      filesTruncated,
      stat,
      patch: null,
      summary: patchParsed.summary ?? null,
    };
  }

  if (patchParsed.availability === "unavailable" && patchResult.exitCode !== 0) {
    return {
      baseRef,
      headRef,
      resolvedBase,
      resolvedHead,
      availability: "unavailable",
      reason: "git_unavailable",
      files,
      filesTruncated,
      stat,
      patch: null,
      summary: patchParsed.summary ?? null,
    };
  }

  if (patchParsed.availability === "unavailable") {
    // 命令成功但无输出：范围内无差异。`path` 同时作用于 numstat 与 patch，
    // 因此「空 patch」恒对应「空 files」，可如实报 no_changes（UI 按“无改动”而非“坏了”呈现）。
    if (files.length === 0 && !filesTruncated) {
      return {
        baseRef,
        headRef,
        resolvedBase,
        resolvedHead,
        availability: "unavailable",
        reason: "no_changes",
        files: [],
        filesTruncated: false,
        stat: { added: 0, removed: 0, fileCount: 0 },
        patch: null,
        summary: "No changes between the resolved base and head commits.",
      };
    }

    // 防御：文件清单非空却没有 patch 输出（两路输出不一致）——不冒充 no_changes。
    return {
      baseRef,
      headRef,
      resolvedBase,
      resolvedHead,
      availability: "unavailable",
      reason: "unknown",
      files,
      filesTruncated,
      stat,
      patch: null,
      summary: patchParsed.summary ?? null,
    };
  }

  const availability: GitDiffAvailability =
    patchParsed.availability === "binary" ? "binary" : "patch";

  return {
    baseRef,
    headRef,
    resolvedBase,
    resolvedHead,
    availability,
    reason: "ok",
    files,
    filesTruncated,
    stat,
    patch: availability === "patch" ? patchParsed.patch : null,
    summary: filesTruncated
      ? "The changed-file list exceeded the size limit and was dropped entirely (desync)."
      : null,
  };
}