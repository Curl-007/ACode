/**
 * 回答末尾速率行（apps/acode-cli/specs/usage-statusbar-port.md §2.1 末段）。
 *
 * 数据来自 `turnHeader.stats`（目标把源 `turnHeader.metrics` 映射为既有 stats + 两个
 * additive 速度字段）与权威工时 `turnHeader.activeMs`；速度与状态栏「生成速度」同一口径，
 * 一轮结束时两者数值相等。缺哪项省略哪项，全部缺失整行不渲染；进行中的轮由状态栏负责，
 * 这里只在收口后出现。
 */
import { memo, useMemo } from "react";
import { ZapIcon } from "lucide-react";
import { TID_V4_TURN_RATE_FOOTER } from "@acode/shared";
import type { TurnHeaderRow } from "@acode/shared/acode-protocol-v4";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatTurnFirstTokenMs,
  formatTurnTokensPerSecond,
} from "@/chat-input-toolbar/turnMetrics.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import { UsageBarHoverDetail } from "./UsageBarHoverDetail.js";
import { resolveUsageBarSettings } from "./usageBarModel.js";
import { useUsageBarPreferences } from "./useUsageBarPreferences.js";

/** 权威工时口径与轨迹耗时同档：秒级取整，分钟给 `Xm Ys`。 */
function formatActiveDuration(activeMs: number): string {
  const totalSeconds = Math.max(0, Math.round(activeMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
}

type TurnRateStats = NonNullable<TurnHeaderRow["stats"]>;

interface TurnRateFooterInput {
  /** turnHeader 行；只在 state ≠ running 时渲染。 */
  row: Pick<TurnHeaderRow, "stats" | "activeMs" | "state">;
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
  locale: string;
}

/** 段落生成：缺项省略；五项都没有时返回 null（整行不渲染）。单测直接驱动本函数。 */
export function buildTurnRateFooterText(input: TurnRateFooterInput): string | null {
  const stats = input.row.stats;
  const activeMs = input.row.activeMs;
  if (!stats) return null;
  const segments: string[] = [];
  if (stats.tokensPerSecond !== undefined) {
    segments.push(
      input.formatMessage(
        { id: "chat.turnMetrics.tokensPerSecond" },
        { value: formatTurnTokensPerSecond(stats.tokensPerSecond, input.locale) },
      ),
    );
  }
  if (stats.timeToFirstTokenMs !== undefined) {
    segments.push(
      `${input.formatMessage({ id: "chat.turnMetrics.firstToken" })} ${formatTurnFirstTokenMs(stats.timeToFirstTokenMs)}`,
    );
  }
  if (stats.outputTokens > 0) {
    segments.push(
      `${input.formatMessage({ id: "chat.turnMetrics.outputTokens" })} ${formatCompactTokenNumber(input.locale, stats.outputTokens)}`,
    );
  }
  // 段 / 峰：段 = 模型请求次数，峰 = 最快一段速率。旧 CLI 不带 peakTokensPerSecond 时整行省略。
  if (stats.modelRequestCount > 0 && stats.peakTokensPerSecond !== undefined) {
    segments.push(
      input.formatMessage(
        { id: "chat.turnRateFooter.segmentsPeak" },
        {
          segments: formatCompactTokenNumber(input.locale, stats.modelRequestCount),
          peak: formatTurnTokensPerSecond(stats.peakTokensPerSecond, input.locale),
        },
      ),
    );
  }
  if (activeMs !== undefined && activeMs > 0) {
    segments.push(formatActiveDuration(activeMs));
  }
  return segments.length > 0 ? segments.join(" · ") : null;
}

/** 本轮服务过的模型（additive，≥2 才算「多模型」）。 */
function servedModelsOf(stats: TurnRateStats | null | undefined): readonly string[] {
  const models = stats?.servedModels ?? [];
  return models.length >= 2 ? models : [];
}

export const TurnRateFooter = memo(function TurnRateFooterImpl({
  row,
}: {
  row: Pick<TurnHeaderRow, "stats" | "activeMs" | "state">;
}) {
  const preferences = useUsageBarPreferences();
  const resolved = useMemo(() => resolveUsageBarSettings(preferences), [preferences]);
  const { intl, locale } = useACodeIntl();
  const enabled = resolved.enabled && resolved.answerFooter;
  const text = useMemo(
    () =>
      enabled
        ? buildTurnRateFooterText({
            row,
            formatMessage: (descriptor, values) => intl.formatMessage(descriptor, values),
            locale,
          })
        : null,
    [enabled, row, intl, locale],
  );
  if (text === null || row.state === "running") return null;
  const servedModels = servedModelsOf(row.stats);

  return (
    <UsageBarHoverDetail
      content={
        <p className="max-w-72 text-ui-xs leading-relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "chat.turnRateFooter.note" })}
        </p>
      }
    >
      <span
        data-testid={TID_V4_TURN_RATE_FOOTER}
        tabIndex={0}
        className="inline-flex items-center gap-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtlest tabular-nums"
      >
        <ZapIcon aria-hidden className="size-3 shrink-0" />
        <span>{text}</span>
        {servedModels.length > 0 ? (
          <span
            className="rounded-full bg-foreground/8 px-1.5 text-foreground-subtle"
            title={servedModels.join(" · ")}
          >
            {intl.formatMessage(
              { id: "chat.usageStatusbar.rateLine.servedModels" },
              { count: servedModels.length },
            )}
          </span>
        ) : null}
      </span>
    </UsageBarHoverDetail>
  );
});
