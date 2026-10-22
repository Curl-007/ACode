import { useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, Maximize2Icon, UsersIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  WorkflowTimeline,
  timelineHeight,
} from "@/components/workflow-timeline/WorkflowTimeline.js";
import { teamStatusDotClass } from "@/app-shell/teamPaneParts.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";
import {
  buildTeamWorkflowPresentation,
  groupInlineTasks,
  isTeamEnded,
  localizeTeamTimeline,
  teamStatusMessageId,
} from "@/v4/teamWorkflowPresentation.js";
import type { TeamPanelLanding } from "@/lib/workspaceSidePane.js";
import { TeamInlineTaskList } from "@/components/TeamInlineTaskList.js";
import { TeamApprovalActions } from "@/components/TeamApprovalActions.js";
import { TeamLingeringMembers } from "@/components/TeamLingeringMembers.js";

export function TeamWorkflowCard({
  team,
  onOpen,
  onOpenMemberSession,
  resolveMemberStop,
}: {
  team: ConversationStatusPanelTeam;
  onOpen?: (landing: TeamPanelLanding) => void;
  /** 打开成员子 Agent 会话（SPEC-012 R3）；缺席时药丸退回「打开团队面板」。 */
  onOpenMemberSession?: (request: { childSessionId: string; title: string }) => void;
  /** 子会话仍在运行 → 停止入口（SPEC-012 R13）；停在宿主的智能体分区同一条通道。 */
  resolveMemberStop?: (childSessionId: string) => (() => void) | undefined;
}) {
  const { intl } = useACodeIntl();
  // 已结束的团队卡默认折叠（SPEC-012 R6）；用户手动展开后不被快照更新抢回。
  const [expanded, setExpanded] = useState(() => !isTeamEnded(team));
  const presentation = useMemo(() => buildTeamWorkflowPresentation(team), [team]);
  const model = localizeTeamTimeline(presentation, intl.formatMessage.bind(intl));
  const shown = expanded
    ? model
    : { ...model, stations: model.stations.map((station) => ({ ...station, pills: [] })) };
  const statusId = teamStatusMessageId(team.status);
  const status = statusId ? intl.formatMessage({ id: statusId }) : team.status;
  const activeMembers = team.members.filter((member) => member.status !== "removed").length;
  const detail = intl.formatMessage(
    { id: "teamPanel.timeline.summary" },
    {
      phases: model.stations.length,
      members: activeMembers,
      done: team.counts.done,
      total: team.tasks.length,
    },
  );
  const open = (landing: TeamPanelLanding = {}) => onOpen?.({ ...landing, teamId: team.teamId });
  const inlineGroups = groupInlineTasks(team);
  // 任务所属阶段：内联任务行点击时随 focusTaskId 一起交给团队面板落点。
  const phaseIdOfTask = new Map(
    presentation.phases.flatMap((phase) =>
      phase.tasks.map((task) => [task.taskId, phase.id] as const),
    ),
  );
  // 药丸两行与 tooltip（SPEC-012 R2）：第二行 = 该成员当前任务标题（无则「已完成 N 项」）；
  // 角色不进显示名（168px 会把人名 100% 截断），改走 tooltip。
  const pillDetail = (pill: { lane: { id: string }; stepIds: readonly string[] }) => {
    const member = presentation.members.get(pill.lane.id);
    if (!member) {
      const task = team.tasks.find((candidate) => candidate.taskId === pill.stepIds[0]);
      return task === undefined ? {} : { subtitle: task.title };
    }
    const taskTitle =
      member.currentTaskTitle ?? team.tasks.find((task) => task.taskId === pill.stepIds[0])?.title;
    const subtitle =
      taskTitle ??
      (team.counts.done > 0
        ? intl.formatMessage({ id: "teamPanel.timeline.doneCount" }, { count: team.counts.done })
        : undefined);
    return {
      ...(subtitle === undefined ? {} : { subtitle }),
      title: member.role ? `${member.name} · ${member.role}` : member.name,
    };
  };
  const hasRail = model.stations.length > 0;
  const hitsControl = (target: EventTarget | null, root: HTMLElement) => {
    const element = target as Element | null;
    const control =
      typeof element?.closest === "function"
        ? element.closest("button, a, input, textarea, select, [role='button']")
        : null;
    return control !== null && control !== root;
  };
  const label = intl.formatMessage({ id: "chat.statusPanel.agentTeams.openPanel" });
  const collapseLabel = intl.formatMessage({
    id: expanded ? "teamPanel.timeline.collapseMembers" : "teamPanel.timeline.expandMembers",
  });
  // SPEC-012 R3：有子会话就打开成员会话，让用户看「他正在干什么」；没有则退回打开
  // 团队面板并定位到该成员的当前任务（旧插件 / 未绑定成员的退化路径）。
  const openPill = (memberKey: string, stepIds: readonly string[]) => {
    const member = presentation.members.get(memberKey);
    if (member?.childSessionId && onOpenMemberSession) {
      onOpenMemberSession({ childSessionId: member.childSessionId, title: member.name });
      return;
    }
    open({
      focusPhaseId: undefined,
      focusTaskId: stepIds[0],
    });
  };
  return (
    <section
      aria-label={intl.formatMessage({ id: "teamPanel.timeline.card" })}
      aria-expanded={hasRail ? expanded : undefined}
      role={hasRail ? "group" : undefined}
      tabIndex={hasRail ? 0 : undefined}
      data-testid="team-workflow-card"
      data-team-id={team.teamId}
      data-expanded={String(expanded)}
      className={cn(
        "wf-motion wf-arrive flex w-full min-w-0 flex-col gap-1 rounded-xl border border-card-border bg-card px-3.5 pb-2 pt-1.5 outline-none",
      )}
      onKeyDown={(event) => {
        if (!hasRail || hitsControl(event.target, event.currentTarget)) return;
        // SPEC-012 R1：Enter = 打开团队面板，Space = 折叠成员（原「Enter/Space 都折叠」被覆盖）。
        if (event.key === "Enter") {
          event.preventDefault();
          open();
        } else if (event.key === " ") {
          event.preventDefault();
          setExpanded((value) => !value);
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2 text-ui-base">
        {/* 表头整行即入口（SPEC-012 R1）：点击打开团队面板；折叠交给右侧独立箭头。 */}
        {onOpen ? (
          <button
            aria-label={label}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            data-testid="team-card-header-open"
            title={label}
            type="button"
            onClick={() => open()}
          >
            <UsersIcon className="size-4 shrink-0 text-foreground-subtle" />
            <span
              className={cn(
                "shrink-0 font-medium",
                team.status === "active" ? "animated-gradient-text" : "text-foreground",
              )}
            >
              {intl.formatMessage({ id: "teamPanel.timeline.card" })}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground-subtle" title={team.goal}>
              {team.goal}
            </span>
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <UsersIcon className="size-4 shrink-0 text-foreground-subtle" />
            <span className="shrink-0 font-medium text-foreground">
              {intl.formatMessage({ id: "teamPanel.timeline.card" })}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground-subtle" title={team.goal}>
              {team.goal}
            </span>
          </span>
        )}
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="hidden min-w-0 truncate text-ui-sm tabular-nums text-foreground-subtlest @sm/conversation:inline"
            title={detail}
          >
            {detail}
          </span>
          {onOpen ? (
            <Button
              aria-label={label}
              title={label}
              data-testid="team-card-open"
              size="icon-md"
              variant="ghost"
              onClick={() => open()}
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          ) : null}
          {hasRail ? (
            <Button
              aria-label={collapseLabel}
              aria-expanded={expanded}
              data-testid="team-card-collapse"
              size="icon-md"
              title={collapseLabel}
              variant="ghost"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
            </Button>
          ) : null}
        </span>
      </div>
      {hasRail ? (
        <div
          className="wf-digest-plot overflow-hidden"
          style={{ height: timelineHeight(shown) + 8 }}
        >
          <WorkflowTimeline
            className="py-1"
            model={shown}
            pillOpenLabel={(_pill, name) =>
              intl.formatMessage({ id: "teamPanel.timeline.memberTasks" }, { name })
            }
            pillDetail={pillDetail}
            moreOpenLabel={() => intl.formatMessage({ id: "teamPanel.timeline.openStage" })}
            {...(onOpen || onOpenMemberSession
              ? {
                  onSelectStation: (station) => open({ focusPhaseId: station.id }),
                  onOpenMore: (station) => open({ focusPhaseId: station.id }),
                  onOpenPill: (pill) => openPill(pill.lane.id, pill.stepIds),
                }
              : {})}
          />
        </div>
      ) : null}
      {expanded ? (
        <>
          <TeamInlineTaskList
            groups={inlineGroups}
            totalCount={team.tasks.length}
            onOpenTask={
              onOpen
                ? (taskId) => open({ focusPhaseId: phaseIdOfTask.get(taskId), focusTaskId: taskId })
                : undefined
            }
            onOpenAll={onOpen ? () => open() : undefined}
          />
          {team.status === "draft" ? (
            <TeamApprovalActions team={team} onOpenPlan={onOpen ? () => open() : undefined} />
          ) : null}
          {isTeamEnded(team) ? (
            <TeamLingeringMembers
              members={team.members}
              title={team.goal}
              {...(resolveMemberStop ? { resolveStop: resolveMemberStop } : {})}
            />
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 text-ui-sm text-foreground-subtle">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", teamStatusDotClass(team))}
        />
        <span>{status}</span>
        <span className="min-w-0 text-foreground-subtlest @sm/conversation:hidden">· {detail}</span>
        {team.stale ? (
          <span title={intl.formatMessage({ id: "chat.statusPanel.agentTeams.staleHint" })}>
            · {intl.formatMessage({ id: "chat.statusPanel.agentTeams.stale" })}
          </span>
        ) : null}
        {team.counts.failed + team.counts.blocked > 0 ? (
          <span className="text-destructive">
            ·{" "}
            {intl.formatMessage(
              { id: "teamPanel.timeline.failures" },
              { count: team.counts.failed + team.counts.blocked },
            )}
          </span>
        ) : null}
      </div>
    </section>
  );
}
