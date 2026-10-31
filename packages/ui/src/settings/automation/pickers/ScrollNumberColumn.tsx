/**
 * 月/日单列滚动列表（1-based 值），样式对齐 TimeUnitColumn。
 *
 * 受控组件：`selected` 与 `values` 完全由 props 决定；onSelect 由父组件接管。
 * `buttonTestIdPrefix` 提供时每个数字按钮带 `${prefix}-${value}` 的 data-testid（e2e 用）。
 * 来源：AutomationEditView.tsx 行 291-330（批次 2 选择器族外迁，逐字迁移）。
 */
import { useEffect, useRef } from "react";
import { testId } from "@acode/shared";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { cn } from "@/components/lib/utils.js";
import { pad2 } from "@/settings/automation/scheduleModel.js";

export function ScrollNumberColumn({
  values,
  selected,
  onSelect,
  buttonTestIdPrefix,
}: {
  values: number[];
  selected: number;
  onSelect: (value: number) => void;
  /** 提供时每个数字按钮带 `${prefix}-${value}` 的 data-testid（e2e 用）。 */
  buttonTestIdPrefix?: string;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {values.map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            data-testid={buttonTestIdPrefix ? testId(buttonTestIdPrefix, String(value)) : undefined}
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-sm tabular-nums transition-colors",
              value === selected
                ? "bg-primary text-primary-foreground"
                : "text-foreground-subtle hover:bg-surface-hover",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
