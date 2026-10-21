import { layoutTeamTaskGraph } from "@/components/TeamTaskGraph.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type {
  TimelineInk,
  TimelinePill,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import { assignArcLanes } from "@/components/workflow-timeline/timeline-bands.js";
import type { LaneNameFormatter } from "@/components/workflow-graph/lane-name.js";
import { isTeamEnded } from "./teamPanelModel.js";
import type {
  ConversationStatusPanelTeam,
  ConversationStatusPanelTeamTask,
} from "./teamPanelModel.js";

// 判据住在 teamPanelModel（模型层），这里转出旧入口，避免 presentation 反向依赖被打破。
export { isTeamEnded } from "./teamPanelModel.js";

export interface TeamWorkflowPhase {
  id: string;
  depth: number;
  tasks: ConversationStatusPanelTeamTask[];
}
export interface TeamWorkflowPresentation {
  phases: TeamWorkflowPhase[];
  model: WorkflowTimelineModel;
  /**
   * 成员信息查找表（键 = 药丸 lane.id `member:<name>`）：药丸第二行与「查看会话」
   * 需要 role / childSessionId / 当前任务标题，而时间线模型只带显示名。
   */
  members: Map<string, TeamWorkflowMember>;
}
export interface TeamWorkflowMember {
  name: string;
  role: string;
  childSessionId?: string;
  currentTaskTitle?: string;
}

export function teamTaskStatus(status: string): StepRunStatus {
  if (status === "in_progress") return "running";
  if (status === "done") return "done";
  if (status === "failed" || status === "blocked" || status === "cancelled") return "failed";
  return "pending";
}
function aggregateStatus(statuses: StepRunStatus[]): StepRunStatus {
  if (statuses.includes("running")) return "running";
  if (statuses.includes("failed")) return "failed";
  return statuses.length > 0 && statuses.every((status) => status === "done") ? "done" : "pending";
}
export function teamPhaseName(phase: TeamWorkflowPhase, format: LaneNameFormatter): string {
  if (phase.tasks.length === 1) return phase.tasks[0]!.title;
  return format(
    { id: "teamPanel.timeline.phase" },
    { index: phase.depth + 1, count: phase.tasks.length },
  );
}
export function teamPillName(pill: TimelinePill, format: LaneNameFormatter): string {
  return pill.runtimeName ?? format({ id: "teamPanel.timeline.unassigned" });
}

export function buildTeamWorkflowPresentation(
  team: ConversationStatusPanelTeam,
): TeamWorkflowPresentation {
  const layers = new Map<number, ConversationStatusPanelTeamTask[]>();
  for (const { task, column } of layoutTeamTaskGraph(team).placed) {
    const tasks = layers.get(column) ?? [];
    tasks.push(task);
    layers.set(column, tasks);
  }
  const phases = [...layers]
    .sort(([a], [b]) => a - b)
    .map(([depth, tasks]) => ({ id: `depth-${depth}`, depth, tasks }));
  const memberIndexes = new Map(team.members.map((member, index) => [member.name, index]));
  const blocked = new Set(team.blockedByFailedQuality.map((entry) => entry.taskId));
  const statusOf = (task: ConversationStatusPanelTeamTask) =>
    blocked.has(task.taskId) && task.status === "todo"
      ? ("failed" as const)
      : teamTaskStatus(task.status);
  const stations = phases.map((phase) => {
    const buckets = new Map<string, ConversationStatusPanelTeamTask[]>();
    for (const task of phase.tasks) {
      const owner =
        task.assignee ?? team.members.find((member) => member.currentTaskId === task.taskId)?.name;
      const key = owner ? `member:${owner}` : `task:${task.taskId}`;
      const tasks = buckets.get(key) ?? [];
      tasks.push(task);
      buckets.set(key, tasks);
    }
    const pills: TimelinePill[] = [...buckets].map(([key, tasks]) => {
      const owner = key.startsWith("member:") ? key.slice(7) : undefined;
      const member = team.members.find((candidate) => candidate.name === owner);
      // 人名优先（SPEC-012 R2）：role 不进显示名——168px 站宽里 `role · name` 会把人名
      // 100% 截断。role 改走药丸 tooltip，第二行放当前任务标题。
      const name = member?.name ?? owner;
      const laneClass =
        owner === "captain"
          ? ("workspace" as const)
          : owner
            ? ("agent" as const)
            : ("unresolved" as const);
      return {
        key: `${phase.id}:${key}`,
        lane: { id: key, laneClass, ...(name ? { name } : {}) },
        laneClass,
        ...(name ? { runtimeName: name } : {}),
        ...(owner && memberIndexes.has(owner) ? { avatarIndex: memberIndexes.get(owner)! } : {}),
        status: aggregateStatus(tasks.map(statusOf)),
        stepIds: tasks.map((task) => task.taskId),
        // slot 只是复用时间线的点击抓手，不是 workflow actor，也不用于派工。
        slot: { siteId: tasks[0]!.taskId, ordinal: 1 },
      };
    });
    const statuses = phase.tasks.map(statusOf);
    return {
      id: phase.id,
      naming: { id: phase.id },
      pills,
      status: aggregateStatus(statuses),
      visited: statuses.some((status) => status !== "pending"),
      rounds: 0,
      onLoop: false,
      track: 0,
      fraction: {
        settled: phase.tasks.filter((task) => task.status === "done").length,
        observed: phase.tasks.length,
      },
    };
  });
  const phaseByTask = new Map(
    phases.flatMap((phase, index) => phase.tasks.map((task) => [task.taskId, index] as const)),
  );
  const edges = new Map<string, { from: number; to: number }>();
  phases.forEach((phase, to) =>
    phase.tasks.forEach((task) =>
      task.dependencies.forEach((id) => {
        const from = phaseByTask.get(id);
        if (from !== undefined && from !== to) edges.set(`${from}:${to}`, { from, to });
      }),
    ),
  );
  const inkOf = (from: number, to: number): TimelineInk =>
    stations[to]!.status === "running"
      ? "march"
      : stations[from]!.status === "done"
        ? "strong"
        : "faint";
  const pairs = [...edges.values()];
  const runningIndex = stations.findLastIndex((station) => station.status === "running");
  const members = new Map<string, TeamWorkflowMember>(
    team.members
      .filter((member) => member.status !== "removed")
      .map((member) => {
        const key = `member:${member.name}`;
        return [
          key,
          {
            name: member.name,
            role: member.role,
            ...(member.childSessionId ? { childSessionId: member.childSessionId } : {}),
            ...(member.currentTaskId
              ? {
                  currentTaskTitle: team.tasks.find((task) => task.taskId === member.currentTaskId)
                    ?.title,
                }
              : {}),
          },
        ];
      }),
  );
  return {
    phases,
    members,
    model: {
      stations,
      rails: pairs
        .filter(({ from, to }) => to === from + 1)
        .map(({ from, to }) => ({ from, to, ink: inkOf(from, to) })),
      arcs: assignArcLanes(pairs.filter(({ from, to }) => to !== from + 1)).map((arc) => ({
        ...arc,
        air: 0,
        ink: inkOf(arc.from, arc.to),
      })),
      bands: [],
      runningIndex: runningIndex < 0 ? undefined : runningIndex,
      live: true,
    },
  };
}

export function localizeTeamTimeline(
  presentation: TeamWorkflowPresentation,
  format: LaneNameFormatter,
): WorkflowTimelineModel {
  return {
    ...presentation.model,
    stations: presentation.model.stations.map((station, index) => ({
      ...station,
      naming: { ...station.naming, name: teamPhaseName(presentation.phases[index]!, format) },
      pills: station.pills.map((pill) => ({ ...pill, runtimeName: teamPillName(pill, format) })),
    })),
  };
}

/** 内联任务清单的分组键（SPEC-012 R5）。 */
export type TeamInlineTaskGroupKey = "running" | "failed" | "ready" | "todo" | "done";

export interface TeamInlineTaskGroup {
  key: TeamInlineTaskGroupKey;
  tasks: ConversationStatusPanelTeamTask[];
}

/**
 * 卡片内联任务清单分组：进行中 → 失败·阻断 → 就绪 → 待开始 → 已完成。
 * 空组不返回；组序即渲染序。blockedByFailedQuality 命中的 todo 归入失败·阻断
 * （与时间线的 statusOf 同一口径）。
 */
export function groupInlineTasks(team: ConversationStatusPanelTeam): TeamInlineTaskGroup[] {
  const ready = new Set(team.readyTaskIds);
  const blockedQuality = new Set(team.blockedByFailedQuality.map((entry) => entry.taskId));
  const groups: Record<TeamInlineTaskGroupKey, ConversationStatusPanelTeamTask[]> = {
    running: [],
    failed: [],
    ready: [],
    todo: [],
    done: [],
  };
  for (const task of team.tasks) {
    if (task.status === "done" || task.status === "cancelled") groups.done.push(task);
    else if (task.status === "failed" || task.status === "blocked") groups.failed.push(task);
    else if (task.status === "in_progress") groups.running.push(task);
    else if (blockedQuality.has(task.taskId)) groups.failed.push(task);
    else if (ready.has(task.taskId)) groups.ready.push(task);
    else groups.todo.push(task);
  }
  return (["running", "failed", "ready", "todo", "done"] as const)
    .map((key) => ({ key, tasks: groups[key] }))
    .filter((group) => group.tasks.length > 0);
}

/**
 * 批准语（SPEC-012 R9）：用户粘进对话框的那句话。批准动作仍由用户在对话里做出、
 * 队长调 `agent_teams_approve_plan`；UI 不直接调插件工具。
 */
export function teamApprovalText(teamId: string): string {
  return `批准团队 ${teamId} 的计划，按依赖顺序开始执行；遇到阻塞先告诉我。`;
}

export function teamStatusMessageId(status: string): string | undefined {
  const key = {
    draft: "statusDraft",
    active: "statusActive",
    paused: "statusPaused",
    archived: "statusArchived",
  }[status];
  return key ? `chat.statusPanel.agentTeams.${key}` : undefined;
}
