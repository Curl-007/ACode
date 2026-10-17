import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

// 用量状态栏展示格式化（纯函数；locale 显式入参，不触全局状态）。
// 无数据一律 "—"（em dash），与「缺席 ≠ 0」的模型层语义配套。

export const USAGE_NO_DATA_PLACEHOLDER = "—";

export function formatTokensPerSecond(locale: string, tokensPerSecond: number | null): string {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond)) {
    return USAGE_NO_DATA_PLACEHOLDER;
  }
  const value = new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(tokensPerSecond);
  return `${value} tok/s`;
}

export function formatUsageDurationMs(locale: string, durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return USAGE_NO_DATA_PLACEHOLDER;
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 1 }).format(seconds)}s`;
  }
  const wholeMinutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds - wholeMinutes * 60);
  return `${wholeMinutes}m${String(restSeconds).padStart(2, "0")}s`;
}

export function formatUsageTokenCount(locale: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return USAGE_NO_DATA_PLACEHOLDER;
  }
  return formatCompactTokenNumber(locale, value);
}

export function formatUsagePercent(locale: string, ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) {
    return USAGE_NO_DATA_PLACEHOLDER;
  }
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(ratio);
}

export function formatUsageCount(locale: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return USAGE_NO_DATA_PLACEHOLDER;
  }
  return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 0 }).format(value);
}

/** 代码增删（+additions / −deletions）；两端都为 0 时仍显示 "+0 −0"（零值是事实不是无数据）。 */
export function formatCodeDelta(locale: string, additions: number, deletions: number): string {
  const numberFormat = new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 0 });
  return `+${numberFormat.format(additions)} −${numberFormat.format(deletions)}`;
}
