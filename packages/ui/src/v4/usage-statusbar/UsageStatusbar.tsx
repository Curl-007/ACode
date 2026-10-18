import { useMemo } from "react";
import { Bot, CalendarDays, Gauge, Layers, Sigma, Wrench } from "lucide-react";
import type { ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
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
  UsageStatusbarTooltipNote,
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
// tooltip 明细内容组装在同目录 UsageStatusbarTooltips.tsx（400 行 ratchet 拆分，纯移动）。
// 上下文容量项不在此条上——由既有 composer 上下文环承载（chat-input-toolbar/contextUsage.tsx）。

const EMPTY_ROWS: never[] = [];

/** 容器查询分级隐藏（Tailwind v4 命名容器任意值语法，@container/composer 在 Composer 根）。 */
const CAPSULE_HIDE_TIER_1 = "@max-[520px]/composer:hidden";
const CAPSULE_HIDE_TIER_2 = "@max-[420px]/composer:hidden";

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
  // 根因修复（bug：对话流式输出/思考进行中悬停胶囊 tooltip 只闪一下即消失）：
  // 全局 TooltipProvider（Root.tsx）delayDuration=0 + 默认 skipDelayDuration=300，
  // 在流式高频 snapshot re-render 下，Radix Tooltip 的 hoverable content 机制
  // （@radix-ui/react-tooltip TooltipContentHoverable：grace area pointer 追踪 +
  // trigger/content pointerleave 建立凸包，见 dist/index.mjs:231-291）会出现
  // 指针静止却被判定离开 grace area → onClose() → setOpen(false) 的抖动；close 后
  // TooltipTrigger 的 hasPointerMoveOpenedRef 仍为 true（仅 pointerleave 才重置），
  // 指针未移动不再触发 onTriggerEnter 重开——与「闪一下即消失、等思考结束才常驻」
  // 症状完全吻合。
  // 修复针对根因所有者（状态栏胶囊的 tooltip 行为配置）：用局部 TooltipProvider
  // 覆盖，disableHoverableContent=true 禁用导致抖动的 grace area 追踪逻辑，改用
  // TooltipContentImpl（非 hoverable）。状态栏 tooltip 是只读明细，用户无需将指针
  // 移入 tooltip content 内部，禁用 hoverable content 不损失核心交互；保留
  // delayDuration=0 不改变首次悬停的零延迟体验。子代理胶囊的 Popover 点击展开
  // 走独立 Radix Popover 机制，不受 Tooltip 的 hoverable content 禁用影响。
  // 运行时根因复现受限于 DOM+流式环境无法自动化（ui 包无 jsdom/happy-dom/testing-library），
  // 证据链见 specs/usage-statusbar.md「Tooltip 稳定性」节与 verify 字段。
  return (
    <TooltipProvider delayDuration={0} disableHoverableContent>
      <div
        className={cn(
          "flex h-7 min-w-0 items-center gap-0.5 overflow-hidden px-1 text-ui-sm",
          className,
        )}
        data-testid="usage-statusbar"
      >
        {visible.generationSpeed && presence.generationSpeed ? (
          <UsageStatusbarCapsule
            className={CAPSULE_HIDE_TIER_2}
            icon={<Gauge />}
            label={intl.formatMessage({ id: "chat.usageStatusbar.speed.label" })}
            pulse={phaseRunning}
            testId="usage-statusbar-speed"
            tone={speedTone}
            tooltip={<SpeedTooltipContent lastRequest={lastRequest} />}
            value={formatTokensPerSecond(locale, speed, tokensPerSecondUnit)}
          />
        ) : null}
        {visible.turnUsage && presence.turnUsage ? (
          <UsageStatusbarCapsule
            icon={<Sigma />}
            label={intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.label" })}
            testId="usage-statusbar-turn-usage"
            tooltip={<TurnUsageTooltipContent stats={lastTurnStats} />}
            value={formatUsageTokenCount(
              locale,
              lastTurnStats ? lastTurnStats.inputTokens + lastTurnStats.outputTokens : null,
            )}
          />
        ) : null}
        {visible.sessionCumulative && presence.sessionCumulative ? (
          <UsageStatusbarCapsule
            className={CAPSULE_HIDE_TIER_2}
            icon={<Layers />}
            label={intl.formatMessage({ id: "chat.usageStatusbar.session.label" })}
            testId="usage-statusbar-session"
            tooltip={<SessionTooltipContent cumulative={cumulative} />}
            value={formatUsageTokenCount(locale, cumulative.totalTokens)}
          />
        ) : null}
        {visible.toolCalls && presence.toolCalls ? (
          <UsageStatusbarCapsule
            className={CAPSULE_HIDE_TIER_2}
            icon={<Wrench />}
            label={intl.formatMessage({ id: "chat.usageStatusbar.tools.label" })}
            pulse={tools.activeCount > 0}
            testId="usage-statusbar-tools"
            tone={tools.errorCount > 0 ? "destructive" : "default"}
            tooltip={<ToolsTooltipContent tools={tools} />}
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
            className={CAPSULE_HIDE_TIER_1}
            icon={<CalendarDays />}
            label={intl.formatMessage({ id: "chat.usageStatusbar.today.label" })}
            testId="usage-statusbar-today"
            tooltip={<TodayTooltipContent totals={today.totals} />}
            value={formatUsageTokenCount(locale, today.totals?.totalTokens ?? null)}
          />
        ) : null}
        {visible.subagents && presence.subagents ? (
          <UsageStatusbarCapsule
            className={CAPSULE_HIDE_TIER_1}
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
            tooltip={
              // 值 = 仅子代理累计（specs/usage-statusbar.md「子代理胶囊值语义」节）：
              // 不再重复展示主代理值（与会话累计胶囊同一事实两处呈现）；主/子对比在面板。
              <UsageStatusbarTooltipNote>
                {intl.formatMessage({ id: "chat.usageStatusbar.subagents.tooltip" })}
              </UsageStatusbarTooltipNote>
            }
            value={formatUsageTokenCount(locale, subagents.childTotalTokens)}
          />
        ) : null}
        <span className="ml-auto inline-flex shrink-0">
          <UsageStatusbarSettingsPopover />
        </span>
      </div>
    </TooltipProvider>
  );
}
