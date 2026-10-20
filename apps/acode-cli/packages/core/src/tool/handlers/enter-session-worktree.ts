// ============================================================
// EnterSessionWorktree Tool Handler
// ============================================================
// 会话直接开在用户 checkout 时，做任何代码改动前进入隔离 worktree
// （specs/session-worktree-lifecycle.md R2）：从当前 HEAD 切分支、**不携带未提交
// 改动**（它们留在用户 checkout 原地），cwd 经既有 setWorkingDirectory 漏斗切换
// （触发 CwdChanged hook），workspaceRoot 不变（工作区身份不随执行 cwd 漂移）。
//
// 拒绝是普通工具结果（闭集 reason，对齐 escalate 的「拒绝不是错误」裁决）；git
// 基础设施故障 fail-loud 上抛。已在受管 worktree 内 → already_in_session_worktree；
// 在任何 linked worktree 内（别人的会话/workflow 域/用户自建）→ inside_linked_worktree。

import {
  CoreErrorType,
  ENTER_SESSION_WORKTREE_TOOL_NAME,
  EnterSessionWorktreeInputJsonSchema,
  EnterSessionWorktreeInputSchema,
  EnterSessionWorktreeOutputJsonSchema,
  EnterSessionWorktreeOutputSchema,
  createCoreError,
  type EnterSessionWorktreeInput,
  type EnterSessionWorktreeOutput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  enterSessionWorktree,
  type EnterSessionWorktreeDeps,
} from "../../worktree/session-worktree-enter.js";
import { resolveSessionWorktreeFenceMode } from "../../worktree/session-worktree-fence.js";

const MAX_OUTPUT_BYTES = 16_000;
const ENTER_TIMEOUT_MS = 300_000;

const ENTER_DESCRIPTION = [
  "Enters an isolated git worktree for this session before making code changes, when the session is running directly in the user's checkout.",
  "",
  "What it does: cuts a new branch (acode/session/<name>) from the current HEAD into a managed worktree under the system temp namespace, then switches this session's working directory into it through the regular cwd funnel. Uncommitted changes in the user's checkout are NOT carried over — they stay exactly where they are.",
  "",
  "When to use: call this ONCE, before the first code-modifying action (Write/Edit/ApplyPatch/git commits), whenever the session started in the user's own checkout and the task will modify code. Read-only work does not need it.",
  "",
  "Idempotent: if this session already has a managed worktree, the call returns it (outcome reused) instead of creating another one. If a previous worktree was reaped, the session branch is remounted at its tip (outcome reattached) — committed work is never lost.",
  "",
  "Refusals (reported as outcome=rejected with a closed-set reason): the directory is not a git repository, the repository has no commits, the session is already inside a managed worktree, the current directory is some other linked worktree, or the requested branch name is already taken. Do not retry a refusal unchanged — read the reason and adapt.",
].join("\n");

function makeHandler(deps: EnterSessionWorktreeDeps): ToolHandler {
  return async (input, context) => {
    const parsed = EnterSessionWorktreeInputSchema.parse(input) as EnterSessionWorktreeInput;
    const setWorkingDirectory = context.setWorkingDirectory;
    if (!setWorkingDirectory) {
      // 接线故障，不是一种结局（照 escalate 的端口缺席裁决）。
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "setWorkingDirectory is not available for EnterSessionWorktree",
        {
          context: { toolCallId: context.toolCallId, toolName: ENTER_SESSION_WORKTREE_TOOL_NAME },
          recoverable: false,
        },
      );
    }

    const result = await enterSessionWorktree(
      {
        repoDir: context.workingDirectory,
        sessionId: context.sessionId,
        ...(parsed.branch_name === undefined ? {} : { branchName: parsed.branch_name }),
      },
      deps,
    );

    if (result.outcome === "rejected") {
      return {
        outcome: "rejected",
        reason: result.reason,
        message: result.message,
      } satisfies EnterSessionWorktreeOutput;
    }

    // cwd 切换只经既有漏斗（CwdChanged hook 由漏斗触发，这里不另发事件）。
    await setWorkingDirectory(result.handle.path);
    const fenceMode = resolveSessionWorktreeFenceMode();
    const { handle } = result;
    const message =
      result.outcome === "entered"
        ? `Entered a new session worktree at ${handle.path} on branch ${handle.branch} (cut from HEAD ${handle.baseRef.slice(0, 12)}). Uncommitted changes in the main checkout were not carried over. The session working directory is now the worktree; write-fence mode: ${fenceMode}.`
        : result.outcome === "reused"
          ? `This session already has a managed worktree at ${handle.path} on branch ${handle.branch}; the working directory was switched back into it.`
          : `Remounted the session branch ${handle.branch} at ${handle.path} (the previous worktree was reaped or lost; committed work on the branch is intact).`;

    return {
      outcome: result.outcome,
      worktree_path: handle.path,
      branch: handle.branch,
      base_ref: handle.baseRef,
      ...(handle.sourceBranch === undefined ? {} : { source_branch: handle.sourceBranch }),
      repo_root: handle.repoRoot,
      fence_mode: fenceMode,
      message,
    } satisfies EnterSessionWorktreeOutput;
  };
}

const baseEntry = {
  capability: "Enter an isolated per-session git worktree cut from the current HEAD",
  metadata: {
    shouldDefer: true, // tool-search wave1a: 非常驻内置工具默认 defer(specs/tool-search.md R4)
    name: ENTER_SESSION_WORKTREE_TOOL_NAME,
    description: ENTER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    // cwd 切换是 runtime 级事实，绝不与兄弟工具并发。
    concurrentSafe: false,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    sideEffectScope: "git",
    riskLevel: "low",
    needsApproval: false,
  },
  formatModelContent: formatEnterModelContent,
  inputSchema: EnterSessionWorktreeInputJsonSchema,
  outputSchema: EnterSessionWorktreeOutputJsonSchema,
  runtimeInputSchema: EnterSessionWorktreeInputSchema,
  runtimeOutputSchema: EnterSessionWorktreeOutputSchema,
  permission: {
    permission: "session.worktree.enter",
    reason: "EnterSessionWorktree creates a git worktree and branch for this session",
    riskLevel: "low",
    sideEffectScope: "git",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_OUTPUT_BYTES,
    maxModelBytes: MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_OUTPUT_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: ENTER_TIMEOUT_MS,
    maxMs: ENTER_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "EnterSessionWorktree was cancelled before the worktree switch completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
} satisfies Omit<ToolEntry, "handler">;

/** 工厂：测试注入 manager/ledger/tmpRoot；装配面用缺省 entry 即可（无注册门）。 */
export function createEnterSessionWorktreeToolEntry(
  deps: EnterSessionWorktreeDeps = {},
): ToolEntry {
  return { ...baseEntry, handler: makeHandler(deps) };
}

export const enterSessionWorktreeToolEntry: ToolEntry = {
  ...baseEntry,
  handler: makeHandler({}),
};

/** 模型只读一段文本：成功摘要或拒绝理由（判别位不进模型面）。 */
function formatEnterModelContent(output: unknown): string {
  const parsed = EnterSessionWorktreeOutputSchema.safeParse(output);
  if (!parsed.success) return "EnterSessionWorktree returned an invalid result.";
  return parsed.data.message;
}
