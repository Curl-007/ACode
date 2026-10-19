import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CalendarDays, Gauge, Layers, Sigma, Wrench } from "lucide-react";
import type { ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatUsageCount,
  formatUsageTokenCount,
  formatTokensPerSecond,
} from "@/v4/usage-statusbar/usageStatusbarFormat.js";
import {
  aggregateToolCallRows,
  buildSubagentSummaryView,
  classifyUsageSpeedTier,
  deriveLastCompletedTurnStats,
  deriveLastRequestTokensPerSecond,
  hasToolCallRows,
  resolveUsageStatusbarPresence,
  summarizeSessionCumulative,
} from "@/v4/usage-statusbar/usageStatusbarModel.js";
import { useTodayUsageTotals } from "@/v4/usage-statusbar/useTodayUsageTotals.js";
import { useUsageStatusbarPreferences } from "@/v4/usage-statusbar/useUsageStatusbarPreferences.js";
import {
  UsageStatusbarCapsule,
  type UsageStatusbarTone,
} from "@/v4/usage-statusbar/UsageStatusbarCapsule.js";
import { UsageStatusbarSettingsPopover } from "@/v4/usage-statusbar/UsageStatusbarSettingsPopover.js";
import { UsageSubagentPanel } from "@/v4/usage-statusbar/UsageSubagentPanel.js";
import {
  SessionTooltipContent,
  SpeedTooltipContent,
  TodayTooltipContent,
  ToolsTooltipContent,
  TurnUsageTooltipContent,
} from "@/v4/usage-statusbar/UsageStatusbarTooltips.js";

// 用量状态栏（specs/usage-statusbar.md「状态栏」节）：七胶囊条状布局，逐项可显隐。
// 每窗口绑定纪律：本组件只消费 props 传入的**本窗口活动会话** snapshot（宿主从本窗口
// conversationProjectionStore 取），自身不查任何 store/session 索引、不做跨会话兜底。
// 空态 = hide-on-absent（specs/usage-statusbar.md「hide-on-absent 空态规则」节）：
// 数据源缺席的胶囊不渲染（snapshot=null 只剩设置齿轮），零值 ≠ 缺席照常显示；
// 判定单一所有者是 usageStatusbarPresence.resolveUsageStatusbarPresence（model re-export），
// 本组件不做内联启发式。
// 窄屏分级隐藏（同 spec「窄屏分级隐藏优先级」节）：容器查询挂 composer 命名容器，
// 先藏今日合计→子智能体→生成速度→工具调用→会话累计，本轮用量与齿轮保留到最后。
// tooltip 明细内容组装在同目录 UsageStatusbarTooltips.tsx。
// 上下文容量项不在此条上——由既有 composer 上下文环承载（chat-input-toolbar/contextUsage.tsx）。
//
// 悬停生命周期自管（spec「Tooltip 稳定性」2026-10-19 最小修复，核心不变量）：
// **指针静止 = 无 mousemove/pointermove = 明细常驻**。流式几何位移（值 tick/脉冲/
// presence 插入/整条 bar 纵向推移）会把胶囊从静止指针下推走，浏览器补发边界事件；
// 开 = 胶囊 pointerenter（位移后落到新胶囊也自然接续），关仅三条路径：
// ① pointerleave 且 relatedTarget 在整条 bar 外；② bar 自身 pointermove（指针停进
// 胶囊间隙）；③ Popover 主动关闭（Escape/外部点击）。Radix Tooltip 的 pointermove
// 重开门与其关闭路径全部不再参与。

const EMPTY_ROWS: never[] = [];

/** 容器查询分级隐藏（Tailwind v4 命名容器任意值语法，@container/composer 在 Composer 根）。 */
const CAPSULE_HIDE_TIER_1 = "@max-[520px]/composer:hidden";
const CAPSULE_HIDE_TIER_2 = "@max-[420px]/composer:hidden";

/** 布局稳定规则 2（spec「Tooltip 稳定性」修复 2）：每胶囊固定 min-w 槽位，典型值
 * tick 在槽内变化不推挤邻居（tabular-nums 既有）；工具槽按「计数 · N 运行中」后缀档预留。 */
const CAPSULE_MIN_WIDTH = {
  generationSpeed: "min-w-[6.5rem]",
  turnUsage: "min-w-[4.5rem]",
  sessionCumulative: "min-w-[5rem]",
  toolCalls: "min-w-[7rem]",
  todayTotal: "min-w-[5rem]",
  subagents: "min-w-[4.5rem]",
} as const;

export interface UsageStatusbarProps {
  /** 本窗口活动会话的 v4 快照；null = 无活动会话（hide-on-absent，只留齿轮）。 */
  snapshot: ConversationSnapshot | null;
  className?: string;
}

export function UsageStatusbar({ snapshot, className }: UsageStatusbarProps) {
  const { intl, locale } = useACodeIntl();
  const preferences = useUsageStatusbarPreferences();
  const rows = snapshot?.rows.window ?? EMPTY_ROWS;
  const usage = snapshot?.usage ?? null;

  const speed = useMemo(
    () => deriveLastRequestTokensPerSecond(usage?.lastRequest ?? null),
    [usage?.lastRequest],
  );
  const speedTier = classifyUsageSpeedTier(speed);
  const cumulative = useMemo(() => summarizeSessionCumulative(usage, rows), [usage, rows]);
  const lastTurnStats = useMemo(() => deriveLastCompletedTurnStats(rows), [rows]);
  const tools = useMemo(() => aggregateToolCallRows(rows), [rows]);
  const subagents = useMemo(
    () => buildSubagentSummaryView(snapshot?.subagents ?? null),
    [snapshot?.subagents],
  );
  const today = useTodayUsageTotals({ snapshot, enabled: preferences.visibleItems.todayTotal });

  const lastRequest = usage?.lastRequest ?? null;
  // hide-on-absent 判定（纯函数单点；用户显式开关与此正交）。
  const presence = useMemo(
    () =>
      resolveUsageStatusbarPresence({
        usage,
        lastRequest,
        lastTurnStats,
        hasToolCallRows: hasToolCallRows(rows),
        todayTotals: today.totals,
        subagents: snapshot?.subagents ?? null,
      }),
    [usage, lastRequest, lastTurnStats, rows, today.totals, snapshot?.subagents],
  );
  // 相位指示：只消费请求边界事实（running 与否），不做流式估算（spec 口径 4 红线）。
  const phaseRunning = snapshot?.control.phase === "running";

  const speedTone: UsageStatusbarTone =
    speedTier === "fast" ? "success" : speedTier === "slow" ? "warning" : "default";
  // tok/s 单位后缀走 i18n（specs/usage-statusbar.md「排版一致性」节，双语同值）。
  const tokensPerSecondUnit = intl.formatMessage({
    id: "chat.usageStatusbar.unit.tokensPerSecond",
  });

  const visible = preferences.visibleItems;

  // ── 自管 hover 生命周期（spec「Tooltip 稳定性」2026-10-19 最小修复）──
  const barRef = useRef<HTMLDivElement | null>(null);
  const [hoveredCapsuleId, setHoveredCapsuleId] = useState<string | null>(null);
  const dismissHover = useCallback(() => setHoveredCapsuleId(null), []);
  const enterCapsule = useCallback((id: string) => setHoveredCapsuleId(id), []);
  // 核心不变量：指针静止 = 明细常驻。布局位移（值 tick/脉冲/presence 插入/整条 bar
  // 纵向推移）补发的 pointerleave/pointerenter 边界事件一律不作关闭依据——开/切换只认
  // pointerenter（位移后落到新胶囊自然接续），关闭只认两条真实指针路径：
  // ① 打开期间 window mousemove 命中测试落在整条 bar 当前 rect 之外（真移走）；
  // ② Popover 主动关闭（Escape/外部点击，经 onTooltipDismiss）。
  // 静止指针不产生 mousemove → 任何几何突变都不关闭（2026-10-19 二轮录证修正：
  // 首版用 pointerleave+relatedTarget 判定，composer 高度变化把 bar 纵向推离静止
  // 指针时仍误关一次，post-hoverfix-run1.jsonl +5.9s 实证）。
  const hoverOpen = hoveredCapsuleId !== null;
  useEffect(() => {
    if (!hoverOpen) return;
    const handleMove = (event: MouseEvent) => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        setHoveredCapsuleId(null);
      }
    };
    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
  }, [hoverOpen]);

  return (
    <div
      ref={barRef}
      className={cn(
        "flex h-7 min-w-0 items-center gap-0.5 overflow-hidden px-1 text-ui-sm",
        className,
      )}
      data-testid="usage-statusbar"
    >
      {/* 布局稳定规则 1：稳定 key = 项 id，条件渲染不依赖数组位置。 */}
      {visible.generationSpeed && presence.generationSpeed ? (
        <UsageStatusbarCapsule
          key="generationSpeed"
          className={cn(CAPSULE_HIDE_TIER_2, CAPSULE_MIN_WIDTH.generationSpeed)}
          icon={<Gauge />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.speed.label" })}
          onCapsuleEnter={() => enterCapsule("generationSpeed")}
          onTooltipDismiss={dismissHover}
          pulse={phaseRunning}
          testId="usage-statusbar-speed"
          tone={speedTone}
          tooltip={<SpeedTooltipContent lastRequest={lastRequest} />}
          tooltipOpen={hoveredCapsuleId === "generationSpeed"}
          value={formatTokensPerSecond(locale, speed, tokensPerSecondUnit)}
        />
      ) : null}
      {visible.turnUsage && presence.turnUsage ? (
        <UsageStatusbarCapsule
          key="turnUsage"
          className={CAPSULE_MIN_WIDTH.turnUsage}
          icon={<Sigma />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.label" })}
          onCapsuleEnter={() => enterCapsule("turnUsage")}
          onTooltipDismiss={dismissHover}
          testId="usage-statusbar-turn-usage"
          tooltip={<TurnUsageTooltipContent stats={lastTurnStats} />}
          tooltipOpen={hoveredCapsuleId === "turnUsage"}
          value={formatUsageTokenCount(
            locale,
            lastTurnStats ? lastTurnStats.inputTokens + lastTurnStats.outputTokens : null,
          )}
        />
      ) : null}
      {visible.sessionCumulative && presence.sessionCumulative ? (
        <UsageStatusbarCapsule
          key="sessionCumulative"
          className={cn(CAPSULE_HIDE_TIER_2, CAPSULE_MIN_WIDTH.sessionCumulative)}
          icon={<Layers />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.session.label" })}
          onCapsuleEnter={() => enterCapsule("sessionCumulative")}
          onTooltipDismiss={dismissHover}
          testId="usage-statusbar-session"
          tooltip={<SessionTooltipContent cumulative={cumulative} />}
          tooltipOpen={hoveredCapsuleId === "sessionCumulative"}
          value={formatUsageTokenCount(locale, cumulative.totalTokens)}
        />
      ) : null}
      {visible.toolCalls && presence.toolCalls ? (
        <UsageStatusbarCapsule
          key="toolCalls"
          className={cn(CAPSULE_HIDE_TIER_2, CAPSULE_MIN_WIDTH.toolCalls)}
          icon={<Wrench />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.tools.label" })}
          onCapsuleEnter={() => enterCapsule("toolCalls")}
          onTooltipDismiss={dismissHover}
          pulse={tools.activeCount > 0}
          testId="usage-statusbar-tools"
          tone={tools.errorCount > 0 ? "destructive" : "default"}
          tooltip={<ToolsTooltipContent tools={tools} />}
          tooltipOpen={hoveredCapsuleId === "toolCalls"}
          value={
            tools.errorCount > 0
              ? `${formatUsageCount(locale, tools.totalCount)} · ${intl.formatMessage(
                  { id: "chat.usageStatusbar.tools.errors" },
                  { count: tools.errorCount },
                )}`
              : tools.activeCount > 0
                ? `${formatUsageCount(locale, tools.totalCount)} · ${intl.formatMessage(
                    { id: "chat.usageStatusbar.tools.running" },
                    { count: tools.activeCount },
                  )}`
                : formatUsageCount(locale, tools.totalCount)
          }
        />
      ) : null}
      {visible.todayTotal && presence.todayTotal ? (
        <UsageStatusbarCapsule
          key="todayTotal"
          className={cn(CAPSULE_HIDE_TIER_1, CAPSULE_MIN_WIDTH.todayTotal)}
          icon={<CalendarDays />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.today.label" })}
          onCapsuleEnter={() => enterCapsule("todayTotal")}
          onTooltipDismiss={dismissHover}
          testId="usage-statusbar-today"
          tooltip={<TodayTooltipContent totals={today.totals} />}
          tooltipOpen={hoveredCapsuleId === "todayTotal"}
          value={formatUsageTokenCount(locale, today.totals?.totalTokens ?? null)}
        />
      ) : null}
      {visible.subagents && presence.subagents ? (
        <UsageStatusbarCapsule
          key="subagents"
          className={cn(CAPSULE_HIDE_TIER_1, CAPSULE_MIN_WIDTH.subagents)}
          icon={<Bot />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.subagents.label" })}
          popoverContent={
            <UsageSubagentPanel
              locale={locale}
              mainTotalTokens={cumulative.totalTokens}
              view={subagents}
            />
          }
          testId="usage-statusbar-subagents"
          value={formatUsageTokenCount(locale, subagents.childTotalTokens)}
        />
      ) : null}
      <span className="ml-auto inline-flex shrink-0">
        <UsageStatusbarSettingsPopover />
      </span>
    </div>
  );
}
