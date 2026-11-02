import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { useTeamComposerInsert } from "@/hooks/useTeamComposerInsert.js";
import type { TeamPanelReview } from "@/v4/teamReviewModel.js";

/**
 * 提醒队长验收 / 请求打回（R4）：**唯一写入通道** = composer。
 *
 * 两个动作都**只填不发送**（`mode: "append"` 不覆盖用户草稿）：用户看一眼自己按回车。
 * 面板内**不提供**「接受 / 合并」按钮——那会让 UI 从只读投影变成调度入口（冻结契约）。
 * 写入失败（无活跃/可写入工作区）→ 就地内联提示 + logger.warn，不弹「出错了」（R5）。
 */
export function TeamReviewActions({
  reviews,
  workspacePath,
  workspaceIdentity,
}: {
  reviews: readonly TeamPanelReview[];
  /** pane scope 的工作区（远程/隔离场景必须显式传，避免落到 path 桶）。 */
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
}) {
  const { intl } = useACodeIntl();
  const { insertTeamText } = useTeamComposerInsert();
  const [writeFailed, setWriteFailed] = useState(false);
  if (reviews.length === 0) return null;
  const taskIds = reviews.map((review) => review.taskId).join(", ");
  const insert = (messageId: string) => {
    const text = intl.formatMessage({ id: messageId }, { taskIds });
    const ok = insertTeamText(text, { workspacePath, workspaceIdentity });
    setWriteFailed(!ok);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="team-review-actions">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Button
          data-testid="team-review-remind"
          size="sm"
          variant="outline"
          onClick={() => insert("teamPanel.review.remindText")}
        >
          {intl.formatMessage({ id: "teamPanel.review.remind" })}
        </Button>
        <Button
          data-testid="team-review-reject"
          size="sm"
          variant="outline"
          onClick={() => insert("teamPanel.review.rejectText")}
        >
          {intl.formatMessage({ id: "teamPanel.review.reject" })}
        </Button>
      </div>
      {writeFailed ? (
        <p className="text-ui-xs text-[var(--color-destructive)]" data-testid="team-review-write-warn">
          {intl.formatMessage({ id: "teamPanel.review.composerWarn" })}
        </p>
      ) : null}
    </div>
  );
}