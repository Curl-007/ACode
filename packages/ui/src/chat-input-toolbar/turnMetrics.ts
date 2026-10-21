/**
 * Composer 生成指标状态栏的展示投影（apps/acode-cli/specs/usage-statusbar-port.md）。
 *
 * 指标由 CLI ProductProjection 累加后写入 `snapshot.composerTurnMetrics`。
 * 这里只做空值收口和格式化：不重算指标、不补默认值、不估算、不从 row 窗口挑轮次。
 * 纯函数、无 React 与 i18n provider 依赖；文案通过 `formatMessage` 注入，便于单测。
 */

export type TurnMetricsMessageFormat = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** 首 token 延迟：不足 1 秒给毫秒，其余给秒（10 秒以上取整），与轨迹耗时同一可读性档位。 */
export function formatTurnFirstTokenMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

/** 解码速度保留一位小数，与 Developer Tools 的 TPS 列一致。 */
export function formatTurnTokensPerSecond(tokensPerSecond: number, locale: string): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) return "";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(tokensPerSecond);
}
