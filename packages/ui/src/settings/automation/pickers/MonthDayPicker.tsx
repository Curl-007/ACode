/**
 * 月/日选择器（custom → yearly 用）：一个 pill 触发器 + 弹层内月/日两列滚动选择，
 * 样式与 TimeOfDayPicker 对齐。切月后当前日超过该月最大天数时自动收敛。
 *
 * 受控组件：`month`/`day` 由 props 透传；onChange 触发后由父组件写回。
 * 内部仅维护弹层 open 视觉态。
 * 来源：AutomationEditView.tsx 行 336-393（批次 2 选择器族外迁，逐字迁移）。
 */
import { useState } from "react";
import {
  TID_AUTOMATION_YEAR_DAY_OPTION,
  TID_AUTOMATION_YEAR_MONTH_OPTION,
  TID_AUTOMATION_YEAR_MONTHDAY,
} from "@acode/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { AutomationChevronDownIcon } from "@/settings/AutomationDesignPrimitives.js";
import { daysInMonth } from "@/settings/automation/scheduleModel.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { ScrollNumberColumn } from "./ScrollNumberColumn.js";

export function MonthDayPicker({
  month,
  day,
  intl,
  onChange,
}: {
  month: number;
  day: number;
  intl: IntlInstance;
  onChange: (month: number, day: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const days = Array.from({ length: daysInMonth(month) }, (_, index) => index + 1);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={TID_AUTOMATION_YEAR_MONTHDAY}
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.yearDateLabel",
          })}
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:bg-input-focused focus-visible:outline-none"
        >
          {intl.formatMessage(
            { id: "automations.form.schedule.monthDayValue" },
            { month: String(month), day: String(day) },
          )}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      {/* 与 TimeOfDayPicker 一致：flex-row 覆盖 PopoverContent 默认的 flex-col，月/日两列并排。 */}
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <ScrollNumberColumn
          values={months}
          selected={month}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_MONTH_OPTION}
          onSelect={(value) => onChange(value, Math.min(day, daysInMonth(value)))}
        />
        <div className="w-px shrink-0 bg-border" />
        <ScrollNumberColumn
          values={days}
          selected={day}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_DAY_OPTION}
          onSelect={(value) => onChange(month, value)}
        />
      </PopoverContent>
    </Popover>
  );
}
