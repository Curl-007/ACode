/**
 * cron builder 状态机（批次 3：27 个 useState 中 builder 相关簇收敛为单一 useReducer）。
 *
 * 来源：packages/ui/src/settings/AutomationEditView.tsx 的 8 个 `setBuilder((prev) => ({...}))`
 * 调用点（split-plan god-component-split-plan.md `settings/AutomationEditView.tsx` 登记表，
 * spec：packages/ui/specs/automation-edit-batch-3-cron-builder-reducer.md）。
 *
 * 设计要求：
 *   - **纯函数**（可单测）：reducer 不读时钟、不读 DOM、不依赖 React；
 *   - **严格 discriminated union**：action.type 穷举，每个 action 携带最小 payload；
 *   - **逐字迁移调用语义**：每个 action 的 state 转移必须等价于被替换的 `setBuilder` 调用；
 *   - state 形状复用 `CronBuilderState`（单一来源 `automationFormat.ts`），不新增字段。
 */
import type {
  CronBuilderState,
  CronFrequency,
  CustomMonthlyMode,
  CustomRepeatUnit,
} from "@/settings/automationFormat.js";

export type CronBuilderAction =
  /** 切换频率；weekdays 频率时强制 weekdays=[1..5]，其它频率不动 weekdays。 */
  | { type: "setFrequency"; frequency: CronFrequency }
  /** monthly 的 dayOfMonth。 */
  | { type: "setDayOfMonth"; dayOfMonth: number }
  /** weekly 的 weekdays 整体替换。 */
  | { type: "setWeekdays"; weekdays: number[] }
  /** TimeOfDayPicker onChange：同时更新 hour 和 minute。 */
  | { type: "setTimeOfDay"; hour: number; minute: number }
  /** hourly 频率或 custom+hourly unit 下的 minute。 */
  | { type: "setMinute"; minute: number }
  /** yearly 的月 + 日（day 落到 customMonthDays[0]，与 MonthDayPicker 的受控语义一致）。 */
  | { type: "setYearlyMonthDay"; month: number; day: number }
  /**
   * CustomRepeatDialog onConfirm 一次性提交：强制 frequency="custom"，
   * 同步更新 5 个 custom* 字段；endAt 不在此处（属独立 state）。
   */
  | {
      type: "applyCustomRepeat";
      interval: number;
      unit: CustomRepeatUnit;
      weekdays: number[];
      monthDays: number[];
      monthlyMode: CustomMonthlyMode;
    }
  /** 编辑对象/草稿切换时整体重置（替换为 `initialBuilder(editing, initialDraft)` 的结果）。 */
  | { type: "reset"; next: CronBuilderState };

/**
 * 频率切换时的 weekdays 重置规则（逐字迁移自 AutomationEditView 的两个 setFrequency 调用点）：
 * 选 "weekdays" 时强制 `[1,2,3,4,5]`，其它频率保留当前 weekdays。
 */
function resolveWeekdaysForFrequency(
  frequency: CronFrequency,
  currentWeekdays: number[],
): number[] {
  return frequency === "weekdays" ? [1, 2, 3, 4, 5] : currentWeekdays;
}

export function cronBuilderReducer(
  state: CronBuilderState,
  action: CronBuilderAction,
): CronBuilderState {
  switch (action.type) {
    case "setFrequency":
      return {
        ...state,
        frequency: action.frequency,
        weekdays: resolveWeekdaysForFrequency(action.frequency, state.weekdays),
      };
    case "setDayOfMonth":
      return { ...state, dayOfMonth: action.dayOfMonth };
    case "setWeekdays":
      return { ...state, weekdays: action.weekdays };
    case "setTimeOfDay":
      return { ...state, hour: action.hour, minute: action.minute };
    case "setMinute":
      return { ...state, minute: action.minute };
    case "setYearlyMonthDay":
      return { ...state, customMonth: action.month, customMonthDays: [action.day] };
    case "applyCustomRepeat":
      return {
        ...state,
        frequency: "custom",
        customInterval: action.interval,
        customUnit: action.unit,
        customWeekdays: action.weekdays,
        customMonthDays: action.monthDays,
        customMonthlyMode: action.monthlyMode,
      };
    case "reset":
      return action.next;
  }
}
