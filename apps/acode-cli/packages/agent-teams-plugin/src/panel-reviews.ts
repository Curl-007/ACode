import type { TaskCheckResult, TeamState, TeamTask } from "./state/types.js";

/**
 * 面板验收投影 `reviews[]`（批次 1 生产；契约见
 * `packages/shared/specs/team-acceptance-review-contract.md` 契约 A）。
 *
 * 纯投影、无 git IO：**只报插件已落盘的事实**。`baseCommit`/`headCommit` 坐标来自
 * `review_member_diff` 落盘的 `task.lastReview`（快照生成时无法现算成员分支 HEAD）；
 * `check` 来自 `run_checks` 落盘的 `task.lastCheck`（仅当其 attemptId 仍是当前活动 attempt，
 * 避免把上一次交付的检查贴到新交付上）。
 *
 * 只产出诚实的两种状态：`in_review`（当前待验收）与 `merged`（已合并验收）。`rejected`
 * 没有可靠持久化信号（打回与普通 reassign 共用同一 revision 形状），故不臆造——留给
 * 批次 4 的渲染与后续打回记录（登记项）。
 */

/** 单条检查投影（契约 A 的 `reviews[].check` 形状）。 */
export interface TeamPanelReviewCheck {
  command: string;
  exitCode: number;
  passed: boolean;
  summary?: string;
  truncated?: boolean;
  ranAt: string;
}

export interface TeamPanelReview {
  taskId: string;
  /** 归属成员（TeamTask.assignee 或最后一次 attempt 的 owner）。 */
  member: string;
  status: "in_review" | "merged" | "rejected";
  baseCommit?: string;
  headCommit?: string;
  mergedAt?: string;
  check?: TeamPanelReviewCheck;
  diffAvailable?: boolean;
  unavailableReason?: "worktree_disabled" | "worktree_cleaned" | "commits_unreachable" | "unknown";
}

/** reviews[] 条数上限（超限整段丢弃并置 reviewsTruncated，EI-97）。 */
export const MAX_PANEL_REVIEWS = 24;

function toCheck(check: TaskCheckResult): TeamPanelReviewCheck {
  return {
    command: check.command,
    exitCode: check.exitCode,
    passed: check.passed,
    ...(check.summary !== undefined ? { summary: check.summary } : {}),
    ...(check.truncated !== undefined ? { truncated: check.truncated } : {}),
    ranAt: check.ranAt,
  };
}

/** 投影某团队的验收 review 列表（调用方负责截断标志）。 */
function projectReviews(team: TeamState, tasks: readonly TeamTask[]): TeamPanelReview[] {
  const isolation = team.worktreeIsolation?.enabled === true;
  const reviews: TeamPanelReview[] = [];
  for (const task of tasks) {
    const member = task.assignee ?? task.attempts[task.attempts.length - 1]?.owner;
    if (!member || member === "captain") continue;
    const handle = team.members.find((item) => item.name === member)?.worktree;

    if (task.status === "in_review") {
      const baseCommit = task.lastReview?.baseCommit ?? handle?.baseCommit;
      const headCommit = task.lastReview?.headCommit;
      const diffAvailable = baseCommit !== undefined && headCommit !== undefined;
      const check =
        task.lastCheck && task.lastCheck.attemptId === task.activeAttemptId
          ? toCheck(task.lastCheck)
          : undefined;
      reviews.push({
        taskId: task.taskId,
        member,
        status: "in_review",
        ...(baseCommit ? { baseCommit } : {}),
        ...(headCommit ? { headCommit } : {}),
        ...(check ? { check } : {}),
        diffAvailable,
        ...(diffAvailable
          ? {}
          : { unavailableReason: isolation ? "unknown" : "worktree_disabled" }),
      });
      continue;
    }

    if (task.status === "done" && handle?.status === "merged" && handle.mergedAt) {
      const headCommit = handle.lastMergedCommit;
      const diffAvailable = headCommit !== undefined;
      reviews.push({
        taskId: task.taskId,
        member,
        status: "merged",
        ...(handle.baseCommit ? { baseCommit: handle.baseCommit } : {}),
        ...(headCommit ? { headCommit } : {}),
        mergedAt: handle.mergedAt,
        diffAvailable,
        ...(diffAvailable ? {} : { unavailableReason: "unknown" }),
      });
    }
  }
  // 分组序：待验收在前（最可行动），其后按验收时间倒序，再按 taskId。
  return reviews.sort((left, right) => {
    const rank = (review: TeamPanelReview): number => (review.status === "in_review" ? 0 : 1);
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    if (left.status === "merged" && right.status === "merged") {
      const byTime = (right.mergedAt ?? "").localeCompare(left.mergedAt ?? "");
      if (byTime !== 0) return byTime;
    }
    return left.taskId.localeCompare(right.taskId, undefined, { numeric: true });
  });
}

/** 投影并截断（超 MAX_PANEL_REVIEWS 整段保留前 N 条 + reviewsTruncated）。 */
export function buildTeamPanelReviews(
  team: TeamState,
  tasks: readonly TeamTask[],
): { reviews: TeamPanelReview[]; reviewsTruncated: boolean } {
  const all = projectReviews(team, tasks);
  if (all.length <= MAX_PANEL_REVIEWS) {
    return { reviews: all, reviewsTruncated: false };
  }
  return { reviews: all.slice(0, MAX_PANEL_REVIEWS), reviewsTruncated: true };
}