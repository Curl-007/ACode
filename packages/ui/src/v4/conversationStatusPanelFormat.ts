/**
 * ConversationStatusPanel 的纯格式化/决策函数叶子（批次 4 helper 外迁）。
 * 自 ConversationStatusPanel.tsx 逐字迁移：纯函数、无 React、无闭包依赖。
 * 批次 4 仅抽纯格式化/决策函数，实时投影语义（memo/tick/scroll policy）全部留主文件。
 * 唯一非逐字点：formatMessage 形参类型改用宿主模块具名类型 `IntlInstance["formatMessage"]`
 * （与原文 `ReturnType<typeof useACodeIntl>["intl"]["formatMessage"]` 解析为同一类型）。
 * 消费方：ConversationStatusPanel.tsx 主组件（仅换 import 来源，行为逐点等价）。
 */
import type { ACodeSessionRunningSubagent } from "@acode/shared";
import type {
  BackgroundWorkSummary,
  PlanState,
  WorkflowRunState,
} from "@acode/shared/acode-protocol-v4";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type {
  ConversationStatusPanelModel,
  ConversationStatusPanelSessionPlanItem,
} from "@/v4/conversationStatusPanelModel.js";

// memo 组件默认 props 不内联创建数组，避免每次渲染生成新引用触发稳定引用边界测试。
export const EMPTY_BACKGROUND_WORKS: readonly BackgroundWorkSummary[] = [];
export const EMPTY_RUNNING_SUBAGENTS: readonly ACodeSessionRunningSubagent[] = [];
export const EMPTY_WORKFLOW_RUNS: readonly WorkflowRunState[] = [];

export function formatDurationUnits(
  totalSeconds: number,
  formatMessage: IntlInstance["formatMessage"],
) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  const hourUnit = formatMessage({ id: "chat.summaryPanel.duration.hours" });
  const minuteUnit = formatMessage({ id: "chat.summaryPanel.duration.minutes" });
  const secondUnit = formatMessage({ id: "chat.summaryPanel.duration.seconds" });
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}${hourUnit}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}${minuteUnit}`);
  }
  if (restSeconds > 0 || parts.length === 0) {
    parts.push(`${restSeconds}${secondUnit}`);
  }
  return parts.join(" ");
}

export function getBackgroundWorkElapsedMs(work: BackgroundWorkSummary, now: number) {
  return Math.max(0, now - work.startedAt);
}

export function getLongestRunningWorkElapsedMs(works: readonly BackgroundWorkSummary[], now: number) {
  return works.reduce(
    (longestElapsedMs, work) => Math.max(longestElapsedMs, getBackgroundWorkElapsedMs(work, now)),
    0,
  );
}

export function formatRunningCount(
  formatMessage: IntlInstance["formatMessage"],
  count: number,
) {
  return formatMessage(
    {
      id:
        count === 1
          ? "chat.summaryPanel.runningBackgroundTasksMiniValue"
          : "chat.summaryPanel.runningBackgroundTasksMiniValuePlural",
    },
    { count: String(count) },
  );
}

export function formatRunningSubagentCount(
  formatMessage: IntlInstance["formatMessage"],
  count: number,
) {
  return formatMessage(
    {
      // 这里的计数至少包含 running 投影中的 subagent（可能是 mixed 胶囊总数）；
      // subagent 又包含 foreground、background、blocked 和 waiting，复用后台任务文案
      // 会把计数语义错误地缩窄成“后台”。
      id:
        count === 1
          ? "chat.statusPanel.runningAgentsValue"
          : "chat.statusPanel.runningAgentsValuePlural",
    },
    { count: String(count) },
  );
}

export const COMPACT_TODO_THRESHOLD = 6;
export const TODO_FOCUS_WINDOW_SIZE = 3;

export interface StatusPanelTodoFocusWindow {
  compact: boolean;
  precedingItems: PlanState["items"];
  focusItems: PlanState["items"];
  followingItems: PlanState["items"];
}

export function getStatusPanelTodoFocusWindow(items: PlanState["items"]): StatusPanelTodoFocusWindow {
  if (items.length <= COMPACT_TODO_THRESHOLD) {
    return {
      compact: false,
      precedingItems: [],
      focusItems: items,
      followingItems: [],
    };
  }

  const runningIndex = items.findIndex((item) => item.status === "inProgress");
  const firstUnfinishedIndex = items.findIndex((item) => item.status !== "completed");
  const focusIndex =
    runningIndex >= 0
      ? runningIndex
      : firstUnfinishedIndex >= 0
        ? firstUnfinishedIndex
        : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE);
  // 只取“当前 + 后两条”会让靠近列表末尾的当前项只剩一两条上下文。
  // 从前面回补可以让精简窗口在项目数足够时始终保持三条，同时不改变 snapshot 原序。
  const focusStartIndex = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_WINDOW_SIZE));
  const focusEndIndex = Math.min(items.length, focusStartIndex + TODO_FOCUS_WINDOW_SIZE);

  return {
    compact: true,
    precedingItems: items.slice(0, focusStartIndex),
    focusItems: items.slice(focusStartIndex, focusEndIndex),
    followingItems: items.slice(focusEndIndex),
  };
}

export function buildSessionPlanOpenRequest(
  parentSessionId: string,
  item: ConversationStatusPanelSessionPlanItem,
): OpenPlanDetailSideTabRequest {
  return {
    parentSessionId,
    toolCallId: item.toolCallId,
    markdown: item.markdown,
    ...(item.planFilePath ? { planFilePath: item.planFilePath } : {}),
  };
}

export function buildRunningSubagentOpenRequest({
  parentSessionId,
  rootSessionId,
  subagent,
}: {
  parentSessionId?: string;
  rootSessionId?: string;
  subagent: ACodeSessionRunningSubagent;
}): OpenSubagentSideTabRequest | null {
  if (!parentSessionId) return null;
  return {
    rootSessionId: rootSessionId ?? parentSessionId,
    parentSessionId,
    childSessionId: subagent.childSessionId,
    subagentType: subagent.subagentType,
    title: subagent.title,
  };
}

export function getCurrentPlanItem(plan: ConversationStatusPanelModel["plan"]) {
  return (
    plan?.items.find((item) => item.status === "inProgress") ??
    plan?.items.find((item) => item.status === "pending") ??
    null
  );
}

export function getCompletedPlanItem(plan: ConversationStatusPanelModel["plan"]) {
  return [...(plan?.items ?? [])].reverse().find((item) => item.status === "completed") ?? null;
}
