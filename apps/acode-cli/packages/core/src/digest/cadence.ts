// ============================================================
// Digest cadence 文案（specs/periodic-digest.md R1 routines 节）
// ============================================================
// scheduleRule 是调度权威、cronExpr 只是兼容展示（automation-types 同一条纪律）：
// cadence 文案优先从 scheduleRule 派生，无 rule 时回退展示 cron 原文。纯函数、
// 恒英文（模型可见数据面，prompt-language-policy 同款口径）。

import type { CronAutomationScheduleRule } from "@acode/contracts";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clockOf(rule: CronAutomationScheduleRule): string {
  return `${pad2(rule.hour)}:${pad2(rule.minute)}`;
}

function weekdaysOf(rule: CronAutomationScheduleRule): string {
  if (!rule.weekdays || rule.weekdays.length === 0) return "";
  const names = rule.weekdays
    .filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6)
    .map((day) => WEEKDAY_NAMES[day]);
  return names.length > 0 ? ` on ${names.join(",")}` : "";
}

function monthDaysOf(rule: CronAutomationScheduleRule): string {
  if (!rule.monthDays || rule.monthDays.length === 0) return "";
  return ` on day ${rule.monthDays.join(",")}`;
}

function monthsOf(rule: CronAutomationScheduleRule): string {
  if (!rule.months || rule.months.length === 0) return "";
  const names = rule.months
    .filter((month): month is number => Number.isInteger(month) && month >= 1 && month <= 12)
    .map((month) => MONTH_NAMES[month - 1]);
  return names.length > 0 ? ` in ${names.join(",")}` : "";
}

/** scheduleRule → 人类可读 cadence；单位分支与 ACodeAutomationScheduleRule.unit 同集。 */
export function describeScheduleRuleCadence(rule: CronAutomationScheduleRule): string {
  const interval = rule.interval;
  switch (rule.unit) {
    case "minute":
      return interval === 1 ? "every minute" : `every ${interval} minutes`;
    case "hourly": {
      const atMinute = rule.minute > 0 ? ` at :${pad2(rule.minute)}` : "";
      return interval === 1 ? `hourly${atMinute}` : `every ${interval} hours${atMinute}`;
    }
    case "daily":
      return interval === 1
        ? `daily at ${clockOf(rule)}`
        : `every ${interval} days at ${clockOf(rule)}`;
    case "weekly": {
      const days = weekdaysOf(rule);
      return interval === 1
        ? `weekly${days} at ${clockOf(rule)}`
        : `every ${interval} weeks${days} at ${clockOf(rule)}`;
    }
    case "monthly": {
      // weekday 模式（第 N 个星期几）没有 day 列表可展示，报模式本身而不是编一个日期。
      const when = rule.monthlyMode === "weekday" ? " (weekday rule)" : monthDaysOf(rule);
      return interval === 1
        ? `monthly${when} at ${clockOf(rule)}`
        : `every ${interval} months${when} at ${clockOf(rule)}`;
    }
    case "yearly": {
      const when = `${monthsOf(rule)}${monthDaysOf(rule)}`;
      return interval === 1
        ? `yearly${when} at ${clockOf(rule)}`
        : `every ${interval} years${when} at ${clockOf(rule)}`;
    }
    default:
      return `rule: ${rule.unit}`;
  }
}

/** automation → cadence 文案：scheduleRule 权威、cronExpr 兜底（验收场景 3）。 */
export function describeAutomationCadence(
  scheduleRule: CronAutomationScheduleRule | undefined,
  cronExpr: string,
): string {
  if (scheduleRule) return describeScheduleRuleCadence(scheduleRule);
  const expr = cronExpr.trim();
  return expr.length > 0 ? `cron: ${expr}` : "unscheduled";
}
