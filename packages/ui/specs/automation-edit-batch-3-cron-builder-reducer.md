# AutomationEditView 批次 3：cron builder reducer 收敛

日期：2026-10-28。基线：`fix/project-review-2026-10-26`。

## 目标

`settings/AutomationEditView.tsx` 的 `builder` state 当前是单一 `useState<CronBuilderState>`，
但所有更新都是 `setBuilder((prev) => ({ ...prev, ...partial }))` 散点，共有 8 个调用点，
每处手写 spread。本批把 builder 相关更新收敛为 `useReducer`，reducer 为**纯函数**、actions
为**严格 discriminated union**，使状态机可单测、调用点语义化。

## 范围

只动 builder reducer。**不动**：
- 表单其它 state（title / prompt / model / mode / thoughtLevel / workspaceKey / endAt /
  scheduleRemoved / validationErrors / touchedFields / customRepeatOpen / runsPage / tab /
  saveAndRunPending）。
- CustomRepeatDialog 内部 state（弹窗草稿语义保持，onConfirm 仍一次性提交，已受控）。
- 选择器族（批次 2 已外迁）的 props 签名与交互。

## reducer state

复用 `CronBuilderState`（单一来源 `automationFormat.ts`），不新增字段。

## action 清单（discriminated union）

| action type | payload | 语义 | 替换的旧调用 |
|---|---|---|---|
| `setFrequency` | `{ frequency: CronFrequency }` | 切换频率；`weekdays` 频率时 weekdays 强制为 `[1,2,3,4,5]`，其它频率不动 weekdays | `setBuilder((p) => ({ ...p, frequency, ...(frequency === "weekdays" ? { weekdays: [1,2,3,4,5] } : {}) }))` |
| `setDayOfMonth` | `{ dayOfMonth: number }` | monthly 的日期 | `setBuilder((p) => ({ ...p, dayOfMonth: Number(value) }))` |
| `setWeekdays` | `{ weekdays: number[] }` | weekly 的星期集合 | `setBuilder((p) => ({ ...p, weekdays }))` |
| `setTimeOfDay` | `{ hour: number; minute: number }` | TimeOfDayPicker onChange | `setBuilder((p) => ({ ...p, hour, minute }))` |
| `setMinute` | `{ minute: number }` | hourly 的 minute / custom+hourly 的 minute | `setBuilder((p) => ({ ...p, minute: Number(value) }))` |
| `setYearlyMonthDay` | `{ month: number; day: number }` | yearly 的月+日（day 落到 customMonthDays[0]） | `setBuilder((p) => ({ ...p, customMonth: month, customMonthDays: [day] }))` |
| `applyCustomRepeat` | `{ interval: number; unit: CustomRepeatUnit; weekdays: number[]; monthDays: number[]; monthlyMode: CustomMonthlyMode }` | CustomRepeatDialog onConfirm；强制 `frequency: "custom"` | `setBuilder((p) => ({ ...p, frequency: "custom", customInterval: interval, customUnit: unit, customWeekdays: weekdays, customMonthDays: monthDays, customMonthlyMode: monthlyMode }))` |
| `reset` | `{ next: CronBuilderState }` | 编辑对象/草稿切换时整体重置（useEffect 内） | `setBuilder(initialBuilder(editing, initialDraft))` |

## 验收

- `pnpm --filter @acode/ui test` 全绿
- `pnpm --filter @acode/ui typecheck` exit 0
- `pnpm architecture:check --changed` exit 0（新文件 <400 行）
- `pnpm lint` 触碰文件 0 新增警告
- `godComponentLineRatchet.guard.test.mjs` 上限随主文件实测下调
- 交互语义逐字保留：picker onChange / CustomRepeatDialog onConfirm / 重置 effect 的调用序列不变
