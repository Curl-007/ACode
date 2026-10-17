import type { ReapSessionWorktreeEntryOutcome } from "@acode/contracts";
import { gitHasUncommittedChanges } from "./session-worktree-git.js";
import { SessionWorktreeLedger } from "./session-worktree-ledger.js";
import { isSessionWorktreeFencedPath } from "./session-worktree-fence.js";
import {
  getSessionWorktreeManager,
  type SessionWorktreeManager,
} from "./session-worktree-manager.js";

/**
 * 不活跃会话 worktree 收割（specs/session-worktree-lifecycle.md R6）。
 *
 * 保护序在删除判定**之前**（绝不动运行中/打开/最近使用的）：
 *   1. 本进程在绑（围栏注册表按路径命中）→ in_use_current_process；
 *   2. lastUsedAt（台账心跳，跨进程可见）距 now 不足阈值 → recently_used；
 *   3. dirty（未提交改动）→ dirty_kept——材料优先，与 workflow 域 R5 同一裁决。
 *
 * clean → `git worktree remove`（不带 --force；失败 → remove_failed_kept 如实上报）
 * → 台账落 tombstone(reaped)。**会话与分支保留**：分支是重开时重新 checkout 的
 * 材料（enter 的重挂路径），会话/对话数据不归本台账管，一概不动。目录已丢失 →
 * tombstone(worktree-missing)，计入 tombstoned（诚实语义：没有目录被本工具删除）。
 *
 * 分域纪律（spec R1）：只处理**自己台账**里的条目，绝不扫描 workflow 命名空间。
 */

export interface ReapSessionWorktreesDeps {
  manager?: SessionWorktreeManager;
  ledger?: SessionWorktreeLedger;
  now?: () => number;
}

export interface ReapSessionWorktreesEntryResult {
  sessionId: string;
  branch: string;
  worktreePath?: string;
  outcome: ReapSessionWorktreeEntryOutcome;
}

export interface ReapSessionWorktreesResult {
  reaped: number;
  kept: number;
  tombstoned: number;
  entries: ReapSessionWorktreesEntryResult[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function reapSessionWorktrees(
  input: { olderThanDays: 30 | 60 | 90 },
  deps: ReapSessionWorktreesDeps = {},
): Promise<ReapSessionWorktreesResult> {
  const manager = deps.manager ?? getSessionWorktreeManager();
  const ledger = deps.ledger ?? new SessionWorktreeLedger();
  const now = (deps.now ?? Date.now)();
  const cutoff = now - input.olderThanDays * DAY_MS;

  const bindings = await ledger.load();
  const entries: ReapSessionWorktreesEntryResult[] = [];
  const touchedRepoRoots = new Set<string>();
  let reaped = 0;
  let kept = 0;
  let tombstoned = 0;

  const push = (entry: ReapSessionWorktreesEntryResult): void => {
    entries.push(entry);
    if (entry.outcome === "reaped") reaped += 1;
    else if (entry.outcome === "tombstoned_missing") tombstoned += 1;
    else kept += 1;
  };

  for (const binding of bindings) {
    // tombstone 无目录可收（重开时由 enter 重挂）；合成墓碑（身份不全）同样跳过。
    if (binding.state !== "active" || binding.worktreePath === "") continue;
    const base = {
      sessionId: binding.sessionId,
      branch: binding.branch,
      worktreePath: binding.worktreePath,
    };
    try {
      // 保护 1：本进程正绑在这条目的 worktree 上 = 运行中/打开着。
      if (isSessionWorktreeFencedPath(binding.worktreePath)) {
        push({ ...base, outcome: "in_use_current_process" });
        continue;
      }
      // 保护 2：最近使用（跨进程心跳经台账可见）。
      if (binding.lastUsedAt > cutoff) {
        push({ ...base, outcome: "recently_used" });
        continue;
      }
      if (binding.repoRoot !== "") touchedRepoRoots.add(binding.repoRoot);
      // 目录已丢失（tmp 清理/外部删除）：台账卫生墓碑，不是本工具删的。
      if (!(await manager.directoryExists(binding.worktreePath))) {
        await ledger.tombstone(binding.sessionId, binding.repoFingerprint, "worktree-missing");
        push({ ...base, outcome: "tombstoned_missing" });
        continue;
      }
      // 保护 3：dirty → 材料优先保留。检视失败（目录半损等）同样保留——不能证明
      // clean 就不删（诚实语义，对齐 workflow 域 reclaim-failed-kept）。
      let dirty: boolean;
      try {
        dirty = await gitHasUncommittedChanges(manager.git, binding.worktreePath);
      } catch {
        push({ ...base, outcome: "remove_failed_kept" });
        continue;
      }
      if (dirty) {
        push({ ...base, outcome: "dirty_kept" });
        continue;
      }
      await manager.removeWorktree({
        repoRoot: binding.repoRoot,
        path: binding.worktreePath,
      });
      await ledger.tombstone(binding.sessionId, binding.repoFingerprint, "reaped");
      push({ ...base, outcome: "reaped" });
    } catch {
      // 单条失败不阻断其余（best-effort，逐条上报）；移除失败一律按保留计数。
      push({ ...base, outcome: "remove_failed_kept" });
    }
  }

  // 台账卫生：清 .git/worktrees 里指向已消失目录的登记（含 tombstoned_missing 的残影）。
  for (const repoRoot of touchedRepoRoots) {
    await manager.prune(repoRoot);
  }

  return { reaped, kept, tombstoned, entries };
}
