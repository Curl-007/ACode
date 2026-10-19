import type { ReactNode } from "react";
import type { SessionUsageLastRequest, TurnHeaderStats } from "@acode/shared/acode-protocol-v4";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatTokensPerSecond,
  formatUsageCount,
  formatUsageDurationMs,
  formatUsagePercent,
  formatUsageTokenCount,
} from "@/v4/usage-statusbar/usageStatusbarFormat.js";
import {
  deriveCacheHitRate,
  type UsageInFlightLiveView,
} from "@/v4/usage-statusbar/usageStatusbarModel.js";
import { useStopwatchElapsedMs } from "@/v4/usage-statusbar/useStopwatchElapsedMs.js";
import {
  UsageStatusbarDetailRow,
  UsageStatusbarTooltipNote,
} from "@/v4/usage-statusbar/UsageStatusbarCapsule.js";

// 「用量明细」统一面板——共享分组壳与请求作用域分组（本次请求进行中 / 生成速度权威值 /
// 本轮）。从 UsageStatusbarDetailPanel 因 400 行 ratchet（oxlint max-lines）拆出：
// 2026-10-19 重设计加入进行中分组后该文件超限（拆分先例同 usageStatusbarModel →
// usageStatusbarPresence / usageStatusbarInFlight）。行内容与 i18n key 逐行搬移零改写。
// 分组纪律（hide-on-absent、偏好只治 bar 面板恒全量、绝不造数）见
// UsageStatusbarDetailPanel.tsx 头注释；纯展示件，本文件不做新的事实计算。

/** 分组壳：text-ui-xs 弱化标题 + 可选徽标 + 行清单（DESIGN.md 弱元数据用 subtlest 级）。 */
export function PanelGroup({
  badge,
  children,
  testId,
  title,
}: {
  badge?: ReactNode;
  children: ReactNode;
  testId: string;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-1" data-testid={testId}>
      <header className="flex items-center gap-1.5">
        <span className="text-ui-xs font-medium text-foreground-subtlest">{title}</span>
        {badge ?? null}
      </header>
      {children}
    </section>
  );
}

/** 「进行中 ●」徽标：权威 running 事实的装饰性标记（点用 success 语义色，先例同胶囊脉冲）。 */
export function InProgressBadge() {
  const { intl } = useACodeIntl();
  return (
    <span className="inline-flex items-center gap-1 text-ui-xs text-success">
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none"
      />
      {intl.formatMessage({ id: "chat.usageStatusbar.panel.inProgress" })}
    </span>
  );
}

/**
 * 本次请求（进行中）分组：live 值 + 口径脚注。仅 running 且 inFlight 在场时渲染
 * （宿主门控）。已耗时 = now − startedAtMs 秒表（1Hz 定时器仅在本分组挂载期间存在，
 * reduce-motion 双闸见 useStopwatchElapsedMs）；其余行全部来自 producer 事实，缺席
 * 显示占位（"—"），绝不估算。
 */
export function InFlightGroup({ live }: { live: UsageInFlightLiveView }) {
  const { intl, locale } = useACodeIntl();
  const elapsedMs = useStopwatchElapsedMs({ startedAtMs: live.startedAtMs, active: true });
  const tokensPerSecondUnit = intl.formatMessage({
    id: "chat.usageStatusbar.unit.tokensPerSecond",
  });
  return (
    <PanelGroup
      badge={<InProgressBadge />}
      testId="usage-statusbar-panel-group-in-flight"
      title={intl.formatMessage({ id: "chat.usageStatusbar.panel.inFlight" })}
    >
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.elapsed" })}
        value={formatUsageDurationMs(locale, elapsedMs)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.liveOutput" })}
        value={formatUsageTokenCount(locale, live.partialOutputTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.liveSpeed" })}
        value={formatTokensPerSecond(locale, live.liveTokensPerSecond, tokensPerSecondUnit)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.announcedInput" })}
        value={formatUsageTokenCount(locale, live.announcedInputTokens)}
      />
      {/* 首字行仅在投影观测到 firstTokenAtMs 时出现（在场时 = firstTokenAtMs − startedAtMs）。 */}
      {live.timeToFirstTokenMs !== null ? (
        <UsageStatusbarDetailRow
          label={intl.formatMessage({ id: "chat.usageStatusbar.detail.ttft" })}
          value={formatUsageDurationMs(locale, live.timeToFirstTokenMs)}
        />
      ) : null}
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.panel.inFlightNote" })}
      </UsageStatusbarTooltipNote>
    </PanelGroup>
  );
}

/** 生成速度分组（权威值）：最近一次模型请求的 output/耗时/TTFT + 口径说明。 */
export function SpeedGroup({ lastRequest }: { lastRequest: SessionUsageLastRequest }) {
  const { intl, locale } = useACodeIntl();
  return (
    <PanelGroup
      testId="usage-statusbar-panel-group-speed"
      title={intl.formatMessage({ id: "chat.usageStatusbar.speed.label" })}
    >
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.outputTokens" })}
        value={formatUsageTokenCount(locale, lastRequest.outputTokens ?? null)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.generationMs" })}
        value={formatUsageDurationMs(locale, lastRequest.generationMs ?? null)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.ttft" })}
        value={formatUsageDurationMs(locale, lastRequest.timeToFirstTokenMs ?? null)}
      />
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.speed.tooltip" })}
      </UsageStatusbarTooltipNote>
    </PanelGroup>
  );
}

/**
 * 本轮分组：running 且有 turnToDate live 事实 → live 行 + 「进行中」徽标（TurnComplete
 * 被权威 stats 定格替换）；否则最近完成轮权威明细；running 但暂无任何事实 → 如实占位
 * 文案（不回退更早轮）；三态皆无 → 分组缺席。
 */
export function TurnGroup({
  live,
  phaseRunning,
  stats,
}: {
  live: UsageInFlightLiveView;
  phaseRunning: boolean;
  stats: TurnHeaderStats | null;
}) {
  const { intl, locale } = useACodeIntl();
  const turnLiveActive = live.turnToDateTotalTokens !== null;
  if (!turnLiveActive && !stats && !phaseRunning) return null;
  const title = intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.label" });
  if (turnLiveActive) {
    return (
      <PanelGroup
        badge={<InProgressBadge />}
        testId="usage-statusbar-panel-group-turn"
        title={title}
      >
        <UsageStatusbarDetailRow
          label={intl.formatMessage({ id: "chat.usageStatusbar.detail.inputTokens" })}
          value={formatUsageTokenCount(locale, live.turnToDateInputTokens)}
        />
        <UsageStatusbarDetailRow
          label={intl.formatMessage({ id: "chat.usageStatusbar.detail.outputTokens" })}
          value={formatUsageTokenCount(locale, live.turnToDateOutputTokens)}
        />
        <UsageStatusbarTooltipNote>
          {intl.formatMessage({ id: "chat.usageStatusbar.panel.inFlightNote" })}
        </UsageStatusbarTooltipNote>
      </PanelGroup>
    );
  }
  if (!stats) {
    return (
      <PanelGroup testId="usage-statusbar-panel-group-turn" title={title}>
        <UsageStatusbarTooltipNote>
          {intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.empty" })}
        </UsageStatusbarTooltipNote>
      </PanelGroup>
    );
  }
  return (
    <PanelGroup testId="usage-statusbar-panel-group-turn" title={title}>
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.inputTokens" })}
        value={formatUsageTokenCount(locale, stats.inputTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.outputTokens" })}
        value={formatUsageTokenCount(locale, stats.outputTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.reasoningTokens" })}
        value={formatUsageTokenCount(locale, stats.reasoningTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.cacheReadTokens" })}
        value={formatUsageTokenCount(locale, stats.cacheReadTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.cacheWriteTokens" })}
        value={formatUsageTokenCount(locale, stats.cacheWriteTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.cacheHitRate" })}
        value={formatUsagePercent(
          locale,
          deriveCacheHitRate(stats.inputTokens, stats.cacheReadTokens),
        )}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.ttft" })}
        value={formatUsageDurationMs(locale, stats.timeToFirstTokenMs ?? null)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.requestCount" })}
        value={formatUsageCount(locale, stats.modelRequestCount)}
      />
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.tooltip" })}
      </UsageStatusbarTooltipNote>
    </PanelGroup>
  );
}
