/**
 * 上下文容量段（第 3 段）的判据与明细（apps/acode-cli/specs/usage-statusbar-port.md §2.1）。
 *
 * 判据只有一条，不再单列 70/85 两套阈值：
 *   usedTokens ≥ maxTokens                       → error（红档）+ 闪烁
 *   usedTokens ≥ autoCompactThresholdTokens     → warning（黄档）
 *   其余                                         → default
 * maxTokens 缺失或 ≤ 0 时整段不渲染（不给假容量）。
 * 数据全部来自现成的 usage.contextWindow，不新增协议字段。
 */
import type { UsageBarDetailRow, UsageBarSegment } from "./usageBarModel.js";
import { formatCompact, formatPercent, formatPercentUnclamped } from "./usageBarFormat.js";
import type { TurnMetricsMessageFormat } from "@/chat-input-toolbar/turnMetrics.js";

type ContextCapacityTier = "normal" | "nearThreshold" | "overWindow";

export interface ContextCapacityInput {
  usedTokens: number;
  maxTokens: number;
  autoCompactThresholdTokens: number | null;
  /** provider 上报的缓存命中率；null = 未上报（明细省略该行）。 */
  cacheHitRate: number | null;
}

interface ContextCapacityView {
  tier: ContextCapacityTier;
  /** 环形进度的填充比例，钳在 0~1（环本身不越过整圈）。 */
  ringRatio: number;
  /** 百分比原文按未钳制的 realRatio 显示，超限时也要看得见（如 103%）。 */
  percentLabel: string;
  realRatio: number;
}

/**
 * 三档判据。`used ≥ max` 用「含等于」：等于时下一次请求必被 window 拒绝，
 * 此时就该红，而不是等到确实超了才提示。
 */
function resolveContextCapacity(
  input: ContextCapacityInput,
  locale: string,
): ContextCapacityView | null {
  const { usedTokens, maxTokens, autoCompactThresholdTokens } = input;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || !Number.isFinite(usedTokens)) return null;
  const used = Math.max(0, usedTokens);
  const realRatio = used / maxTokens;
  const tier: ContextCapacityTier =
    used >= maxTokens
      ? "overWindow"
      : autoCompactThresholdTokens !== null &&
          Number.isFinite(autoCompactThresholdTokens) &&
          autoCompactThresholdTokens > 0 &&
          used >= autoCompactThresholdTokens
        ? "nearThreshold"
        : "normal";
  return {
    tier,
    ringRatio: Math.min(1, Math.max(0, realRatio)),
    percentLabel: formatPercentUnclamped(locale, realRatio),
    realRatio,
  };
}

/**
 * 容量段的段与明细。超限时明细末尾附一行处置建议（不是每行都挂，避免常态噪音）。
 * 缺哪项省略哪项：阈值、命中率、距阈值都由数据存在性决定。
 */
export function buildContextSegment(input: {
  capacity: ContextCapacityInput;
  locale: string;
  formatMessage: TurnMetricsMessageFormat;
}): UsageBarSegment | null {
  const { capacity, locale, formatMessage } = input;
  const view = resolveContextCapacity(capacity, locale);
  if (view === null) return null;
  const { usedTokens, maxTokens, autoCompactThresholdTokens } = capacity;
  const detailRows: UsageBarDetailRow[] = [
    {
      label: formatMessage({ id: "chat.usageStatusbar.capacity.usedOfWindow" }),
      value: `${formatCompact(locale, usedTokens)} / ${formatCompact(locale, maxTokens)}`,
      ...(view.tier === "overWindow" ? { tone: "error" as const } : {}),
    },
  ];
  if (autoCompactThresholdTokens !== null && autoCompactThresholdTokens > 0) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.capacity.threshold" }),
      value: `${formatCompact(locale, autoCompactThresholdTokens)} (${formatPercent(
        locale,
        autoCompactThresholdTokens / maxTokens,
      )})`,
    });
    const remaining = autoCompactThresholdTokens - usedTokens;
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.capacity.distanceToThreshold" }),
      value:
        remaining >= 0
          ? formatMessage(
              { id: "chat.usageStatusbar.capacity.remaining" },
              { value: formatCompact(locale, remaining) },
            )
          : formatMessage(
              { id: "chat.usageStatusbar.capacity.beyond" },
              { value: formatCompact(locale, Math.abs(remaining)) },
            ),
      tone: remaining >= 0 ? "success" : "error",
    });
  }
  if (capacity.cacheHitRate !== null && Number.isFinite(capacity.cacheHitRate)) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.cacheHitRate" }),
      value: formatPercent(locale, capacity.cacheHitRate),
    });
  }
  const noteParts = [formatMessage({ id: "chat.usageStatusbar.capacity.note" })];
  if (view.tier === "overWindow") {
    noteParts.push(formatMessage({ id: "chat.usageStatusbar.capacity.overflowAdvice" }));
  }
  return {
    id: "context",
    label: formatMessage({ id: "chat.usageStatusbar.context.label" }),
    value: view.percentLabel,
    tone:
      view.tier === "overWindow" ? "error" : view.tier === "nearThreshold" ? "warning" : "default",
    ...(view.tier === "overWindow" ? { blink: true } : {}),
    ring: { ratio: view.ringRatio },
    detailRows,
    note: noteParts.join(" "),
  };
}
