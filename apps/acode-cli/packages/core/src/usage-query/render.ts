// /usage 纯文本报表渲染：输入 = query.ts 的报表数据 + locale，输出 = 多行文本。
// 纯函数，无 IO；宿主（cli command-center / bootstrap v4 handler）只负责把 text 装进回执。
import type { AppUsageQueryResult } from "@acode/contracts";
import { normalizeUsageQueryLocale, usageQueryTexts, type UsageQueryTexts } from "./text.js";
import type {
  UsageQueryLocale,
  UsageQueryParseError,
  UsageQueryReport,
  UsageSessionEntry,
  UsageTokenTotals,
} from "./types.js";
import { USAGE_QUERY_DAY_MS } from "./types.js";

const EMPTY_PLACEHOLDER = "—";

export function renderUsageReport(report: UsageQueryReport, locale?: string | null): string {
  const texts = usageQueryTexts(normalizeUsageQueryLocale(locale));
  switch (report.kind) {
    case "invalid":
      return [renderParseErrorText(report.error, texts), "", ...renderUsageHelpLines(texts)].join("\n");
    case "range":
      return renderRangeReport(report, texts);
    case "models":
      return renderModelsReport(report, texts);
    case "sessions":
      return renderEntriesReport({
        heading: texts.heading.sessions(report.limit),
        report,
        texts,
      });
    case "workspace":
      return renderEntriesReport({
        heading: texts.heading.workspace(report.keyword),
        report,
        texts,
      });
    case "session":
      return renderEntriesReport({
        heading: texts.heading.session(report.prefix),
        report,
        texts,
        detailed: true,
      });
    case "current":
      return renderEntriesReport({
        heading: texts.heading.current(report.windowMinutes),
        report,
        texts,
        footnote:
          report.entries.length > 0
            ? texts.sessions.currentFootnote(report.windowMinutes)
            : undefined,
      });
  }
}

export function renderUsageHelp(locale?: string | null): string {
  const texts = usageQueryTexts(normalizeUsageQueryLocale(locale));
  return renderUsageHelpLines(texts).join("\n");
}

/** 宿主无用量数据源时的可读回执（bootstrap leaf 在 store 缺席时用，不抛裸异常）。 */
export function renderUsageQueryUnavailable(locale?: string | null): string {
  return usageQueryTexts(normalizeUsageQueryLocale(locale)).errors.unavailable;
}

/** 取数意外失败时的可读回执（executeUsageQuery 捕获后走这里）。 */
export function renderUsageQueryFailure(message: string, locale?: string | null): string {
  return usageQueryTexts(normalizeUsageQueryLocale(locale)).errors.failed(message);
}

// ── range / models ─────────────────────────────────────────────

function renderRangeReport(
  report: Extract<UsageQueryReport, { kind: "range" }>,
  texts: UsageQueryTexts,
): string {
  const { window, result } = report;
  const heading =
    report.range === "today"
      ? texts.heading.today
      : report.range === "week"
        ? texts.heading.week
        : texts.heading.days(window.dayCount);
  if (isRangeEmpty(result)) return [heading, texts.range.noData].join("\n");

  const totals = result.totals;
  // spec 数据口径 1：总用量 = input + output（cache_read 已含于 input，不重复相加）。
  const totalTokens = totals.inputTokens + totals.outputTokens;
  const lines = [
    heading,
    texts.range.window(formatTimestamp(window.since, window.tzOffsetMs), formatTzLabel(window.tzOffsetMs)),
    texts.range.total(
      formatCount(totalTokens),
      formatCount(totals.inputTokens),
      formatCount(totals.outputTokens),
    ),
  ];
  // spec 数据口径 2：input 为 0 时不显示命中率。
  if (totals.inputTokens > 0) {
    lines.push(
      texts.range.cacheHit(
        formatPercent(totals.cacheReadTokens / totals.inputTokens),
        formatCount(totals.cacheReadTokens),
        formatCount(totals.inputTokens),
      ),
    );
  }
  lines.push(
    texts.range.reasoning(formatCount(totals.reasoningTokens), formatCount(totals.cacheCreationTokens)),
    texts.range.requests(
      formatCount(totals.modelRequestCount),
      formatCount(totals.modelErrorCount),
      formatDurationMs(totals.avgTimeToFirstTokenMs),
    ),
    texts.range.turns(
      formatCount(result.turnTotals.totalSessions),
      formatCount(result.turnTotals.totalTurns),
      formatDurationMs(result.turnTotals.avgTurnDurationMs),
      formatDurationMs(result.turnTotals.longestSessionMs),
    ),
    texts.range.tools(
      formatCount(result.toolTotals.toolCallCount),
      formatCount(result.toolTotals.toolErrorCount),
    ),
  );
  if (window.dayCount > 1 && result.days.length > 0) {
    lines.push(texts.range.byDay);
    for (const day of result.days) {
      lines.push(
        texts.range.dayRow(
          formatDayLabel(day.dayIndex),
          formatCount(day.totalTokens),
          formatCount(day.turnCount),
          formatCount(day.toolCallCount),
        ),
      );
    }
  }
  return lines.join("\n");
}

function renderModelsReport(
  report: Extract<UsageQueryReport, { kind: "models" }>,
  texts: UsageQueryTexts,
): string {
  const { window, result } = report;
  const heading = texts.heading.models(window.dayCount);
  if (result.models.length === 0) return [heading, texts.range.noData].join("\n");

  const dayTokensByModel = new Map<string, Array<{ dayIndex: number; totalTokens: number }>>();
  for (const row of result.dayModels) {
    const key = row.modelId ?? "";
    const rows = dayTokensByModel.get(key);
    if (rows) rows.push(row);
    else dayTokensByModel.set(key, [row]);
  }
  const lines = [
    heading,
    texts.range.window(formatTimestamp(window.since, window.tzOffsetMs), formatTzLabel(window.tzOffsetMs)),
  ];
  for (const model of result.models) {
    const label = model.modelId ?? texts.models.unknownModel;
    lines.push(
      `${label}　${texts.models.modelTotal(formatCount(model.totalTokens))}　${texts.models.requests(formatCount(model.requestCount))}`,
    );
    const dayRows = (dayTokensByModel.get(model.modelId ?? "") ?? [])
      .filter((row) => row.totalTokens > 0)
      .sort((a, b) => a.dayIndex - b.dayIndex);
    for (const row of dayRows) {
      lines.push(`  ${formatDayLabel(row.dayIndex)}　${formatCount(row.totalTokens)}`);
    }
  }
  return lines.join("\n");
}

function isRangeEmpty(result: AppUsageQueryResult): boolean {
  return (
    result.totals.modelRequestCount === 0 &&
    result.turnTotals.totalTurns === 0 &&
    result.toolTotals.toolCallCount === 0
  );
}

// ── 会话条目类报表（sessions / workspace / session / current）──

function renderEntriesReport(input: {
  heading: string;
  report: Extract<UsageQueryReport, { kind: "sessions" | "workspace" | "session" | "current" }>;
  texts: UsageQueryTexts;
  detailed?: boolean;
  footnote?: string;
}): string {
  const { heading, report, texts } = input;
  if (report.entries.length === 0) {
    const emptyLine =
      report.kind === "current"
        ? texts.sessions.currentEmpty(report.windowMinutes)
        : texts.sessions.noSessions;
    return [heading, emptyLine].join("\n");
  }
  const lines = [heading];
  for (const entry of report.entries) {
    lines.push(...renderEntryLines(entry, report, input.detailed === true, texts));
  }
  const totals = sumEntries(report.entries);
  lines.push(
    texts.sessions.grandTotal(
      formatCount(totals.totalTokens),
      report.entries.length,
      formatCount(totals.modelRequestCount),
      formatCount(totals.modelErrorCount),
    ),
  );
  if (input.footnote) lines.push(input.footnote);
  return lines.join("\n");
}

function renderEntryLines(
  entry: UsageSessionEntry,
  report: Extract<UsageQueryReport, { kind: "sessions" | "workspace" | "session" | "current" }>,
  detailed: boolean,
  texts: UsageQueryTexts,
): string[] {
  const title = entry.session.title.trim() || texts.sessions.untitled;
  // current 口径下未命中窗口的父会话不在报表里，子会话行标注父 ID 供追溯。
  const parentSuffix = entry.session.parentID ? `　${texts.sessions.parent(entry.session.parentID)}` : "";
  const header = `- ${title}　[${entry.session.id}]${parentSuffix}　${texts.sessions.updated(
    formatTimestamp(entry.session.time.updated, report.tzOffsetMs),
  )}`;
  const usage = entry.usage;
  const usageParts = [
    texts.sessions.usage(
      formatCount(usage.totalTokens),
      formatCount(usage.inputTokens),
      formatCount(usage.outputTokens),
      formatCount(usage.modelRequestCount),
      formatCount(usage.modelErrorCount),
    ),
  ];
  if (usage.inputTokens > 0) {
    usageParts.push(texts.sessions.cacheHit(formatPercent(usage.cacheReadTokens / usage.inputTokens)));
  }
  if (entry.mergedChildIds.length > 0) {
    usageParts.push(texts.sessions.mergedChildren(entry.mergedChildIds.length));
  }
  const lines = [header, `  ${usageParts.join("　")}`];
  if (detailed) {
    lines.push(
      `  ${texts.sessions.detail(
        formatCount(usage.reasoningTokens),
        formatCount(usage.cacheReadTokens),
        formatCount(usage.cacheCreationTokens),
      )}`,
    );
  }
  return lines;
}

function sumEntries(entries: readonly UsageSessionEntry[]): UsageTokenTotals {
  const totals: UsageTokenTotals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelRequestCount: 0,
    modelErrorCount: 0,
  };
  for (const entry of entries) {
    totals.totalTokens += entry.usage.totalTokens;
    totals.inputTokens += entry.usage.inputTokens;
    totals.outputTokens += entry.usage.outputTokens;
    totals.reasoningTokens += entry.usage.reasoningTokens;
    totals.cacheCreationTokens += entry.usage.cacheCreationTokens;
    totals.cacheReadTokens += entry.usage.cacheReadTokens;
    totals.modelRequestCount += entry.usage.modelRequestCount;
    totals.modelErrorCount += entry.usage.modelErrorCount;
  }
  return totals;
}

// ── 帮助 / 非法参数回执 ────────────────────────────────────────

function renderUsageHelpLines(texts: UsageQueryTexts): string[] {
  return [texts.help.title, ...texts.help.lines, texts.help.currentNote, texts.help.retentionNote];
}

export function renderParseError(error: UsageQueryParseError, locale?: string | null): string {
  const texts = usageQueryTexts(normalizeUsageQueryLocale(locale));
  return renderParseErrorText(error, texts);
}

function renderParseErrorText(error: UsageQueryParseError, texts: UsageQueryTexts): string {
  switch (error.code) {
    case "unknownScope":
      return texts.errors.unknownScope(error.value);
    case "multipleArgs":
      return texts.errors.multipleArgs(error.value);
    case "invalidNumber":
      return texts.errors.invalidNumber(error.value);
    case "outOfRange":
      return texts.errors.outOfRange(error.value, error.min ?? 0, error.max ?? 0);
    case "emptyKeyword":
      return texts.errors.emptyKeyword;
    case "emptyPrefix":
      return texts.errors.emptyPrefix;
  }
}

// ── 数字/时间格式化（两种语言共用；不依赖 Intl locale，保证快照稳定）──

export function formatCount(value: number): string {
  return groupDigits(Math.trunc(value));
}

function groupDigits(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}${String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return EMPTY_PLACEHOLDER;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** dayIndex → 本地日历日（dayIndex*DAY 是「本地午夜当作 UTC」，取 UTC 分量即本地日期）。 */
export function formatDayLabel(dayIndex: number): string {
  return new Date(dayIndex * USAGE_QUERY_DAY_MS).toISOString().slice(0, 10);
}

export function formatTimestamp(ms: number, tzOffsetMs: number): string {
  return new Date(ms + tzOffsetMs).toISOString().slice(0, 16).replace("T", " ");
}

export function formatTzLabel(tzOffsetMs: number): string {
  if (tzOffsetMs === 0) return "UTC";
  const sign = tzOffsetMs > 0 ? "+" : "-";
  const abs = Math.abs(tzOffsetMs);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  return `UTC${sign}${hours}${minutes > 0 ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

export type { UsageQueryLocale };
