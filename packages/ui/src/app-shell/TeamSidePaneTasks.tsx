import { memo, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { TeamTaskGraph } from "@/components/TeamTaskGraph.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { BlockedQualityCard, GroupHeader, groupTasks, TaskRow } from "@/app-shell/teamPaneParts.js";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";

/**
 * 任务板页签：同一份依赖数据的两种画法。
 *
 * 图态回答「这活是什么形状」（扇出/汇入/关键路径），列表态回答「现在该谁动」
 * （按可否开工分组）。两种都需要，所以给切换而不是二选一——只看图不知道从哪下手，
 * 只看列表看不出结构。
 *
 * 视图与分组折叠状态留在本组件内：它们是纯呈现状态，父组件（面板外壳）不该知道。
 */

const GROUP_ORDER = [
  ["inProgress", "teamPanel.group.inProgress", "bg-[var(--color-warning)]"],
  ["ready", "teamPanel.group.ready", "bg-[var(--color-success)]"],
  ["waiting", "teamPanel.group.waiting", "bg-[var(--color-foreground-subtlest)]"],
  ["blocked", "teamPanel.group.blocked", "bg-[var(--color-destructive)]"],
  ["done", "teamPanel.group.done", "bg-[var(--color-success)]"],
] as const;

export const TeamSidePaneTasks = memo(function TeamSidePaneTasks({
  team,
}: {
  team: ConversationStatusPanelTeam;
}) {
  const { intl } = useACodeIntl();
  const [view, setView] = useState<"graph" | "list">("graph");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => groupTasks(team), [team]);
  const blockedQualityByTask = useMemo(
    () => new Map(team.blockedByFailedQuality.map((entry) => [entry.taskId, entry.blockedBy])),
    [team.blockedByFailedQuality],
  );
  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (team.tasks.length === 0) {
    return (
      <p className="px-1.5 text-ui-base text-foreground-subtlest">
        {intl.formatMessage({ id: "teamPanel.tasks.empty" })}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-1">
        {(["graph", "list"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setView(candidate)}
            aria-pressed={view === candidate}
            className={cn(
              "inline-flex h-7 items-center rounded-lg px-2.5 text-ui-base font-medium transition-colors",
              view === candidate
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-[var(--color-hover)]",
            )}
          >
            {intl.formatMessage({
              id: candidate === "graph" ? "teamPanel.view.graph" : "teamPanel.view.list",
            })}
          </button>
        ))}
      </div>

      {view === "graph" ? (
        <div className="min-w-0 rounded-lg border border-border bg-panel p-2">
          <div className="min-w-0 overflow-x-auto">
            <TeamTaskGraph team={team} variant="full" />
          </div>
          {team.criticalPathDepth > 0 ? (
            <p className="pt-1.5 text-ui-xs text-[var(--color-foreground-subtlest)]">
              {intl.formatMessage({ id: "teamPanel.metric.criticalPath" })}
              {" · "}
              {intl.formatMessage(
                { id: "teamPanel.depthUnit" },
                { depth: String(team.criticalPathDepth) },
              )}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          {!team.hasTaskDerivations ? (
            <p className="px-1.5 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "teamPanel.readyUnavailable" })}
            </p>
          ) : null}
          {GROUP_ORDER.map(([key, labelId, tone]) => {
            const list = groups[key];
            if (list.length === 0) return null;
            const open = !collapsed.has(key);
            return (
              <section key={key}>
                <GroupHeader
                  label={intl.formatMessage({ id: labelId })}
                  count={list.length}
                  tone={tone}
                  open={open}
                  onToggle={() => toggle(key)}
                />
                {open ? (
                  <div className="min-w-0 pl-1">
                    {list.map((task) => (
                      <TaskRow
                        key={task.taskId}
                        task={task}
                        team={team}
                        blockedByQuality={blockedQualityByTask.get(task.taskId) ?? []}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}

      <BlockedQualityCard team={team} />
    </div>
  );
});
