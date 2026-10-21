/**
 * 速度与本轮用量两段的构造、以及各段共用的错误徽标与档位判据
 * （apps/acode-cli/specs/usage-statusbar-port.md §2.1）。
 *
 * 从 `usageBarModel.ts` 拆出来的兄弟模块：主模型只留类型、开关解析与编排；
 * 会话/工具/今日/子智能体四段在 `usageBarSessionSegments.ts`（按 max-lines 分档）。
 * 纯函数、无 React：可见性与语气都按「缺值整行隐藏」处理。
 */
import type { UsageBarDetailRow, UsageBarSegment, UsageBarTone } from "./usageBarModel.js";
import { formatCompact, formatCount, formatExact, formatPercent } from "./usageBarFormat.js";
import {
  formatTurnFirstTokenMs,
  formatTurnTokensPerSecond,
  type TurnMetricsMessageFormat,
} from "@/chat-input-toolbar/turnMetrics.js";
import type { TurnMetrics } from "@acode/shared/acode-protocol-v4";

/** 速度档位阈值（收口态）：≥70 绿 / 40–70 黄 / <40 红（含下界、不含上界）。 */
const SPEED_TIER_SUCCESS_MIN = 70;
const SPEED_TIER_WARNING_MIN = 40;

/** 每工具明细的展示行数上限（聚合本身不丢项，只是不显示）。 */
export const TOOL_DETAIL_ROW_LIMIT = 12;

export interface ToolStatsInput {
  calls: number;
  errors: number;
  turnCount?: number;
  requestCount?: number;
  reasoningTokens?: number;
  linesAdded?: number;
  linesDeleted?: number;
  fileCount?: number;
  retryCount?: number;
  tools?: readonly {
    name: string;
    calls: number;
    errors: number;
    durationMs?: number;
  }[];
}

/** 错误徽标：0 错误时返回 undefined，视图据此整块不渲染（不给 0 占位）。 */
export function buildErrorBadge(
  errors: number,
  formatMessage: TurnMetricsMessageFormat,
): { count: number; label: string } | undefined {
  if (!Number.isFinite(errors) || errors <= 0) return undefined;
  return {
    count: errors,
    label: formatMessage({ id: "chat.usageStatusbar.badge.errors" }, { count: errors }),
  };
}

/**
 * 收口态速度档位色。生成中恒绿（tone=live）由调用方决定，这里只处理已收口的实测值。
 * 阈值含下界：70 → 绿档，40 → 黄档。
 */
function resolveSpeedTone(rate: number): UsageBarTone {
  if (rate >= SPEED_TIER_SUCCESS_MIN) return "success";
  if (rate >= SPEED_TIER_WARNING_MIN) return "warning";
  return "error";
}

export function buildSpeedSegment(input: {
  metrics: TurnMetrics | null;
  /** 流式中的实时估算值；null = 没有实时样本。 */
  estimatedRate: number | null;
  /** 本轮加权实测值；null = 未知。 */
  measuredRate: number | null;
  streaming: boolean;
  locale: string;
  formatMessage: TurnMetricsMessageFormat;
}): UsageBarSegment | null {
  const { metrics, estimatedRate, measuredRate, streaming, locale, formatMessage } = input;
  const estimated = streaming ? estimatedRate : null;
  const rate = estimated ?? measuredRate;
  if (rate === null) return null;
  const liveEstimate = estimated !== null;
  const detailRows: UsageBarDetailRow[] = [];
  if (metrics !== null) {
    if (metrics.firstTokenMs !== null) {
      detailRows.push({
        label: formatMessage({ id: "chat.turnMetrics.firstToken" }),
        value: formatTurnFirstTokenMs(metrics.firstTokenMs),
      });
    }
    if (metrics.outputTokens > 0) {
      detailRows.push({
        label: formatMessage({ id: "chat.turnMetrics.outputTokens" }),
        value: formatExact(locale, metrics.outputTokens),
      });
    }
    if (metrics.requestCount !== undefined && metrics.requestCount > 0) {
      detailRows.push({
        label: formatMessage({ id: "chat.usageStatusbar.speed.requests" }),
        value: formatCount(locale, metrics.requestCount),
      });
    }
  }
  // 速度单一口径：流式中取实时估算（绿 + ≈），收口后取加权实测。明细不再出现第二个速度数字。
  return {
    id: "speed",
    label: formatMessage({ id: "chat.usageStatusbar.speed.label" }),
    value: liveEstimate
      ? formatMessage(
          { id: "chat.usageStatusbar.speed.estimated" },
          { value: formatTurnTokensPerSecond(rate, locale) },
        )
      : formatMessage(
          { id: "chat.turnMetrics.tokensPerSecond" },
          { value: formatTurnTokensPerSecond(rate, locale) },
        ),
    // 生成中恒绿（live）；收口后按档位着色（success/warning/error）。
    tone: streaming ? "live" : resolveSpeedTone(rate),
    detailRows,
    note: liveEstimate
      ? formatMessage({ id: "chat.usageStatusbar.speed.noteEstimated" })
      : formatMessage({ id: "chat.usageStatusbar.speed.note" }),
  };
}

/** 「段 / 峰」行：段 = 模型请求次数；峰 = 最快一段速率（旧 CLI 不带峰时整行隐藏）。 */
function buildSegmentsPeakRow(input: {
  metrics: TurnMetrics | null;
  locale: string;
  formatMessage: TurnMetricsMessageFormat;
}): UsageBarDetailRow | null {
  const { metrics, locale, formatMessage } = input;
  const requestCount = metrics?.requestCount;
  const peak = metrics?.peakTokensPerSecond;
  if (requestCount === undefined || requestCount <= 0 || peak === undefined) return null;
  return {
    label: formatMessage({ id: "chat.usageStatusbar.detail.segmentsPeak" }),
    value: formatMessage(
      { id: "chat.usageStatusbar.detail.segmentsPeakValue" },
      {
        segments: formatCount(locale, requestCount),
        peak: formatTurnTokensPerSecond(peak, locale),
      },
    ),
  };
}

export function buildTurnUsageSegment(input: {
  metrics: TurnMetrics | null;
  locale: string;
  formatMessage: TurnMetricsMessageFormat;
}): UsageBarSegment | null {
  const { metrics, locale, formatMessage } = input;
  // 有指标但缺 inputTokens = 旧 CLI，整段隐藏、不拿输出侧凑数；
  // 指标为 null（本轮首个请求未完成 / 目标无 inFlight）= 没有本轮用量，整段隐藏。
  if (metrics === null) return null;
  if (metrics.inputTokens === undefined) return null;
  const inputTokens = metrics.inputTokens;
  const outputTokens = metrics.outputTokens;
  // 明细顺序：输入 / 输出 / 思考 / 缓存读 / 缓存写 / 缓存命中率 / 首字耗时 / 模型请求数 / 段·峰；
  // 旧 CLI 不带的字段整行省略。
  const detailRows: UsageBarDetailRow[] = [
    {
      label: formatMessage({ id: "chat.usageStatusbar.turnUsage.input" }),
      value: formatCompact(locale, inputTokens),
    },
    {
      label: formatMessage({ id: "chat.usageStatusbar.turnUsage.output" }),
      value: formatCompact(locale, outputTokens),
    },
  ];
  if (metrics.reasoningTokens !== undefined) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.reasoningTokens" }),
      value: formatCompact(locale, metrics.reasoningTokens),
    });
  }
  if (metrics.cacheReadTokens !== undefined) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.cacheReadTokens" }),
      value: formatCompact(locale, metrics.cacheReadTokens),
    });
  }
  if (metrics.cacheWriteTokens !== undefined) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.cacheWriteTokens" }),
      value: formatCompact(locale, metrics.cacheWriteTokens),
    });
  }
  if (metrics.cacheReadTokens !== undefined && inputTokens > 0) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.cacheHitRate" }),
      value: formatPercent(locale, metrics.cacheReadTokens / inputTokens),
    });
  }
  if (metrics.firstTokenMs !== null && metrics.firstTokenMs !== undefined) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.ttft" }),
      value: formatTurnFirstTokenMs(metrics.firstTokenMs),
    });
  }
  if (metrics.requestCount !== undefined) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.requestCount" }),
      value: formatCount(locale, metrics.requestCount),
    });
  }
  const segmentsPeak = buildSegmentsPeakRow({ metrics, locale, formatMessage });
  if (segmentsPeak !== null) detailRows.push(segmentsPeak);
  return {
    id: "turnUsage",
    label: formatMessage({ id: "chat.usageStatusbar.turnUsage.label" }),
    value: formatCompact(locale, inputTokens + outputTokens),
    tone: "default",
    detailRows,
    note: formatMessage({ id: "chat.usageStatusbar.turnUsage.note" }),
  };
}
