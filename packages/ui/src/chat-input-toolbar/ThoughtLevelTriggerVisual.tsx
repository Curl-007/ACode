import type { RefObject } from "react";
import { BrainIcon } from "lucide-react";
import type { ACodeConfigOption } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { isNoThoughtLevel } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";

type ThoughtLevelEntry = NonNullable<ACodeConfigOption["options"]>[number];

export interface ThoughtLevelTriggerVisualProps {
  composerCollapsePriority?: number;
  currentEntry: ThoughtLevelEntry | undefined;
  currentLabel: string;
  currentValueIsValid: boolean;
  entries: readonly ThoughtLevelEntry[];
  /** 主控件持有（ResizeObserver 监测标签可见性）；本组件只挂载。 */
  labelRef: RefObject<HTMLSpanElement | null>;
  labelVisibilityClassName: string;
}

/**
 * 思考档位控件的共享触发器视觉：脑图标 + 档位进度条 + 滚动档名。
 * slider/select/cycle 三种交互模式共用的纯 props 展示件（chat-input-toolbar 惯例），
 * 按仓内拆分先例自 ThoughtLevelCycleControl 拆出（max-file-lines 闸内收敛）；
 * 本组件不持有状态、不含写路径。
 */
export function ThoughtLevelTriggerVisual({
  composerCollapsePriority,
  currentEntry,
  currentLabel,
  currentValueIsValid,
  entries,
  labelRef,
  labelVisibilityClassName,
}: ThoughtLevelTriggerVisualProps) {
  // 配置顺序不再经过名称排序，关闭项可能位于任意位置；只计算当前项之前的非关闭项。
  // 未选／失效及关闭值始终为零进度，不能把缺失选择投影成首档。
  const thinkingEntries = entries.filter((entry) => !isNoThoughtLevel(entry));
  const activeDotCount =
    !currentValueIsValid || !currentEntry || isNoThoughtLevel(currentEntry)
      ? 0
      : thinkingEntries.indexOf(currentEntry) + 1;
  const dotCount = Math.max(1, thinkingEntries.length);
  const progressPercent = (activeDotCount / dotCount) * 100;

  return (
    <>
      <BrainIcon
        className={cn(
          "pointer-events-none size-4 text-current",
          // "inline-flex @lg/composer:hidden",
        )}
      />
      <span
        className={cn(
          "relative w-1 self-stretch overflow-hidden rounded-full bg-current/10",
          composerCollapsePriority !== undefined
            ? "hidden group-data-[composer-compact=true]/thought:inline-flex"
            : "hidden @sm/composer:inline-flex @xl/composer:hidden",
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "absolute bottom-0 left-0 w-full rounded-full bg-success transition-[height] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
            progressPercent > 0 ? "min-h-1" : undefined,
          )}
          style={{ height: `${progressPercent}%` }}
        />
      </span>
      <span
        ref={labelRef}
        className={cn(
          "min-w-0 whitespace-nowrap",
          labelVisibilityClassName,
          composerCollapsePriority !== undefined && "group-data-[composer-compact]/thought:hidden",
        )}
      >
        <RollingToolbarLabel label={currentLabel} />
      </span>
    </>
  );
}
