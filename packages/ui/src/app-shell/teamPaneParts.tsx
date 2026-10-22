import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ConversationStatusPanelTeam,
  ConversationStatusPanelTeamTask,
} from "@/v4/teamPanelModel.js";

/**
 * 团队面板与团队卡共用的展示碎片：状态点色表、身份色、拓扑判定、任务分组，以及
 * 两个叶组件（任务行、分组头）。
 *
 * 拆出来是因为团队面板的四个页签都要用它们——留在面板主文件里会让那个文件越过
 * 400 行约束，而按页签拆又会把这几样复制四遍。
 */

/**
 * 状态色语义（SPEC-012 §3.5）：灰色 = 无需你动作、彩色 = 有你的事。
 * 修正前 draft（最需要用户动作）用最淡的灰点、archived（只表示归档）却用 success 绿，
 * 两个关键语义各错一次。
 */
export const TEAM_STATUS_DOT: Record<string, string> = {
  // 等你批准：品牌色空心环。
  draft: "border-[1.5px] border-[var(--color-primary)] bg-transparent",
  // 在跑：橙实心。
  active: "bg-[var(--color-warning)]",
  paused: "border-[1.5px] border-[var(--color-foreground-subtle)] bg-transparent",
  // 归档 ≠ 成功（SPEC-003 明写「archived 只表示归档，不表示所有任务通过」）。
  archived: "bg-[var(--color-foreground-subtle)]",
};

/**
 * 团队状态点取色：绿色**只**留给「全部任务 done / cancelled」这一条真含义
 * （SPEC-012 §3.5）；归档或全终态但含失败、取消之外的动作一律走 TEAM_STATUS_DOT。
 */
export function teamStatusDotClass(team: {
  status: string;
  tasks: ReadonlyArray<{ status: string }>;
}): string {
  const allSettled =
    team.tasks.length > 0 &&
    team.tasks.every((task) => task.status === "done" || task.status === "cancelled");
  if (allSettled && team.status !== "draft") return "bg-[var(--color-success)]";
  return TEAM_STATUS_DOT[team.status] ?? TEAM_STATUS_DOT["paused"]!;
}

export const TEAM_TASK_STATUS_DOT: Record<string, string> = {
  todo: "border-[1.5px] border-[var(--color-foreground-subtlest)] bg-transparent",
  in_progress: "bg-[var(--color-warning)]",
  done: "bg-[var(--color-success)]",
  failed: "bg-[var(--color-destructive)]",
  blocked: "bg-[var(--color-destructive)]",
  cancelled: "border-[1.5px] border-[var(--color-foreground-subtlest)] bg-transparent opacity-55",
};

/** 子智能体身份色板（与 SubagentColorDot / 工作流代理药丸同一套身份语言）。 */
const MEMBER_COLORS = [
  "#38bdf8",
  "#a78bfa",
  "#34d399",
  "#fb923c",
  "#22d3ee",
  "#fbbf24",
  "#fb7185",
  "#f472b6",
];

/** 按名册顺序取色：同一成员在任务行、图节点、成员行、邮箱里必须是同一个色点。 */
export function memberColor(name: string, members: readonly { name: string }[]): string {
  const index = members.findIndex((member) => member.name === name);
  return MEMBER_COLORS[(index < 0 ? 0 : index) % MEMBER_COLORS.length]!;
}

/**
 * 拓扑判定：只看依赖结构，不看成员数——拓扑讲的是「谁决定下一步」，而依赖结构正是
 * 快照里唯一能表达这件事的东西。
 *
 * 这里不做 autogen 那样的拓扑**选择**（那要动插件调度），只是把已有结构读出来给用户看：
 * 无依赖多任务 = 并行；有任务依赖 ≥2 个上游 = 扇出/汇入（有向图）；否则是单链。
 */
export function describeTopology(
  team: ConversationStatusPanelTeam,
): { id: string; values: Record<string, string> } | null {
  if (team.tasks.length === 0) return null;
  if (team.tasks.length === 1) return { id: "teamPanel.topology.single", values: {} };
  const byId = new Set(team.tasks.map((task) => task.taskId));
  const roots = team.tasks.filter(
    (task) => !task.dependencies.some((dependency) => byId.has(dependency)),
  );
  const maxFanIn = team.tasks.reduce((max, task) => Math.max(max, task.dependencies.length), 0);
  const anyDependency = team.tasks.some((task) => task.dependencies.length > 0);
  if (!anyDependency) {
    return { id: "teamPanel.topology.parallel", values: { roots: String(roots.length) } };
  }
  if (maxFanIn >= 2) {
    return {
      id: "teamPanel.topology.digraph",
      values: { fanOut: String(roots.length), fanIn: String(maxFanIn) },
    };
  }
  return { id: "teamPanel.topology.chain", values: { depth: String(team.criticalPathDepth) } };
}

/** 任务分组：按「能不能开工」分，而不是按 status 字段分——后者分不出「就绪」与「等依赖」。 */
export interface TaskGroups {
  inProgress: ConversationStatusPanelTeamTask[];
  ready: ConversationStatusPanelTeamTask[];
  waiting: ConversationStatusPanelTeamTask[];
  blocked: ConversationStatusPanelTeamTask[];
  done: ConversationStatusPanelTeamTask[];
}

export function groupTasks(team: ConversationStatusPanelTeam): TaskGroups {
  const ready = new Set(team.readyTaskIds);
  const blocked = new Set(team.blockedByFailedQuality.map((entry) => entry.taskId));
  const groups: TaskGroups = { inProgress: [], ready: [], waiting: [], blocked: [], done: [] };
  for (const task of team.tasks) {
    if (task.status === "in_progress") groups.inProgress.push(task);
    else if (task.status === "done") groups.done.push(task);
    else if (task.status === "failed" || task.status === "blocked" || task.status === "cancelled")
      groups.blocked.push(task);
    else if (blocked.has(task.taskId)) groups.blocked.push(task);
    else if (team.hasTaskDerivations && ready.has(task.taskId)) groups.ready.push(task);
    else groups.waiting.push(task);
  }
  return groups;
}

/**
 * 任务行。**不是按钮**——行上没有可执行的动作（跳转详情页要等 M3 评估），给一个点了
 * 没反应的按钮比给一个静态行更糟：用户会以为坏了。只读立场与 spec §4.1 一致。
 */
export function TaskRow({
  task,
  team,
  blockedByQuality,
}: {
  task: ConversationStatusPanelTeamTask;
  team: ConversationStatusPanelTeam;
  blockedByQuality: readonly string[];
}) {
  const { intl } = useACodeIntl();
  const color = task.assignee ? memberColor(task.assignee, team.members) : null;
  return (
    <div
      className={cn(
        "flex min-h-7 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-ui-base transition-colors hover:bg-[var(--color-hover)]",
        blockedByQuality.length > 0 && "bg-[var(--color-destructive)]/10",
      )}
      data-task-id={task.taskId}
      data-task-status={task.status}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", TEAM_TASK_STATUS_DOT[task.status])}
      />
      <span className="shrink-0 font-mono text-ui-xs text-[var(--color-foreground-subtle)]">
        {task.taskId}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--color-foreground)]">{task.title}</span>
      <span className="shrink-0 rounded-sm bg-[var(--color-surface)] px-1 text-ui-xs text-[var(--color-foreground-subtle)]">
        {task.kind}
      </span>
      {blockedByQuality.length > 0 ? (
        <span className="shrink-0 font-mono text-ui-xs text-[var(--color-destructive)]">
          ← {blockedByQuality.join(" ")}{" "}
          {intl.formatMessage({ id: "teamPanel.blocked.gateSuffix" })}
        </span>
      ) : task.dependencies.length > 0 ? (
        <span className="shrink-0 font-mono text-ui-xs text-[var(--color-foreground-subtlest)]">
          ← {task.dependencies.join(" ")}
        </span>
      ) : null}
      {task.assignee ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-ui-xs text-[var(--color-foreground-subtle)]">
          {color ? (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ backgroundColor: color }}
            />
          ) : null}
          {task.assignee}
        </span>
      ) : null}
    </div>
  );
}

export function GroupHeader({
  label,
  count,
  tone,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  tone: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 text-left text-ui-base text-[var(--color-foreground-subtle)] transition-colors hover:bg-surface-hover"
    >
      <span
        aria-hidden="true"
        className={cn(
          "text-ui-xs text-[var(--color-foreground-subtlest)] transition-transform",
          open && "rotate-90",
        )}
      >
        ›
      </span>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", tone)} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-ui-sm text-[var(--color-foreground-subtlest)]">
        {count}
      </span>
    </button>
  );
}

/** 失败质量门的阻断说明卡：从「看到红色」到「知道怎么办」。 */
export function BlockedQualityCard({ team }: { team: ConversationStatusPanelTeam }) {
  const { intl } = useACodeIntl();
  if (team.blockedByFailedQuality.length === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/10 p-3">
      <p className="text-ui-base font-semibold text-[var(--color-destructive)]">
        {intl.formatMessage(
          { id: "teamPanel.blocked.title" },
          { taskId: team.blockedByFailedQuality.map((entry) => entry.taskId).join("、") },
        )}
      </p>
      <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">
        {intl.formatMessage(
          { id: "teamPanel.blocked.body" },
          { deps: team.blockedByFailedQuality.flatMap((entry) => entry.blockedBy).join(" ") },
        )}
      </p>
      <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "teamPanel.blocked.fixHint" })}
      </p>
    </div>
  );
}
