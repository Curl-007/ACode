// 团队/成员维度的保守清理编排（SPEC-015）。
//
// manager.cleanupMemberWorktree 只处理一棵树的 git 事实；这里负责：
// - 从 team.json 取句柄（唯一映射，不维护第二份）；
// - 成员仍有进行中任务时保留（keptReason: member_active）；
// - 把清理结果写回 team.json，供归档后审计。
import type { TeamState } from "../state/types.js";
import { nowIso } from "../state/types.js";
import type { TeamStore } from "../state/store.js";
import { cleanupMemberWorktree } from "./manager.js";

export interface WorktreeCleanupEntry {
  member: string;
  branch: string;
  path: string;
  removed: boolean;
  branchRemoved: boolean;
  keptReason?: string;
  error?: string;
}

export interface WorktreeCleanupSummary {
  removed: WorktreeCleanupEntry[];
  retained: WorktreeCleanupEntry[];
  errors: WorktreeCleanupEntry[];
}

/** 成员是否仍持有进行中任务（队长视角：attempt owner 或 assignee 命中）。 */
function memberHasActiveTask(store: TeamStore, team: TeamState, memberName: string): boolean {
  return store.readTasks(team.teamId).some((task) => {
    if (task.status !== "in_progress") return false;
    const owner = task.attempts.find((attempt) => attempt.id === task.activeAttemptId)?.owner;
    return owner === memberName || task.assignee === memberName;
  });
}

/** 清理一个成员的工作树；不写盘，调用方决定何时写回。 */
export async function cleanupMemberWorktreeRecord(
  store: TeamStore,
  team: TeamState,
  memberName: string,
): Promise<WorktreeCleanupEntry | undefined> {
  const isolation = team.worktreeIsolation;
  const member = team.members.find((item) => item.name === memberName);
  const handle = member?.worktree;
  if (!isolation?.enabled || !handle) return undefined;
  if (memberHasActiveTask(store, team, memberName)) {
    return {
      member: memberName,
      branch: handle.branch,
      path: handle.path,
      removed: false,
      branchRemoved: false,
      keptReason: "member_active",
    };
  }
  const result = await cleanupMemberWorktree({
    repoRoot: isolation.repoRoot,
    baseBranch: isolation.baseBranch,
    handle,
  });
  return {
    member: memberName,
    branch: handle.branch,
    path: handle.path,
    removed: result.removed,
    branchRemoved: result.branchRemoved,
    ...(result.keptReason ? { keptReason: result.keptReason } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * 团队结束时清理所有成员树（含已 removed 成员的历史句柄），并写回 team.json。
 * 必须在 archiveTeam 之前调用：归档会搬走 team.json，之后无句柄可查。
 */
export async function cleanupTeamWorktrees(
  store: TeamStore,
  team: TeamState,
): Promise<WorktreeCleanupSummary | undefined> {
  if (!team.worktreeIsolation?.enabled) return undefined;
  const entries: WorktreeCleanupEntry[] = [];
  for (const member of team.members) {
    if (!member.worktree) continue;
    const entry = await cleanupMemberWorktreeRecord(store, team, member.name);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    return { removed: [], retained: [], errors: [] };
  }
  const at = nowIso();
  store.writeTeam(team.teamId, (current) => {
    for (const entry of entries) {
      const target = current.members.find((item) => item.name === entry.member);
      if (!target?.worktree) continue;
      target.worktree.lastCleanup = {
        at,
        removed: entry.removed,
        branchRemoved: entry.branchRemoved,
        ...(entry.keptReason ? { keptReason: entry.keptReason } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      };
    }
  });
  return {
    removed: entries.filter((entry) => entry.removed),
    retained: entries.filter((entry) => !entry.removed),
    errors: entries.filter((entry) => entry.error !== undefined),
  };
}
