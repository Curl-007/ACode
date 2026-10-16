// ============================================================
// Fleet Archive - 归档 + 级联 + 拒绝而非强制
// (apps/acode-cli/specs/session-fleet.md R7)
// ============================================================
// 级联两路：a) 共享同一 worktree 路径的其它舰队会话（须终态，在跑 → 整单拒绝）；
// b) 目标自己启动且已终态的会话（「已完成的 side 会话」；在跑的嵌套会话不动、
// 也不阻塞本单）。动作顺序（spec 事件顺序节）：校验全通过 → store timeArchived
// → runtime-task 条目 remove（结构性关闭 SendMessage/TaskOutput/TaskStop 与
// resume 面）→ 舰队记录 archived → note 订阅撤销。worktree 本体不动（材料保留，
// 不活跃清理归波次 2 的 ReapSessionWorktrees）。

import type { SessionStorePort } from "@acode/contracts";
import { isTerminalRuntimeTask, type RuntimeTaskRegistry } from "../runtime-task/contract.js";
import type { FleetRegistry, FleetSessionRecord } from "./registry.js";

export type FleetArchivePlan =
  | { kind: "plan"; target: FleetSessionRecord; cascaded: FleetSessionRecord[] }
  | {
      kind: "rejected";
      reason: "session_running" | "cascade_session_running";
      message: string;
    };

export interface FleetArchiveDeps {
  registry: FleetRegistry;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  target: FleetSessionRecord;
}

/** 会话是否在跑：runtime-task 条目存在且非终态。条目缺席 = 已收口/已被移除，可归档。 */
export function isFleetSessionRunning(
  record: FleetSessionRecord,
  runtimeTaskRegistry: RuntimeTaskRegistry | undefined,
): boolean {
  const task = runtimeTaskRegistry?.get(record.agentId);
  return task !== undefined && !isTerminalRuntimeTask(task);
}

/**
 * 归档计划（纯裁决，无副作用）：先校验目标与级联对象的运行态，任一在跑即整单
 * 拒绝（拒绝而非强制——原子性，绝不落半单）。
 */
export function resolveFleetArchivePlan(deps: FleetArchiveDeps): FleetArchivePlan {
  const { registry, runtimeTaskRegistry, target } = deps;

  if (isFleetSessionRunning(target, runtimeTaskRegistry)) {
    return {
      kind: "rejected",
      reason: "session_running",
      message:
        `Fleet session "${target.sessionId}" (${target.title}) is still running. ` +
        "Archiving refuses to force-stop work in flight: wait for it to finish, or stop it explicitly with TaskStop first.",
    };
  }

  const cascaded: FleetSessionRecord[] = [];
  const seen = new Set<string>([target.sessionId]);

  // a) 共享 worktree 的会话：同分支同材料同归宿；在跑 → 整单拒绝。
  if (target.worktree) {
    for (const sharer of registry.listSharingWorktree(target.worktree.path, target.sessionId)) {
      if (seen.has(sharer.sessionId)) continue;
      if (isFleetSessionRunning(sharer, runtimeTaskRegistry)) {
        return {
          kind: "rejected",
          reason: "cascade_session_running",
          message:
            `Archiving "${target.sessionId}" would cascade to "${sharer.sessionId}" (${sharer.title}), ` +
            "which shares its worktree and is still running. Refusing rather than forcing: wait for it or TaskStop it first.",
        };
      }
      seen.add(sharer.sessionId);
      cascaded.push(sharer);
    }
  }

  // b) 目标启动的已完成 side 会话：只收终态；在跑的嵌套会话不动、不阻塞。
  for (const child of registry.listLaunchedBy(target.sessionId)) {
    if (seen.has(child.sessionId)) continue;
    if (isFleetSessionRunning(child, runtimeTaskRegistry)) continue;
    seen.add(child.sessionId);
    cascaded.push(child);
  }

  return { kind: "plan", target, cascaded };
}

export interface FleetArchiveExecutionDeps {
  registry: FleetRegistry;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  sessionStore?: SessionStorePort;
  targets: readonly FleetSessionRecord[];
  now?: () => number;
}

/**
 * 执行归档（校验已在 resolveFleetArchivePlan 收口）。store 写入 best-effort
 * （舰队记录是事实源，冷目录面失败不回滚归档）；runtime-task 条目移除是
 * 结构性门（R6：SendMessage/TaskOutput/TaskStop 自然 not-found）。
 */
export async function executeFleetArchive(deps: FleetArchiveExecutionDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  for (const target of deps.targets) {
    if (deps.sessionStore) {
      try {
        await deps.sessionStore.updateSession({ id: target.sessionId, timeArchived: now });
      } catch {
        // best-effort：内存记录已归档，store 面失败只影响冷目录投影。
      }
    }
    deps.runtimeTaskRegistry?.remove(target.agentId);
    deps.registry.update(target.sessionId, (record) => ({
      ...record,
      archived: true,
      archivedAt: now,
      lastActivityAt: now,
    }));
    deps.registry.disposeWatcher(target.sessionId);
  }
}
