import { memo, useState } from "react";
import type { TeamSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { useTeamReviewDiff } from "@/hooks/useTeamReviewDiff.js";
import { TeamReviewList } from "@/components/TeamReviewList.js";
import { TeamReviewDetail } from "@/components/TeamReviewDetail.js";
import { TeamReviewActions } from "@/components/TeamReviewActions.js";

/**
 * 待验收页签容器（R2）：清单 + 选中项的详情 + 提醒动作。
 *
 * 页签只在 `reviews[]` 非空时由其入口渲染（空态不给裸文本，R5/EI-101）；本容器只是组合叶子，
 * 不重定义收窄（形状与分组判据全在 teamPanelModel / teamReviewModel）。
 * 选区与展开是组件内呈现状态：`focusReviewTaskId` 缺席即定位第一条；用户手动展开后不被
 * 快照更新抢回。diff 读数由 useTeamReviewDiff 按需发起，只活在当前展开内。
 */
export const TeamSidePaneReview = memo(function TeamSidePaneReview({
  team,
  tab,
}: {
  team: ConversationStatusPanelTeam;
  tab: TeamSidePaneTab;
}) {
  const { intl } = useACodeIntl();
  // userExpanded === undefined 表示「跟随落点默认」；null = 用户收起；string = 用户选中。
  const [userExpanded, setUserExpanded] = useState<string | null | undefined>(undefined);
  const reviews = team.reviews;
  const defaultTaskId = tab.focusReviewTaskId ?? reviews[0]?.taskId ?? null;
  const expandedTaskId = userExpanded === undefined ? defaultTaskId : userExpanded;
  const expandedReview = reviews.find((review) => review.taskId === expandedTaskId) ?? null;
  const diff = useTeamReviewDiff({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity ?? null,
    remoteSessionId: tab.remoteSessionId ?? null,
    review: expandedReview,
  });
  if (reviews.length === 0) return null;
  const pendingReviews = reviews.filter((review) => review.status === "in_review");
  const wakeHint = team.wakeHint;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="team-side-pane-review">
      {wakeHint ? (
        <p
          className="rounded-lg border border-border bg-[var(--color-interaction-confirmation-surface)] px-2 py-1.5 text-ui-sm text-[var(--color-interaction-confirmation-foreground)]"
          data-testid="team-review-wake-hint"
        >
          {intl.formatMessage(
            { id: "teamPanel.review.wakeHint" },
            { unread: wakeHint.unreadMessages, tasks: wakeHint.unsettledMemberTasks },
          )}
        </p>
      ) : null}
      <TeamReviewList
        expandedTaskId={expandedTaskId}
        loadingPhase={diff.loadingPhase}
        loadingStage={diff.loadingStage}
        loadingTaskId={
          diff.range.status === "loading" || diff.file.status === "loading" ? expandedTaskId : null
        }
        reviews={reviews}
        onToggleReview={(taskId) =>
          setUserExpanded((expandedTaskId ?? null) === taskId ? null : taskId)
        }
      />
      {expandedReview ? (
        <TeamReviewDetail
          file={diff.file}
          loadingPhase={diff.loadingPhase}
          loadingStage={diff.loadingStage}
          range={diff.range}
          review={expandedReview}
          selectedPath={diff.selectedPath}
          onReload={diff.reload}
          onSelectFile={diff.selectFile}
        />
      ) : null}
      <TeamReviewActions
        reviews={pendingReviews}
        workspaceIdentity={tab.workspaceIdentity ?? null}
        workspacePath={tab.workspacePath}
      />
    </div>
  );
});