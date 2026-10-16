// ============================================================
// Fleet Worktree Provisioning - use_worktree 的临时键 provision 与重键
// (apps/acode-cli/specs/session-fleet.md R2)
// ============================================================
// enter 编排（波次 2 的唯一汇合点）需要 sessionId 作台账键，而 child 的
// agentId/sessionId 在 launch 内部才生成——因此舰队用**临时键**在 launch 之前
// provision worktree（child 必须以 worktree 为 workingDirectory 启动，launch 后
// 再进就晚了），launch 成功后经台账公开 API 重键到 childSessionId：
//   tombstone(临时键, released) → bind(childSessionId, 同一事实) → 围栏重绑。
// launch 失败则 release：tombstone + 围栏解绑 + best-effort 删除 worktree 本体
// ——失败路径不留孤儿绑定（spec 场景 8）。
//
// 全程只消费 worktree 模块公开 API，不改其实现（波次 1/2 面只消费纪律）。

import {
  enterSessionWorktree,
  type EnterSessionWorktreeDeps,
  type EnterSessionWorktreeRejectReason,
} from "../worktree/session-worktree-enter.js";
import { SessionWorktreeLedger } from "../worktree/session-worktree-ledger.js";
import {
  bindSessionWorktreeFence,
  unbindSessionWorktreeFence,
} from "../worktree/session-worktree-fence.js";
import { getSessionWorktreeManager } from "../worktree/session-worktree-manager.js";

export interface FleetWorktreeProvision {
  /** 临时台账键（launch 成功后 tombstone，重键到 childSessionId）。 */
  tempKey: string;
  path: string;
  branch: string;
  baseRef: string;
  repoRoot: string;
  fingerprint: string;
  sourceBranch?: string;
}

export type FleetWorktreeProvisionResult =
  | { ok: true; provision: FleetWorktreeProvision }
  | { ok: false; reason: EnterSessionWorktreeRejectReason; message: string };

export interface FleetWorktreeDeps extends EnterSessionWorktreeDeps {
  ledger?: SessionWorktreeLedger;
}

/**
 * launch 前 provision：从当前 HEAD 切隔离 worktree（不携带未提交改动——enter
 * 编排的既有语义），台账键 = 调用方生成的临时舰队键。enter 的闭集拒绝面
 * （not_git_repo / unborn_head / inside_linked_worktree / branch_in_use 等）
 * 原样透传，由工具层折成 worktree_rejected 拒绝结果。
 */
export async function provisionFleetWorktree(
  input: {
    repoDir: string;
    tempKey: string;
    /** 分支 slug 源：branch_name 参数优先，其次会话标题（人类可读分支名）。 */
    slugSource: string;
  },
  deps: FleetWorktreeDeps = {},
): Promise<FleetWorktreeProvisionResult> {
  const result = await enterSessionWorktree(
    {
      repoDir: input.repoDir,
      sessionId: input.tempKey,
      branchName: input.slugSource,
    },
    deps,
  );
  if (result.outcome === "rejected") {
    return { ok: false, reason: result.reason, message: result.message };
  }
  const { handle, fingerprint } = result;
  return {
    ok: true,
    provision: {
      tempKey: input.tempKey,
      path: handle.path,
      branch: handle.branch,
      baseRef: handle.baseRef,
      repoRoot: handle.repoRoot,
      fingerprint,
      ...(handle.sourceBranch === undefined ? {} : { sourceBranch: handle.sourceBranch }),
    },
  };
}

/**
 * launch 成功后重键：临时键 tombstone（released）→ childSessionId bind（同一
 * 事实）→ 围栏按路径重绑到 childSessionId（bindSessionWorktreeFence 自带同路径
 * 先解绑语义）。台账是追加式 JSONL，多写方安全。
 */
export async function adoptFleetWorktreeForChild(
  input: { provision: FleetWorktreeProvision; childSessionId: string },
  deps: FleetWorktreeDeps = {},
): Promise<void> {
  const ledger = deps.ledger ?? new SessionWorktreeLedger();
  const { provision } = input;
  await ledger.tombstone(provision.tempKey, provision.fingerprint, "released");
  await ledger.bind({
    sessionId: input.childSessionId,
    repoFingerprint: provision.fingerprint,
    repoRoot: provision.repoRoot,
    worktreePath: provision.path,
    branch: provision.branch,
    baseRef: provision.baseRef,
    ...(provision.sourceBranch === undefined ? {} : { sourceBranch: provision.sourceBranch }),
  });
  bindSessionWorktreeFence(
    {
      sessionId: input.childSessionId,
      repoFingerprint: provision.fingerprint,
      repoRoot: provision.repoRoot,
      worktreePath: provision.path,
      branch: provision.branch,
      ...(provision.sourceBranch === undefined ? {} : { sourceBranch: provision.sourceBranch }),
    },
    {
      flushTouch: () => ledger.touch(input.childSessionId, provision.fingerprint),
      ...(deps.fenceFlushIntervalMs === undefined
        ? {}
        : { flushIntervalMs: deps.fenceFlushIntervalMs }),
      ...(deps.now ? { now: deps.now } : {}),
    },
  );
}

/**
 * launch 失败/被拒后的回收：tombstone 临时键 + 围栏解绑 + best-effort 删除
 * worktree 本体与登记（材料是刚刚 provision 的，绝无用户内容；删除失败只留
 * 待收割残骸，不阻断拒绝结果返回）。
 */
export async function releaseFleetWorktreeProvision(
  input: { provision: FleetWorktreeProvision },
  deps: FleetWorktreeDeps = {},
): Promise<void> {
  const ledger = deps.ledger ?? new SessionWorktreeLedger();
  const { provision } = input;
  unbindSessionWorktreeFence({ worktreePath: provision.path });
  await ledger.tombstone(provision.tempKey, provision.fingerprint, "released");
  try {
    const manager = deps.manager ?? getSessionWorktreeManager();
    await manager.removeWorktree({ repoRoot: provision.repoRoot, path: provision.path });
    await manager.prune(provision.repoRoot);
  } catch {
    // best-effort：残骸由波次 2 的收割面（ReapSessionWorktrees）按不活跃清理。
  }
}
