import { useMemo } from "react";
import { Bot, CalendarDays, Gauge, Layers, Sigma, Wrench } from "lucide-react";
import type { ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatTokensPerSecond,
  formatUsageCount,
  formatUsageDurationMs,
  formatUsageTokenCount,
  USAGE_NO_DATA_PLACEHOLDER,
} from "@/v4/usage-statusbar/usageStatusbarFormat.js";
import {
  aggregateToolCallRows,
  buildSubagentSummaryView,
  classifyUsageSpeedTier,
  deriveLastCompletedTurnStats,
  deriveLastRequestTokensPerSecond,
  deriveRunningTurnStartedAtMs,
  deriveUsageInFlightLiveView,
  hasToolCallRows,
  resolveUsageSpeedDisplayMode,
  resolveUsageStatusbarPresence,
  summarizeSessionCumulative,
} from "@/v4/usage-statusbar/usageStatusbarModel.js";
import { useStopwatchElapsedMs } from "@/v4/usage-statusbar/useStopwatchElapsedMs.js";
import { useTodayUsageTotals } from "@/v4/usage-statusbar/useTodayUsageTotals.js";
import { useUsageDetailPanelOpen } from "@/v4/usage-statusbar/useUsageDetailPanelOpen.js";
import { useUsageStatusbarPreferences } from "@/v4/usage-statusbar/useUsageStatusbarPreferences.js";
import {
  UsageStatusbarCapsule,
  type UsageStatusbarTone,
} from "@/v4/usage-statusbar/UsageStatusbarCapsule.js";
import { UsageStatusbarDetailPanel } from "@/v4/usage-statusbar/UsageStatusbarDetailPanel.js";
import { UsageStatusbarSettingsPopover } from "@/v4/usage-statusbar/UsageStatusbarSettingsPopover.js";
import { UsageSubagentPanel } from "@/v4/usage-statusbar/UsageSubagentPanel.js";

// 用量状态栏（specs/usage-statusbar.md「状态栏」+「Tooltip 稳定性与统一明细面板」节，
// 2026-10-19 重设计）：六胶囊 = icon + 微标签 + 值，逐项可显隐；六个胶囊级 tooltip
// 已退役，明细统一进整条 bar 悬停/钉住的「用量明细」受控 Popover 面板（open 状态
// 管理与位置命中测试在 useUsageDetailPanelOpen，核心不变量注释见该文件）。
// 每窗口绑定纪律：本组件只消费 props 传入的**本窗口活动会话** snapshot（宿主从本窗口
// conversationProjectionStore 取），自身不查任何 store/session 索引、不做跨会话兜底。
// 空态 = hide-on-absent（「hide-on-absent 空态规则」节）：数据源缺席的胶囊不渲染
// （snapshot=null 只剩设置齿轮），零值 ≠ 缺席照常显示；判定单一所有者是
// usageStatusbarPresence.resolveUsageStatusbarPresence（model re-export）。
// 上下文容量项不在此条上——由既有 composer 上下文环承载（chat-input-toolbar/contextUsage.tsx，
// running 态 announcedInputTokens 展示值覆盖单点在 v4/composer/V4ComposerToolbar 映射处）。

const EMPTY_ROWS: never[] = [];

// 容器查询分级隐藏（2026-10-19 微标签形态后按 min-w 槽位预算重调，优先级次序不变：
// 先藏今日→子代理，再藏速度→工具→会话，本轮 + 齿轮恒驻）。预算口径 = 各胶囊固定
// min-w 档（见 CAPSULE_MIN_WIDTH）+ 齿轮 24px + gap-0.5×7 + px-1：
// 六胶囊全量 ≈ 612+24+14+8 ≈ 658 → 一级断点 660px；藏今日/子代理后 ≈ 470 → 二级 470px。
const CAPSULE_HIDE_TIER_1 = "@max-[660px]/composer:hidden";
const CAPSULE_HIDE_TIER_2 = "@max-[470px]/composer:hidden";

// 每胶囊固定 min-w 槽位（「布局稳定规则」2）：按「微标签 + 典型值」宽度选档，
// 值 tick 在槽内变化不推挤邻居（配合 tabular-nums）；微标签为恒定文案不随值变化。
const CAPSULE_MIN_WIDTH = {
  /** icon + 微标签 + 脉冲槽 + "52.3 tok/s"/"生成中 · 12s" 档。 */
  generationSpeed: "min-w-[8.5rem]",
  /** icon + 微标签 + 脉冲槽 + compact 合计（"120K"）。 */
  turnUsage: "min-w-[6.25rem]",
  /** icon + 微标签（en "Session" 最宽）+ compact 值。 */
  sessionCumulative: "min-w-[6.5rem]",
  /** icon + 微标签 + 脉冲槽 + 计数（错误/运行中后缀为事件驱动的一次性变宽）。 */
  toolCalls: "min-w-[5.5rem]",
  /** icon + 微标签 + compact 值。 */
  todayTotal: "min-w-[5.5rem]",
  /** icon + 微标签（"子代理"/"Agents"）+ compact 值。 */
  subagents: "min-w-[6rem]",
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
  const inFlight = usage?.inFlight ?? null;
  // 相位指示：只消费请求边界事实（running 与否）；live 数字全部来自 producer 下发的
  // inFlight 事实（spec「面板明细与实时动态显示口径」节），UI 端零估算。
  const phaseRunning = snapshot?.control.phase === "running";

  // ── live 派生（usageStatusbarInFlight 纯函数单点；空闲态相位门在此收口）──
  // 依赖 = inFlight 对象身份（conflated 状态，值未变不重复下发）→ 事件驱动重算，
  // 严禁 UI 定时器重算速率（口径 4 红线改写版）。
  const live = useMemo(
    () => deriveUsageInFlightLiveView({ phaseRunning, inFlight }),
    [phaseRunning, inFlight],
  );
  const inFlightActive = phaseRunning && inFlight != null;

  const speed = useMemo(
    () => deriveLastRequestTokensPerSecond(usage?.lastRequest ?? null),
    [usage?.lastRequest],
  );
  // 速度胶囊三态（spec 口径 4 两档 + 空闲权威值）：live 事实 → 进行中 tok/s；
  // running 无事实 → 「生成中 · 已耗时」秒表降级（绝不显示假速率）；空闲 → 权威值。
  const speedMode = resolveUsageSpeedDisplayMode({
    phaseRunning,
    liveTokensPerSecond: live.liveTokensPerSecond,
  });
  // 秒表起点：inFlight.startedAtMs（请求起点）优先；provider 无中途事实时兜底
  // running turnHeader.startedAt（投影权威时间戳）；无起点 → 占位，不猜。
  const stopwatchStartedAtMs = useMemo(
    () => (inFlight ? live.startedAtMs : deriveRunningTurnStartedAtMs(rows)),
    [inFlight, live.startedAtMs, rows],
  );
  const speedStopwatchMs = useStopwatchElapsedMs({
    startedAtMs: stopwatchStartedAtMs,
    // 1Hz 定时器仅在速度位真处于秒表降级档时挂载（live/空闲档不挂）。
    active: speedMode === "stopwatch",
  });
  const speedTier = classifyUsageSpeedTier(
    speedMode === "live" ? live.liveTokensPerSecond : speedMode === "authoritative" ? speed : null,
  );
  const speedTone: UsageStatusbarTone =
    speedTier === "fast" ? "success" : speedTier === "slow" ? "warning" : "default";
  // tok/s 单位后缀走 i18n（specs/usage-statusbar.md「排版一致性」节，双语同值）。
  const tokensPerSecondUnit = intl.formatMessage({
    id: "chat.usageStatusbar.unit.tokensPerSecond",
  });
  const speedValue =
    speedMode === "live"
      ? formatTokensPerSecond(locale, live.liveTokensPerSecond, tokensPerSecondUnit)
      : speedMode === "stopwatch"
        ? intl.formatMessage(
            { id: "chat.usageStatusbar.speed.generating" },
            {
              seconds:
                speedStopwatchMs !== null
                  ? formatUsageDurationMs(locale, speedStopwatchMs)
                  : USAGE_NO_DATA_PLACEHOLDER,
            },
          )
        : formatTokensPerSecond(locale, speed, tokensPerSecondUnit);

  const cumulative = useMemo(() => summarizeSessionCumulative(usage, rows), [usage, rows]);
  const lastTurnStats = useMemo(() => deriveLastCompletedTurnStats(rows), [rows]);
  const tools = useMemo(() => aggregateToolCallRows(rows), [rows]);
  const subagents = useMemo(
    () => buildSubagentSummaryView(snapshot?.subagents ?? null),
    [snapshot?.subagents],
  );
  // 今日合计取数不再受胶囊显隐偏好门控：统一面板分组恒全量（偏好只治 bar，spec
  // 「Tooltip 稳定性与统一明细面板」节），胶囊隐藏时面板今日分组仍要有事实。
  const today = useTodayUsageTotals({ snapshot, enabled: true });

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

  // 本轮胶囊 running 态（spec 裁决 3）：turnToDate live 事实在场 → live 合计 +
  // 进行中脉冲标记；缺席 → 维持上一轮权威值且**不加**标记；TurnComplete 后
  // inFlight=null 自然回落权威 stats。
  const turnLiveActive = live.turnToDateTotalTokens !== null;
  const turnValue = formatUsageTokenCount(
    locale,
    turnLiveActive
      ? live.turnToDateTotalTokens
      : lastTurnStats
        ? lastTurnStats.inputTokens + lastTurnStats.outputTokens
        : null,
  );

  // ── 统一面板受控 open（bar 级 hover + 点击钉住 + mousemove 命中测试关闭）──
  const panel = useUsageDetailPanelOpen();

  const visible = preferences.visibleItems;
  return (
    <Popover modal={false} onOpenChange={panel.handlePanelOpenChange} open={panel.panelOpen}>
      <PopoverAnchor asChild>
        <div
          ref={panel.barRef}
          className={cn(
            "flex h-7 min-w-0 items-center gap-0.5 overflow-hidden px-1 text-ui-sm",
            className,
          )}
          data-testid="usage-statusbar"
          onClick={panel.handleBarClick}
          onMouseEnter={panel.handleBarMouseEnter}
        >
          {/* 每胶囊稳定 key = 项 id（布局稳定规则 1，同 USAGE_STATUSBAR_ITEM_IDS）。 */}
          {visible.generationSpeed && presence.generationSpeed ? (
            <UsageStatusbarCapsule
              key="generationSpeed"
              className={cn(CAPSULE_HIDE_TIER_2, CAPSULE_MIN_WIDTH.generationSpeed)}
              icon={<Gauge />}
              label={intl.formatMessage({ id: "chat.usageStatusbar.speed.label" })}
              pulse={phaseRunning}
              pulseSlot
              shortLabel={intl.formatMessage({ id: "chat.usageStatusbar.speed.shortLabel" })}
              testId="usage-statusbar-speed"
              tone={speedTone}
              value={speedValue}
            />
          ) : null}
          {visible.turnUsage && presence.turnUsage ? (
            <UsageStatusbarCapsule
              key="turnUsage"
              className={cn(CAPSULE_MIN_WIDTH.turnUsage)}
              icon={<Sigma />}
              label={intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.label" })}
              pulse={turnLiveActive}
              pulseSlot
              shortLabel={intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.shortLabel" })}
              testId="usage-statusbar-turn-usage"
              value={turnValue}
            />
          ) : null}
          {visible.sessionCumulative && presence.sessionCumulative ? (
            <UsageStatusbarCapsule
              key="sessionCumulative"
              className={cn(CAPSULE_HIDE_TIER_2, CAPSULE_MIN_WIDTH.sessionCumulative)}
              icon={<Layers />}
              label={intl.formatMessage({ id: "chat.usageStatusbar.session.label" })}
              shortLabel={intl.formatMessage({ id: "chat.usageStatusbar.session.shortLabel" })}
              testId="usage-statusbar-session"
              value={formatUsageTokenCount(locale, cumulative.totalTokens)}
            />
          ) : null}
          {visible.toolCalls && presence.toolCalls ? (
            <UsageStatusbarCapsule
              key="toolCalls"
              className={cn(CAPSULE_HIDE_TIER_2, CAPSULE_MIN_WIDTH.toolCalls)}
              icon={<Wrench />}
              label={intl.formatMessage({ id: "chat.usageStatusbar.tools.label" })}
              pulse={tools.activeCount > 0}
              pulseSlot
              shortLabel={intl.formatMessage({ id: "chat.usageStatusbar.tools.shortLabel" })}
              testId="usage-statusbar-tools"
              tone={tools.errorCount > 0 ? "destructive" : "default"}
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
              shortLabel={intl.formatMessage({ id: "chat.usageStatusbar.today.shortLabel" })}
              testId="usage-statusbar-today"
              value={formatUsageTokenCount(locale, today.totals?.totalTokens ?? null)}
            />
          ) : null}
          {visible.subagents && presence.subagents ? (
            <UsageStatusbarCapsule
              key="subagents"
              className={cn(CAPSULE_HIDE_TIER_1, CAPSULE_MIN_WIDTH.subagents)}
              icon={<Bot />}
              label={intl.formatMessage({ id: "chat.usageStatusbar.subagents.label" })}
              onPopoverOpenChange={panel.handleSubagentOpenChange}
              popoverContent={
                <UsageSubagentPanel
                  locale={locale}
                  mainTotalTokens={cumulative.totalTokens}
                  view={subagents}
                />
              }
              popoverOpen={panel.subagentOpen}
              shortLabel={intl.formatMessage({ id: "chat.usageStatusbar.subagents.shortLabel" })}
              testId="usage-statusbar-subagents"
              // 值 = 仅子代理累计（specs/usage-statusbar.md「子代理胶囊值语义」节）：
              // 不再重复展示主代理值；主/子对比在点击面板与统一面板子代理分组。
              value={formatUsageTokenCount(locale, subagents.childTotalTokens)}
            />
          ) : null}
          <span className="ml-auto inline-flex shrink-0" data-usage-statusbar-no-pin="">
            <UsageStatusbarSettingsPopover />
          </span>
        </div>
      </PopoverAnchor>
      {/* 统一「用量明细」面板：受控 Popover 锚定整条 bar（side=top），样式照 DESIGN.md
          §Menus, Popovers（bg-popover + border-popover-border + rounded-xl + shadow-md，
          组件默认已带，边框按规范覆盖为 popover-border）；宽度 max-w-96 级。
          hover 面板不抢焦点（auto focus 双向阻断）。 */}
      <PopoverContent
        ref={panel.panelRef}
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)] gap-2 border-popover-border p-3"
        data-testid="usage-statusbar-detail-panel"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
        side="top"
        sideOffset={4}
      >
        <UsageStatusbarDetailPanel
          cumulative={usage ? cumulative : null}
          inFlightActive={inFlightActive}
          lastRequest={lastRequest}
          lastTurnStats={lastTurnStats}
          live={live}
          phaseRunning={phaseRunning}
          subagents={presence.subagents ? subagents : null}
          todayTotals={today.totals}
          tools={presence.toolCalls ? tools : null}
        />
      </PopoverContent>
    </Popover>
  );
}
