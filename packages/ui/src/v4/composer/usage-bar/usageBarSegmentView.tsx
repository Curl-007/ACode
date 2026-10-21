/**
 * 用量状态栏的展示层（apps/acode-cli/specs/usage-statusbar-port.md §2.1/R5）。
 *
 * 从 `UsageStatusBar.tsx` 拆出的兄弟模块：段行的图标/环形进度、错误徽标、语气着色、
 * 闪烁，以及悬停明细的键值行与「+N」浮层。这里不读 snapshot、不读设置：入参只有模型层
 * 给出的段数据。
 */
import type { ReactNode } from "react";
import { BotIcon, CalendarIcon, GaugeIcon, LayersIcon, SigmaIcon, WrenchIcon } from "lucide-react";
import { TID_V4_COMPOSER_USAGE_BAR_SEGMENT } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import type { UsageBarDetailRow, UsageBarSegment, UsageBarSegmentId } from "./usageBarModel.js";
import { UsageBarErrorBadge } from "./UsageBarErrorBadge.js";
import { UsageBarHoverDetail, type UsageBarDetailGroup } from "./UsageBarHoverDetail.js";

const SEGMENT_ICONS: Record<Exclude<UsageBarSegmentId, "context">, typeof GaugeIcon> = {
  speed: GaugeIcon,
  turnUsage: SigmaIcon,
  session: LayersIcon,
  tools: WrenchIcon,
  today: CalendarIcon,
  subagents: BotIcon,
};

/** 折叠档位对应的容器查询类：命中时该段 display:none（先收容量/今日/本轮，再收子智能体/工具）。 */
const SEGMENT_COLLAPSE_CLASS: Partial<Record<UsageBarSegmentId, string>> = {
  context: "@max-[639px]/usagebar:hidden",
  today: "@max-[639px]/usagebar:hidden",
  turnUsage: "@max-[639px]/usagebar:hidden",
  subagents: "@max-[479px]/usagebar:hidden",
  tools: "@max-[479px]/usagebar:hidden",
};

/**
 * 每段的最小槽位（spec §6.1.2）：按典型值紧档预留、`tabular-nums`，
 * 段值 tick 时只在槽内变化，不推挤邻居。瞬态超槽允许一次性变宽（不为了稳定留大片空白）。
 * `context` 单独给槽（环形 16px + 三位百分比）；`speed`/`session` 永不收起。
 */
const SEGMENT_MIN_WIDTH_CLASS: Record<UsageBarSegmentId, string> = {
  speed: "min-w-[4.5rem]",
  turnUsage: "min-w-[3rem]",
  context: "min-w-[3.25rem]",
  session: "min-w-[3.5rem]",
  tools: "min-w-[2rem]",
  today: "min-w-[2.5rem]",
  subagents: "min-w-[2rem]",
};

function toneClass(tone: UsageBarSegment["tone"]): string {
  if (tone === "live" || tone === "success") return "text-success";
  if (tone === "warning") return "text-warning";
  if (tone === "error") return "text-destructive";
  if (tone === "estimated") return "text-foreground-subtlest";
  return "";
}

function detailToneClass(tone: UsageBarDetailRow["tone"]): string {
  if (tone === "error") return "text-destructive";
  if (tone === "warning") return "text-warning";
  if (tone === "success" || tone === "live") return "text-success";
  return "text-foreground";
}

export function UsageBarSegmentView({
  segment,
  detail,
  detailGroup,
}: {
  segment: UsageBarSegment;
  /** 覆盖默认键值明细（子智能体段传任务级面板）。 */
  detail?: (state: { pinned: boolean }) => ReactNode;
  /** 明细互斥组：同一时刻只展开一个（见 UsageBarHoverDetail 注释）。 */
  detailGroup?: UsageBarDetailGroup;
}) {
  const Icon = segment.id === "context" ? null : SEGMENT_ICONS[segment.id];
  return (
    <UsageBarHoverDetail
      content={detail ?? <UsageBarSegmentTooltip segment={segment} />}
      className="min-w-[240px]"
      detailId={segment.id}
      {...(detailGroup ? { detailGroup } : {})}
    >
      <span
        data-testid={TID_V4_COMPOSER_USAGE_BAR_SEGMENT}
        data-segment={segment.id}
        data-tone={segment.tone}
        tabIndex={0}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap",
          toneClass(segment.tone),
          segment.blink && "motion-safe:animate-pulse motion-reduce:animate-none",
          SEGMENT_COLLAPSE_CLASS[segment.id],
          SEGMENT_MIN_WIDTH_CLASS[segment.id],
        )}
      >
        {/*
          图标槽（spec §6.1.3）：脉冲点改为绝对定位角标、恒渲染不插拔——零布局占用，
          只切 opacity。条件渲染会在 flex 流内占位，段值 tick 时整条 bar 横向抖动。
        */}
        <span aria-hidden="true" className="relative inline-flex shrink-0">
          {segment.ring !== undefined ? (
            <UsageBarCapacityRing ratio={segment.ring.ratio} />
          ) : Icon ? (
            <Icon aria-hidden className="size-3.5" />
          ) : null}
          <span
            aria-hidden="true"
            className={cn(
              "absolute -right-1 -top-0.5 size-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none",
              segment.dot === "live" ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
        <span
          className={cn(
            segment.tone === "estimated" &&
              "border-b border-dotted border-foreground-subtlest pb-px",
          )}
        >
          {segment.value}
        </span>
        {segment.badge !== undefined ? <UsageBarErrorBadge badge={segment.badge} /> : null}
      </span>
    </UsageBarHoverDetail>
  );
}

/** 上下文容量环形进度：16×16 / stroke 3 / pathLength=100 / 12 点起（rotate -90）。 */
function UsageBarCapacityRing({ ratio }: { ratio: number }) {
  const filled = Math.min(100, Math.max(0, ratio * 100));
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      data-testid="v4-composer-usage-bar-capacity-ring"
      className="size-4 shrink-0 fill-none stroke-[3]"
    >
      {/* 轨道与进度都取 currentColor：颜色只由段语气决定，深浅主题各自取 token。 */}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity={0.2} />
      <circle
        cx="12"
        cy="12"
        r="9"
        pathLength={100}
        strokeDasharray={`${filled} 100`}
        transform="rotate(-90 12 12)"
        strokeLinecap="round"
        stroke="currentColor"
      />
    </svg>
  );
}

/** 段明细：键值行 + 一行小字口径。 */
function UsageBarSegmentTooltip({ segment }: { segment: UsageBarSegment }) {
  return (
    <div className="space-y-1.5 py-0.5">
      <div className="text-ui-base font-semibold text-foreground">{segment.label}</div>
      {segment.detailRows.length > 0 ? (
        <div className="space-y-1">
          {segment.detailRows.map((row) => (
            <UsageBarDetailRowView key={row.label} row={row} />
          ))}
        </div>
      ) : null}
      {segment.note ? (
        <p className="border-t border-border pt-1.5 text-ui-xs leading-relaxed text-foreground-subtle">
          {segment.note}
        </p>
      ) : null}
    </div>
  );
}

function UsageBarDetailRowView({ row }: { row: UsageBarDetailRow }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-foreground-subtle">{row.label}</span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("font-mono font-medium tabular-nums", detailToneClass(row.tone))}>
          {row.value}
        </span>
        {row.badge !== undefined ? <UsageBarErrorBadge badge={row.badge} /> : null}
      </span>
    </div>
  );
}

/** 窄宽折叠后剩在「+N」里的段：只列标签与段值。 */
export function UsageBarMoreTooltip({
  segments,
}: {
  segments: readonly UsageBarSegment[];
}): ReactNode {
  return (
    <div className="space-y-0.5 py-0.5">
      {segments.map((segment) => (
        <div key={segment.id} className="flex items-center justify-between gap-4">
          <span className="text-foreground-subtle">{segment.label}</span>
          <span className="font-mono tabular-nums">{segment.value}</span>
        </div>
      ))}
    </div>
  );
}
