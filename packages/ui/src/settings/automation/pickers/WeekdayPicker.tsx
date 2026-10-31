/**
 * 每周日期选择：保持语句式 trigger，并禁止清空最后一个日期。
 *
 * 受控组件：`weekdays` 数组由 props 透传；onChange 由父组件接管。
 * 单选最后一个日期时 onClick 直接 return（约束：weekdays 不可为空）。
 * 来源：AutomationEditView.tsx 行 396-452（批次 2 选择器族外迁，逐字迁移）。
 */
import { Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { AutomationChevronDownIcon } from "@/settings/AutomationDesignPrimitives.js";
import { WEEKDAY_ORDER } from "@/settings/automationFormat.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

export function WeekdayPicker({
  weekdays,
  intl,
  onChange,
}: {
  weekdays: number[];
  intl: IntlInstance;
  onChange: (weekdays: number[]) => void;
}) {
  const label = WEEKDAY_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => intl.formatMessage({ id: `automations.weekday.${day}` }))
    .join(intl.formatMessage({ id: "automations.weekday.separator" }));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.weekdaysLabel",
          })}
          // 星期多选 trigger 与同层频率、时间 tag 使用相同高亮，避免亮度不一致。
          className="inline-flex h-auto max-w-full items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground transition-colors hover:bg-selected data-[state=open]:bg-selected focus-visible:bg-input-focused focus-visible:outline-none"
        >
          <span className="truncate">{label}</span>
          <AutomationChevronDownIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-40 p-1">
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
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui-base text-foreground transition-colors hover:bg-menu-hover"
            >
              {/* 勾选位放在行首会让星期菜单偏离标准的尾部状态布局。 */}
              <span className="min-w-0 flex-1 truncate">
                {intl.formatMessage({ id: `automations.weekday.${day}` })}
              </span>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {active ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
