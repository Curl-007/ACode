import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";

// 状态栏胶囊（纯展示件）：icon + 主值 + 悬停 tooltip 明细；可选点击展开 popover
// （子智能体面板）。数值区 tabular-nums/mono 倾向（DESIGN.md「Chat, Tooling, and
// Developer UI」）；胶囊形状用 rounded-md 文本 chip——rounded-full 保留给刻意 pill
// 形（DESIGN.md §Radius）。popover 浮层规范照 §Menus, Popovers（bg-popover 组件默认）。

export type UsageStatusbarTone = "default" | "success" | "warning" | "destructive";

const TONE_CLASS: Record<UsageStatusbarTone, string> = {
  default: "text-foreground-subtle",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

export interface UsageStatusbarCapsuleProps {
  /** 项名：进 tooltip 标题与 aria-label，不上胶囊正文（保持条状紧凑）。 */
  label: string;
  icon?: ReactNode;
  value: ReactNode;
  tone?: UsageStatusbarTone;
  /** tooltip 明细正文（标题由 label 承担）；null = 无 tooltip。 */
  tooltip?: ReactNode;
  /** 点击展开的面板内容；在场时胶囊渲染为 button + Popover 触发器。 */
  popoverContent?: ReactNode;
  testId?: string;
  className?: string;
}

export function UsageStatusbarCapsule({
  label,
  icon,
  value,
  tone = "default",
  tooltip,
  popoverContent,
  testId,
  className,
}: UsageStatusbarCapsuleProps) {
  const bodyClass = cn(
    "inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-ui-sm tabular-nums",
    TONE_CLASS[tone],
    popoverContent && "cursor-pointer hover:bg-hover",
    className,
  );
  const body = (
    <>
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-3.5">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{value}</span>
    </>
  );
  const tooltipContent = tooltip ? (
    <TooltipContent
      side="top"
      className="max-w-72 flex-col items-start gap-1.5 px-3 py-2 text-left"
    >
      <span className="text-ui-base font-medium">{label}</span>
      {tooltip}
    </TooltipContent>
  ) : null;

  if (!popoverContent) {
    const staticBody = (
      <span aria-label={label} className={bodyClass} data-testid={testId} role="status">
        {body}
      </span>
    );
    if (!tooltipContent) return staticBody;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{staticBody}</TooltipTrigger>
        {tooltipContent}
      </Tooltip>
    );
  }

  const triggerButton = (
    <button type="button" aria-label={label} className={bodyClass} data-testid={testId}>
      {body}
    </button>
  );
  // Radix 组合触发器：PopoverTrigger 与 TooltipTrigger 双层 asChild 落到同一 button，
  // 悬停出明细、点击出面板，两个浮层不互抢锚点。
  const composedTrigger = tooltipContent ? (
    <PopoverTrigger asChild>
      <span className="inline-flex min-w-0 max-w-full">
        <Tooltip>
          <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
          {tooltipContent}
        </Tooltip>
      </span>
    </PopoverTrigger>
  ) : (
    <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
  );
  return (
    <Popover>
      {composedTrigger}
      <PopoverContent align="start" side="top" sideOffset={4} className="w-auto gap-0 p-1.5">
        {popoverContent}
      </PopoverContent>
    </Popover>
  );
}

/** tooltip 明细行：左标签右值，值区 mono 倾向。 */
export function UsageStatusbarDetailRow({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: ReactNode;
  valueClass?: string;
}) {
  return (
    <span className="flex w-full items-baseline justify-between gap-3 text-ui-sm">
      <span className="shrink-0 text-tooltip-foreground/70">{label}</span>
      <span className={cn("min-w-0 truncate font-mono tabular-nums", valueClass)}>{value}</span>
    </span>
  );
}

/** tooltip 口径说明段（弱化色小字）。 */
export function UsageStatusbarTooltipNote({ children }: { children: ReactNode }) {
  return (
    <span className="w-full border-t border-border pt-1.5 text-ui-xs leading-snug text-tooltip-foreground/70">
      {children}
    </span>
  );
}
