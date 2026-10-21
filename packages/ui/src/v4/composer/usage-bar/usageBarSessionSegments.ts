/**
 * 会话累计 / 工具调用 / 今日合计 / 子智能体四段的构造
 * （apps/acode-cli/specs/usage-statusbar-port.md §2.1）。
 *
 * 与 `usageBarSegments.ts`（速度、本轮用量）拆开：两批加起来顶到 max-lines 上限，
 * 按「本轮口径 / 会话与本地口径」切分；两侧共用 `usageBarFormat` 与 `buildErrorBadge`。
 */
import type { UsageBarDetailRow, UsageBarSegment } from "./usageBarModel.js";
import {
  formatCompact,
  formatCount,
  formatDurationMs,
  formatExact,
  formatPercent,
} from "./usageBarFormat.js";
import { buildErrorBadge, TOOL_DETAIL_ROW_LIMIT, type ToolStatsInput } from "./usageBarSegments.js";
import type { TurnMetricsMessageFormat } from "@/chat-input-toolbar/turnMetrics.js";

function pushRow(
  rows: UsageBarDetailRow[],
  label: string,
  value: string | null,
  tone?: UsageBarDetailRow["tone"],
): void {
  if (value === null) return;
  rows.push({ label, value, ...(tone === undefined ? {} : { tone }) });
}

export function buildSessionSegment(input: {
  sessionTokenTotal: number;
  incompleteTotal: boolean;
  mainInputTokens: number | null;
  mainOutputTokens: number | null;
  cacheHitRate: number | null;
  childCount: number;
  childTokenTotal: number;
  toolStats: ToolStatsInput | null;
  estimatedCostLabel: string | null;
  locale: string;
  formatMessage: TurnMetricsMessageFormat;
}): UsageBarSegment {
  const {
    sessionTokenTotal,
    incompleteTotal,
    mainInputTokens,
    mainOutputTokens,
    cacheHitRate,
    childCount,
    childTokenTotal,
    toolStats,
    estimatedCostLabel,
    locale,
    formatMessage,
  } = input;
  // 明细顺序：输入 / 输出 / 思考 / 缓存命中率 / 轮数 / 模型请求数 / 工具·重试 / 代码增删 /
  // 子代理 / 预估费用；拿不到的字段整行不出现。
  const detailRows: UsageBarDetailRow[] = [];
  pushRow(
    detailRows,
    formatMessage({ id: "chat.usageStatusbar.detail.inputTokens" }),
    mainInputTokens === null ? null : formatCompact(locale, mainInputTokens),
  );
  pushRow(
    detailRows,
    formatMessage({ id: "chat.usageStatusbar.detail.outputTokens" }),
    mainOutputTokens === null ? null : formatCompact(locale, mainOutputTokens),
  );
  pushRow(
    detailRows,
    formatMessage({ id: "chat.usageStatusbar.detail.reasoningTokens" }),
    toolStats?.reasoningTokens === undefined
      ? null
      : formatCompact(locale, toolStats.reasoningTokens),
  );
  pushRow(
    detailRows,
    formatMessage({ id: "chat.usageStatusbar.detail.cacheHitRate" }),
    cacheHitRate === null || !Number.isFinite(cacheHitRate)
      ? null
      : formatPercent(locale, cacheHitRate),
  );
  pushRow(
    detailRows,
    formatMessage({ id: "chat.usageStatusbar.detail.turnCount" }),
    toolStats?.turnCount === undefined ? null : formatCount(locale, toolStats.turnCount),
  );
  pushRow(
    detailRows,
    formatMessage({ id: "chat.usageStatusbar.detail.requestCount" }),
    toolStats?.requestCount === undefined ? null : formatCount(locale, toolStats.requestCount),
  );
  if (toolStats !== null && (toolStats.calls > 0 || toolStats.retryCount !== undefined)) {
    // 「工具 · 重试」：两段都可缺——旧 CLI 只发 calls 时不显示重试，也不写 0。
    const callsLabel = formatMessage(
      { id: "chat.usageStatusbar.session.toolCalls" },
      { value: formatCount(locale, toolStats.calls) },
    );
    const retryLabel =
      toolStats.retryCount === undefined
        ? null
        : formatMessage(
            { id: "chat.usageStatusbar.session.retries" },
            { value: formatCount(locale, toolStats.retryCount) },
          );
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.session.toolsRetries" }),
      value: retryLabel === null ? callsLabel : `${callsLabel} · ${retryLabel}`,
      ...(toolStats.errors > 0 ? { badge: buildErrorBadge(toolStats.errors, formatMessage) } : {}),
    });
  }
  if (toolStats?.linesAdded !== undefined && toolStats.linesDeleted !== undefined) {
    const fileSuffix =
      toolStats.fileCount === undefined
        ? ""
        : ` (${formatMessage(
            { id: "chat.usageStatusbar.session.fileCount" },
            { value: formatCount(locale, toolStats.fileCount) },
          )})`;
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.codeDelta" }),
      value: `+${formatCount(locale, toolStats.linesAdded)} -${formatCount(locale, toolStats.linesDeleted)}${fileSuffix}`,
      tone: "success",
    });
  }
  if (childCount > 0) {
    detailRows.push({
      label: formatMessage({ id: "chat.sessionUsage.subagents" }),
      value: formatCompact(locale, Math.max(0, childTokenTotal)),
    });
  }
  pushRow(detailRows, formatMessage({ id: "chat.sessionUsage.estimatedCost" }), estimatedCostLabel);
  return {
    id: "session",
    label: formatMessage({ id: "chat.usageStatusbar.session.label" }),
    value: `${incompleteTotal ? "≥" : ""}${formatCompact(locale, sessionTokenTotal)}`,
    tone: "default",
    detailRows,
    note:
      estimatedCostLabel !== null
        ? `${formatMessage({ id: "chat.usageStatusbar.session.note" })} ${formatMessage({ id: "chat.sessionUsage.estimatedCostNote" })}`
        : formatMessage({ id: "chat.usageStatusbar.session.note" }),
  };
}

export function buildToolsSegment(input: {
  toolStats: ToolStatsInput;
  locale: string;
  formatMessage: TurnMetricsMessageFormat;
}): UsageBarSegment {
  const { toolStats, locale, formatMessage } = input;
  const { calls, errors } = toolStats;
  const detailRows: UsageBarDetailRow[] = [
    {
      label: formatMessage({ id: "chat.usageStatusbar.tools.calls" }),
      value: formatCount(locale, calls),
    },
  ];
  // 每工具明细：名称 / 调用次数 / 累计耗时 /（有错时）错误徽标。
  // 旧 CLI 不带 tools 时只剩下面两行，不建空壳。
  const tools = toolStats.tools ?? [];
  if (tools.length > 0) {
    for (const tool of [...tools]
      .sort((left, right) =>
        right.calls === left.calls ? left.name.localeCompare(right.name) : right.calls - left.calls,
      )
      .slice(0, TOOL_DETAIL_ROW_LIMIT)) {
      // 0ms 与「没有耗时」同档：不写「0s」这种无意义读数（口径与「缺失不写 0」一致）。
      const duration =
        tool.durationMs === undefined || tool.durationMs <= 0
          ? null
          : formatDurationMs(tool.durationMs);
      detailRows.push({
        label: tool.name,
        value:
          duration === null
            ? formatCount(locale, tool.calls)
            : `${formatCount(locale, tool.calls)} · ${duration}`,
        ...(tool.errors > 0 ? { badge: buildErrorBadge(tool.errors, formatMessage) } : {}),
      });
    }
  }
  detailRows.push({
    label: formatMessage({ id: "chat.usageStatusbar.tools.errors" }),
    value: formatCount(locale, errors),
    ...(errors > 0
      ? { badge: buildErrorBadge(errors, formatMessage), tone: "error" as const }
      : {}),
  });
  return {
    id: "tools",
    label: formatMessage({ id: "chat.usageStatusbar.tools.label" }),
    value: formatCount(locale, calls),
    // 段值只留调用次数；错误改由徽标承载（0 错误时整块不渲染）。
    tone: errors > 0 ? "error" : "default",
    ...(errors > 0 ? { badge: buildErrorBadge(errors, formatMessage) } : {}),
    detailRows,
    note: formatMessage({ id: "chat.usageStatusbar.tools.note" }),
  };
}

export function buildTodaySegment(input: {
  todayUsage: {
    totalTokens: number;
    turnCount: number;
    toolCallCount: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheHitRate?: number;
    requestCount?: number;
  };
  locale: string;
  formatMessage: TurnMetricsMessageFormat;
}): UsageBarSegment {
  const { todayUsage, locale, formatMessage } = input;
  const detailRows: UsageBarDetailRow[] = [
    {
      label: formatMessage({ id: "chat.usageStatusbar.detail.turnCount" }),
      value: formatCount(locale, todayUsage.turnCount),
    },
    {
      label: formatMessage({ id: "chat.usageStatusbar.today.tools" }),
      value: formatCount(locale, todayUsage.toolCallCount),
    },
  ];
  // 今日分项（本地 AppUsage 聚合 additive 字段）：拿不到就整行隐藏，不显示 0。
  const cacheSuffix =
    todayUsage.cacheHitRate === undefined || !Number.isFinite(todayUsage.cacheHitRate)
      ? ""
      : ` (${formatMessage(
          { id: "chat.usageStatusbar.today.cacheHit" },
          { value: formatPercent(locale, todayUsage.cacheHitRate) },
        )})`;
  if (todayUsage.inputTokens !== undefined) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.inputTokens" }),
      value: `${formatCompact(locale, todayUsage.inputTokens)}${cacheSuffix}`,
    });
  }
  if (todayUsage.outputTokens !== undefined) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.outputTokens" }),
      value: formatCompact(locale, todayUsage.outputTokens),
    });
  }
  if (todayUsage.requestCount !== undefined) {
    detailRows.push({
      label: formatMessage({ id: "chat.usageStatusbar.detail.requestCount" }),
      value: formatCount(locale, todayUsage.requestCount),
    });
  }
  return {
    id: "today",
    label: formatMessage({ id: "chat.usageStatusbar.today.label" }),
    value: formatCompact(locale, todayUsage.totalTokens),
    tone: "default",
    detailRows,
    note: formatMessage({ id: "chat.usageStatusbar.today.note" }),
  };
}

export function buildSubagentsSegment(input: {
  childTokenTotal: number;
  /** 只算正在运行任务的 token 合计；null = 运行中任务的用量都读不到。 */
  runningTokenTotal: number | null;
  childLiveOutputRate: number | null;
  childCurrentOutputTokens: number | null;
  /** 面板分组信息；运行中数量同时决定段值前缀与运行点。 */
  subagentGroups: { running: number; ended: number; mainTokenTotal: number | null };
  locale: string;
  formatMessage: TurnMetricsMessageFormat;
}): UsageBarSegment {
  const {
    childTokenTotal,
    runningTokenTotal,
    childLiveOutputRate,
    childCurrentOutputTokens,
    subagentGroups,
    locale,
    formatMessage,
  } = input;
  const childRate = childLiveOutputRate;
  const running = Math.max(0, subagentGroups.running);
  // 段值只反映「正在运行」：数量 · 运行中 tokens · 运行中速率，各自缺失就省略。
  // 已结束任务不进段值。
  const valueParts: string[] = [];
  if (running > 0) valueParts.push(formatCount(locale, running));
  const tokens = running > 0 ? runningTokenTotal : childTokenTotal;
  if (tokens !== null && tokens > 0) valueParts.push(formatCompact(locale, tokens));
  if (running > 0 && childRate !== null && childRate > 0) {
    valueParts.push(
      formatMessage(
        { id: "chat.usageStatusbar.subagents.rate" },
        { rate: formatExact(locale, Math.round(childRate)) },
      ),
    );
  }
  const detailRows: UsageBarDetailRow[] = [];
  pushRow(
    detailRows,
    formatMessage({ id: "chat.usageStatusbar.subagents.main" }),
    subagentGroups.mainTokenTotal === null
      ? null
      : formatCompact(locale, subagentGroups.mainTokenTotal),
  );
  if (subagentGroups.running > 0) {
    detailRows.push({
      label: formatMessage(
        { id: "chat.usageStatusbar.subagents.running" },
        { count: formatCount(locale, subagentGroups.running) },
      ),
      value: formatCompact(locale, childTokenTotal),
      tone: "live",
    });
  }
  if (subagentGroups.ended > 0) {
    detailRows.push({
      label: formatMessage(
        { id: "chat.usageStatusbar.subagents.ended" },
        { count: formatCount(locale, subagentGroups.ended) },
      ),
      value: subagentGroups.running > 0 ? "—" : formatCompact(locale, childTokenTotal),
    });
  }
  pushRow(
    detailRows,
    formatMessage({ id: "chat.sessionUsage.childCurrentOutput" }),
    childCurrentOutputTokens === null ? null : formatExact(locale, childCurrentOutputTokens),
  );
  if (childRate !== null && childRate > 0) {
    detailRows.push({
      label: formatMessage({ id: "chat.sessionUsage.childSpeed" }),
      value: formatMessage(
        { id: "chat.turnMetrics.tokensPerSecond" },
        { value: formatExact(locale, Math.round(childRate)) },
      ),
    });
  }
  return {
    id: "subagents",
    label: formatMessage({ id: "chat.usageStatusbar.subagents.label" }),
    value: valueParts.join(" · "),
    tone: running > 0 && childRate !== null && childRate > 0 ? "live" : "default",
    // 有任务在跑时补一个运行点（替代文字「运行中」）。面板打开入口由视图负责。
    ...(running > 0 ? { dot: "live" as const } : {}),
    detailRows,
    note: formatMessage({ id: "chat.usageStatusbar.subagents.note" }),
  };
}
