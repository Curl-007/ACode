import { FileDiffIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";
import type { TeamPanelLanding } from "@/lib/workspaceSidePane.js";

/**
 * 团队卡状态行上的验收薄入口（R2）：点击打开团队面板并落到「待验收」页签。
 *
 * 只在有待验收件且宿主给了打开回调时出现——没有动作的入口比没有入口更糟。
 * 计数取 `counts.inReview`（唯一计数源，OQ2），不自算。
 */
export function TeamReviewEntry({
  team,
  onOpen,
}: {
  team: ConversationStatusPanelTeam;
  onOpen?: (landing: TeamPanelLanding) => void;
}) {
  const { intl } = useACodeIntl();
  if (!onOpen || team.counts.inReview <= 0) return null;
  const label = intl.formatMessage(
    { id: "teamPanel.review.openEntry" },
    { count: team.counts.inReview },
  );
  return (
    <button
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-transparent bg-interaction-confirmation-surface px-1.5 text-ui-xs font-medium text-interaction-confirmation-foreground",
        "outline-none hover:bg-interaction-confirmation-surface/80 focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-testid="team-review-entry"
      title={label}
      type="button"
      onClick={() => onOpen({ focusTab: "review" })}
    >
      <FileDiffIcon aria-hidden className="size-3" />
      {label}
    </button>
  );
}