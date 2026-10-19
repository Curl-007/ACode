import type { SessionUsageLastRequest, TurnHeaderStats } from "@acode/shared/acode-protocol-v4";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatCodeDelta,
  formatUsageCount,
  formatUsageDurationMs,
  formatUsagePercent,
  formatUsageTokenCount,
  USAGE_NO_DATA_PLACEHOLDER,
} from "@/v4/usage-statusbar/usageStatusbarFormat.js";
import {
  type SessionCumulativeSummary,
  type SubagentSummaryView,
  type ToolCallAggregation,
  type UsageInFlightLiveView,
} from "@/v4/usage-statusbar/usageStatusbarModel.js";
import type { TodayUsageTotals } from "@/v4/usage-statusbar/usageStatusbarTodayModel.js";
import {
  InFlightGroup,
  PanelGroup,
  SpeedGroup,
  TurnGroup,
} from "@/v4/usage-statusbar/UsageStatusbarDetailRequestGroups.js";
import {
  UsageStatusbarDetailRow,
  UsageStatusbarTooltipNote,
} from "@/v4/usage-statusbar/UsageStatusbarCapsule.js";

// 「用量明细」统一面板内容（specs/usage-statusbar.md「Tooltip 稳定性与统一明细面板」节，
// 2026-10-19 重写）：六个胶囊级 tooltip 全部退役，明细合并为整条 bar 悬停/钉住的单一
// 面板。分组行式清单（复用 UsageStatusbarDetailRow / UsageStatusbarTooltipNote），
// 既有 5 个 tooltip 正文重构为面板分组——行内容与 i18n key 全量保留（原
// UsageStatusbarTooltips.tsx 各行逐行迁移）；各组口径脚注 = 既有 *.tooltip 文案。
// 请求作用域分组（分组壳/进行中徽标/本次请求/速度权威/本轮）在姊妹文件
// UsageStatusbarDetailRequestGroups.tsx（400 行 ratchet 拆分，行内容零改写）；本文件
// 保留聚合作用域分组（会话/今日/工具/子代理）与分组序装配。
//
// 分组纪律：
// - 分组不受胶囊显隐偏好影响（偏好只治 bar，面板恒全量）；
// - 无数据分组按 hide-on-absent 缺席不渲染（缺席 ≠ 零值）；
// - 「本次请求（进行中）」分组仅在 running 且 inFlight 事实在场时出现——无中途事实
//   的 provider 如实不渲染该组，绝不造数。
// 纯展示件：只吃数据 props + 自取 intl/locale；数据派生在 usageStatusbarModel /
// usageStatusbarInFlight（单一所有者），本文件不做新的事实计算。

/** 会话分组：token 权威面（含缓存读/写明细）+ 轮数/请求数/代码增删。 */
function SessionGroup({ cumulative }: { cumulative: SessionCumulativeSummary }) {
  const { intl, locale } = useACodeIntl();
  return (
    <PanelGroup
      testId="usage-statusbar-panel-group-session"
      title={intl.formatMessage({ id: "chat.usageStatusbar.session.label" })}
    >
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
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.cacheReadTokens" })}
        value={formatUsageTokenCount(locale, cumulative.cacheReadTokens)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.detail.cacheWriteTokens" })}
        value={formatUsageTokenCount(locale, cumulative.cacheWriteTokens)}
      />
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
    </PanelGroup>
  );
}

/** 今日分组：当天轮数/工具调用/主要模型 + 刷新时机与 workspace 口径说明。 */
function TodayGroup({ totals }: { totals: TodayUsageTotals }) {
  const { intl, locale } = useACodeIntl();
  return (
    <PanelGroup
      testId="usage-statusbar-panel-group-today"
      title={intl.formatMessage({ id: "chat.usageStatusbar.today.label" })}
    >
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.today.turnCount" })}
        value={formatUsageCount(locale, totals.turnCount)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.today.toolCallCount" })}
        value={formatUsageCount(locale, totals.toolCallCount)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.today.favoriteModel" })}
        value={totals.favoriteModel ?? USAGE_NO_DATA_PLACEHOLDER}
      />
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.today.tooltip" })}
      </UsageStatusbarTooltipNote>
    </PanelGroup>
  );
}

/** 工具分组：各工具计数/耗时（封顶 8 行 + 「+N 更多」）+ 错误计数与最近错误弱化行。 */
function ToolsGroup({ tools }: { tools: ToolCallAggregation }) {
  const { intl, locale } = useACodeIntl();
  return (
    <PanelGroup
      testId="usage-statusbar-panel-group-tools"
      title={intl.formatMessage({ id: "chat.usageStatusbar.tools.label" })}
    >
      {tools.byTool.slice(0, 8).map((entry) => (
        <UsageStatusbarDetailRow
          key={entry.toolName}
          label={entry.toolName}
          value={`×${formatUsageCount(locale, entry.count)} · ${formatUsageDurationMs(locale, entry.totalDurationMs)}`}
          valueClass={entry.errorCount > 0 ? "text-destructive" : undefined}
        />
      ))}
      {/* 溢出收口（spec「面板明细与实时动态显示口径」节）：明细行封顶 8 行，
          余量以「+N 更多」收口，不在面板内无限铺开。 */}
      {tools.byTool.length > 8 ? (
        <UsageStatusbarDetailRow
          label={intl.formatMessage(
            { id: "chat.usageStatusbar.tools.more" },
            { count: tools.byTool.length - 8 },
          )}
          value=""
        />
      ) : null}
      {tools.errorCount > 0 ? (
        <UsageStatusbarDetailRow
          label={intl.formatMessage({ id: "chat.usageStatusbar.tools.errorCount" })}
          value={formatUsageCount(locale, tools.errorCount)}
          valueClass="text-destructive"
        />
      ) : null}
      {tools.lastErrorMessage ? (
        <UsageStatusbarDetailRow
          label={intl.formatMessage({ id: "chat.usageStatusbar.tools.lastError" })}
          value={tools.lastErrorMessage}
          valueClass="text-destructive"
        />
      ) : null}
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.tools.tooltip" })}
      </UsageStatusbarTooltipNote>
    </PanelGroup>
  );
}

/** 子代理分组：主/子累计对比 + 值语义口径说明（任务清单深钻仍在胶囊点击 Popover）。 */
function SubagentsGroup({
  cumulative,
  view,
}: {
  cumulative: SessionCumulativeSummary | null;
  view: SubagentSummaryView;
}) {
  const { intl, locale } = useACodeIntl();
  return (
    <PanelGroup
      testId="usage-statusbar-panel-group-subagents"
      title={intl.formatMessage({ id: "chat.usageStatusbar.subagents.label" })}
    >
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.subagents.main" })}
        value={formatUsageTokenCount(locale, cumulative?.totalTokens ?? null)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.subagents.children" })}
        value={
          view.endedTotal > 0
            ? `${formatUsageTokenCount(locale, view.childTotalTokens)} · ${intl.formatMessage(
                { id: "chat.usageStatusbar.subagents.ended" },
                { count: view.endedTotal },
              )}`
            : formatUsageTokenCount(locale, view.childTotalTokens)
        }
      />
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.subagents.tooltip" })}
      </UsageStatusbarTooltipNote>
    </PanelGroup>
  );
}

export interface UsageStatusbarDetailPanelProps {
  /** live 视图（deriveUsageInFlightLiveView 产物；空闲态/无事实全 null）。 */
  live: UsageInFlightLiveView;
  /** running 且 inFlight 事实在场（宿主门控「本次请求」分组的出现）。 */
  inFlightActive: boolean;
  phaseRunning: boolean;
  /** null = lastRequest 缺席（速度分组 hide-on-absent）。 */
  lastRequest: SessionUsageLastRequest | null;
  lastTurnStats: TurnHeaderStats | null;
  /** null = snapshot.usage 缺席（会话分组 hide-on-absent）。 */
  cumulative: SessionCumulativeSummary | null;
  /** null = 当天 heatmap 未命中（今日分组 hide-on-absent）。 */
  todayTotals: TodayUsageTotals | null;
  /** null = 投影无 toolCall 行（工具分组 hide-on-absent）。 */
  tools: ToolCallAggregation | null;
  /** null = 子代理投影缺席/无事实（子代理分组 hide-on-absent）。 */
  subagents: SubagentSummaryView | null;
}

export function UsageStatusbarDetailPanel({
  live,
  inFlightActive,
  phaseRunning,
  lastRequest,
  lastTurnStats,
  cumulative,
  todayTotals,
  tools,
  subagents,
}: UsageStatusbarDetailPanelProps) {
  const { intl } = useACodeIntl();
  // 分组序（spec「Tooltip 稳定性与统一明细面板」节）：本次请求（进行中 ●）→ 本轮 →
  // 会话 → 今日 → 工具 → 子代理；生成速度权威组紧随本次请求（既有 speed tooltip
  // 行内容全量保留的归宿）。分组不受胶囊显隐偏好影响，无数据分组缺席不渲染。
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-ui-sm font-medium text-foreground">
        {intl.formatMessage({ id: "chat.usageStatusbar.panel.title" })}
      </span>
      {inFlightActive ? <InFlightGroup live={live} /> : null}
      {lastRequest ? <SpeedGroup lastRequest={lastRequest} /> : null}
      <TurnGroup live={live} phaseRunning={phaseRunning} stats={lastTurnStats} />
      {cumulative ? <SessionGroup cumulative={cumulative} /> : null}
      {todayTotals ? <TodayGroup totals={todayTotals} /> : null}
      {tools ? <ToolsGroup tools={tools} /> : null}
      {subagents ? <SubagentsGroup cumulative={cumulative} view={subagents} /> : null}
    </div>
  );
}
