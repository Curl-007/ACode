import { useMemo } from "react";
import { Bot, CalendarDays, Gauge, Layers, Sigma, Wrench } from "lucide-react";
import type { ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatCodeDelta,
  formatUsageCount,
  formatUsageDurationMs,
  formatUsagePercent,
  formatUsageTokenCount,
  formatTokensPerSecond,
} from "@/v4/usage-statusbar/usageStatusbarFormat.js";
import {
  aggregateToolCallRows,
  buildSubagentSummaryView,
  classifyUsageSpeedTier,
  deriveCacheHitRate,
  deriveLastCompletedTurnStats,
  deriveLastRequestTokensPerSecond,
  summarizeSessionCumulative,
} from "@/v4/usage-statusbar/usageStatusbarModel.js";
import { useTodayUsageTotals } from "@/v4/usage-statusbar/useTodayUsageTotals.js";
import { useUsageStatusbarPreferences } from "@/v4/usage-statusbar/useUsageStatusbarPreferences.js";
import {
  UsageStatusbarCapsule,
  UsageStatusbarDetailRow,
  UsageStatusbarTooltipNote,
  type UsageStatusbarTone,
} from "@/v4/usage-statusbar/UsageStatusbarCapsule.js";
import { UsageStatusbarSettingsPopover } from "@/v4/usage-statusbar/UsageStatusbarSettingsPopover.js";
import { UsageSubagentPanel } from "@/v4/usage-statusbar/UsageSubagentPanel.js";

// 用量状态栏（specs/usage-statusbar.md「状态栏」节）：七胶囊条状布局，逐项可显隐。
// 每窗口绑定纪律：本组件只消费 props 传入的**本窗口活动会话** snapshot（宿主从本窗口
// conversationProjectionStore 取），自身不查任何 store/session 索引、不做跨会话兜底；
// snapshot=null（无活动会话）→ 全部胶囊零值/占位展示，绝不回退到别的会话。
// 上下文容量项不在此条上——由既有 composer 上下文环承载（chat-input-toolbar/contextUsage.tsx）。

const EMPTY_ROWS: never[] = [];

export interface UsageStatusbarProps {
  /** 本窗口活动会话的 v4 快照；null = 无活动会话（零值展示）。 */
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

  const speedTone: UsageStatusbarTone =
    speedTier === "fast" ? "success" : speedTier === "slow" ? "warning" : "default";
  const lastRequest = usage?.lastRequest ?? null;

  const turnUsageTooltip = lastTurnStats ? (
    <>
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.inputTokens" })}
        value={formatUsageTokenCount(locale, lastTurnStats.inputTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.outputTokens" })}
        value={formatUsageTokenCount(locale, lastTurnStats.outputTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.reasoningTokens" })}
        value={formatUsageTokenCount(locale, lastTurnStats.reasoningTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.cacheReadTokens" })}
        value={formatUsageTokenCount(locale, lastTurnStats.cacheReadTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.cacheWriteTokens" })}
        value={formatUsageTokenCount(locale, lastTurnStats.cacheWriteTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.cacheHitRate" })}
        value={formatUsagePercent(
          locale,
          deriveCacheHitRate(lastTurnStats.inputTokens, lastTurnStats.cacheReadTokens),
        )}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.ttft" })}
        value={formatUsageDurationMs(locale, lastTurnStats.timeToFirstTokenMs ?? null)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.requestCount" })}
        value={formatUsageCount(locale, lastTurnStats.modelRequestCount)}
      />
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.tooltip" })}
      </UsageStatusbarTooltipNote>
    </>
  ) : (
    <UsageStatusbarTooltipNote>
      {intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.empty" })}
    </UsageStatusbarTooltipNote>
  );

  const sessionTooltip = (
    <>
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.inputTokens" })}
        value={formatUsageTokenCount(locale, cumulative.inputTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.outputTokens" })}
        value={formatUsageTokenCount(locale, cumulative.outputTokens)}
      />
      {/* reasoningTokens 是 additive optional：旧投影缺席时隐藏明细行，不当 0 渲染。 */}
      {cumulative.reasoningTokens !== null ? (
        <UsageStatusbarDetailRow
          label={intl.formatMessage({ id: "chat.usageStatusbar.detail.reasoningTokens" })}
          value={formatUsageTokenCount(locale, cumulative.reasoningTokens)}
        />
      ) : null}
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.cacheHitRate" })}
        value={formatUsagePercent(locale, cumulative.cacheHitRate)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.turnCount" })}
        value={formatUsageCount(locale, cumulative.turnCount)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.requestCount" })}
        value={formatUsageCount(locale, cumulative.modelRequestCount)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.codeDelta" })}
        value={formatCodeDelta(locale, cumulative.additions, cumulative.deletions)}
        valueClass="text-success"
      />
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.session.tooltip" })}
      </UsageStatusbarTooltipNote>
    </>
  );

  const toolsTooltip = (
    <>
      {tools.byTool.slice(0, 8).map((entry) => (
        <UsageStatusbarDetailRow
          key={entry.toolName}
          label={entry.toolName}
          value={`×${formatUsageCount(locale, entry.count)} · ${formatUsageDurationMs(locale, entry.totalDurationMs)}`}
          valueClass={entry.errorCount > 0 ? "text-destructive" : undefined}
        />
      ))}
      {tools.errorCount > 0 ? (
        <UsageStatusbarDetailRow
          label={intl.formatMessage({ id: "chat.usageStatusbar.tools.errorCount" })}
          value={formatUsageCount(locale, tools.errorCount)}
          valueClass="text-destructive"
        />
      ) : null}
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.tools.tooltip" })}
      </UsageStatusbarTooltipNote>
    </>
  );

  const visible = preferences.visibleItems;
  return (
    <div
      className={cn(
        "flex h-7 min-w-0 items-center gap-0.5 overflow-hidden px-1 text-ui-sm",
        className,
      )}
      data-testid="usage-statusbar"
    >
      {visible.generationSpeed ? (
        <UsageStatusbarCapsule
          icon={<Gauge />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.speed.label" })}
          testId="usage-statusbar-speed"
          tone={speedTone}
          tooltip={
            <>
              <UsageStatusbarDetailRow
                label={intl.formatMessage({ id: "chat.usageStatusbar.detail.outputTokens" })}
                value={formatUsageTokenCount(locale, lastRequest?.outputTokens ?? null)}
              />
              <UsageStatusbarDetailRow
                label={intl.formatMessage({ id: "chat.usageStatusbar.detail.generationMs" })}
                value={formatUsageDurationMs(locale, lastRequest?.generationMs ?? null)}
              />
              <UsageStatusbarDetailRow
                label={intl.formatMessage({ id: "chat.usageStatusbar.detail.ttft" })}
                value={formatUsageDurationMs(locale, lastRequest?.timeToFirstTokenMs ?? null)}
              />
              <UsageStatusbarTooltipNote>
                {intl.formatMessage({ id: "chat.usageStatusbar.speed.tooltip" })}
              </UsageStatusbarTooltipNote>
            </>
          }
          value={formatTokensPerSecond(locale, speed)}
        />
      ) : null}
      {visible.turnUsage ? (
        <UsageStatusbarCapsule
          icon={<Sigma />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.label" })}
          testId="usage-statusbar-turn-usage"
          tooltip={turnUsageTooltip}
          value={formatUsageTokenCount(
            locale,
            lastTurnStats ? lastTurnStats.inputTokens + lastTurnStats.outputTokens : null,
          )}
        />
      ) : null}
      {visible.sessionCumulative ? (
        <UsageStatusbarCapsule
          icon={<Layers />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.session.label" })}
          testId="usage-statusbar-session"
          tooltip={sessionTooltip}
          value={formatUsageTokenCount(locale, cumulative.totalTokens)}
        />
      ) : null}
      {visible.toolCalls ? (
        <UsageStatusbarCapsule
          icon={<Wrench />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.tools.label" })}
          testId="usage-statusbar-tools"
          tone={tools.errorCount > 0 ? "destructive" : "default"}
          tooltip={toolsTooltip}
          value={
            tools.errorCount > 0
              ? `${formatUsageCount(locale, tools.totalCount)} · ${intl.formatMessage(
                  { id: "chat.usageStatusbar.tools.errors" },
                  { count: tools.errorCount },
                )}`
              : formatUsageCount(locale, tools.totalCount)
          }
        />
      ) : null}
      {visible.todayTotal ? (
        <UsageStatusbarCapsule
          icon={<CalendarDays />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.today.label" })}
          testId="usage-statusbar-today"
          tooltip={
            <>
              <UsageStatusbarDetailRow
                label={intl.formatMessage({ id: "chat.usageStatusbar.today.turnCount" })}
                value={formatUsageCount(locale, today.totals?.turnCount ?? null)}
              />
              <UsageStatusbarDetailRow
                label={intl.formatMessage({ id: "chat.usageStatusbar.today.toolCallCount" })}
                value={formatUsageCount(locale, today.totals?.toolCallCount ?? null)}
              />
              <UsageStatusbarTooltipNote>
                {intl.formatMessage({ id: "chat.usageStatusbar.today.tooltip" })}
              </UsageStatusbarTooltipNote>
            </>
          }
          value={formatUsageTokenCount(locale, today.totals?.totalTokens ?? null)}
        />
      ) : null}
      {visible.subagents ? (
        <UsageStatusbarCapsule
          icon={<Bot />}
          label={intl.formatMessage({ id: "chat.usageStatusbar.subagents.label" })}
          testId="usage-statusbar-subagents"
          popoverContent={
            <UsageSubagentPanel
              locale={locale}
              mainTotalTokens={cumulative.totalTokens}
              view={subagents}
            />
          }
          tooltip={
            <UsageStatusbarTooltipNote>
              {intl.formatMessage({ id: "chat.usageStatusbar.subagents.tooltip" })}
            </UsageStatusbarTooltipNote>
          }
          value={`${formatUsageTokenCount(locale, cumulative.totalTokens)} / ${formatUsageTokenCount(locale, subagents.childTotalTokens)}`}
        />
      ) : null}
      <span className="ml-auto inline-flex shrink-0">
        <UsageStatusbarSettingsPopover />
      </span>
    </div>
  );
}
