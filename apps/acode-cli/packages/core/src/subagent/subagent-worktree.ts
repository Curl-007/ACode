// ============================================================
// Subagent worktree isolation（isolation: worktree 声明式每代理临时 worktree）
// (specs/subagent-declarative-keys.md R2)
// ============================================================
//
// 复用会话 worktree 机制（core/src/worktree/，session-worktree-lifecycle spec 的
// 唯一所有者）的导出面，本模块只做**子代理侧编排**：
// - enter 以 childSessionId 为绑定键（resume 复用同一 id → ledger 命中既有绑定，
//   天然走 reuse/reattach，分支 tip 材料不丢）；
// - child 的 workingDirectory 换成 worktree 路径，workspaceRoot（身份锚）不变；
// - settle 后 release 并按现有 reap 语义回收：clean → remove + tombstone(reaped)；
//   dirty → 材料优先保留（active 绑定留给 ReapSessionWorktrees/用户处置）；
//   分支永远保留（child 的提交材料在分支 tip 上；合并归 MergeBaseBranch 工具面）。
//
// fail-loud（session-worktree spec R8「假装隔离比不隔离更糟」）：enter 的闭集拒绝
// 面 → CoreError 拒绝派发，绝不静默降级回共享 cwd。release 全程 best-effort——
// 清理失败只 warn 留痕，绝不覆盖/吞掉 child 的真实结果或错误。

import {
  AgentErrorCode,
  AgentLaunchFailureReason,
  CoreErrorType,
  createCoreError,
  type CoreError,
  type Logger,
} from "@acode/contracts";
import {
  enterSessionWorktree,
  type EnterSessionWorktreeRejectReason,
} from "../worktree/session-worktree-enter.js";
import { unbindSessionWorktreeFence } from "../worktree/session-worktree-fence.js";
import { gitHasUncommittedChanges } from "../worktree/session-worktree-git.js";
import { SessionWorktreeLedger } from "../worktree/session-worktree-ledger.js";
import {
  getSessionWorktreeManager,
  type SessionWorktreeHandle,
  type SessionWorktreeManager,
} from "../worktree/session-worktree-manager.js";

/** 测试注入面（spec R2）：缺省 = 进程级 manager + env 兜底 ledger（生产装配零改动）。 */
export interface SubagentWorktreeDeps {
  manager?: SessionWorktreeManager;
  ledger?: SessionWorktreeLedger;
}

export interface SubagentWorktreeIsolation {
  childSessionId: string;
  fingerprint: string;
  handle: SessionWorktreeHandle;
  ledger: SessionWorktreeLedger;
  manager: SessionWorktreeManager;
}

/** release 结果闭集（日志 detail 键用 outcome，避开保留闭集键 status）。 */
export type SubagentWorktreeReleaseOutcome =
  | "reaped"
  | "dirty_kept"
  | "tombstoned_missing"
  | "remove_failed_kept"
  | "release_failed_kept";

/**
 * 隔离 child 的 system prompt 追加段（自撰英文，spec R2）：child 必须知道自己在
 * 临时 worktree 里、settle 后的回收语义（提交进分支的材料保留 / 未提交改动保目录 /
 * clean 目录被移除）——否则 child 会把临时路径当持久事实汇报给父。
 */
export function buildSubagentWorktreeIsolationNote(branch: string, worktreePath: string): string {
  return [
    `You are running inside an isolated temporary git worktree (branch ${branch}, path ${worktreePath}) cut from the repository HEAD; the parent session's checkout is not your working directory.`,
    "When this run settles, the harness reclaims the worktree: work you committed is preserved on the branch, uncommitted changes keep the worktree directory alive for later inspection, and a clean worktree directory is removed.",
    "Commit work you want preserved, and report the branch name (not the temporary path) as the durable location of your changes.",
  ].join(" ");
}

export interface EnterSubagentWorktreeInput {
  agentId: string;
  agentType: string;
  childSessionId: string;
  /** child 继承的执行 cwd（父当前 workingDirectory）——worktree 从它所在的仓切出。 */
  repoDir: string;
  deps?: SubagentWorktreeDeps;
}

export async function enterSubagentWorktreeIsolation(
  input: EnterSubagentWorktreeInput,
): Promise<SubagentWorktreeIsolation> {
  const manager = input.deps?.manager ?? getSessionWorktreeManager();
  const ledger = input.deps?.ledger ?? new SessionWorktreeLedger();
  const result = await enterSessionWorktree(
    {
      repoDir: input.repoDir,
      sessionId: input.childSessionId,
      // 分支 slug 显式携带代理身份（acode/session/ 前缀与 40 字符截断归
      // buildSessionBranchName 既有规则）；uuid 尾巴保证并发派发不撞名。
      branchName: `subagent-${input.agentType}-${input.agentId}`,
    },
    { manager, ledger },
  );
  if (result.outcome === "rejected") {
    throw createSubagentIsolationRejectedError(input, result.reason, result.message);
  }
  return {
    childSessionId: input.childSessionId,
    fingerprint: result.fingerprint,
    handle: result.handle,
    ledger,
    manager,
  };
}

export async function releaseSubagentWorktreeIsolation(
  isolation: SubagentWorktreeIsolation,
  input: { agentId: string; agentType: string; logger?: Logger },
): Promise<SubagentWorktreeReleaseOutcome> {
  const { handle, ledger, manager } = isolation;
  const logContext = {
    agentId: input.agentId,
    agentType: input.agentType,
    branch: handle.branch,
    module: "core.subagent",
    worktreePath: handle.path,
  };
  // 1) 解除进程内围栏绑定：reap 保护序第 1 条「本进程在绑」随 run settle 释放，
  //    否则本条目对后续收割永远呈 in_use_current_process。
  unbindSessionWorktreeFence({ sessionId: isolation.childSessionId });
  try {
    if (!(await manager.directoryExists(handle.path))) {
      // 目录已丢失（tmp 清理/外部删除）：台账卫生墓碑（诚实语义：不是本模块删的）。
      await ledger.tombstone(isolation.childSessionId, isolation.fingerprint, "worktree-missing");
      return "tombstoned_missing";
    }
    let dirty: boolean;
    try {
      dirty = await gitHasUncommittedChanges(manager.git, handle.path);
    } catch {
      // 检视失败（目录半损等）→ 保留：不能证明 clean 就不删（reap 同款诚实语义）。
      input.logger?.warn("Subagent worktree release could not inspect dirtiness; kept", {
        ...logContext,
        event: "subagent.isolation.release_kept",
        outcome: "remove_failed_kept",
      });
      return "remove_failed_kept";
    }
    if (dirty) {
      // 材料优先（reap 保护序第 3 条同款）：未提交改动随目录与 active 绑定保留，
      // 后续由 ReapSessionWorktrees 按天数或用户处置；分支材料本就在分支 tip 上。
      input.logger?.warn("Subagent worktree kept: uncommitted changes remain (material first)", {
        ...logContext,
        event: "subagent.isolation.release_kept",
        outcome: "dirty_kept",
      });
      return "dirty_kept";
    }
    await manager.removeWorktree({ repoRoot: handle.repoRoot, path: handle.path });
    await ledger.tombstone(isolation.childSessionId, isolation.fingerprint, "reaped");
    return "reaped";
  } catch (error) {
    // best-effort：清理失败绝不覆盖 child 的真实结果；条目保持 active，收割面兜底。
    input.logger?.warn("Subagent worktree release failed; entry kept for later reap", {
      ...logContext,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.isolation.release_failed",
      outcome: "release_failed_kept",
    });
    return "release_failed_kept";
  } finally {
    // 台账卫生：清 .git/worktrees 里指向已消失目录的登记（reap 同款，失败不阻断）。
    await manager.prune(handle.repoRoot);
  }
}

/**
 * enter 拒绝 → 派发拒绝（fail-loud，spec R2）。reason 用专用全局 token
 * worktree_isolation_unavailable（declarative-keys spec 接线需求 8 已落地，取代对
 * subagent_unavailable 的复用）+ 局部维度键 isolationReason（error-taxonomy spec
 * R2.1 的 tree-budget「全局 token + budgetReason」先例）；code 面保持
 * SUBAGENT_UNAVAILABLE 不动（code 标识契约面，reason 标识原因）。
 */
function createSubagentIsolationRejectedError(
  input: { agentType: string },
  reason: EnterSessionWorktreeRejectReason,
  message: string,
): CoreError {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Agent '${input.agentType}' declares isolation: worktree, but its isolated worktree could not be entered (${reason}): ${message} The agent was NOT started in the shared checkout.`,
    {
      context: {
        code: AgentErrorCode.SUBAGENT_UNAVAILABLE,
        reason: AgentLaunchFailureReason.WorktreeIsolationUnavailable,
        isolationReason: reason,
        agentType: input.agentType,
      },
      recoverable: true,
    },
  );
}
