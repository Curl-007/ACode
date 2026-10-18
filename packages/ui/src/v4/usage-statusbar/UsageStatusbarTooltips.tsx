import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { SessionUsageLastRequest, TurnHeaderStats } from "@acode/shared/acode-protocol-v4";
import {
  formatCodeDelta,
  formatUsageCount,
  formatUsageDurationMs,
  formatUsagePercent,
  formatUsageTokenCount,
  USAGE_NO_DATA_PLACEHOLDER,
} from "@/v4/usage-statusbar/usageStatusbarFormat.js";
import {
  deriveCacheHitRate,
  type SessionCumulativeSummary,
  type ToolCallAggregation,
} from "@/v4/usage-statusbar/usageStatusbarModel.js";
import type { TodayUsageTotals } from "@/v4/usage-statusbar/usageStatusbarTodayModel.js";
import {
  UsageStatusbarDetailRow,
  UsageStatusbarTooltipNote,
} from "@/v4/usage-statusbar/UsageStatusbarCapsule.js";

// 用量状态栏各胶囊的 tooltip 明细内容（specs/usage-statusbar.md「Tooltip 增强与实时
// 动态显示口径」节）。从 UsageStatusbar.tsx 拆出的原因：该文件顶过 400 行 ratchet
// （architecture:check）；本文件只承载 tooltip 内容组装这一内聚块，纯移动、语义不变——
// 行文案、行序、口径注释逐行保留。
// 纯展示件：只吃数据 props + 自取 intl/locale，不持有任何状态；数据派生仍在
// usageStatusbarModel（单一所有者），本文件不做新的事实计算。

/** 生成速度 tooltip：最近一次模型请求的 output/耗时/TTFT + 口径说明。 */
export function SpeedTooltipContent({
  lastRequest,
}: {
  lastRequest: SessionUsageLastRequest | null;
}) {
  const { intl, locale } = useACodeIntl();
  return (
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
  );
}

/** 本轮用量 tooltip：最近完成轮明细；纯问答轮（stats=null）如实给占位，不回退更早轮。 */
export function TurnUsageTooltipContent({ stats }: { stats: TurnHeaderStats | null }) {
  const { intl, locale } = useACodeIntl();
  return stats ? (
    <>
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
    </>
  ) : (
    <UsageStatusbarTooltipNote>
      {intl.formatMessage({ id: "chat.usageStatusbar.turnUsage.empty" })}
    </UsageStatusbarTooltipNote>
  );
}

/** 会话累计 tooltip：token 权威面（含缓存读/写明细）+ 轮数/请求数/代码增删。 */
export function SessionTooltipContent({ cumulative }: { cumulative: SessionCumulativeSummary }) {
  const { intl, locale } = useACodeIntl();
  return (
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
      {/* 缓存读/写明细（cumulative 权威面既有字段，specs/usage-statusbar.md「Tooltip 增强」节）。 */}
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
    </>
  );
}

/** 工具调用 tooltip：各工具计数/耗时（封顶 8 行 + 「+N 更多」）+ 错误计数与最近错误。 */
export function ToolsTooltipContent({ tools }: { tools: ToolCallAggregation }) {
  const { intl, locale } = useACodeIntl();
  return (
    <>
      {tools.byTool.slice(0, 8).map((entry) => (
        <UsageStatusbarDetailRow
          key={entry.toolName}
          label={entry.toolName}
          value={`×${formatUsageCount(locale, entry.count)} · ${formatUsageDurationMs(locale, entry.totalDurationMs)}`}
          valueClass={entry.errorCount > 0 ? "text-destructive" : undefined}
        />
      ))}
      {/* 溢出收口（specs/usage-statusbar.md「Tooltip 增强与实时动态显示口径」节）：
          明细行封顶 8 行，余量以「+N 更多」收口，不在 tooltip 内无限铺开。 */}
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
    </>
  );
}

/** 今日合计 tooltip：当天轮数/工具调用/主要模型 + 刷新时机与 workspace 口径说明。 */
export function TodayTooltipContent({ totals }: { totals: TodayUsageTotals | null }) {
  const { intl, locale } = useACodeIntl();
  return (
    <>
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.today.turnCount" })}
        value={formatUsageCount(locale, totals?.turnCount ?? null)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.today.toolCallCount" })}
        value={formatUsageCount(locale, totals?.toolCallCount ?? null)}
      />
      <UsageStatusbarDetailRow
        label={intl.formatMessage({ id: "chat.usageStatusbar.today.favoriteModel" })}
        value={totals?.favoriteModel ?? USAGE_NO_DATA_PLACEHOLDER}
      />
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.today.tooltip" })}
      </UsageStatusbarTooltipNote>
    </>
  );
}
