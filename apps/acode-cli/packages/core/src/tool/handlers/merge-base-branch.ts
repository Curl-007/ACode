// ============================================================
// MergeBaseBranch Tool Handler
// ============================================================
// 把基分支合并进会话分支（specs/session-worktree-lifecycle.md R5），在会话 worktree
// 内执行。两个刻意选择：
//   - **宿主执行层**：git 经 context.executionPort 以 argv 模式、sandbox disabled
//     直跑——不经 Bash 工具的沙箱/只读治理，因为合并常触碰受保护路径（hooks/skills/
//     mcp 配置一类），沙箱面会把它拦死。
//   - **base 闭集**：source_branch（会话 worktree 的切出分支）/ default_branch
//     （仓库默认分支）/ pr_base（PR 面缺席即拒绝）；其余一律 base_not_allowed。
// 红线：不 push、不删除任何分支/远端引用；有未提交改动即拒；冲突保留现场 +
// action=abort 恢复干净态。拒绝是普通工具结果（闭集 reason），git 故障 fail-loud。

import {
  CoreErrorType,
  MERGE_BASE_BRANCH_TOOL_NAME,
  MergeBaseBranchInputJsonSchema,
  MergeBaseBranchInputSchema,
  MergeBaseBranchOutputJsonSchema,
  MergeBaseBranchOutputSchema,
  createCoreError,
  type MergeBaseBranchInput,
  type MergeBaseBranchOutput,
  type TraceContext,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  createHostGitRunnerFromExecutionPort,
  mergeBaseBranchIntoSessionBranch,
} from "../../worktree/base-branch-merge.js";
import { lookupSessionWorktreeFenceBinding } from "../../worktree/session-worktree-fence.js";
import { adoptLedgerBindingForCwd } from "../../worktree/session-worktree-adoption.js";
import type { SessionWorktreeLedger } from "../../worktree/session-worktree-ledger.js";

const MAX_OUTPUT_BYTES = 16_000;
const MERGE_TIMEOUT_MS = 300_000;

const MERGE_DESCRIPTION = [
  "Merges a base branch into this session's branch, inside the session's managed worktree, on the host execution layer (outside the Bash tool's sandbox/read-only governance, because merges routinely touch protected config paths).",
  "",
  "base is a closed set:",
  "- source_branch: the branch this session's worktree was cut from;",
  "- default_branch: the repository's default branch (origin/HEAD, else main/master);",
  "- pr_base: rejected in this build (no PR surface yet).",
  "",
  "Guarantees: never pushes, never deletes any branch or remote ref, and refuses to run while the worktree has uncommitted changes. On conflict the merge state is KEPT in place — resolve the conflicted files and commit inside the worktree, or call again with action=abort to restore a clean state (git merge --abort).",
  "",
  "Prerequisite: the session must be inside its managed worktree (call EnterSessionWorktree first); otherwise the call is rejected with not_in_session_worktree.",
].join("\n");

export interface MergeBaseBranchToolDeps {
  ledger?: SessionWorktreeLedger;
  /** PR base 解析器（PR 面落地后由装配层注入；缺席 → pr_surface_unavailable）。 */
  resolvePrBase?: () => Promise<string | undefined>;
  now?: () => number;
  fenceFlushIntervalMs?: number;
}

function makeHandler(deps: MergeBaseBranchToolDeps): ToolHandler {
  return async (input, context) => {
    const parsed = MergeBaseBranchInputSchema.parse(input) as MergeBaseBranchInput;
    const action = parsed.action ?? "merge";

    // 绑定解析：进程内注册表优先；进程重启后（resume 的会话 cwd 仍在 worktree 里）
    // 从台账领养回注册表（spec R5 前置）。都没有 → 闭集拒绝。
    const binding =
      lookupSessionWorktreeFenceBinding(context.workingDirectory) ??
      (await adoptLedgerBindingForCwd(context.workingDirectory, {
        ...(deps.ledger ? { ledger: deps.ledger } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.fenceFlushIntervalMs === undefined
          ? {}
          : { fenceFlushIntervalMs: deps.fenceFlushIntervalMs }),
      }));
    if (!binding) {
      return {
        outcome: "rejected",
        reason: "not_in_session_worktree",
        message:
          "This session is not inside a managed session worktree, so there is no session branch to merge into. Call EnterSessionWorktree first (from the repository's main checkout).",
      } satisfies MergeBaseBranchOutput;
    }

    const executionPort = context.executionPort;
    if (!executionPort) {
      // 接线故障，不是一种结局：宿主执行层缺席时绝不回退 Bash 工具面（那会把
      // 合并重新塞回沙箱/只读治理，正是本工具要绕开的拦截面）。
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "executionPort is not available for MergeBaseBranch host git execution",
        {
          context: { toolCallId: context.toolCallId, toolName: MERGE_BASE_BRANCH_TOOL_NAME },
          recoverable: false,
        },
      );
    }

    const git = createHostGitRunnerFromExecutionPort(
      executionPort,
      resolveToolTraceContext(context),
    );
    return (await mergeBaseBranchIntoSessionBranch(
      {
        action,
        ...(parsed.base === undefined ? {} : { base: parsed.base }),
        worktreePath: binding.worktreePath,
        sessionBranch: binding.branch,
        ...(binding.sourceBranch === undefined ? {} : { sourceBranch: binding.sourceBranch }),
        ...(deps.resolvePrBase ? { resolvePrBase: deps.resolvePrBase } : {}),
      },
      { git },
    )) satisfies MergeBaseBranchOutput;
  };
}

const baseEntry = {
  capability: "Merge the base branch into the session branch on the host execution layer",
  metadata: {
    shouldDefer: true, // tool-search wave1a: 非常驻内置工具默认 defer(specs/tool-search.md R4)
    name: MERGE_BASE_BRANCH_TOOL_NAME,
    description: MERGE_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    sideEffectScope: "git",
    riskLevel: "medium",
    needsApproval: false,
  },
  formatModelContent: formatMergeModelContent,
  inputSchema: MergeBaseBranchInputJsonSchema,
  outputSchema: MergeBaseBranchOutputJsonSchema,
  runtimeInputSchema: MergeBaseBranchInputSchema,
  runtimeOutputSchema: MergeBaseBranchOutputSchema,
  permission: {
    permission: "session.worktree.mergeBase",
    reason: "MergeBaseBranch writes a merge commit into the session branch",
    riskLevel: "medium",
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
    defaultMs: MERGE_TIMEOUT_MS,
    maxMs: MERGE_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "MergeBaseBranch was cancelled; check for an in-progress merge state",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
} satisfies Omit<ToolEntry, "handler">;

/** 工厂：测试注入 ledger/PR 解析器；装配面用缺省 entry 即可（无注册门）。 */
export function createMergeBaseBranchToolEntry(deps: MergeBaseBranchToolDeps = {}): ToolEntry {
  return { ...baseEntry, handler: makeHandler(deps) };
}

export const mergeBaseBranchToolEntry: ToolEntry = {
  ...baseEntry,
  handler: makeHandler({}),
};

/** 模型只读一段文本：结局摘要（判别位与结构化清单不进模型面正文）。 */
function formatMergeModelContent(output: unknown): string {
  const parsed = MergeBaseBranchOutputSchema.safeParse(output);
  if (!parsed.success) return "MergeBaseBranch returned an invalid result.";
  return parsed.data.message;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
