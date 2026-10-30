/**
 * ConversationStatusPanel 的 Workflows 分区（批次 7 外迁，第二阶段）。
 *
 * 逐字迁移自 `ConversationStatusPanel.tsx` 的 `WorkflowStatusSection`。秒针已统一到
 * `useNowTicker`（原实现是 `useState(now) + setInterval(1000)` + 手写 early return）。
 *
 * 行的字段分三簇（见 `ConversationStatusPanelWorkflowRun`），渲染逐簇独立缺席：
 * - 无 `status`：偏斜降级行（旧 CLI 没有 workflowRuns 投影键），没有状态词与步数；
 * - 无 `startedAt`：run 还没有配对的后台任务，没有时长；
 * - 无 `workId`：停不了，不出 Stop。
 * 把它们并成一个「有没有 work」的布尔就会漏掉偏斜形态——这三簇正是偏斜的全部表现。
 *
 * **不排序**：顺序 = 投影 runs 序 = 启动序（模型层已经保证）。Terminals / Agents 按
 * startedAt 排是因为它们的投影无序；这里重排反而会让行在每次投影更新时跳位。
 */
import { CheckCircle2Icon, Workflow } from "lucide-react";
import { TID_V4_BACKGROUND_WORK_ITEM, testId } from "@acode/shared";
import type { OpenWorkflowRunDirectorySideTabRequest } from "@/lib/workspaceSidePane.js";
import { cn } from "@/components/lib/utils.js";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import { RUN_STATUS_DOT, RUN_STATUS_TEXT } from "@/components/workflow-graph/run-status-presentation.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatDurationUnits,
  formatRunningCount,
} from "@/v4/conversationStatusPanelFormat.js";
import {
  workflowRunOpenTarget,
  type ConversationStatusPanelWorkflowRun,
  type ConversationStatusPanelWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import {
  shouldShowWorkflowCollapsedElapsed,
  shouldTickWorkflowRuns,
  toCollapsedElapsedSeconds,
} from "@/v4/conversation-status-panel/conversationStatusPanelTicks.js";
import { RunningWorkCancelButton } from "@/v4/conversation-status-panel/StatusActivityRows.js";
import { EndedDirectoryRow } from "@/v4/conversation-status-panel/TeamAndEndedSections.js";
import { StatusSection } from "@/v4/conversation-status-panel/StatusSectionShell.js";

export function WorkflowStatusSection({
  endedRunCount,
  onCancelBackgroundWork,
  onOpenChange,
  onOpenDirectory,
  onOpenWorkflowRun,
  open,
  parentSessionId,
  runs,
  separated,
  title,
}: {
  endedRunCount: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  open?: boolean;
  parentSessionId?: string;
  runs: readonly ConversationStatusPanelWorkflowRun[];
  separated: boolean;
  title: string;
}) {
  const { intl } = useACodeIntl();
  const now = useNowTicker(shouldTickWorkflowRuns(runs));

  // 活动行与已结束计数**都**为零才收起整个分区：只按活动数开门的那一版，重启后一个 run
  // 都不在跑，于是入口连带目录页一起消失——而重启后回看被打断的 run 正是它的主要用途。
  if (runs.length === 0 && endedRunCount <= 0) return null;

  const longestElapsedMs = runs.reduce(
    (longest, run) =>
      run.startedAt === undefined ? longest : Math.max(longest, Math.max(0, now - run.startedAt)),
    0,
  );
  const openLabel = intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" });

  return (
    <StatusSection
      section="workflow"
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
                // 复用 Terminals 的计数文案而不是 Agents 的：workflow run 确实是一条后台任务
                // （它有自己的 BackgroundWorkSummary），而 subagent 可能是前台的，那条文案
                // 才需要把语义放宽成「运行」。
                id:
                  runs.length === 1
                    ? "chat.statusPanel.runningStatusValue"
                    : "chat.statusPanel.runningStatusValuePlural",
              },
              { count: String(runs.length) },
            )}
          </span>
        ) : (
          <>
            {/* 一行都没有 startedAt 时收起态只剩计数：宁可少一段，也不显示一个 0 秒的假时长。 */}
            {shouldShowWorkflowCollapsedElapsed(longestElapsedMs) ? (
              <>
                <span className="min-w-0 truncate">
                  {formatDurationUnits(
                    toCollapsedElapsedSeconds(longestElapsedMs),
                    intl.formatMessage,
                  )}
                </span>
                <span className="shrink-0">·</span>
              </>
            ) : null}
            <span className="shrink-0">{formatRunningCount(intl.formatMessage, runs.length)}</span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {runs.map((run) => {
          // 行 → 打开意图的换算与 composer 徽标直达共用（模型层 workflowRunOpenTarget）。
          const openTarget = onOpenWorkflowRun ? workflowRunOpenTarget(run) : null;
          const canOpen = openTarget !== null;
          // 未命名的判定：`title ≡ workId`（≡ runId）就是 core 的 workflowTaskSubject 兜底到
          // taskId 的样子，投影会把非空 description 原样抄进 title。降级行的 runId 也 ≡ workId，
          // 所以一次比较覆盖两簇。
          const displayName =
            run.title && run.title !== run.runId
              ? run.title
              : intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
          return (
            <li
              key={run.runId}
              data-testid={run.workId ? testId(TID_V4_BACKGROUND_WORK_ITEM, run.workId) : undefined}
              data-background-task-kind="workflow"
              data-workflow-run-id={run.runId}
              data-work-id={run.workId}
              data-work-status={run.status}
              className={cn(
                "group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]",
                canOpen && "cursor-pointer",
              )}
            >
              {openTarget ? (
                // 与 Agent 行同款：行里已经有 Stop 这个嵌套交互，整行 button 会套出嵌套按钮。
                // 透明同级按钮承接「打开详情页」，Stop 保持独立交互层并阻止冒泡。
                <button
                  type="button"
                  data-workflow-run-details-trigger="true"
                  data-workflow-run-id={run.runId}
                  aria-label={openLabel}
                  onClick={() => onOpenWorkflowRun?.(openTarget)}
                  className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
                />
              ) : null}
              <Workflow className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
              <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="line-clamp-2 text-ui-base leading-5 text-[var(--color-foreground)]">
                  {displayName}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
                  {run.status ? (
                    <>
                      {/* 状态永远有词，绝不只靠颜色或动画表达（a11y）。 */}
                      <span
                        aria-hidden="true"
                        data-workflow-run-status-dot={run.status}
                        className={cn("size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[run.status])}
                      />
                      <span className={cn("shrink-0", RUN_STATUS_TEXT[run.status])}>
                        {intl.formatMessage({
                          id: `chat.toolCall.workflow.run.status.${run.status}`,
                        })}
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtle)]">
                        {intl.formatMessage(
                          { id: "chat.toolCall.workflow.card.steps" },
                          {
                            // 步数与 status 在模型层同簇出现（present iff status present），
                            // 但类型上是各自独立的可选字段；`?? 0` 只是补这道类型形式，
                            // 真跑到它意味着模型违反了自己的不变量。
                            done: String(run.nodesSettled ?? 0),
                            total: String(run.nodesTotal ?? 0),
                          },
                        )}
                      </span>
                    </>
                  ) : null}
                  {run.startedAt === undefined ? null : (
                    <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtle)]">
                      {formatBackgroundTaskElapsedLabel(
                        Math.max(0, now - run.startedAt),
                        intl.formatMessage,
                      )}
                    </span>
                  )}
                  {run.workId && run.cancellable !== false ? (
                    <RunningWorkCancelButton
                      workId={run.workId}
                      onCancel={onCancelBackgroundWork}
                    />
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {/* 已结束的 run 折进这条页脚行（与 Agents 分区共用同一个 affordance）：终态 run 不占
          活动列表的位置，但入口必须留着——被打断的那些正是最需要点进去的。 */}
      <EndedDirectoryRow
        count={endedRunCount}
        icon={
          <CheckCircle2Icon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
        }
        label={intl.formatMessage({ id: "chat.statusPanel.endedWorkflows" })}
        separated={runs.length > 0}
        testId="workflow-run-directory-trigger"
        onOpen={
          parentSessionId && onOpenDirectory
            ? () => onOpenDirectory({ parentSessionId })
            : undefined
        }
      />
    </StatusSection>
  );
}
