/**
 * CustomRepeatDialog 的「按 unit 切换」区块：weekly 的 7 日勾选网格 + monthly 的
 * monthlyMode select + byDate/byWeekday 二选一网格。抽出是为让 CustomRepeatDialog
 * 自身落到 max-lines 400 以下；语义与样式逐字从 CustomRepeatDialog 迁入，**不改行为**。
 *
 * 全部为受控子组件：选中态（weekdays/monthDays/monthlyMode）由父组件 props 提供，
 * onChange 由父组件接管写回。本模块自身不持有任何 state。
 */
import { ChevronDown } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { WEEKDAY_ORDER, type CronBuilderState } from "@/settings/automationFormat.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

const CUSTOM_REPEAT_SELECT_CONTENT_CLASS =
  "w-[var(--radix-select-trigger-width)] px-0 py-1.5 [&_[data-position=popper]]:px-1 [&_[data-slot=select-scroll-up-button]]:hidden [&_[data-slot=select-scroll-down-button]]:hidden";
const CUSTOM_REPEAT_SELECT_ITEM_CLASS =
  "min-h-8 rounded-[8px] px-2 py-1.5 pr-8 text-ui-base leading-5 text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-[state=checked]:bg-menu-hover data-[state=checked]:text-foreground";

function CustomRepeatSelectIndicator() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
      <ChevronDown className="size-4" strokeWidth={2} />
    </span>
  );
}

/** unit=weekly：7 日勾选网格（不可清空最后一个）。 */
export function CustomRepeatWeeklyGrid({
  intl,
  onChange,
  weekdays,
}: {
  intl: IntlInstance;
  onChange: (weekdays: number[]) => void;
  weekdays: number[];
}) {
  return (
    <div className="grid grid-cols-7 gap-2">
      {WEEKDAY_ORDER.map((day) => {
        const active = weekdays.includes(day);
        return (
          <button
            key={day}
            type="button"
            onClick={() => {
              if (active && weekdays.length === 1) return;
              onChange(
                active ? weekdays.filter((candidate) => candidate !== day) : [...weekdays, day],
              );
            }}
            className={cn(
              "flex h-9 items-center justify-center rounded-md border text-ui-base",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-surface-hover",
            )}
          >
            {intl.formatMessage({ id: `automations.weekday.${day}` })}
          </button>
        );
      })}
    </div>
  );
}

/** unit=monthly：monthlyMode select + byDate(31 日网格) / byWeekday(7 日单选网格)。 */
export function CustomRepeatMonthlySection({
  intl,
  monthDays,
  monthlyMode,
  onModeChange,
  onMonthDaysChange,
  onWeekdaysChange,
  weekdays,
}: {
  intl: IntlInstance;
  monthDays: number[];
  monthlyMode: CronBuilderState["customMonthlyMode"];
  onModeChange: (mode: CronBuilderState["customMonthlyMode"]) => void;
  onMonthDaysChange: (days: number[]) => void;
  onWeekdaysChange: (days: number[]) => void;
  weekdays: number[];
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui-base text-foreground">
          {intl.formatMessage({ id: "automations.customRepeat.rule" })}
        </span>
        <Select
          value={monthlyMode}
          onValueChange={(value) =>
            onModeChange(value as CronBuilderState["customMonthlyMode"])
          }
        >
          <SelectTrigger
            className="h-9 w-32 rounded-[8px] px-3 text-ui-base hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
            indicator={<CustomRepeatSelectIndicator />}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position="popper"
            align="start"
            side="bottom"
            sideOffset={4}
            collisionPadding={8}
            className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
          >
            <SelectItem value="date" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
              {intl.formatMessage({ id: "automations.customRepeat.byDate" })}
            </SelectItem>
            <SelectItem value="weekday" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
              {intl.formatMessage({ id: "automations.customRepeat.byWeekday" })}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {monthlyMode === "date" ? (
        <div className="grid grid-cols-10 gap-2.5">
          {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => {
            const active = monthDays.includes(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() => {
                  if (active && monthDays.length === 1) return;
                  onMonthDaysChange(
                    active
                      ? monthDays.filter((candidate) => candidate !== day)
                      : [...monthDays, day],
                  );
                }}
                className={cn(
                  "flex h-7 w-full items-center justify-center rounded-[8px] border text-ui-sm",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-surface-hover",
                )}
              >
                {day}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-2">
          {WEEKDAY_ORDER.map((day) => {
            const active = weekdays.includes(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() => onWeekdaysChange([day])}
                className={cn(
                  "flex h-9 items-center justify-center rounded-md border text-ui-base",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-surface-hover",
                )}
              >
                {intl.formatMessage({ id: `automations.weekday.${day}` })}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
