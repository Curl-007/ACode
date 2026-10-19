import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";

// 状态栏胶囊（纯展示件，2026-10-19 微标签形态）：icon + 文字微标签 + 值；可选点击
// 展开 popover（子智能体面板，受控 open 供宿主做统一面板互斥）。
// 胶囊级 Tooltip 已退役（specs/usage-statusbar.md「Tooltip 稳定性与统一明细面板」节）：
// 明细统一进整条 bar 悬停的「用量明细」面板，胶囊不再各自包 Tooltip。
// 数值区 tabular-nums/mono 倾向（DESIGN.md「Chat, Tooling, and Developer UI」）；
// 胶囊形状用 rounded-md 文本 chip——rounded-full 保留给刻意 pill 形（DESIGN.md §Radius）。
// popover 浮层规范照 §Menus, Popovers（bg-popover 组件默认）。

export type UsageStatusbarTone = "default" | "success" | "warning" | "destructive";

const TONE_CLASS: Record<UsageStatusbarTone, string> = {
  default: "text-foreground-subtle",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

export interface UsageStatusbarCapsuleProps {
  /** 项全名：aria-label 与统一面板分组语义（微标签用 shortLabel，不上全名保持条状紧凑）。 */
  label: string;
  /** 文字微标签（新 i18n key *.shortLabel）：text-ui-xs 弱化色，恒定文案不随值变化。 */
  shortLabel: string;
  icon?: ReactNode;
  value: ReactNode;
  tone?: UsageStatusbarTone;
  /** 点击展开的面板内容；在场时胶囊渲染为 button + Popover 触发器。 */
  popoverContent?: ReactNode;
  /** 受控 popover open（宿主做统一面板互斥）；缺席 = 非受控。 */
  popoverOpen?: boolean;
  onPopoverOpenChange?: (open: boolean) => void;
  /**
   * 相位状态点显隐（specs/usage-statusbar.md「面板明细与实时动态显示口径」节）：
   * 只表达请求边界/权威聚合事实（control.phase、工具 activeCount、本轮 live 在场），
   * 不伪造实时速率；装饰件 aria-hidden。
   */
  pulse?: boolean;
  /**
   * 脉冲点常驻槽位（「Tooltip 稳定性与统一明细面板」节布局稳定规则 3）：
   * true = 固定尺寸 span 恒渲染占位，opacity 切换显隐，绝不条件插拔——插拔会改变
   * 胶囊几何，流式期间把邻居与 hover 命中目标推移。
   */
  pulseSlot?: boolean;
  testId?: string;
  className?: string;
}

export function UsageStatusbarCapsule({
  label,
  shortLabel,
  icon,
  value,
  tone = "default",
  popoverContent,
  popoverOpen,
  onPopoverOpenChange,
  pulse = false,
  pulseSlot = false,
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
      {pulseSlot ? (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-success",
            // 常驻槽位：显隐只切 opacity（motion-reduce 关脉冲动画，槽位占位不变）。
            pulse ? "opacity-100 animate-pulse motion-reduce:animate-none" : "opacity-0",
          )}
        />
      ) : null}
      <span className="shrink-0 text-ui-xs font-normal text-foreground-subtlest">{shortLabel}</span>
      {/* keyed span（specs/usage-statusbar.md「面板明细与实时动态显示口径」节）：
          key = 值字符串，真实事实变更 → 重挂载 → styles.css 的 160ms 淡入（双闸）；
          值未变 → 同 key 不重挂载、动画不重放（流式高频 re-render 下零动画开销）。
          重挂载发生在固定 min-w 槽位内，不改变条几何（布局稳定规则 4）。 */}
      <span
        key={typeof value === "string" ? value : undefined}
        className="usage-statusbar-value-swap min-w-0 truncate"
      >
        {value}
      </span>
    </>
  );

  if (!popoverContent) {
    return (
      <span aria-label={label} className={bodyClass} data-testid={testId} role="status">
        {body}
      </span>
    );
  }

  const triggerButton = (
    <button
      type="button"
      aria-label={label}
      className={bodyClass}
      data-testid={testId}
      // 自带 Popover 的胶囊点击不参与统一面板「钉住」切换（bar onClick 由此标记豁免）。
      data-usage-statusbar-no-pin=""
    >
      {body}
    </button>
  );
  return (
    <Popover
      {...(popoverOpen !== undefined
        ? { open: popoverOpen, onOpenChange: onPopoverOpenChange }
        : {})}
    >
      <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={4} className="w-auto gap-0 p-1.5">
        {popoverContent}
      </PopoverContent>
    </Popover>
  );
}

/** 明细行：左标签右值，值区 mono 倾向（统一面板分组复用）。 */
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

/** 口径说明段（弱化色小字，统一面板分组脚注复用）。 */
export function UsageStatusbarTooltipNote({ children }: { children: ReactNode }) {
  return (
    <span className="w-full border-t border-border pt-1.5 text-ui-xs leading-snug text-tooltip-foreground/70">
      {children}
    </span>
  );
}
