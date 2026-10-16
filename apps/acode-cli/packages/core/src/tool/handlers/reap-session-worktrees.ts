// ============================================================
// ReapSessionWorktrees Tool Handler
// ============================================================
// 按 older_than_days（30/60/90 闭集）收割不活跃会话 worktree
// （specs/session-worktree-lifecycle.md R6，对应设置面「清理不活跃会话」档位语义）。
// 保护序在删除判定之前：运行中/打开（本进程在绑）/最近使用（台账心跳）/dirty
// （材料优先）绝不动。**会话与分支保留**——收割只移除 clean 的 worktree 目录，
// 台账落 tombstone(reaped)，重开会话时 enter 按分支 tip 重挂。不 push 不删分支。

import {
  REAP_SESSION_WORKTREES_TOOL_NAME,
  ReapSessionWorktreesInputJsonSchema,
  ReapSessionWorktreesInputSchema,
  ReapSessionWorktreesOutputJsonSchema,
  ReapSessionWorktreesOutputSchema,
  type ReapSessionWorktreesInput,
  type ReapSessionWorktreesOutput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  reapSessionWorktrees,
  type ReapSessionWorktreesDeps,
} from "../../worktree/session-worktree-reap.js";

const MAX_OUTPUT_BYTES = 16_000;
const REAP_TIMEOUT_MS = 600_000;

const REAP_DESCRIPTION = [
  "Reaps inactive session worktrees: removes the worktree directories of sessions whose last activity is older than older_than_days (30, 60, or 90).",
  "",
  "Never touched: worktrees of sessions running or open in this process, sessions used within the threshold, and worktrees with uncommitted changes (dirty material is kept — nothing uncommitted is ever destroyed).",
  "",
  "What is kept: the sessions themselves and their branches. Reaping only removes clean worktree directories; when a reaped session is reopened, its branch is remounted at its tip, so committed work is never lost. Nothing is pushed and no branch is deleted.",
  "",
  "Per-entry outcomes are a closed set: reaped / dirty_kept / recently_used / in_use_current_process / remove_failed_kept / tombstoned_missing.",
].join("\n");

function makeHandler(deps: ReapSessionWorktreesDeps): ToolHandler {
  return async (input) => {
    const parsed = ReapSessionWorktreesInputSchema.parse(input) as ReapSessionWorktreesInput;
    const result = await reapSessionWorktrees({ olderThanDays: parsed.older_than_days }, deps);
    const message = [
      `Reaped ${result.reaped} inactive session worktree(s) older than ${parsed.older_than_days} days; kept ${result.kept}; recorded ${result.tombstoned} already-missing as tombstones.`,
      result.entries.length > 0
        ? result.entries
            .map((entry) => `- ${entry.outcome}: ${entry.branch} (${entry.sessionId})`)
            .join("\n")
        : "No session worktree entries were eligible.",
      "Sessions and branches are preserved; reopening a reaped session remounts its branch at its tip.",
    ].join("\n");
    return {
      reaped: result.reaped,
      kept: result.kept,
      tombstoned: result.tombstoned,
      entries: result.entries.map((entry) => ({
        session_id: entry.sessionId,
        branch: entry.branch,
        ...(entry.worktreePath === undefined ? {} : { worktree_path: entry.worktreePath }),
        outcome: entry.outcome,
      })),
      message,
    } satisfies ReapSessionWorktreesOutput;
  };
}

const baseEntry = {
  capability: "Reap inactive session worktrees by age threshold, keeping sessions and branches",
  metadata: {
    name: REAP_SESSION_WORKTREES_TOOL_NAME,
    description: REAP_DESCRIPTION,
    readOnly: false,
    // 只删 clean 目录（材料优先判定在删除之前），但目录移除本身是销毁性动作。
    destructive: true,
    concurrentSafe: false,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    sideEffectScope: "git",
    riskLevel: "medium",
    needsApproval: false,
  },
  formatModelContent: formatReapModelContent,
  inputSchema: ReapSessionWorktreesInputJsonSchema,
  outputSchema: ReapSessionWorktreesOutputJsonSchema,
  runtimeInputSchema: ReapSessionWorktreesInputSchema,
  runtimeOutputSchema: ReapSessionWorktreesOutputSchema,
  permission: {
    permission: "session.worktree.reap",
    reason: "ReapSessionWorktrees removes clean inactive session worktree directories",
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
    defaultMs: REAP_TIMEOUT_MS,
    maxMs: REAP_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage:
      "ReapSessionWorktrees was cancelled; some entries may not have been processed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
} satisfies Omit<ToolEntry, "handler">;

/** 工厂：测试注入 manager/ledger/now；装配面用缺省 entry 即可（无注册门）。 */
export function createReapSessionWorktreesToolEntry(
  deps: ReapSessionWorktreesDeps = {},
): ToolEntry {
  return { ...baseEntry, handler: makeHandler(deps) };
}

export const reapSessionWorktreesToolEntry: ToolEntry = {
  ...baseEntry,
  handler: makeHandler({}),
};

function formatReapModelContent(output: unknown): string {
  const parsed = ReapSessionWorktreesOutputSchema.safeParse(output);
  if (!parsed.success) return "ReapSessionWorktrees returned an invalid result.";
  return parsed.data.message;
}
