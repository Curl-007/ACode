/**
 * HH:MM 时间选择器：一个 pill 触发器 + 弹层内小时/分钟两列滚动选择。
 * 时间选择触发器属于常用交互控件，应使用正文基准字号 text-ui-base。
 *
 * 受控组件：`hour`/`minute` 由 props 透传，弹层内的 open/close 由内部 useState 管理
 * （视觉态，不影响受控值）。onChange 触发后由父组件写回 props。
 * 来源：AutomationEditView.tsx 行 250-288（批次 2 选择器族外迁，逐字迁移）。
 */
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { AutomationChevronDownIcon } from "@/settings/AutomationDesignPrimitives.js";
import { pad2 } from "@/settings/automation/scheduleModel.js";
import { TimeUnitColumn } from "./TimeUnitColumn.js";

export function TimeOfDayPicker({
  hour,
  minute,
  onChange,
  ariaLabel,
}: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:bg-input-focused focus-visible:outline-none"
        >
          {pad2(hour)}:{pad2(minute)}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <TimeUnitColumn count={24} selected={hour} onSelect={(value) => onChange(value, minute)} />
        <div className="w-px shrink-0 bg-border" />
        <TimeUnitColumn count={60} selected={minute} onSelect={(value) => onChange(hour, value)} />
      </PopoverContent>
    </Popover>
  );
}
