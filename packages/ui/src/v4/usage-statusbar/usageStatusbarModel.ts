import type {
  ConversationRow,
  SessionUsageLastRequest,
  SessionUsageState,
  SubagentProjectionState,
  TurnHeaderRow,
  TurnHeaderStats,
} from "@acode/shared/acode-protocol-v4";
// hide-on-absent 判定拆至 usageStatusbarPresence（400 行 ratchet，纯移动）；此处
// re-export 保持既有导入面（UsageStatusbar 与测试的 deep-import 不得破）。
export {
  hasToolCallRows,
  resolveUsageStatusbarPresence,
  type UsageStatusbarPresence,
} from "@/v4/usage-statusbar/usageStatusbarPresence.js";
import { hasToolCallRows } from "@/v4/usage-statusbar/usageStatusbarPresence.js";

// 用量状态栏派生逻辑（specs/usage-statusbar.md「数据口径」节的 ui 消费端实现）。
// 纯函数纪律：
// - 所有函数对 null/undefined 输入返回显式零值语义（无活动会话 → 全零，绝不回退到
//   别的会话；「回退」在数据面就不存在——本模块只吃传入的 snapshot/rows）。
// - 「缺席 ≠ 0」：cumulative.reasoningTokens / subagent cumulativeTokens 等 optional
//   additive 字段缺席时返回 null（消费端隐藏明细，不得当零值渲染）。
// - tok/s 等派生值：分母缺失/为 0/非有限 → null（无数据缺省），不做任何猜测。

// ── 生成速度（口径 4：最近一次模型请求 outputTokens ÷ generationMs）──

export type UsageSpeedTier = "none" | "fast" | "normal" | "slow";

/** 快慢档阈值（tok/s）：仅呈现分色，不参与任何数据计算。 */
export const USAGE_SPEED_TIER_FAST_TPS = 50;
export const USAGE_SPEED_TIER_SLOW_TPS = 15;

/**
 * 最近一次模型请求的生成速度（tok/s）。
 * generationMs 口径由 core producer 单点计算（含思考从请求起算、否则从首字起算），
 * ui 只透传消费；无请求 / 分母非法 → null。
 */
export function deriveLastRequestTokensPerSecond(
  lastRequest: SessionUsageLastRequest | null | undefined,
): number | null {
  if (!lastRequest) return null;
  const { outputTokens, generationMs } = lastRequest;
  if (!Number.isFinite(outputTokens) || !Number.isFinite(generationMs) || generationMs <= 0) {
    return null;
  }
  return (outputTokens / generationMs) * 1000;
}

export function classifyUsageSpeedTier(tokensPerSecond: number | null): UsageSpeedTier {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond)) return "none";
  if (tokensPerSecond >= USAGE_SPEED_TIER_FAST_TPS) return "fast";
  if (tokensPerSecond < USAGE_SPEED_TIER_SLOW_TPS) return "slow";
  return "normal";
}

// ── 缓存命中率（口径 2：cacheRead ÷ input；input=0 不显示）──

/**
 * 缓存命中率。cache_read 已含于 input（AI SDK v6 Anthropic 口径），比值天然 ≤ 1，
 * 仍做钳位防脏数据。input ≤ 0 / 非有限 → null（不显示）。
 */
export function deriveCacheHitRate(
  inputTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
): number | null {
  if (
    typeof inputTokens !== "number" ||
    typeof cacheReadTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(cacheReadTokens) ||
    inputTokens <= 0
  ) {
    return null;
  }
  return Math.min(Math.max(cacheReadTokens / inputTokens, 0), 1);
}

// ── 会话累计（口径 1/6：snapshot.usage.cumulative 权威 + turnHeader 行求和）──

export interface SessionCumulativeSummary {
  inputTokens: number;
  outputTokens: number;
  /** 总用量 = input + output（cache_read 已含于 input，不重复相加）。 */
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** additive optional：旧投影缺席 = null（隐藏明细），不当 0 渲染。 */
  reasoningTokens: number | null;
  cacheHitRate: number | null;
  /** count(distinct turn)：投影窗口内 turnHeader 行数。 */
  turnCount: number;
  /** 模型请求计数累计：Σ turnHeader.stats.modelRequestCount。 */
  modelRequestCount: number;
  additions: number;
  deletions: number;
}

const ZERO_SESSION_CUMULATIVE: SessionCumulativeSummary = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: null,
  cacheHitRate: null,
  turnCount: 0,
  modelRequestCount: 0,
  additions: 0,
  deletions: 0,
};

function isTurnHeaderRow(row: ConversationRow): row is TurnHeaderRow {
  return row.kind === "turnHeader";
}

/**
 * 会话累计。token 面以 snapshot.usage.cumulative 为权威（producer 单点累计），
 * 轮数/请求数/代码增删从 turnHeader 行求和（rows 已是本窗口活动会话的投影行，
 * 每窗口绑定纪律由 props 供给方保证；null → 全零）。
 * reverted 的 fileChanges 不计入代码增删（已被回滚的改动不是产出）。
 */
export function summarizeSessionCumulative(
  usage: SessionUsageState | null | undefined,
  rows: readonly ConversationRow[] | null | undefined,
): SessionCumulativeSummary {
  const cumulative = usage?.cumulative;
  const inputTokens = Number.isFinite(cumulative?.inputTokens) ? (cumulative?.inputTokens ?? 0) : 0;
  const outputTokens = Number.isFinite(cumulative?.outputTokens)
    ? (cumulative?.outputTokens ?? 0)
    : 0;
  const cacheReadTokens = Number.isFinite(cumulative?.cacheReadTokens)
    ? (cumulative?.cacheReadTokens ?? 0)
    : 0;
  const cacheWriteTokens = Number.isFinite(cumulative?.cacheWriteTokens)
    ? (cumulative?.cacheWriteTokens ?? 0)
    : 0;
  const summary: SessionCumulativeSummary = {
    ...ZERO_SESSION_CUMULATIVE,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens:
      typeof cumulative?.reasoningTokens === "number" && Number.isFinite(cumulative.reasoningTokens)
        ? cumulative.reasoningTokens
        : null,
    cacheHitRate: deriveCacheHitRate(inputTokens, cacheReadTokens),
  };
  for (const row of rows ?? []) {
    if (!isTurnHeaderRow(row)) continue;
    summary.turnCount += 1;
    summary.modelRequestCount += Number.isFinite(row.stats?.modelRequestCount)
      ? (row.stats?.modelRequestCount ?? 0)
      : 0;
    const fileChanges = row.fileChanges;
    if (fileChanges && fileChanges.state !== "reverted") {
      summary.additions += Number.isFinite(fileChanges.additions) ? fileChanges.additions : 0;
      summary.deletions += Number.isFinite(fileChanges.deletions) ? fileChanges.deletions : 0;
    }
  }
  return summary;
}

// ── 本轮用量（最近完成 turn 的 turnHeader.stats）──

/**
 * 最近一个已完成（非 running）且带 stats 的 turnHeader 的统计。
 * 纯问答轮（stats=null）跳过继续向前找？——不：spec 定义「本轮用量 = 最近完成 turn」，
 * 最近完成的纯问答轮就是 null（胶囊显示无数据），绝不回退到更早的轮。
 */
export function deriveLastCompletedTurnStats(
  rows: readonly ConversationRow[] | null | undefined,
): TurnHeaderStats | null {
  const rowsList = rows ?? [];
  for (let index = rowsList.length - 1; index >= 0; index -= 1) {
    const row = rowsList[index];
    if (!row || !isTurnHeaderRow(row)) continue;
    if (row.state === "running") continue;
    return row.stats ?? null;
  }
  return null;
}

// ── 工具调用聚合（投影 toolCall 行本地聚合，零协议改动）──

export interface ToolCallAggregationEntry {
  toolName: string;
  count: number;
  errorCount: number;
  /** Σ(endedAt − startedAt)，仅两端在场的行计入；无数据 = null。 */
  totalDurationMs: number | null;
  lastErrorMessage: string | null;
}

export interface ToolCallAggregation {
  totalCount: number;
  errorCount: number;
  /** 仍在飞（inputStreaming/pendingApproval/running）的调用数。 */
  activeCount: number;
  /** 全会话最近一次工具错误消息（行序最后一条）；无错误 = null（specs/usage-statusbar.md「Tooltip 增强与实时动态显示口径」节）。 */
  lastErrorMessage: string | null;
  byTool: ToolCallAggregationEntry[];
}

const ACTIVE_TOOL_STATUSES: ReadonlySet<string> = new Set([
  "inputStreaming",
  "pendingApproval",
  "running",
]);

const ZERO_TOOL_AGGREGATION: ToolCallAggregation = {
  totalCount: 0,
  errorCount: 0,
  activeCount: 0,
  lastErrorMessage: null,
  byTool: [],
};

export function aggregateToolCallRows(
  rows: readonly ConversationRow[] | null | undefined,
): ToolCallAggregation {
  const rowsList = rows ?? [];
  if (!hasToolCallRows(rowsList)) return { ...ZERO_TOOL_AGGREGATION };
  const byTool = new Map<string, ToolCallAggregationEntry & { durationSampled: boolean }>();
  const aggregation: ToolCallAggregation = {
    totalCount: 0,
    errorCount: 0,
    activeCount: 0,
    lastErrorMessage: null,
    byTool: [],
  };
  for (const row of rowsList) {
    if (row.kind !== "toolCall") continue;
    aggregation.totalCount += 1;
    if (row.status === "error") {
      aggregation.errorCount += 1;
      // 行序最后一条错误即「最近错误」（行按时间追加），供 tooltip 单行展示。
      aggregation.lastErrorMessage = row.error?.message ?? null;
    }
    if (ACTIVE_TOOL_STATUSES.has(row.status)) aggregation.activeCount += 1;
    let entry = byTool.get(row.toolName);
    if (!entry) {
      entry = {
        toolName: row.toolName,
        count: 0,
        errorCount: 0,
        totalDurationMs: null,
        lastErrorMessage: null,
        durationSampled: false,
      };
      byTool.set(row.toolName, entry);
    }
    entry.count += 1;
    if (row.status === "error") {
      entry.errorCount += 1;
      entry.lastErrorMessage = row.error?.message ?? null;
    }
    if (typeof row.startedAt === "number" && typeof row.endedAt === "number") {
      const durationMs = row.endedAt - row.startedAt;
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        entry.totalDurationMs = (entry.totalDurationMs ?? 0) + durationMs;
        entry.durationSampled = true;
      }
    }
  }
  aggregation.byTool = [...byTool.values()]
    .sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName))
    .map(({ durationSampled: _durationSampled, ...entry }) => entry);
  return aggregation;
}

// ── 子智能体（主/子分列 + running 状态；归因只用投影官方关联字段）──

export interface SubagentPanelItem {
  childSessionId: string;
  /** 展示名：官方 title 优先；无名字显示线路名（subagentType）——宁无名不错名。 */
  label: string;
  labelSource: "title" | "subagentType" | "childSessionId";
  /** additive optional：旧投影缺席 = null（隐藏该列），不当 0 呈现。 */
  cumulativeTokens: number | null;
  status: "running" | "waiting" | "blocked";
}

export interface SubagentSummaryView {
  items: SubagentPanelItem[];
  runningCount: number;
  endedTotal: number;
  /** Σ 在场子代理的 cumulativeTokens；全部缺席 = null（隐藏而非 0）。 */
  childTotalTokens: number | null;
}

const ZERO_SUBAGENT_VIEW: SubagentSummaryView = {
  items: [],
  runningCount: 0,
  endedTotal: 0,
  childTotalTokens: null,
};

export function buildSubagentSummaryView(
  subagents: SubagentProjectionState | null | undefined,
): SubagentSummaryView {
  const running = subagents?.running ?? [];
  if (!subagents || running.length === 0) {
    return {
      ...ZERO_SUBAGENT_VIEW,
      endedTotal: Number.isFinite(subagents?.endedTotal) ? (subagents?.endedTotal ?? 0) : 0,
    };
  }
  let childTotalTokens: number | null = null;
  const items: SubagentPanelItem[] = running.map((entry) => {
    const title = entry.title?.trim();
    const subagentType = entry.subagentType?.trim();
    const label = title || subagentType || entry.childSessionId;
    const labelSource: SubagentPanelItem["labelSource"] = title
      ? "title"
      : subagentType
        ? "subagentType"
        : "childSessionId";
    const cumulativeTokens =
      typeof entry.cumulativeTokens === "number" && Number.isFinite(entry.cumulativeTokens)
        ? entry.cumulativeTokens
        : null;
    if (cumulativeTokens !== null) {
      childTotalTokens = (childTotalTokens ?? 0) + cumulativeTokens;
    }
    return {
      childSessionId: entry.childSessionId,
      label,
      labelSource,
      cumulativeTokens,
      status: entry.status,
    };
  });
  return {
    items,
    runningCount: items.filter((item) => item.status === "running").length,
    endedTotal: Number.isFinite(subagents.endedTotal) ? subagents.endedTotal : 0,
    childTotalTokens,
  };
}

// ── 回答末尾速率行（口径 4 的加权形态：Σoutput ÷ ΣgenerationMs 已在 stats 内聚合）──

export interface TurnRateLineModel {
  /** 加权速度：stats.outputTokens（含思考）÷ stats.generationMs；分母缺失/0 → null。 */
  tokensPerSecond: number | null;
  timeToFirstTokenMs: number | null;
  outputTokens: number;
  generationMs: number | null;
  /** 本轮服务过的模型身份（请求序，≤4）；≥2 = 多模型轮（轮中晋升标记，spec「多模型轮标记」）。 */
  servedModels: string[];
  /** 本轮提示缓存未命中计数；null = 事实缺席（旧投影），不渲染缓存行。 */
  promptCacheMisses: number | null;
}

export function deriveTurnRateLine(
  stats: TurnHeaderStats | null | undefined,
): TurnRateLineModel | null {
  if (!stats) return null;
  const generationMs =
    typeof stats.generationMs === "number" && Number.isFinite(stats.generationMs)
      ? stats.generationMs
      : null;
  const outputTokens = Number.isFinite(stats.outputTokens) ? stats.outputTokens : 0;
  return {
    tokensPerSecond:
      generationMs !== null && generationMs > 0 ? (outputTokens / generationMs) * 1000 : null,
    timeToFirstTokenMs:
      typeof stats.timeToFirstTokenMs === "number" && Number.isFinite(stats.timeToFirstTokenMs)
        ? stats.timeToFirstTokenMs
        : null,
    outputTokens,
    generationMs,
    servedModels: Array.isArray(stats.servedModels)
      ? stats.servedModels.filter((model): model is string => typeof model === "string")
      : [],
    promptCacheMisses:
      typeof stats.promptCacheMisses === "number" && Number.isFinite(stats.promptCacheMisses)
        ? stats.promptCacheMisses
        : null,
  };
}
