/**
 * ConversationStatusPanel 的 Agents 分区（批次 7 外迁，第二阶段）。
 *
 * 逐字迁移自 `ConversationStatusPanel.tsx` 的 `SubagentStatusSection`。秒针已统一到
 * `useNowTicker`（原实现是 `useState(now) + setInterval(1000)` + 手写 early return）。
 *
 * 行内同时有「打开详情」与 Stop：整行 button 会套出嵌套按钮，因此详情用绝对定位的同级
 * 透明 button（与 Workflows 分区同款）。
 */
import { useMemo } from "react";
import { BotIcon } from "lucide-react";
import { TID_V4_BACKGROUND_WORK_ITEM, testId } from "@acode/shared";
import type {
  OpenSubagentDirectorySideTabRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import { cn } from "@/components/lib/utils.js";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildRunningSubagentOpenRequest,
  formatDurationUnits,
  formatRunningSubagentCount,
} from "@/v4/conversationStatusPanelFormat.js";
import type { ConversationStatusPanelRunningSubagent } from "@/v4/conversationStatusPanelModel.js";
import {
  shouldTickSubagents,
  toCollapsedElapsedSeconds,
} from "@/v4/conversation-status-panel/conversationStatusPanelTicks.js";
import { RunningWorkCancelButton } from "@/v4/conversation-status-panel/StatusActivityRows.js";
import { EndedSubagentDirectoryRow } from "@/v4/conversation-status-panel/TeamAndEndedSections.js";
import { StatusSection } from "@/v4/conversation-status-panel/StatusSectionShell.js";

export function SubagentStatusSection({
  endedSubagentCount,
  onCancelBackgroundWork,
  onOpenChange,
  onOpenSubagentDirectory,
  onOpenSubagentSession,
  open,
  parentSessionId,
  rootSessionId,
  separated,
  title,
  subagents,
}: {
  endedSubagentCount: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenSubagentDirectory?: (request: OpenSubagentDirectorySideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  open?: boolean;
  parentSessionId?: string;
  rootSessionId?: string;
  separated: boolean;
  title: string;
  subagents: readonly ConversationStatusPanelRunningSubagent[];
}) {
  const { intl } = useACodeIntl();
  const now = useNowTicker(shouldTickSubagents(subagents));
  // 保留原实现的 memo：投影每帧可能换引用，排序结果按 subagents 缓存，避免每帧重排。
  const ordered = useMemo(
    () => [...subagents].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0)),
    [subagents],
  );
  if (subagents.length === 0 && endedSubagentCount <= 0) return null;
  const longestElapsedMs = subagents.reduce(
    (longest, item) => Math.max(longest, Math.max(0, now - (item.startedAt ?? now))),
    0,
  );

  return (
    <StatusSection
      section="agent"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        subagents.length === 0 ? null : isOpen ? (
          <span>{formatRunningSubagentCount(intl.formatMessage, subagents.length)}</span>
        ) : (
          <>
            <span className="min-w-0 truncate">
              {formatDurationUnits(
                toCollapsedElapsedSeconds(longestElapsedMs),
                intl.formatMessage,
              )}
            </span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">
              {formatRunningSubagentCount(intl.formatMessage, subagents.length)}
            </span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {ordered.map((subagent) => {
          const request = buildRunningSubagentOpenRequest({
            parentSessionId,
            rootSessionId,
            subagent,
          });
          const canOpenSubagentSession = Boolean(request && onOpenSubagentSession);
          return (
            <li
              key={subagent.childSessionId}
              data-testid={
                subagent.controlWorkId
                  ? testId(TID_V4_BACKGROUND_WORK_ITEM, subagent.controlWorkId)
                  : undefined
              }
              data-background-task-kind="agent"
              data-child-session-id={subagent.childSessionId}
              data-work-id={subagent.controlWorkId}
              data-work-status="running"
              className={cn(
                "group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]",
                canOpenSubagentSession && "cursor-pointer",
              )}
            >
              {canOpenSubagentSession ? (
                // Agent 行同时包含“打开详情”和 Stop，不能用整行 button 包住
                // Stop 形成嵌套按钮。透明同级按钮承接详情，Stop 保持独立交互层且阻止冒泡。
                <button
                  type="button"
                  data-running-subagent-session-trigger="true"
                  data-child-session-id={subagent.childSessionId}
                  aria-label={intl.formatMessage({
                    id: "chat.summaryPanel.openRunningSubagentSession",
                  })}
                  onClick={() => request && onOpenSubagentSession?.(request)}
                  className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
                />
              ) : null}
              <BotIcon className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
              <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="line-clamp-2 text-ui-base leading-5 text-[var(--color-foreground)]">
                  {subagent.title}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
                  <span className="text-ui-base tabular-nums text-[var(--color-foreground-subtle)]">
                    {formatBackgroundTaskElapsedLabel(
                      Math.max(0, now - (subagent.startedAt ?? now)),
                      intl.formatMessage,
                    )}
                  </span>
                  {subagent.controlWorkId && subagent.cancellable !== false ? (
                    <RunningWorkCancelButton
                      workId={subagent.controlWorkId}
                      onCancel={onCancelBackgroundWork}
                    />
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <EndedSubagentDirectoryRow
        count={endedSubagentCount}
        parentSessionId={parentSessionId}
        rootSessionId={rootSessionId}
        onOpen={onOpenSubagentDirectory}
        separated={subagents.length > 0}
      />
    </StatusSection>
  );
}
