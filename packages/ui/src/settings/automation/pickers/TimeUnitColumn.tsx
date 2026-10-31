/**
 * 时间选择的单列滚动列表（小时或分钟），选中项打开时自动滚动到可见位置。
 * 时间选项属于常用交互控件，不应沿用仅用于徽标和紧凑标签的最小字号 token。
 * 已选时间属于菜单选中态，不是主操作按钮；使用菜单 hover 语义避免 Light 主题下出现突兀黑块。
 *
 * 受控组件：`selected` 完全由 props 决定；onSelect 触发后由父组件改 props 才会更新高亮。
 * 来源：AutomationEditView.tsx 行 209-244（批次 2 选择器族外迁，逐字迁移）。
 */
import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { cn } from "@/components/lib/utils.js";
import { pad2 } from "@/settings/automation/scheduleModel.js";

export function TimeUnitColumn({
  count,
  selected,
  onSelect,
}: {
  count: number;
  selected: number;
  onSelect: (value: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {Array.from({ length: count }, (_, value) => value).map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-base tabular-nums transition-colors",
              value === selected
                ? "bg-menu-hover text-foreground"
                : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
