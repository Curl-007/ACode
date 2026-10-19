import assert from "node:assert/strict";
import test from "node:test";
import type { AppUsageSnapshot } from "@acode/shared";
import type {
  ConversationRow,
  SessionUsageState,
  SubagentProjectionState,
  TurnHeaderRow,
  TurnHeaderStats,
  ToolCallRow,
} from "@acode/shared/acode-protocol-v4";
import {
  aggregateToolCallRows,
  buildSubagentSummaryView,
  classifyUsageSpeedTier,
  deriveCacheHitRate,
  deriveLastCompletedTurnStats,
  deriveLastRequestTokensPerSecond,
  deriveTurnRateLine,
  hasToolCallRows,
  resolveUsageStatusbarPresence,
  summarizeSessionCumulative,
  USAGE_SPEED_TIER_FAST_TPS,
  USAGE_SPEED_TIER_SLOW_TPS,
} from "../src/v4/usage-statusbar/usageStatusbarModel.js";
import {
  deriveTodayUsageTotals,
  resolveTodayDateKey,
} from "../src/v4/usage-statusbar/usageStatusbarTodayModel.js";

// 派生逻辑全量单测（specs/usage-statusbar.md 验收场景 5 的纯函数层）：
// 零值语义（null 输入不回退）、口径（tok/s、缓存命中率、总用量）、缺席 ≠ 0。

let nextRowId = 1;

function makeTurnHeader(overrides: Partial<TurnHeaderRow> = {}): TurnHeaderRow {
  return {
    rowId: nextRowId++,
    turnId: `turn-${nextRowId}`,
    createdAt: 1_700_000_000_000,
    createdAtSeq: nextRowId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    rowId: nextRowId++,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000,
    createdAtSeq: nextRowId,
    kind: "toolCall",
    toolCallId: `tc-${nextRowId}`,
    toolName: "Bash",
    status: "success",
    inputText: "{}",
    ...overrides,
  };
}

function makeStats(overrides: Partial<TurnHeaderStats> = {}): TurnHeaderStats {
  return {
    inputTokens: 100,
    outputTokens: 200,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelRequestCount: 1,
    ...overrides,
  };
}

function makeUsage(overrides: Partial<SessionUsageState["cumulative"]> = {}): SessionUsageState {
  return {
    contextWindow: null,
    cumulative: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...overrides,
    },
  };
}

const APP_USAGE_SNAPSHOT_STUB: AppUsageSnapshot = {
  range: "7d",
  generatedAt: 1_700_000_000_000,
  timeZone: "Asia/Shanghai",
  source: "agent-db",
  summary: {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheHitRate: 0,
    totalSessions: 0,
    totalTurns: 0,
    toolCallCount: 0,
    toolErrorRate: 0,
    modelErrorRate: 0,
    avgTimeToFirstTokenMs: null,
    avgTurnDurationMs: null,
    activeDays: 0,
    currentStreakDays: 0,
    longestSessionMs: 0,
    longestStreakDays: 0,
    peakDayTokens: 0,
    favoriteModel: null,
  },
  heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
  dailyModelUsage: [],
  models: [],
  tools: [],
};

// ── 生成速度 ──

test("deriveLastRequestTokensPerSecond：outputTokens ÷ generationMs（秒归一）", () => {
  assert.equal(
    deriveLastRequestTokensPerSecond({
      outputTokens: 1000,
      generationMs: 2000,
      completedAtMs: 1,
    }),
    500,
  );
});

test("deriveLastRequestTokensPerSecond：无请求/分母为 0/非有限 → null（无数据缺省，不猜测）", () => {
  assert.equal(deriveLastRequestTokensPerSecond(null), null);
  assert.equal(deriveLastRequestTokensPerSecond(undefined), null);
  assert.equal(
    deriveLastRequestTokensPerSecond({ outputTokens: 100, generationMs: 0, completedAtMs: 1 }),
    null,
  );
  assert.equal(
    deriveLastRequestTokensPerSecond({
      outputTokens: Number.NaN,
      generationMs: 100,
      completedAtMs: 1,
    }),
    null,
  );
});

test("classifyUsageSpeedTier：快慢档边界", () => {
  assert.equal(classifyUsageSpeedTier(null), "none");
  assert.equal(classifyUsageSpeedTier(USAGE_SPEED_TIER_FAST_TPS), "fast");
  assert.equal(classifyUsageSpeedTier(USAGE_SPEED_TIER_FAST_TPS - 0.1), "normal");
  assert.equal(classifyUsageSpeedTier(USAGE_SPEED_TIER_SLOW_TPS), "normal");
  assert.equal(classifyUsageSpeedTier(USAGE_SPEED_TIER_SLOW_TPS - 0.1), "slow");
  assert.equal(classifyUsageSpeedTier(Number.NaN), "none");
});

// ── 缓存命中率 ──

test("deriveCacheHitRate：cacheRead ÷ input；input=0 不显示", () => {
  assert.equal(deriveCacheHitRate(1000, 800), 0.8);
  assert.equal(deriveCacheHitRate(0, 500), null);
  assert.equal(deriveCacheHitRate(null, null), null);
  assert.equal(deriveCacheHitRate(-1, 10), null);
  // 脏数据（cacheRead > input）钳位到 1，不产生 >100% 的呈现。
  assert.equal(deriveCacheHitRate(100, 250), 1);
});

// ── 会话累计 ──

test("summarizeSessionCumulative：null 输入 → 全零值（无活动会话不回退）", () => {
  const summary = summarizeSessionCumulative(null, null);
  assert.deepEqual(summary, {
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
  });
  assert.deepEqual(summarizeSessionCumulative(undefined, undefined).totalTokens, 0);
});

test("summarizeSessionCumulative：token 权威面 + turnHeader 行求和；reverted 不计", () => {
  const usage = makeUsage({
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 800,
    cacheWriteTokens: 20,
    reasoningTokens: 30,
  });
  const rows: ConversationRow[] = [
    makeTurnHeader({
      stats: makeStats({ modelRequestCount: 3 }),
      fileChanges: { additions: 10, deletions: 2, files: 1 },
    }),
    makeTurnHeader({
      stats: makeStats({ modelRequestCount: 2 }),
      fileChanges: { additions: 99, deletions: 99, files: 1, state: "reverted" },
    }),
    makeTurnHeader({ stats: null }),
    makeToolCall(),
  ];
  const summary = summarizeSessionCumulative(usage, rows);
  assert.equal(summary.totalTokens, 1500); // input + output，cacheRead 不重复相加
  assert.equal(summary.cacheHitRate, 0.8);
  assert.equal(summary.reasoningTokens, 30);
  assert.equal(summary.turnCount, 3); // distinct turn = turnHeader 行数（toolCall 不计）
  assert.equal(summary.modelRequestCount, 5);
  assert.equal(summary.additions, 10);
  assert.equal(summary.deletions, 2);
});

test("summarizeSessionCumulative：reasoningTokens 缺席 ≠ 0（旧投影不渲染明细）", () => {
  const summary = summarizeSessionCumulative(makeUsage({ inputTokens: 10 }), []);
  assert.equal(summary.reasoningTokens, null);
});

// ── 本轮用量 ──

test("deriveLastCompletedTurnStats：取最近完成轮；running 跳过；纯问答轮 = null 不回退更早轮", () => {
  const older = makeStats({ outputTokens: 111 });
  const rows: ConversationRow[] = [
    makeTurnHeader({ stats: older }),
    makeTurnHeader({ state: "running" }),
  ];
  // 最近一个非 running 的 turnHeader 携带 stats。
  assert.equal(deriveLastCompletedTurnStats(rows), older);

  // 最近完成轮是纯问答（stats=null）→ null，绝不回退到上一问的统计。
  const withNullTail: ConversationRow[] = [
    makeTurnHeader({ stats: older }),
    makeTurnHeader({ state: "completedSuccess", stats: null }),
  ];
  assert.equal(deriveLastCompletedTurnStats(withNullTail), null);

  assert.equal(deriveLastCompletedTurnStats(null), null);
  assert.equal(deriveLastCompletedTurnStats([]), null);
  assert.equal(deriveLastCompletedTurnStats([makeToolCall()]), null);
});

// ── 工具聚合 ──

test("aggregateToolCallRows：计数/错误标记/各工具耗时", () => {
  const rows: ConversationRow[] = [
    makeToolCall({ toolName: "Bash", startedAt: 1000, endedAt: 2500 }),
    makeToolCall({
      toolName: "Bash",
      status: "error",
      startedAt: 1000,
      endedAt: 1200,
      error: { code: "E", message: "boom" },
    }),
    makeToolCall({ toolName: "Read", status: "running" }),
    makeTurnHeader(),
  ];
  const aggregation = aggregateToolCallRows(rows);
  assert.equal(aggregation.totalCount, 3);
  assert.equal(aggregation.errorCount, 1);
  assert.equal(aggregation.activeCount, 1);
  // 全会话最近错误（行序最后一条）供 tooltip 单行展示。
  assert.equal(aggregation.lastErrorMessage, "boom");
  assert.equal(aggregation.byTool.length, 2);
  // 排序：count desc → 名称。
  assert.equal(aggregation.byTool[0]?.toolName, "Bash");
  assert.equal(aggregation.byTool[0]?.count, 2);
  assert.equal(aggregation.byTool[0]?.errorCount, 1);
  assert.equal(aggregation.byTool[0]?.totalDurationMs, 1700); // 1500 + 200
  assert.equal(aggregation.byTool[0]?.lastErrorMessage, "boom");
  // running 行无 startedAt/endedAt → 耗时保持 null（无数据 ≠ 0）。
  assert.equal(aggregation.byTool[1]?.toolName, "Read");
  assert.equal(aggregation.byTool[1]?.totalDurationMs, null);
});

test("aggregateToolCallRows：lastErrorMessage 取行序最后一条错误；无错误 = null", () => {
  const rows: ConversationRow[] = [
    makeToolCall({
      toolName: "Bash",
      status: "error",
      error: { code: "E", message: "first failure" },
    }),
    makeToolCall({
      toolName: "Grep",
      status: "error",
      error: { code: "E2", message: "latest failure" },
    }),
    makeToolCall({ toolName: "Read" }),
  ];
  const aggregation = aggregateToolCallRows(rows);
  assert.equal(aggregation.errorCount, 2);
  assert.equal(aggregation.lastErrorMessage, "latest failure");
  assert.equal(aggregateToolCallRows([makeToolCall()]).lastErrorMessage, null);
});

test("aggregateToolCallRows：null/无 toolCall 行 → 零值", () => {
  assert.deepEqual(aggregateToolCallRows(null), {
    totalCount: 0,
    errorCount: 0,
    activeCount: 0,
    lastErrorMessage: null,
    byTool: [],
  });
  assert.equal(aggregateToolCallRows([makeTurnHeader()]).totalCount, 0);
  assert.equal(hasToolCallRows(null), false);
  assert.equal(hasToolCallRows([makeTurnHeader()]), false);
  assert.equal(hasToolCallRows([makeToolCall()]), true);
});

// ── 子智能体 ──

function makeSubagents(
  running: Partial<SubagentProjectionState["running"][number]>[],
  endedTotal = 0,
): SubagentProjectionState {
  return {
    revision: 1,
    childSessionIds: running.map((_, index) => `child-${index}`),
    running: running.map((entry, index) => ({
      childSessionId: `child-${index}`,
      subagentType: "general-purpose",
      title: "",
      status: "running" as const,
      ...entry,
    })),
    endedTotal,
  };
}

test("buildSubagentSummaryView：null → 零值；无名字显示线路名（宁无名不错名）", () => {
  assert.deepEqual(buildSubagentSummaryView(null), {
    items: [],
    runningCount: 0,
    endedTotal: 0,
    childTotalTokens: null,
  });
  const view = buildSubagentSummaryView(
    makeSubagents(
      [
        { title: " 修复登录 bug ", status: "running", cumulativeTokens: 1200 },
        { title: "", subagentType: "code-review", status: "waiting" },
        { title: "", subagentType: "", status: "blocked" },
      ],
      4,
    ),
  );
  assert.equal(view.runningCount, 1);
  assert.equal(view.endedTotal, 4);
  assert.equal(view.items[0]?.label, "修复登录 bug");
  assert.equal(view.items[0]?.labelSource, "title");
  assert.equal(view.items[1]?.label, "code-review");
  assert.equal(view.items[1]?.labelSource, "subagentType");
  // 连线路名都缺席 → childSessionId 兜底展示（仍是官方关联字段，非启发式）。
  assert.equal(view.items[2]?.label, "child-2");
  assert.equal(view.items[2]?.labelSource, "childSessionId");
  // cumulativeTokens 缺席 ≠ 0：单项 null；合计只加在场项。
  assert.equal(view.items[1]?.cumulativeTokens, null);
  assert.equal(view.childTotalTokens, 1200);
});

test("buildSubagentSummaryView：cumulativeTokens 全部缺席 → 合计 null（隐藏而非假零）", () => {
  const view = buildSubagentSummaryView(makeSubagents([{ status: "running" }]));
  assert.equal(view.childTotalTokens, null);
});

// ── 速率行 ──

test("deriveTurnRateLine：加权速度 = outputTokens ÷ generationMs；stats=null → null", () => {
  assert.equal(deriveTurnRateLine(null), null);
  assert.equal(deriveTurnRateLine(undefined), null);
  const model = deriveTurnRateLine(
    makeStats({ outputTokens: 900, generationMs: 3000, timeToFirstTokenMs: 450 }),
  );
  assert.deepEqual(model, {
    tokensPerSecond: 300,
    timeToFirstTokenMs: 450,
    outputTokens: 900,
    generationMs: 3000,
    servedModels: [],
    promptCacheMisses: null,
  });
});

test("deriveTurnRateLine：generationMs/TTFT 缺席 → null（无数据缺省）", () => {
  const model = deriveTurnRateLine(makeStats({ outputTokens: 900 }));
  assert.equal(model?.tokensPerSecond, null);
  assert.equal(model?.timeToFirstTokenMs, null);
  assert.equal(model?.generationMs, null);
  assert.equal(model?.outputTokens, 900);
  const zero = deriveTurnRateLine(makeStats({ generationMs: 0 }));
  assert.equal(zero?.tokensPerSecond, null);
});

test("deriveTurnRateLine：servedModels/promptCacheMisses 透出；缺席 → 空数组/null（D5）", () => {
  const model = deriveTurnRateLine(
    makeStats({ servedModels: ["p/model-a", "p/model-b"], promptCacheMisses: 3 }),
  );
  assert.deepEqual(model?.servedModels, ["p/model-a", "p/model-b"]);
  assert.equal(model?.promptCacheMisses, 3);
  const bare = deriveTurnRateLine(makeStats());
  assert.deepEqual(bare?.servedModels, []);
  assert.equal(bare?.promptCacheMisses, null);
});

// ── 今日合计 ──

test("resolveTodayDateKey：按请求 timeZone 计算本地日；非法 timeZone 回退 UTC 不抛错", () => {
  // 2026-10-15T16:30:00Z = 上海 2026-10-16 00:30（跨日边界）。
  const nowMs = Date.UTC(2026, 9, 15, 16, 30, 0);
  assert.equal(resolveTodayDateKey("Asia/Shanghai", nowMs), "2026-10-16");
  assert.equal(resolveTodayDateKey("UTC", nowMs), "2026-10-15");
  assert.equal(resolveTodayDateKey("Not/AZone", nowMs), "2026-10-15");
});

test("deriveTodayUsageTotals：命中当天单元格；无单元格/无快照 → null（无数据 ≠ 0）", () => {
  const snapshot: AppUsageSnapshot = {
    ...APP_USAGE_SNAPSHOT_STUB,
    heatmap: {
      startDate: "2026-10-09",
      endDate: "2026-10-15",
      maxTokens: 5000,
      weeks: [
        {
          weekIndex: 0,
          days: [
            null,
            { date: "2026-10-14", level: 2, totalTokens: 900, turnCount: 3, toolCallCount: 7 },
            { date: "2026-10-15", level: 3, totalTokens: 4200, turnCount: 9, toolCallCount: 21 },
          ],
        },
      ],
    },
  };
  assert.deepEqual(deriveTodayUsageTotals(snapshot, "2026-10-15"), {
    totalTokens: 4200,
    turnCount: 9,
    toolCallCount: 21,
    favoriteModel: null,
  });
  assert.equal(deriveTodayUsageTotals(snapshot, "2026-10-01"), null);
  assert.equal(deriveTodayUsageTotals(null, "2026-10-15"), null);
  assert.equal(deriveTodayUsageTotals(APP_USAGE_SNAPSHOT_STUB, "2026-10-15"), null);
  assert.equal(deriveTodayUsageTotals(snapshot, ""), null);
});

test("deriveTodayUsageTotals：主要模型来自 summary.favoriteModel.modelId；缺席 → null", () => {
  const withFavorite: AppUsageSnapshot = {
    ...APP_USAGE_SNAPSHOT_STUB,
    summary: {
      ...APP_USAGE_SNAPSHOT_STUB.summary,
      favoriteModel: { modelId: "glm-5.3", totalTokens: 9000, share: 0.9 },
    },
    heatmap: {
      startDate: "2026-10-15",
      endDate: "2026-10-15",
      maxTokens: 5000,
      weeks: [
        {
          weekIndex: 0,
          days: [
            { date: "2026-10-15", level: 3, totalTokens: 4200, turnCount: 9, toolCallCount: 21 },
          ],
        },
      ],
    },
  };
  assert.equal(deriveTodayUsageTotals(withFavorite, "2026-10-15")?.favoriteModel, "glm-5.3");
  // modelId 为 null（有占比统计但无模型名）→ null，不当空串渲染。
  const nullModelId: AppUsageSnapshot = {
    ...withFavorite,
    summary: {
      ...withFavorite.summary,
      favoriteModel: { modelId: null, totalTokens: 1, share: 1 },
    },
  };
  assert.equal(deriveTodayUsageTotals(nullModelId, "2026-10-15")?.favoriteModel, null);
});

// ── hide-on-absent（specs/usage-statusbar.md「hide-on-absent 空态规则」节）──

test("resolveUsageStatusbarPresence：数据源缺席 → 对应胶囊隐藏；snapshot=null 只剩齿轮", () => {
  assert.deepEqual(
    resolveUsageStatusbarPresence({
      usage: null,
      lastRequest: null,
      lastTurnStats: null,
      hasToolCallRows: false,
      todayTotals: null,
      subagents: null,
    }),
    {
      generationSpeed: false,
      turnUsage: false,
      sessionCumulative: false,
      toolCalls: false,
      todayTotal: false,
      subagents: false,
    },
  );
});

test("resolveUsageStatusbarPresence：零值 ≠ 缺席——数据源在场、数值全 0 照常显示", () => {
  assert.deepEqual(
    resolveUsageStatusbarPresence({
      usage: makeUsage({ inputTokens: 0, outputTokens: 0 }),
      lastRequest: { outputTokens: 0, generationMs: 1000, completedAtMs: 1 },
      lastTurnStats: makeStats({ inputTokens: 0, outputTokens: 0 }),
      hasToolCallRows: true,
      todayTotals: { totalTokens: 0, turnCount: 0, toolCallCount: 0, favoriteModel: null },
      subagents: makeSubagents([]),
    }),
    {
      generationSpeed: true,
      turnUsage: true,
      sessionCumulative: true,
      toolCalls: true,
      todayTotal: true,
      subagents: false, // 空投影（无 running、endedTotal=0）不携带事实 → 隐藏
    },
  );
  // 有已结束子代理（endedTotal>0）= 有事实 → 显示。
  assert.equal(
    resolveUsageStatusbarPresence({
      usage: null,
      lastRequest: null,
      lastTurnStats: null,
      hasToolCallRows: false,
      todayTotals: null,
      subagents: makeSubagents([], 3),
    }).subagents,
    true,
  );
});
