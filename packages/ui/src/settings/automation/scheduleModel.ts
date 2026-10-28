/**
 * AutomationEditView 拆出的「排程规则 / 日期解析 / 运行历史分页 / 状态决策」纯函数与常量。
 *
 * 来源：packages/ui/src/settings/AutomationEditView.tsx 顶部 helper 带（批次 1 helper 外迁，
 * split-plan god-component-split-plan.md `settings/AutomationEditView.tsx` 登记表）。**全部纯函数，
 * 无 React 依赖**。函数体逐字迁移，不修改任何决策语义。
 *
 * 选择器族（TimeOfDayPicker / MonthDayPicker / WeekdayPicker / EndDatePicker / CustomRepeatDialog /
 * TimeUnitColumn / ScrollNumberColumn）仍留在主文件，属批次 2。
 */
import type {
  ACodeAutomationRun,
  ACodeAutomationScheduleRule,
} from "@acode/shared";
import type { AutomationStatusKind, CronFrequency } from "@/settings/automationFormat.js";

export const FREQUENCIES: CronFrequency[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "custom",
];
export const isCronFrequency = (value: string): value is CronFrequency =>
  FREQUENCIES.includes(value as CronFrequency);
/** 运行历史每页条数。 */
export const RUNS_PAGE_SIZE = 8;
/** 自定义重复频率输入允许输入的视觉范围。 */
export const CUSTOM_REPEAT_INTERVAL_INPUT_MIN = 0;
/** cron 的步长必须为正整数，0 不能形成有效调度。 */
export const CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN = 1;
export const CUSTOM_REPEAT_INTERVAL_MAX = 200;

/**
 * 生成分页控件的页码序列：首尾各保留 3 页、当前页左右各 1 页，其余用省略号折叠。
 * 例：current=1,total=10 → [1,2,3,"ellipsis",8,9,10]。
 */
export function buildRunsPageItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>([
    1,
    2,
    3,
    total - 2,
    total - 1,
    total,
    current - 1,
    current,
    current + 1,
  ]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
    previous = page;
  }
  return items;
}

export function workspaceLabelFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 某月天数（用闰年 2024 作参照，使 2 月可选到 29）；month 为 1-12。 */
export function daysInMonth(month: number): number {
  return new Date(2024, month, 0).getDate();
}

export function toDateInputValue(timestamp: number | undefined): string {
  const date = timestamp ? new Date(timestamp) : new Date(Date.now() + 24 * 60 * 60 * 1_000);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function localDateEndTimestamp(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

export function parseDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---- 运行历史状态映射(与 AutomationRunsDialog 保持一致) ----
export type RunStatusKind = "running" | "succeeded" | "failed" | "stopped" | "skipped";
export function resolveRunStatus(run: ACodeAutomationRun): RunStatusKind {
  if (run.dispatchStatus === "skipped") return "skipped";
  if (run.dispatchStatus === "failed_to_dispatch") return "failed";
  switch (run.outcome) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "running";
  }
}

// 运行状态用「圆点 + 彩色文字」呈现（Scheduled 历史表密度规格）。
export const RUN_STATUS_DOT_CLASS: Record<RunStatusKind, string> = {
  running: "bg-primary",
  succeeded: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-foreground-subtlest",
  skipped: "bg-warning",
};
export const RUN_STATUS_TEXT_CLASS: Record<RunStatusKind, string> = {
  running: "text-primary",
  succeeded: "text-success",
  failed: "text-destructive",
  stopped: "text-foreground-subtle",
  skipped: "text-warning",
};

export const AUTOMATION_STATUS_DOT_CLASS: Record<AutomationStatusKind, string> = {
  active: "bg-success",
  paused: "bg-warning",
  failed: "bg-destructive",
  completed: "bg-foreground-subtlest",
};

export function normalizeAutomationScheduleRule(
  rule: ACodeAutomationScheduleRule | null | undefined,
): Record<string, unknown> | null {
  if (!rule) return null;
  return {
    unit: rule.unit,
    interval: rule.interval,
    hour: rule.hour,
    minute: rule.minute,
    anchorAt: rule.anchorAt,
    weekdays: rule.weekdays ?? [],
    monthDays: rule.monthDays ?? [],
    months: rule.months ?? [],
    monthlyMode: rule.monthlyMode ?? "date",
  };
}
