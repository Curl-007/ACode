import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { teamTaskStatus } from "@/v4/teamWorkflowPresentation.js";
import type { TeamInlineTaskGroup, TeamInlineTaskGroupKey } from "@/v4/teamWorkflowPresentation.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 运行卡的内联任务清单（SPEC-012 R5）：把「完成了哪些」搬到卡上，不必先打开侧栏。
 * 分组顺序即 groupInlineTasks 的顺序；「已完成」默认折叠只显示计数，其余组默认展开、
 * 每组最多 5 行，超出显示「还有 N 项」并打开团队面板任务板。行点击定位到该任务。
 */
const GROUP_LIMIT = 5;

const GROUP_LABEL_IDS: Record<TeamInlineTaskGroupKey, string> = {
  running: "teamPanel.timeline.groupRunning",
  failed: "teamPanel.timeline.groupFailed",
  ready: "teamPanel.timeline.groupReady",
  todo: "teamPanel.timeline.groupTodo",
  done: "teamPanel.timeline.groupDone",
};

/** 分组状态点的取色：复用时间线的状态语义（running/failed/done/pending）。 */
const GROUP_DOT: Record<TeamInlineTaskGroupKey, string> = {
  running: "bg-[var(--color-warning)]",
  failed: "bg-destructive",
  ready: "bg-foreground-subtle",
  todo: "bg-foreground-subtlest",
  done: "bg-[var(--color-success)]",
};

export function TeamInlineTaskList({
  groups,
  totalCount,
  onOpenTask,
  onOpenAll,
}: {
  groups: TeamInlineTaskGroup[];
  totalCount: number;
  /** 任务行点击：打开团队面板并定位（SPEC-012 R5）。缺席即行不可点。 */
  onOpenTask?: (taskId: string) => void;
  /** 「还有 N 项」的落点；缺席时退回 onOpenTask 的语义不可用即不渲染该行。 */
  onOpenAll?: () => void;
}) {
  const { intl } = useACodeIntl();
  // 只有「已完成」默认折叠：它是唯一会随长任务列表无限增长的一组。
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<TeamInlineTaskGroupKey>>(
    () => new Set(),
  );
  if (groups.length === 0) return null;
  const doneCount = groups.find((group) => group.key === "done")?.tasks.length ?? 0;
  return (
    <div
      className="flex min-w-0 flex-col gap-1 pt-0.5 text-ui-sm"
      data-testid="team-inline-tasks"
      data-task-total={totalCount}
    >
      <div className="text-xs text-foreground-subtlest">
        {intl.formatMessage(
          { id: "teamPanel.timeline.tasksTitle" },
          { done: doneCount, total: totalCount },
        )}
      </div>
      {groups.map((group) => {
        const open = group.key === "done" ? expandedGroups.has("done") : true;
        const visible = open ? group.tasks.slice(0, GROUP_LIMIT) : [];
        const hidden = group.tasks.length - visible.length;
        return (
          <div className="flex min-w-0 flex-col" data-task-group={group.key} key={group.key}>
            <button
              aria-expanded={group.key === "done" ? open : undefined}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 text-left text-foreground-subtle outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
                group.key === "done" && "rounded-sm",
              )}
              data-testid={`team-inline-group-${group.key}`}
              type="button"
              onClick={() => {
                if (group.key !== "done") return;
                setExpandedGroups((current) => {
                  const next = new Set(current);
                  if (next.has("done")) next.delete("done");
                  else next.add("done");
                  return next;
                });
              }}
            >
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", GROUP_DOT[group.key])}
              />
              <span>
                {intl.formatMessage(
                  { id: GROUP_LABEL_IDS[group.key] },
                  { count: group.tasks.length },
                )}
              </span>
              {group.key === "done" ? (
                open ? (
                  <ChevronDownIcon aria-hidden className="size-3" />
                ) : (
                  <ChevronRightIcon aria-hidden className="size-3" />
                )
              ) : null}
            </button>
            {visible.map((task) => (
              <button
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm py-0.5 pl-4 pr-1 text-left text-foreground",
                  onOpenTask === undefined
                    ? undefined
                    : "cursor-pointer hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40",
                )}
                data-task-id={task.taskId}
                data-task-status={teamTaskStatus(task.status)}
                key={task.taskId}
                title={task.title}
                type="button"
                onClick={onOpenTask === undefined ? undefined : () => onOpenTask(task.taskId)}
              >
                <span className="shrink-0 tabular-nums text-foreground-subtlest">
                  {task.taskId}
                </span>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
              </button>
            ))}
            {open && hidden > 0 && onOpenAll ? (
              <Button
                className="self-start pl-4 text-foreground-subtle"
                size="xs"
                variant="ghost"
                data-testid="team-inline-more"
                onClick={onOpenAll}
              >
                {intl.formatMessage({ id: "teamPanel.timeline.moreTasks" }, { count: hidden })}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
