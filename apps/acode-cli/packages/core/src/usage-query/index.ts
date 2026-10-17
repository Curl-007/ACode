// /usage 命令族的模块入口：parse → query → render 的单点组合。
// 宿主（cli command-center / bootstrap v4 handler）只调用 executeUsageQuery，
// 拿到纯文本回执；本模块不抛裸异常（非法参数与取数失败都渲染成可读回执）。
import { parseUsageQueryArgs } from "./parse.js";
import { runUsageQuery } from "./query.js";
import { renderUsageQueryFailure, renderUsageReport } from "./render.js";
import type { UsageQueryDeps, UsageQueryExecutionResult, UsageQueryReport } from "./types.js";

export async function executeUsageQuery(input: {
  args: string;
  /** 宿主 locale 原文（zh-CN/en-US/...）；normalizeUsageQueryLocale 归一化。 */
  locale?: string | null;
  deps: UsageQueryDeps;
}): Promise<UsageQueryExecutionResult> {
  const parsed = parseUsageQueryArgs(input.args);
  if (!parsed.ok) {
    const invalid: UsageQueryReport = {
      kind: "invalid",
      args: input.args,
      error: parsed.error,
    };
    return { ok: false, text: renderUsageReport(invalid, input.locale), scope: null };
  }
  try {
    const report = await runUsageQuery(input.deps, parsed.scope);
    return { ok: true, text: renderUsageReport(report, input.locale), scope: parsed.scope };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text: renderUsageQueryFailure(message, input.locale),
      scope: parsed.scope,
    };
  }
}

export {
  parseUsageQueryArgs,
  CURRENT_WINDOW_MINUTES,
  USAGE_DAYS_RANGE,
  USAGE_SESSIONS_LIMIT_RANGE,
  USAGE_MODELS_DAYS_RANGE,
  USAGE_SESSIONS_DEFAULT_LIMIT,
  USAGE_MODELS_DEFAULT_DAYS,
} from "./parse.js";
export { runUsageQuery, buildWindow, localDayStartMs } from "./query.js";
export {
  renderUsageReport,
  renderUsageHelp,
  renderUsageQueryUnavailable,
  renderUsageQueryFailure,
  renderParseError,
  formatCount,
  formatPercent,
  formatDurationMs,
  formatDayLabel,
  formatTimestamp,
  formatTzLabel,
} from "./render.js";
export { usageQueryTexts, normalizeUsageQueryLocale, type UsageQueryTexts } from "./text.js";
export type {
  UsageQueryLocale,
  UsageQueryScope,
  UsageQueryParseError,
  UsageQueryParseErrorCode,
  UsageQueryParseResult,
  UsageQueryDeps,
  UsageTokenTotals,
  UsageSessionEntry,
  UsageQueryWindow,
  UsageQueryReport,
  UsageQueryExecutionResult,
} from "./types.js";
export { USAGE_QUERY_DAY_MS } from "./types.js";
