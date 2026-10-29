/**
 * ConversationStatusPanel 的 Terminals 分区（批次 7 外迁，第二阶段）。
 *
 * 逐字迁移自 `ConversationStatusPanel.tsx` 的 `BackgroundWorkStatusSection`。秒针已统一到
 * `useNowTicker`（原实现是 `useState(now) + setInterval(1000)` 且「关」写在 effect early return
 * 里）；开启条件抽到 `conversationStatusPanelTicks.ts` 的 `shouldTickBackgroundWorks`，可单测。
 *
 * 行为保持：仍按 `startedAt` 升序排列（投影无序，分区自己排），仍默认收起。
 */
import { useMemo } from "react";
import type { BackgroundWorkSummary } from "@acode/shared/acode-protocol-v4";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatDurationUnits,
  formatRunningCount,
  getLongestRunningWorkElapsedMs,
} from "@/v4/conversationStatusPanelFormat.js";
import { shouldTickBackgroundWorks, toCollapsedElapsedSeconds } from "@/v4/conversation-status-panel/conversationStatusPanelTicks.js";
import { RunningStatusItem } from "@/v4/conversation-status-panel/StatusActivityRows.js";
import { StatusSection } from "@/v4/conversation-status-panel/StatusSectionShell.js";

export function BackgroundWorkStatusSection({
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  onOpenChange,
  open,
  separated,
  section,
  title,
  works,
}: {
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  separated: boolean;
  section: "terminal" | "agent";
  title: string;
  works: readonly BackgroundWorkSummary[];
}) {
  const { intl } = useACodeIntl();
  const now = useNowTicker(shouldTickBackgroundWorks(works));
  const orderedRunningWorks = useMemo(
    () => [...works].sort((left, right) => left.startedAt - right.startedAt),
    [works],
  );

  if (works.length === 0) return null;

  const collapsedElapsedLabel = formatDurationUnits(
    toCollapsedElapsedSeconds(getLongestRunningWorkElapsedMs(works, now)),
    intl.formatMessage,
  );

  return (
    <StatusSection
      section={section}
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        isOpen ? (
          <span>
            {intl.formatMessage(
              {
                id:
                  works.length === 1
                    ? "chat.statusPanel.runningStatusValue"
                    : "chat.statusPanel.runningStatusValuePlural",
              },
              { count: String(works.length) },
            )}
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate">{collapsedElapsedLabel}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{formatRunningCount(intl.formatMessage, works.length)}</span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {orderedRunningWorks.map((work) => (
          <RunningStatusItem
            key={work.workId}
            work={work}
            now={now}
            onOpenBackgroundBash={onOpenBackgroundBash}
            onCancelBackgroundWork={onCancelBackgroundWork}
          />
        ))}
      </ul>
    </StatusSection>
  );
}
