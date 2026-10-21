import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { WorkflowAgentPill } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowMoreRow } from "@/components/workflow-timeline/WorkflowMoreRow.js";
import { WorkflowRoll } from "@/components/workflow-timeline/WorkflowRoll.js";
import { RosterMeter } from "@/components/workflow-timeline/WorkflowRosterParts.js";
import {
  rosterMore,
  rosterRestCounts,
  rosterRoll,
  stationRosterOf,
  ROSTER_PINS_PANE,
} from "@/components/workflow-timeline/roster-model.js";
import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { AvatarCluster, SpineLamp, SpinePieces } from "./WorkflowRunSpineParts.js";
import { spineSections } from "./workflowRunSpine.js";
import { TaskRow, BlockedQualityCard } from "./teamPaneParts.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";
import {
  buildTeamWorkflowPresentation,
  localizeTeamTimeline,
} from "@/v4/teamWorkflowPresentation.js";
import type { TeamPanelLanding } from "@/lib/workspaceSidePane.js";

export function TeamWorkflowPhaseList({
  team,
  landing,
}: {
  team: ConversationStatusPanelTeam;
  landing?: TeamPanelLanding & { key: string };
}) {
  const { intl } = useACodeIntl();
  const presentation = useMemo(() => buildTeamWorkflowPresentation(team), [team]);
  const model = localizeTeamTimeline(presentation, intl.formatMessage.bind(intl));
  const runningKey = model.stations
    .filter((station) => station.status === "running")
    .map((station) => station.id)
    .join("\u0000");
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(runningKey ? runningKey.split("\u0000") : []),
  );
  const [listed, setListed] = useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = useState<ReadonlySet<string>>(() => new Set());
  const previousRunning = useRef(new Set(runningKey ? runningKey.split("\u0000") : []));
  const rootRef = useRef<HTMLDivElement>(null);
  const landedRef = useRef<string | undefined>(undefined);
  const [landed, setLanded] = useState<string | undefined>(undefined);
  useEffect(() => {
    const next = new Set(runningKey ? runningKey.split("\u0000") : []);
    const entered = [...next].filter((id) => !previousRunning.current.has(id));
    previousRunning.current = next;
    if (entered.length > 0) setOpen((current) => new Set([...current, ...entered]));
  }, [runningKey]);
  useEffect(() => {
    if (!landing || landedRef.current === landing.key) return;
    const station = model.stations.find(
      (item) =>
        item.id === landing.focusPhaseId ||
        (landing.focusTaskId &&
          item.pills.some((pill) => pill.stepIds.includes(landing.focusTaskId!))),
    );
    if (!station) return;
    landedRef.current = landing.key;
    setOpen((current) => new Set([...current, station.id]));
    setListed((current) => new Set([...current, station.id]));
    if (landing.focusTaskId) {
      const pill = station.pills.find((item) => item.stepIds.includes(landing.focusTaskId!));
      if (pill) setDetails((current) => new Set([...current, pill.key]));
    }
    setLanded(station.id);
  }, [landing, model]);
  useEffect(() => {
    if (!landed) return;
    const head = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>("[data-team-phase-head]") ?? [],
    ).find((element) => element.dataset.teamPhaseHead === landed);
    head?.scrollIntoView?.({ block: "start", behavior: "auto" });
  }, [landed, landing?.key]);
  const toggle = (setter: typeof setOpen, id: string) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const blocked = new Map(
    team.blockedByFailedQuality.map((entry) => [entry.taskId, entry.blockedBy]),
  );
  const sections = spineSections(model);
  const renderPill = (pill: TimelinePill, compact = false) => {
    const name = pill.runtimeName ?? "";
    return (
      <div className="flex min-w-0 flex-col" key={pill.key} data-team-participant={pill.key}>
        <WorkflowAgentPill
          avatarIndex={pill.avatarIndex}
          laneClass={pill.laneClass}
          name={name}
          status={pill.status}
          size={compact ? "row" : "md"}
          open={{
            label: intl.formatMessage({ id: "teamPanel.timeline.memberTasks" }, { name }),
            onOpen: () => toggle(setDetails, pill.key),
            data: { "data-team-task-open": pill.key },
          }}
        >
          <span className="shrink-0 text-ui-xs tabular-nums text-foreground-subtlest">
            {intl.formatMessage(
              { id: "chat.toolCall.workflow.graph.card.tasks" },
              { count: pill.stepIds.length },
            )}
          </span>
        </WorkflowAgentPill>
        {details.has(pill.key) ? (
          <div
            className="ml-6 flex min-w-0 flex-col gap-1 border-l border-border py-1 pl-1"
            data-testid="team-participant-tasks"
          >
            {team.tasks
              .filter((task) => pill.stepIds.includes(task.taskId))
              .map((task) => (
                <div key={task.taskId} className="min-w-0">
                  <div className="min-w-0 overflow-x-auto">
                    <TaskRow
                      task={task}
                      team={team}
                      blockedByQuality={blocked.get(task.taskId) ?? []}
                    />
                  </div>
                  <p className="break-words px-2 text-ui-sm text-foreground-subtle">{task.title}</p>
                </div>
              ))}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div
      className="wf-motion flex min-w-0 flex-col pb-3 pt-2.5"
      data-testid="team-workflow-phases"
      ref={rootRef}
    >
      {model.stations.length === 0 ? (
        <p className="px-3 text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "teamPanel.group.empty" })}
        </p>
      ) : null}
      {model.stations.map((station, index) => {
        const expanded = open.has(station.id);
        const roster = stationRosterOf(station, ROSTER_PINS_PANE);
        const name = station.naming.name ?? station.id;
        return (
          <section
            className="relative"
            key={station.id}
            data-team-phase={station.id}
            data-phase-open={String(expanded)}
          >
            <SpinePieces section={sections[index]!} />
            <button
              type="button"
              className="wf-station-open relative flex h-9 w-full min-w-0 items-center gap-2 pl-[39px] pr-3 text-left outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-expanded={expanded}
              data-team-phase-head={station.id}
              onClick={() => toggle(setOpen, station.id)}
              title={name}
            >
              <SpineLamp status={station.status ?? "pending"} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-ui-base",
                  station.status === "pending"
                    ? "text-foreground-subtle"
                    : "font-medium text-foreground",
                )}
              >
                {name}
              </span>
              {!expanded ? (
                roster ? (
                  <RosterMeter counts={roster.counts} mini />
                ) : (
                  <AvatarCluster pills={station.pills} nameOf={(pill) => pill.runtimeName ?? ""} />
                )
              ) : null}
              <span className="shrink-0 text-ui-xs tabular-nums text-foreground-subtlest">
                {station.fraction?.settled}/{station.fraction?.observed}
              </span>
              <ChevronRightIcon
                className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
              />
            </button>
            {expanded ? (
              <div className="wf-unfold flex min-w-0 flex-col gap-1.5 pb-3 pl-[39px] pr-3 pt-0.5">
                {(roster?.pinned ?? station.pills).map((pill) => renderPill(pill))}
                {roster ? (
                  <>
                    <WorkflowMoreRow
                      more={rosterMore(roster)}
                      door={{ open: listed.has(station.id), tally: rosterRestCounts(roster) }}
                      onOpen={() => toggle(setListed, station.id)}
                    />
                    {listed.has(station.id) ? (
                      <WorkflowRoll
                        groups={rosterRoll(roster)}
                        unlisted={0}
                        renderRow={(pill) => renderPill(pill, true)}
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
      <div className="px-3 pt-2">
        <BlockedQualityCard team={team} />
      </div>
    </div>
  );
}
