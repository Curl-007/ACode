import { memo, useMemo } from "react";
import type {
  ConversationStatusPanelTeam,
  ConversationStatusPanelTeamTask,
} from "@/v4/teamPanelModel.js";

/**
 * AgentTeams 任务依赖图（纯 SVG，无图库依赖）。
 *
 * 状态面板的团队卡与 Side Pane 的团队面板共用这一份实现：同一份依赖数据在两处必须
 * 给出同一个结构判断，各画一遍迟早出现「卡片说有依赖、面板说没有」。两处只有尺寸
 * 与信息量不同，所以差异走 `variant`，不走两套代码。
 *
 * 布局是分层（layered）而非力导向：依赖图必须**稳定**——同一份快照每次渲染的节点
 * 位置必须一致，否则面板每收一次状态通知就重排一次，用户跟不上。力导向做不到这点。
 */

/** 任务状态 → 图上的色。与 TEAM_TASK_STATUS_DOT 同一套语义，此处是 SVG 可直接用的值。 */
const STATUS_COLOR: Record<string, string> = {
  todo: "var(--color-foreground-subtlest)",
  in_progress: "var(--color-warning)",
  done: "var(--color-success)",
  failed: "var(--color-destructive)",
  blocked: "var(--color-destructive)",
  cancelled: "var(--color-foreground-subtlest)",
};

const EDGE_COLOR = {
  satisfied: "var(--color-success)",
  running: "var(--color-warning)",
  blocked: "var(--color-destructive)",
  pending: "var(--color-foreground-subtlest)",
} as const;

type EdgeTone = keyof typeof EDGE_COLOR;

export interface TeamTaskGraphEdge {
  from: string;
  to: string;
  tone: EdgeTone;
}

export interface TeamTaskGraphLayout {
  /** 节点按 [列, 行] 定位；taskId 是 React key 与边端点。 */
  placed: Array<{ task: ConversationStatusPanelTeamTask; column: number; row: number }>;
  edges: TeamTaskGraphEdge[];
  columnCount: number;
  rowCount: number;
}

/**
 * 分层：列的序号 = 该任务到根（无依赖任务）的最长路径长度。取最长而非最短，是因为
 * 「最长路径决定最早可开始时间」——用最短路径会把 t-5 画到 t-1 同一列，看起来可以
 * 同时开工，与就绪集矛盾。
 *
 * `seen` 是环保险：插件的 assertNoCycle 不允许成环，但快照可能来自被手工改过的
 * 磁盘状态。成环时按已访问返回 0，画出一张不完美但不会栈溢出的图。
 */
function computeColumn(
  task: ConversationStatusPanelTeamTask,
  byId: ReadonlyMap<string, ConversationStatusPanelTeamTask>,
  seen: Set<string>,
  cache: Map<string, number>,
): number {
  if (seen.has(task.taskId)) return 0;
  const cached = cache.get(task.taskId);
  if (cached !== undefined) return cached;
  seen.add(task.taskId);
  let column = 0;
  for (const dependencyId of task.dependencies) {
    const dependency = byId.get(dependencyId);
    if (!dependency) continue;
    column = Math.max(column, computeColumn(dependency, byId, seen, cache) + 1);
  }
  seen.delete(task.taskId);
  cache.set(task.taskId, column);
  return column;
}

export function layoutTeamTaskGraph(team: ConversationStatusPanelTeam): TeamTaskGraphLayout {
  const byId = new Map(team.tasks.map((task) => [task.taskId, task]));
  const blockedTasks = new Set(team.blockedByFailedQuality.map((entry) => entry.taskId));
  const columns = new Map<number, ConversationStatusPanelTeamTask[]>();
  const columnCache = new Map<string, number>();
  for (const task of team.tasks) {
    const column = computeColumn(task, byId, new Set(), columnCache);
    const bucket = columns.get(column);
    if (bucket) bucket.push(task);
    else columns.set(column, [task]);
  }
  const placed: TeamTaskGraphLayout["placed"] = [];
  for (const [column, tasks] of [...columns.entries()].sort(([a], [b]) => a - b)) {
    tasks.forEach((task, row) => placed.push({ task, column, row }));
  }
  const edges: TeamTaskGraphEdge[] = [];
  for (const task of team.tasks) {
    for (const dependencyId of task.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue;
      // 边色讲的是「这条依赖放行了吗」：上游失败且属质量门 → 红；上游在跑 → 橙；
      // 上游已完成 → 绿；其余（还没开始）→ 灰。下游自己被质量门卡住也标红。
      const tone: EdgeTone = blockedTasks.has(task.taskId)
        ? "blocked"
        : dependency.status === "done"
          ? "satisfied"
          : dependency.status === "in_progress"
            ? "running"
            : "pending";
      edges.push({ from: dependencyId, to: task.taskId, tone });
    }
  }
  const rowCount = Math.max(0, ...[...columns.values()].map((tasks) => tasks.length));
  return { placed, edges, columnCount: columns.size, rowCount };
}

// 豁免 text-ui-* 标尺：依赖图节点的字号随 SVG 绘图坐标系缩放（COMPACT 9px / FULL 11px），
// 属图表节点/轴家具而非业务 UI 文案，与 text-ui-2xs 的 graph-axis 例外同源。见 DESIGN.md
// 「UI font tokens」。节点几何（宽/高/间距）同理是绘图坐标，不进 4px 间距标尺。
const COMPACT = { nodeWidth: 56, nodeHeight: 20, gapX: 34, gapY: 8, fontSize: 9, pad: 6 };
const FULL = { nodeWidth: 176, nodeHeight: 36, gapX: 56, gapY: 12, fontSize: 11, pad: 8 };

export const TeamTaskGraph = memo(function TeamTaskGraph({
  team,
  variant = "compact",
  className,
}: {
  team: ConversationStatusPanelTeam;
  variant?: "compact" | "full";
  className?: string;
}) {
  const metrics = variant === "full" ? FULL : COMPACT;
  const layout = useMemo(() => layoutTeamTaskGraph(team), [team]);
  const width =
    metrics.pad * 2 +
    layout.columnCount * metrics.nodeWidth +
    Math.max(0, layout.columnCount - 1) * metrics.gapX;
  const height =
    metrics.pad * 2 +
    layout.rowCount * metrics.nodeHeight +
    Math.max(0, layout.rowCount - 1) * metrics.gapY;
  if (layout.placed.length === 0) return null;
  const positions = new Map(
    layout.placed.map(({ task, column, row }) => [
      task.taskId,
      {
        x: metrics.pad + column * (metrics.nodeWidth + metrics.gapX),
        y: metrics.pad + row * (metrics.nodeHeight + metrics.gapY),
      },
    ]),
  );
  const ready = new Set(team.readyTaskIds);
  return (
    <svg
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{ width: variant === "full" ? width : "100%", height: "auto" }}
    >
      {layout.edges.map((edge) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return null;
        const startX = from.x + metrics.nodeWidth;
        const startY = from.y + metrics.nodeHeight / 2;
        const endX = to.x;
        const endY = to.y + metrics.nodeHeight / 2;
        const midX = (startX + endX) / 2;
        return (
          <path
            key={`${edge.from}->${edge.to}`}
            d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
            fill="none"
            stroke={EDGE_COLOR[edge.tone]}
            strokeWidth={edge.tone === "pending" ? 1.2 : 1.6}
            {...(edge.tone === "blocked" ? { strokeDasharray: "4 3" } : {})}
          />
        );
      })}
      {layout.placed.map(({ task }) => {
        const position = positions.get(task.taskId);
        if (!position) return null;
        const color = STATUS_COLOR[task.status] ?? STATUS_COLOR.todo!;
        const isReady = ready.has(task.taskId);
        return (
          <g key={task.taskId}>
            <rect
              x={position.x}
              y={position.y}
              width={metrics.nodeWidth}
              height={metrics.nodeHeight}
              rx={variant === "full" ? 7 : 5}
              fill="var(--color-panel)"
              stroke={isReady ? "var(--color-success)" : "var(--color-border)"}
              strokeWidth={isReady ? 1.4 : 1}
            />
            <circle
              cx={position.x + (variant === "full" ? 12 : 9)}
              cy={position.y + metrics.nodeHeight / 2}
              r={variant === "full" ? 3.5 : 3}
              {...(task.status === "todo" || task.status === "cancelled"
                ? { fill: "none", stroke: color, strokeWidth: 1.4 }
                : { fill: color })}
            />
            <text
              x={position.x + (variant === "full" ? 22 : 17)}
              y={position.y + (variant === "full" ? 15 : 13.5)}
              fontSize={metrics.fontSize}
              fontFamily="ui-monospace, monospace"
              fill="var(--color-foreground-subtle)"
            >
              {task.taskId}
            </text>
            {variant === "full" ? (
              <text
                x={position.x + 22}
                y={position.y + 28}
                fontSize={metrics.fontSize}
                fill="var(--color-foreground)"
              >
                {task.title.length > 20 ? `${task.title.slice(0, 19)}…` : task.title}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
});
