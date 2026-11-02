import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  groupTeamReviews,
  REVIEW_GROUP_INLINE_LIMIT,
  type TeamPanelReview,
  type TeamPanelReviewStatus,
  type TeamReviewGroupKey,
} from "@/v4/teamReviewModel.js";
import type { TeamReviewDiffPhase } from "@/hooks/useTeamReviewDiff.js";

/**
 * 待验收页签的清单（R2/R6）：按状态分组（待验收 / 已验收 / 已打回），单组超
 * `REVIEW_GROUP_INLINE_LIMIT` 默认折叠 + 组头计数摘要。
 *
 * 折叠状态是纯呈现状态（同 TeamSidePaneTasks 的 collapsed 集合）：快照更新不重置它，
 * 也不覆盖用户手动切换。分组/排序判据全部来自 teamReviewModel（单一收窄点），此处只画。
 * 行上的「查看 diff」带 `aria-expanded` 与可读 label（R8）；状态一律「文字 + 色点」并出，
 * 不用颜色单独表意（R1）。
 */

const GROUP_LABEL_IDS: Record<TeamReviewGroupKey, string> = {
  in_review: "teamPanel.review.group.in_review",
  merged: "teamPanel.review.group.merged",
  rejected: "teamPanel.review.group.rejected",
};

const STATUS_LABEL_IDS: Record<TeamPanelReviewStatus, string> = {
  in_review: "teamPanel.review.status.in_review",
  merged: "teamPanel.review.status.merged",
  rejected: "teamPanel.review.status.rejected",
};

const STATUS_BADGE: Record<TeamPanelReviewStatus, string> = {
  // 待验收 = 等待裁决，走 confirmation 家族（DESIGN.md 明令：不得用 success 冒充等待态）。
  in_review: "bg-interaction-confirmation-surface text-interaction-confirmation-foreground",
  merged: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
  rejected: "bg-[var(--color-destructive)]/15 text-[var(--color-destructive)]",
};

export function TeamReviewList({
  reviews,
  expandedTaskId,
  onToggleReview,
  loadingTaskId,
  loadingPhase = "quiet",
  loadingStage = "files",
}: {
  reviews: readonly TeamPanelReview[];
  /** 当前展开详情的条目；null = 未展开任何条目。 */
  expandedTaskId: string | null;
  onToggleReview: (taskId: string) => void;
  /** 正在读取 diff 的条目（>100ms 起禁用、>1s 显示 spinner、>3s 换阶段文字，EI-98）。 */
  loadingTaskId?: string | null;
  loadingPhase?: TeamReviewDiffPhase;
  loadingStage?: "files" | "diff";
}) {
  const { intl } = useACodeIntl();
  // 折叠是纯呈现状态：默认在组超过 REVIEW_GROUP_INLINE_LIMIT 时折叠；用户切过之后以
  // override 为准（快照更新不重置，也不覆盖用户选择）。
  const [overrides, setOverrides] = useState<ReadonlyMap<TeamReviewGroupKey, boolean>>(
    () => new Map(),
  );
  const groups = groupTeamReviews(reviews);
  if (groups.length === 0) return null;
  const toggle = (key: TeamReviewGroupKey, open: boolean) =>
    setOverrides((current) => new Map(current).set(key, !open));
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="team-review-list">
      {groups.map((group) => {
        const overLimit = group.reviews.length > REVIEW_GROUP_INLINE_LIMIT;
        const open = overrides.get(group.key) ?? !overLimit;
        const visible = open ? group.reviews : [];
        return (
          <section className="min-w-0" data-review-group={group.key} key={group.key}>
            <button
              aria-expanded={open}
              className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 text-left text-ui-base text-foreground-subtle outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
              data-testid={`team-review-group-${group.key}`}
              type="button"
              onClick={() => toggle(group.key, open)}
            >
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-foreground-subtlest" />
              <span className="min-w-0 flex-1 truncate">
                {intl.formatMessage(
                  { id: GROUP_LABEL_IDS[group.key] },
                  { count: group.reviews.length },
                )}
              </span>
              {open ? (
                <ChevronDownIcon aria-hidden className="size-3" />
              ) : (
                <ChevronRightIcon aria-hidden className="size-3" />
              )}
            </button>
            {visible.map((review) => {
              const expanded = expandedTaskId === review.taskId;
              const diffLabel = intl.formatMessage({
                id: expanded ? "teamPanel.review.hideDiff" : "teamPanel.review.viewDiff",
              });
              const loading = loadingTaskId === review.taskId && loadingPhase !== "quiet";
              const buttonLabel =
                loadingPhase === "staged"
                  ? intl.formatMessage({
                      id:
                        loadingStage === "files"
                          ? "teamPanel.review.loadingFiles"
                          : "teamPanel.review.loadingDiff",
                    })
                  : diffLabel;
              return (
                <div
                  className="flex min-h-7 min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-ui-base hover:bg-[var(--color-hover)]"
                  data-review-task-id={review.taskId}
                  key={review.taskId}
                >
                  <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
                    {review.taskId}
                  </span>
                  <span className="shrink-0 truncate text-ui-sm text-foreground-subtle">
                    {review.member}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-sm px-1 text-ui-xs font-medium",
                      STATUS_BADGE[review.status],
                    )}
                  >
                    {intl.formatMessage({ id: STATUS_LABEL_IDS[review.status] })}
                  </span>
                  <span className="min-w-0 flex-1" />
                  <button
                    aria-busy={loading}
                    aria-expanded={expanded}
                    aria-label={`${diffLabel} ${review.taskId}`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 text-ui-xs text-foreground-subtle outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none"
                    data-phase={loading ? loadingPhase : undefined}
                    data-testid={`team-review-diff-toggle-${review.taskId}`}
                    disabled={loading}
                    title={loading ? buttonLabel : diffLabel}
                    type="button"
                    onClick={() => onToggleReview(review.taskId)}
                  >
                    {/* 固定宽度占位：读中不产生按钮宽度跳动（EI-98 不许无标签转圈）。 */}
                    <span className="inline-flex w-3 shrink-0 justify-center" aria-hidden>
                      {loading && loadingPhase !== "waiting" ? (
                        <span className="size-3 animate-spin rounded-full border-2 border-foreground-subtlest border-t-transparent" />
                      ) : null}
                    </span>
                    {loading ? buttonLabel : diffLabel}
                  </button>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}