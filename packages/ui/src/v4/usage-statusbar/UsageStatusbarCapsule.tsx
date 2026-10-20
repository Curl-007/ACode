import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";

// 状态栏胶囊（纯展示件）：icon + 主值 + 悬停 Popover 明细；可选点击展开 popover
// （子智能体面板）。悬停生命周期自管（specs/usage-statusbar.md「Tooltip 稳定性」
// 2026-10-19 最小修复）：open 由父组件 hoveredCapsuleId 单一状态驱动（单开天然），
// 开 = 本胶囊 pointerenter（布局位移把新胶囊推到静止指针下时浏览器边界事件同样
// 触发），关 = 父组件三条路径（pointerleave 且 relatedTarget 在整条 bar 外 / bar
// 间隙 pointermove / Popover 主动关闭）。**Radix Tooltip 退役**：其 pointerleave
// 关闭 + pointermove 重开门在流式几何位移下误杀静止指针悬停（运行时录证确证）。
// 数值区 tabular-nums/mono 倾向（DESIGN.md「Chat, Tooling, and Developer UI」）；
// 胶囊形状用 rounded-md 文本 chip——rounded-full 保留给刻意 pill 形（DESIGN.md
// §Radius）。popover 浮层规范照 §Menus, Popovers（bg-popover 组件默认）。

export type UsageStatusbarTone = "default" | "success" | "warning" | "destructive";

const TONE_CLASS: Record<UsageStatusbarTone, string> = {
  default: "text-foreground-subtle",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

export interface UsageStatusbarCapsuleProps {
  /** 项名：进浮层标题与 aria-label，不上胶囊正文（保持条状紧凑）。 */
  label: string;
  icon?: ReactNode;
  value: ReactNode;
  tone?: UsageStatusbarTone;
  /** 浮层明细正文（标题由 label 承担）；null = 无浮层。 */
  tooltip?: ReactNode;
  /** 浮层开态（父组件单一 hoveredCapsuleId 驱动）。 */
  tooltipOpen?: boolean;
  /** Popover 主动关闭（Escape/外部点击）→ 父组件清 hovered。 */
  onTooltipDismiss?: () => void;
  onCapsuleEnter?: () => void;
  /** 点击展开的面板内容；在场时胶囊渲染为 button + Popover 触发器。 */
  popoverContent?: ReactNode;
  /**
   * 相位状态点（specs/usage-statusbar.md「Tooltip 增强」节 + 「Tooltip 稳定性」
   * 修复 2.3）：control.phase === "running" 时显影；**常驻槽位**——固定尺寸 span
   * 恒渲染、opacity 切换，不插拔（插拔会造成胶囊宽度突变杀悬停）。装饰件 aria-hidden。
   */
  pulse?: boolean;
  testId?: string;
  className?: string;
}

export function UsageStatusbarCapsule({
  label,
  icon,
  value,
  tone = "default",
  tooltip,
  tooltipOpen = false,
  onTooltipDismiss,
  onCapsuleEnter,
  popoverContent,
  pulse = false,
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
        <span aria-hidden="true" className="relative inline-flex shrink-0 [&>svg]:size-3.5">
          {icon}
          {/* 脉冲点常驻槽（修复 2.3 + 2026-10-19 二轮调紧）：图标右上角标绝对定位——
              零布局占用（不再撑开 icon 与值之间的间隙），恒渲染不插拔，opacity 切换显隐。 */}
          <span
            aria-hidden="true"
            className={cn(
              "absolute -right-1 -top-0.5 size-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none",
              pulse ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
      ) : null}
      {/* keyed span（specs/usage-statusbar.md「Tooltip 增强」节）：key = 值字符串，
          真实事实变更 → 重挂载 → styles.css 的 160ms 淡入（双闸）；值未变不重挂载、
          动画不重放。重挂载发生在父组件给的固定 min-w 槽位内，不改变条几何。 */}
      <span
        key={typeof value === "string" ? value : undefined}
        className="usage-statusbar-value-swap min-w-0 truncate"
      >
        {value}
      </span>
    </>
  );
  const tooltipContent = tooltip ? (
    <PopoverContent
      side="top"
      sideOffset={4}
      // pointer-events-none：明细只读、不参与命中（旧 tooltip 非 hoverable 语义），
      // 也避免浮层自身成为 pointerleave/enter 的目标干扰自管生命周期。
      className="pointer-events-none z-50 inline-flex w-fit max-w-72 flex-col items-start gap-1.5 rounded-lg border border-border bg-tooltip px-3 py-2 text-left text-ui-sm text-tooltip-foreground"
      data-testid="usage-statusbar-tooltip"
    >
      {/* 浮层标题 = text-ui-sm（DESIGN.md「Tooltip：titles … use text-ui-sm」）。 */}
      <span className="text-ui-sm font-medium">{label}</span>
      {tooltip}
    </PopoverContent>
  ) : null;

  if (!popoverContent) {
    const staticBody = (
      <span
        aria-label={label}
        className={bodyClass}
        data-testid={testId}
        role="status"
        onPointerEnter={tooltip ? onCapsuleEnter : undefined}
      >
        {body}
      </span>
    );
    if (!tooltipContent) return staticBody;
    return (
      <Popover
        open={tooltipOpen}
        onOpenChange={(next) => {
          // 只收 Popover 的主动关闭（Escape/外部点击）；开态与指针关闭路径归父组件。
          if (!next) onTooltipDismiss?.();
        }}
      >
        <PopoverAnchor asChild>{staticBody}</PopoverAnchor>
        {tooltipContent}
      </Popover>
    );
  }

  // 点击面板胶囊（子代理）：点击 Popover 不变；hover 明细退役——口径说明移入面板
  // 头部（specs/usage-statusbar.md「Tooltip 稳定性」节 2026-10-19）。
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className={bodyClass} data-testid={testId}>
          {body}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={4} className="w-auto gap-0 p-1.5">
        {popoverContent}
      </PopoverContent>
    </Popover>
  );
}

/** 浮层明细行：左标签右值，值区 mono 倾向。 */
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

/** 浮层口径说明段（弱化色小字）。 */
export function UsageStatusbarTooltipNote({ children }: { children: ReactNode }) {
  return (
    <span className="w-full border-t border-border pt-1.5 text-ui-xs leading-snug text-tooltip-foreground/70">
      {children}
    </span>
  );
}
