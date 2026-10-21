/**
 * 子代理任务级面板的行构造（apps/acode-cli/specs/usage-statusbar-port.md §2.5）。
 *
 * 任务名与「子智能体目录」同源：运行中取 snapshot.subagents.running[].title，
 * 已结束取目录同一条游标查询的 title。缺名时退回该任务的 subagentType（线路名），
 * 并且**只按 childSessionId 对应**——名字、速度与用量都不允许按数组下标张冠李戴。
 */
import type { TurnMetricsMessageFormat } from "@/chat-input-toolbar/turnMetrics.js";
import { localizeSubagentDisplayName } from "@/lib/builtInSubagentDisplay.js";
import { formatCompact, formatExact } from "./usageBarFormat.js";

export type SubagentTaskStatus =
  | "running"
  | "waiting"
  | "blocked"
  | "success"
  | "failed"
  | "cancelled"
  | "lost";

export interface SubagentTaskInfo {
  childSessionId: string;
  /** 目录同源任务名；缺名（空串/null）时退回 subagentType。 */
  title: string | null;
  /** 线路名（subagentType）：标题缺失时的回退名，也是错配的护栏。 */
  subagentType: string;
  status: SubagentTaskStatus;
  /** 该子会话累计 token；null = 读不到（该行不显示用量，不显示 0）。 */
  tokenTotal: number | null;
  /** 该任务自己的实时输出速率（tok/s）；null = 无实时样本（该行省略速度，不写 0）。 */
  liveRate: number | null;
}

export type SubagentTaskTone = "live" | "success" | "error" | "default";

export interface SubagentTaskRow {
  key: string;
  name: string;
  tone: SubagentTaskTone;
  /** 状态文案（面板行尾的可访问名，视觉上是 6px 状态点）。 */
  statusLabel: string;
  /** 用量文案；null = 该任务读不到用量。 */
  usageLabel: string | null;
  /** 该任务自己的速度文案；null = 无实时样本（整条省略，不显示 0）。 */
  speedLabel: string | null;
}

function resolveSubagentTaskName(
  task: SubagentTaskInfo,
  formatMessage?: TurnMetricsMessageFormat,
): string {
  const title = task.title?.trim() ?? "";
  if (title.length > 0) return title;
  // 缺名退回线路名：宁可显示类型名，也不能拿别的任务标题顶上。
  // 内置类型按 locale 展示；自定义/插件名原样保留。
  const fallback = task.subagentType.trim();
  if (fallback.length === 0) return task.childSessionId;
  return formatMessage ? localizeSubagentDisplayName(fallback, formatMessage) : fallback;
}

function resolveSubagentTaskTone(status: SubagentTaskStatus): SubagentTaskTone {
  switch (status) {
    case "running":
      return "live";
    case "waiting":
    case "blocked":
      return "default";
    case "success":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
    case "lost":
      return "default";
  }
}

const SUBAGENT_STATUS_MESSAGE_ID: Record<SubagentTaskStatus, string> = {
  running: "chat.usageStatusbar.subagentPanel.statusRunning",
  waiting: "chat.usageStatusbar.subagentPanel.statusWaiting",
  blocked: "chat.usageStatusbar.subagentPanel.statusBlocked",
  success: "chat.usageStatusbar.subagentPanel.statusSuccess",
  failed: "chat.usageStatusbar.subagentPanel.statusFailed",
  cancelled: "chat.usageStatusbar.subagentPanel.statusCancelled",
  lost: "chat.usageStatusbar.subagentPanel.statusLost",
};

/**
 * 「已结束」分组在拿不到行时显示哪句提示（拿不到行有三种原因，不能都写成「点一下钉住」）：
 * 查询失败 → 失败提示；钉住后正在查 → 加载中；未钉住 → 引导点按。有行时不显示提示。
 */
export function resolveEndedGroupHintId(state: {
  pinned: boolean;
  loading: boolean;
  failed: boolean;
  rowCount: number;
}): string | null {
  if (state.rowCount > 0) return null;
  if (state.failed) return "chat.usageStatusbar.subagentPanel.failedEnded";
  if (state.loading) return "chat.usageStatusbar.subagentPanel.loadingEnded";
  return state.pinned
    ? "chat.usageStatusbar.subagentPanel.emptyEnded"
    : "chat.usageStatusbar.subagentPanel.endedHint";
}

export function buildSubagentTaskRows(input: {
  tasks: readonly SubagentTaskInfo[];
  locale: string;
  formatMessage: TurnMetricsMessageFormat;
}): SubagentTaskRow[] {
  const { tasks, locale, formatMessage } = input;
  return tasks.map((task) => ({
    key: task.childSessionId,
    name: resolveSubagentTaskName(task, formatMessage),
    tone: resolveSubagentTaskTone(task.status),
    statusLabel: formatMessage({ id: SUBAGENT_STATUS_MESSAGE_ID[task.status] }),
    usageLabel: task.tokenTotal === null ? null : formatCompact(locale, task.tokenTotal),
    // 该任务自己的速度：没有实时样本就整条省略（不写 0，也不借用合计或别的任务的值）。
    speedLabel:
      task.liveRate === null || task.liveRate <= 0
        ? null
        : formatMessage(
            { id: "chat.usageStatusbar.subagentPanel.speed" },
            { value: formatExact(locale, Math.round(task.liveRate)) },
          ),
  }));
}
