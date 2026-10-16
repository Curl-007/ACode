// ============================================================
// Session Worktree Tools - 会话级 git worktree 生命周期契约
// ============================================================
// 三个工具面（apps/acode-cli/specs/session-worktree-lifecycle.md）：
//   - EnterSessionWorktree：会话直接开在用户 checkout 时，代码改动前进入隔离
//     worktree（从 HEAD 切分支，不携带未提交改动），经既有 setWorkingDirectory
//     漏斗切 cwd。
//   - MergeBaseBranch：把基分支合并进会话分支。base 是闭集（切出分支 / 仓库默认
//     分支 / PR base），git 在宿主执行层跑（不经 Bash 工具的沙箱/只读治理）；
//     不 push 不删除；冲突保留现场 + abort 语义。
//   - ReapSessionWorktrees：按 older_than_days（30/60/90）收割不活跃会话
//     worktree；运行中/打开/最近使用的绝不动；会话与分支保留（重开重挂）。
//
// 拒绝是**普通工具结果**而非错误（对齐 escalate 的裁决）：模型需要读到闭集
// reason 改道，而不是把可预期的边界当成可重试的故障反复撞墙。
//
// 写围栏 env 键（spec R4）的单一事实源也放在本文件：core（进程内 path-policy
// 判定）与 adapters（子进程注入缝）都要读，而两个包互不 import，只能经 contracts。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const ENTER_SESSION_WORKTREE_TOOL_NAME = "EnterSessionWorktree";
export const MERGE_BASE_BRANCH_TOOL_NAME = "MergeBaseBranch";
export const REAP_SESSION_WORKTREES_TOOL_NAME = "ReapSessionWorktrees";

// ── 写围栏 env 键（ACODE_ 前缀，命名规约对齐 packages/shared/src/runtimeEnv.ts）──

/** 子进程边界标记：本次执行属于受管会话 worktree，值 = worktree 绝对路径。 */
export const SESSION_WORKTREE_ENV_KEY = "ACODE_SESSION_WORKTREE";
/** 围栏档位：`warn`（缺省，记录不拦）| `enforce`（越界写拒绝）。 */
export const SESSION_WORKTREE_FENCE_ENV_KEY = "ACODE_SESSION_WORKTREE_FENCE";
/** E2E/测试关闭开关：truthy（1/true/on）时围栏判定一律放行（生命周期事实不受影响）。 */
export const SESSION_WORKTREE_FENCE_OFF_ENV_KEY = "ACODE_SESSION_WORKTREE_FENCE_OFF";
/**
 * 执行层注入/删除的键名单（spec R7-5）：provider 结果里缺席的名单键从子进程 env
 * 删除——防止父进程环境里的陈旧边界值漏给未绑定的会话。
 */
export const SESSION_WORKTREE_ENV_KEYS: readonly string[] = [
  SESSION_WORKTREE_ENV_KEY,
  SESSION_WORKTREE_FENCE_ENV_KEY,
];

export const SessionWorktreeFenceModeSchema = z.enum(["warn", "enforce", "off"]);
export type SessionWorktreeFenceMode = z.infer<typeof SessionWorktreeFenceModeSchema>;

// ── EnterSessionWorktree ────────────────────────────────────────────

export const EnterSessionWorktreeInputSchema = z
  .object({
    branch_name: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Optional human-readable suffix for the session branch. It is slugified into acode/session/<slug>; omit it to derive the branch from the session id.",
      ),
  })
  .strict();

export type EnterSessionWorktreeInput = z.infer<typeof EnterSessionWorktreeInputSchema>;

/** 拒绝理由闭集（spec R2）。 */
export const EnterSessionWorktreeRejectReasonSchema = z.enum([
  "not_git_repo",
  "unborn_head",
  "inside_linked_worktree",
  "already_in_session_worktree",
  "branch_in_use",
]);

export type EnterSessionWorktreeRejectReason = z.infer<
  typeof EnterSessionWorktreeRejectReasonSchema
>;

export const EnterSessionWorktreeOutputSchema = z
  .object({
    /**
     * `entered` 新建并切入；`reused` 本会话已有活绑定（cwd 切回去）；`reattached`
     * 绑定曾被收割/目录丢失，按台账重挂既有分支；`rejected` 见 reason。
     */
    outcome: z.enum(["entered", "reused", "reattached", "rejected"]),
    reason: EnterSessionWorktreeRejectReasonSchema.optional(),
    worktree_path: z.string().optional(),
    branch: z.string().optional(),
    base_ref: z.string().optional(),
    /** enter 时用户 checkout 所在的分支（detached HEAD 时缺席）。 */
    source_branch: z.string().optional(),
    repo_root: z.string().optional(),
    fence_mode: SessionWorktreeFenceModeSchema.optional(),
    message: z.string(),
  })
  .strict();

export type EnterSessionWorktreeOutput = z.infer<typeof EnterSessionWorktreeOutputSchema>;

export const EnterSessionWorktreeInputJsonSchema = toToolJsonSchema(
  EnterSessionWorktreeInputSchema,
);
export const EnterSessionWorktreeOutputJsonSchema = toToolJsonSchema(
  EnterSessionWorktreeOutputSchema,
);

// ── MergeBaseBranch ─────────────────────────────────────────────────

/** base 闭集（spec R5）：切出分支 / 仓库默认分支 / PR base（PR 面缺席即拒绝）。 */
export const MergeBaseSelectionSchema = z.enum(["source_branch", "default_branch", "pr_base"]);
export type MergeBaseSelection = z.infer<typeof MergeBaseSelectionSchema>;

export const MergeBaseBranchInputSchema = z
  .object({
    action: z
      .enum(["merge", "abort"])
      .optional()
      .describe(
        "merge (default) merges the base branch into the session branch; abort runs `git merge --abort` to restore a clean state after a conflict.",
      ),
    base: MergeBaseSelectionSchema.optional().describe(
      "Required for action=merge. source_branch = the branch the session worktree was cut from; default_branch = the repository default branch; pr_base is rejected until a PR surface exists.",
    ),
  })
  .strict();

export type MergeBaseBranchInput = z.infer<typeof MergeBaseBranchInputSchema>;

/** 拒绝理由闭集（spec R5）。 */
export const MergeBaseBranchRejectReasonSchema = z.enum([
  "not_in_session_worktree",
  "merge_in_progress",
  "uncommitted_changes",
  "base_not_allowed",
  "base_is_current_branch",
  "base_not_found",
  "source_branch_unknown",
  "default_branch_not_found",
  "pr_surface_unavailable",
]);

export type MergeBaseBranchRejectReason = z.infer<typeof MergeBaseBranchRejectReasonSchema>;

export const MergeBaseBranchOutputSchema = z
  .object({
    /**
     * `merged` 生成 merge commit；`up_to_date` 无需合并；`conflict` 冲突现场保留
     * （解决后 commit，或 action=abort）；`aborted` 已 abort；`no_merge_in_progress`
     * abort 时无冲突现场；`rejected` 见 reason。
     */
    outcome: z.enum([
      "merged",
      "up_to_date",
      "conflict",
      "aborted",
      "no_merge_in_progress",
      "rejected",
    ]),
    reason: MergeBaseBranchRejectReasonSchema.optional(),
    /** 实际合并进来的 base ref（分支名或 sha）。 */
    base_ref: z.string().optional(),
    merge_commit: z.string().optional(),
    conflicted_files: z.array(z.string()).optional(),
    message: z.string(),
  })
  .strict();

export type MergeBaseBranchOutput = z.infer<typeof MergeBaseBranchOutputSchema>;

export const MergeBaseBranchInputJsonSchema = toToolJsonSchema(MergeBaseBranchInputSchema);
export const MergeBaseBranchOutputJsonSchema = toToolJsonSchema(MergeBaseBranchOutputSchema);

// ── ReapSessionWorktrees ────────────────────────────────────────────

/** 收割阈值闭集（spec R6，对应设置面「清理不活跃会话」档位语义）。 */
export const ReapSessionWorktreesInputSchema = z
  .object({
    older_than_days: z
      .union([z.literal(30), z.literal(60), z.literal(90)])
      .describe(
        "Reap session worktrees whose last activity is older than this many days. Running, open, recently used, and dirty (uncommitted changes) worktrees are never touched; sessions and branches are kept.",
      ),
  })
  .strict();

export type ReapSessionWorktreesInput = z.infer<typeof ReapSessionWorktreesInputSchema>;

/** 单条目结局闭集（spec R6）。 */
export const ReapSessionWorktreeEntryOutcomeSchema = z.enum([
  "reaped",
  "dirty_kept",
  "recently_used",
  "in_use_current_process",
  "remove_failed_kept",
  "tombstoned_missing",
]);

export type ReapSessionWorktreeEntryOutcome = z.infer<typeof ReapSessionWorktreeEntryOutcomeSchema>;

export const ReapSessionWorktreesOutputSchema = z
  .object({
    reaped: z.number().int().nonnegative(),
    kept: z.number().int().nonnegative(),
    tombstoned: z.number().int().nonnegative(),
    entries: z
      .array(
        z
          .object({
            session_id: z.string(),
            branch: z.string(),
            worktree_path: z.string().optional(),
            outcome: ReapSessionWorktreeEntryOutcomeSchema,
          })
          .strict(),
      )
      .optional(),
    message: z.string(),
  })
  .strict();

export type ReapSessionWorktreesOutput = z.infer<typeof ReapSessionWorktreesOutputSchema>;

export const ReapSessionWorktreesInputJsonSchema = toToolJsonSchema(
  ReapSessionWorktreesInputSchema,
);
export const ReapSessionWorktreesOutputJsonSchema = toToolJsonSchema(
  ReapSessionWorktreesOutputSchema,
);
