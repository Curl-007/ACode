/**
 * 结束日期选择器（CustomRepeatDialog 用）：日历弹层 + pill 触发器。
 *
 * 受控组件：`value`/`min`/`disabled` 由 props 透传；onChange 触发后由父组件写回。
 * 内部仅维护弹层 open 与 visibleMonth 视觉态（visibleMonth 是月历翻页游标，非受控值）。
 *
 * 不能用原生 `<input type="date">`：原生 date input 会在暗色主题中弹出不可控的系统白色月历。
 *
 * 来源：AutomationEditView.tsx 行 454-576（批次 2 选择器族外迁，逐字迁移）。
 * `CustomRepeatCalendarIcon` 从主文件行 200-202 迁入本文件（只此处使用）。
 */
import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import {
  pad2,
  parseDateInputValue,
  toDateInputValue,
} from "@/settings/automation/scheduleModel.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

function CustomRepeatCalendarIcon({ className }: { className?: string }) {
  return <CalendarDays className={className} strokeWidth={2} />;
}

export function EndDatePicker({
  disabled,
  intl,
  min,
  onChange,
  value,
}: {
  disabled: boolean;
  intl: IntlInstance;
  min: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateInputValue(value);
  const minDate = parseDateInputValue(min);
  const [visibleMonth, setVisibleMonth] = useState(() => selectedDate ?? minDate ?? new Date());

  useEffect(() => {
    if (open && selectedDate) setVisibleMonth(selectedDate);
  }, [open, selectedDate?.getTime()]);

  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayValue = toDateInputValue(Date.now());
  const monthLabel = intl.formatMessage(
    { id: "automations.customRepeat.monthLabel" },
    { year: String(year), month: String(month + 1) },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-9 w-[135px] items-center justify-center gap-1.5 rounded-lg border border-input-border bg-input pl-3 pr-3.5 text-ui-base font-normal leading-5 tracking-[-0.18px] text-foreground transition-colors hover:border-input-border-hover hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-input-border disabled:hover:bg-input"
        >
          <CustomRepeatCalendarIcon className="size-5 shrink-0 text-foreground-subtle" />
          <span className="tabular-nums">
            {selectedDate
              ? `${selectedDate.getFullYear()}/${pad2(selectedDate.getMonth() + 1)}/${pad2(selectedDate.getDate())}`
              : value}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-3">
        <div className="mb-3 flex h-8 items-center justify-between">
          <span className="text-ui-sm font-medium text-foreground">{monthLabel}</span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month - 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.previousMonth",
              })}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month + 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.nextMonth",
              })}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {[0, 1, 2, 3, 4, 5, 6].map((day) => (
            <span
              key={day}
              className="flex size-8 items-center justify-center text-ui-sm text-foreground-subtlest"
            >
              {intl.formatMessage({ id: `automations.weekday.${day}` })}
            </span>
          ))}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={`blank-${index}`} className="size-8" />
          ))}
          {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((day) => {
            const dateValue = `${year}-${pad2(month + 1)}-${pad2(day)}`;
            const selected = dateValue === value;
            const isToday = dateValue === todayValue;
            const unavailable = dateValue < min;
            return (
              <button
                key={day}
                type="button"
                disabled={unavailable}
                onClick={() => {
                  onChange(dateValue);
                  setOpen(false);
                }}
                className={cn(
                  "flex size-8 items-center justify-center rounded-[8px] text-ui-base tabular-nums transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-menu-hover",
                  isToday && !selected && "ring-1 ring-inset ring-border-hover",
                  unavailable && "cursor-not-allowed text-foreground-subtlest opacity-35",
                )}
              >
                {day}
              </button>
            );
          })}
          {Array.from({ length: 42 - firstWeekday - daysInMonth }, (_, index) => (
            <span key={`trailing-blank-${index}`} className="size-8" />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
