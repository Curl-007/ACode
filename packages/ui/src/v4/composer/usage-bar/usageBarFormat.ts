/**
 * 用量状态栏的格式化工具（apps/acode-cli/specs/usage-statusbar-port.md）。
 *
 * 几个兄弟段构造器共用同一套格式化；纯函数、无 React/i18n provider 依赖。
 */
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

export function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatExact(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatPercent(locale: string, ratio: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: "percent" }).format(
    Math.min(1, Math.max(0, ratio)),
  );
}

/**
 * 不钳制的百分比：容量段的段值要如实显示 103%（超出窗口的量必须看得见），
 * 环形弧本身仍由 `ringRatio` 钳在 100%。
 */
export function formatPercentUnclamped(locale: string, ratio: number): string {
  const safe = Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: "percent" }).format(safe);
}

export function formatCompact(locale: string, value: number): string {
  return formatCompactTokenNumber(locale, value);
}

/**
 * 工具/轮累计耗时：秒级取整、分钟给 `Xm Ys`、小时给 `Xh Ym`。
 * 与回答末尾速率行的耗时格式同档（<60s 不给 `m0s` 那种无意义读数）。
 */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds > 0 ? `${seconds}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours}h${restMinutes > 0 ? `${restMinutes}m` : ""}`;
}
