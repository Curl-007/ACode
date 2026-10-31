/**
 * cron builder 的初始状态工厂（批次 1 helper 外迁）。
 *
 * 来源：packages/ui/src/settings/AutomationEditView.tsx 的 `defaultBuilder` / `initialBuilder`
 * （split-plan god-component-split-plan.md `settings/AutomationEditView.tsx` 登记表）。**纯函数，
 * 无 React 依赖**，函数体逐字迁移。
 *
 * `CronBuilderState` 类型的**单一来源**在 `@/settings/automationFormat.js`（与 `buildCronExpr` /
 * `parseCronToBuilder` 同文件）。本模块**不重复声明**，只做 re-export，让 builder 相关函数与类型从
 * 同一个入口可达；避免批次 3「cron builder state 机」落地时出现两份 CronBuilderState。
 */
import type { ACodeAutomation } from "@acode/shared";
import { parseCronToBuilder, type CronBuilderState } from "@/settings/automationFormat.js";

export type { CronBuilderState };

export function defaultBuilder(): CronBuilderState {
  return {
    frequency: "daily",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    rawExpr: "0 9 * * *",
    customInterval: 1,
    customUnit: "daily",
    customWeekdays: [1],
    customMonthDays: [1],
    customMonth: new Date().getMonth() + 1,
    customMonthlyMode: "date",
  };
}

export function initialBuilder(
  editing: ACodeAutomation | null,
  initialDraft?: { title: string; cronExpr: string; prompt: string } | null,
): CronBuilderState {
  if (!editing) {
    return initialDraft ? parseCronToBuilder(initialDraft.cronExpr) : defaultBuilder();
  }

  const parsedBuilder = parseCronToBuilder(editing.cronExpr);
  if (!editing.scheduleRule) return parsedBuilder;

  return {
    ...parsedBuilder,
    frequency: "custom",
    hour: editing.scheduleRule.hour,
    minute: editing.scheduleRule.minute,
    customInterval: editing.scheduleRule.interval,
    customUnit: editing.scheduleRule.unit,
    customWeekdays: editing.scheduleRule.weekdays ?? [1],
    customMonthDays: editing.scheduleRule.monthDays ?? [1],
    customMonth:
      editing.scheduleRule.months?.[0] ?? new Date(editing.scheduleRule.anchorAt).getMonth() + 1,
    customMonthlyMode: editing.scheduleRule.monthlyMode ?? "date",
  };
}
