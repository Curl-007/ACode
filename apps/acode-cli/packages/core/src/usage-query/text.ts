// /usage 报表的 zh/en 两套文案（core 内无既有双语回执先例——runtime 侧回执是结构化
// 事实、由 UI 层映射语言；本模块按任务裁决自带文案表，locale 由宿主注入并归一化）。
// 数字一律半角、千分位逗号；两种语言共用同一布局，只有词面不同。
import type { UsageQueryLocale } from "./types.js";

export interface UsageQueryTexts {
  heading: {
    today: string;
    week: string;
    days(n: number): string;
    models(n: number): string;
    sessions(n: number): string;
    workspace(keyword: string): string;
    session(prefix: string): string;
    current(minutes: number): string;
  };
  range: {
    window(sinceLabel: string, tzLabel: string): string;
    total(total: string, input: string, output: string): string;
    cacheHit(pct: string, cacheRead: string, input: string): string;
    reasoning(reasoning: string, cacheWrite: string): string;
    requests(count: string, errors: string, avgTtft: string): string;
    turns(sessions: string, turns: string, avgTurn: string, longest: string): string;
    tools(count: string, errors: string): string;
    byDay: string;
    dayRow(day: string, tokens: string, turns: string, tools: string): string;
    noData: string;
  };
  models: {
    unknownModel: string;
    modelTotal(tokens: string): string;
    requests(count: string): string;
  };
  sessions: {
    untitled: string;
    updated(ts: string): string;
    usage(total: string, input: string, output: string, requests: string, errors: string): string;
    cacheHit(pct: string): string;
    mergedChildren(count: number): string;
    parent(id: string): string;
    detail(reasoning: string, cacheRead: string, cacheWrite: string): string;
    grandTotal(total: string, sessions: number, requests: string, errors: string): string;
    noSessions: string;
    currentEmpty(minutes: number): string;
    currentFootnote(minutes: number): string;
  };
  errors: {
    unknownScope(value: string): string;
    multipleArgs(value: string): string;
    invalidNumber(value: string): string;
    outOfRange(value: string, min: number, max: number): string;
    emptyKeyword: string;
    emptyPrefix: string;
    unavailable: string;
    failed(message: string): string;
  };
  help: {
    title: string;
    lines: readonly string[];
    currentNote: string;
    retentionNote: string;
  };
}

const ZH: UsageQueryTexts = {
  heading: {
    today: "今日用量（本地日）",
    week: "近 7 天用量",
    days: (n) => `近 ${n} 天用量`,
    models: (n) => `按天模型细分（近 ${n} 天）`,
    sessions: (n) => `最近 ${n} 个会话（累计用量）`,
    workspace: (keyword) => `工作区匹配："${keyword}"`,
    session: (prefix) => `会话 ID 前缀匹配："${prefix}"`,
    current: (minutes) => `当前会话（最近 ${minutes} 分钟内有请求）`,
  },
  range: {
    window: (sinceLabel, tzLabel) => `范围：${sinceLabel} → 现在（${tzLabel}）`,
    total: (total, input, output) => `总用量：${total} tokens（输入 ${input} / 输出 ${output}）`,
    cacheHit: (pct, cacheRead, input) => `缓存命中率：${pct}（cache_read ${cacheRead} / 输入 ${input}）`,
    reasoning: (reasoning, cacheWrite) => `思考 tokens：${reasoning}　缓存写入：${cacheWrite}`,
    requests: (count, errors, avgTtft) => `模型请求：${count}（错误 ${errors}）　平均 TTFT：${avgTtft}`,
    turns: (sessions, turns, avgTurn, longest) =>
      `会话：${sessions}　轮次：${turns}　平均轮耗时：${avgTurn}　最长会话：${longest}`,
    tools: (count, errors) => `工具调用：${count}（错误 ${errors}）`,
    byDay: "按日：",
    dayRow: (day, tokens, turns, tools) => `  ${day}　tokens ${tokens}　轮次 ${turns}　工具 ${tools}`,
    noData: "该范围内没有用量数据。",
  },
  models: {
    unknownModel: "（未知模型）",
    modelTotal: (tokens) => `合计 ${tokens}`,
    requests: (count) => `请求 ${count}`,
  },
  sessions: {
    untitled: "（无标题）",
    updated: (ts) => `更新 ${ts}`,
    usage: (total, input, output, requests, errors) =>
      `总用量 ${total}（输入 ${input} / 输出 ${output}）　请求 ${requests}（错误 ${errors}）`,
    cacheHit: (pct) => `缓存命中 ${pct}`,
    mergedChildren: (count) => `已合并子会话 ${count}`,
    parent: (id) => `（父会话 ${id}）`,
    detail: (reasoning, cacheRead, cacheWrite) =>
      `思考 ${reasoning}　缓存读 ${cacheRead}　缓存写 ${cacheWrite}`,
    grandTotal: (total, sessions, requests, errors) =>
      `合计：${total} tokens　会话 ${sessions} 个　请求 ${requests}（错误 ${errors}）`,
    noSessions: "没有匹配的会话。",
    currentEmpty: (minutes) => `最近 ${minutes} 分钟内没有请求活动的会话。`,
    currentFootnote: (minutes) =>
      `注：current = 最近 ${minutes} 分钟内有请求的会话，与状态栏的「本窗口焦点会话」不保证等同。`,
  },
  errors: {
    unknownScope: (value) => `无法识别的 /usage 参数："${value}"。`,
    multipleArgs: (value) => `/usage 只接受一个 scope 参数，收到："${value}"。`,
    invalidNumber: (value) => `days:N / sessions:N / models:N 的 N 需要十进制整数，收到："${value}"。`,
    outOfRange: (value, min, max) => `N 超出允许范围 ${min}-${max}，收到："${value}"。`,
    emptyKeyword: "workspace: 需要一个非空关键词。",
    emptyPrefix: "session: 需要一个非空 ID 前缀。",
    unavailable: "当前宿主没有可用的用量数据源。",
    failed: (message) => `用量查询失败：${message}`,
  },
  help: {
    title: "用法：/usage [scope]",
    lines: [
      "  （留空）| today    今日（本地时区当天）",
      "  week               近 7 天",
      "  days:N             近 N 天（1-365）",
      "  sessions[:N]       最近 N 个会话的累计用量（默认 10，1-100；子会话并入根会话）",
      "  models[:N]         近 N 天的按天模型细分（默认 7，1-90）",
      "  workspace:关键词    按目录/路径/workspace 标识匹配会话（子代理消耗并入父会话）",
      "  session:ID前缀     按会话 ID 前缀匹配（子会话并入命中的祖先）",
      "  current            最近 30 分钟内有请求的会话",
    ],
    currentNote: "注：current 与状态栏的「本窗口焦点会话」口径不同，不保证等同。",
    retentionNote: "注：用量账本保留 30 天，更早的范围如实显示为空。",
  },
};

const EN: UsageQueryTexts = {
  heading: {
    today: "Today's usage (local day)",
    week: "Last 7 days usage",
    days: (n) => `Last ${n} days usage`,
    models: (n) => `Per-day model breakdown (last ${n} days)`,
    sessions: (n) => `${n} most recent sessions (cumulative usage)`,
    workspace: (keyword) => `Workspace match: "${keyword}"`,
    session: (prefix) => `Session ID prefix match: "${prefix}"`,
    current: (minutes) => `Current sessions (requested within last ${minutes} minutes)`,
  },
  range: {
    window: (sinceLabel, tzLabel) => `Range: ${sinceLabel} → now (${tzLabel})`,
    total: (total, input, output) => `Total: ${total} tokens (input ${input} / output ${output})`,
    cacheHit: (pct, cacheRead, input) => `Cache hit rate: ${pct} (cache_read ${cacheRead} / input ${input})`,
    reasoning: (reasoning, cacheWrite) => `Reasoning tokens: ${reasoning}   Cache write: ${cacheWrite}`,
    requests: (count, errors, avgTtft) => `Model requests: ${count} (errors ${errors})   Avg TTFT: ${avgTtft}`,
    turns: (sessions, turns, avgTurn, longest) =>
      `Sessions: ${sessions}   Turns: ${turns}   Avg turn: ${avgTurn}   Longest session: ${longest}`,
    tools: (count, errors) => `Tool calls: ${count} (errors ${errors})`,
    byDay: "By day:",
    dayRow: (day, tokens, turns, tools) => `  ${day}   tokens ${tokens}   turns ${turns}   tools ${tools}`,
    noData: "No usage data in this range.",
  },
  models: {
    unknownModel: "(unknown model)",
    modelTotal: (tokens) => `total ${tokens}`,
    requests: (count) => `requests ${count}`,
  },
  sessions: {
    untitled: "(untitled)",
    updated: (ts) => `updated ${ts}`,
    usage: (total, input, output, requests, errors) =>
      `total ${total} (input ${input} / output ${output})   requests ${requests} (errors ${errors})`,
    cacheHit: (pct) => `cache hit ${pct}`,
    mergedChildren: (count) => `merged children ${count}`,
    parent: (id) => `(parent ${id})`,
    detail: (reasoning, cacheRead, cacheWrite) =>
      `reasoning ${reasoning}   cache read ${cacheRead}   cache write ${cacheWrite}`,
    grandTotal: (total, sessions, requests, errors) =>
      `Total: ${total} tokens   ${sessions} sessions   ${requests} requests (${errors} errors)`,
    noSessions: "No matching sessions.",
    currentEmpty: (minutes) => `No sessions with request activity in the last ${minutes} minutes.`,
    currentFootnote: (minutes) =>
      `Note: current = sessions that issued requests within the last ${minutes} minutes; not guaranteed to equal the status bar's focused-session figure.`,
  },
  errors: {
    unknownScope: (value) => `Unrecognized /usage argument: "${value}".`,
    multipleArgs: (value) => `/usage takes a single scope argument; got: "${value}".`,
    invalidNumber: (value) => `N in days:N / sessions:N / models:N must be a decimal integer; got: "${value}".`,
    outOfRange: (value, min, max) => `N out of allowed range ${min}-${max}; got: "${value}".`,
    emptyKeyword: "workspace: requires a non-empty keyword.",
    emptyPrefix: "session: requires a non-empty ID prefix.",
    unavailable: "Usage data source is not available on this host.",
    failed: (message) => `Usage query failed: ${message}`,
  },
  help: {
    title: "Usage: /usage [scope]",
    lines: [
      "  (empty) | today    Today (local calendar day)",
      "  week               Last 7 days",
      "  days:N             Last N days (1-365)",
      "  sessions[:N]       Cumulative usage of the N most recent sessions (default 10, 1-100; children merged into roots)",
      "  models[:N]         Per-day model breakdown for the last N days (default 7, 1-90)",
      "  workspace:<kw>     Sessions matched by directory/path/workspace identity (subagent usage merged into parents)",
      "  session:<prefix>   Sessions matched by session ID prefix (children merged into matched ancestors)",
      "  current            Sessions that issued requests within the last 30 minutes",
    ],
    currentNote: "Note: current differs from the status bar's focused-session figure; they are not guaranteed to be equal.",
    retentionNote: "Note: the usage ledger retains 30 days; older ranges legitimately show empty.",
  },
};

export function usageQueryTexts(locale: UsageQueryLocale): UsageQueryTexts {
  return locale === "zh" ? ZH : EN;
}

/** 宿主 locale（zh-CN/en-US/auto/裸 string）→ 模块 locale：zh* 前缀归 zh，其余一律 en。 */
export function normalizeUsageQueryLocale(locale: string | undefined | null): UsageQueryLocale {
  return locale?.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}
