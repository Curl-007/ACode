// 用量快照 heatmap 的按日分项（apps/acode-cli/specs/usage-statusbar-port.md §3.4）。
// 状态栏「今日合计」只读 AppUsageSnapshot；这里钉住 builder 的四字段透传、
// 命中率分母口径（输入 tokens，不叠加 cache 读），以及旧查询结果不下发分项。

import assert from "node:assert/strict";
import test from "node:test";

const { buildAppUsageSnapshot } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/usage-stats-builder.ts"
);

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

const BUILD_OPTIONS = {
  range: "7d",
  timeZone: "UTC",
  tzOffsetMs: 0,
  generatedAt: NOW,
  since: NOW - 7 * DAY_MS,
  until: NOW,
};

function queryResult(overrides = {}) {
  return {
    totals: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      avgTimeToFirstTokenMs: null,
    },
    turnTotals: {
      totalSessions: 0,
      totalTurns: 0,
      avgTurnDurationMs: null,
      longestSessionMs: 0,
    },
    toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
    models: [],
    tools: [],
    days: [],
    dayModels: [],
    ...overrides,
  };
}

function heatmapCells(snapshot) {
  return snapshot.heatmap.weeks.flatMap((week) => week.days).filter((cell) => cell !== null);
}

test("heatmap 格子带按日分项（输入/输出/命中率/请求数），命中率与 summary 同分母口径", () => {
  const dayIndex = Math.floor((NOW - DAY_MS) / DAY_MS);
  const snapshot = buildAppUsageSnapshot(
    queryResult({
      days: [
        {
          dayIndex,
          totalTokens: 500,
          turnCount: 3,
          toolCallCount: 9,
          inputTokens: 200,
          outputTokens: 300,
          cacheReadTokens: 160,
          modelRequestCount: 4,
        },
      ],
    }),
    BUILD_OPTIONS,
  );
  const cell = heatmapCells(snapshot).find(
    (entry) => entry.date === new Date(dayIndex * DAY_MS).toISOString().slice(0, 10),
  );
  assert.ok(cell, "当日格子存在");
  assert.equal(cell.totalTokens, 500);
  assert.equal(cell.inputTokens, 200);
  assert.equal(cell.outputTokens, 300);
  assert.equal(cell.requestCount, 4);
  // 命中率分母是输入 tokens（不是输入 + cache 读），否则会低估命中率。
  assert.ok(Math.abs((cell.cacheHitRate ?? 0) - 0.8) < 1e-9);
});

test("旧查询结果（按日无分项）不下发分项字段，UI 据此隐藏对应明细行", () => {
  const dayIndex = Math.floor((NOW - DAY_MS) / DAY_MS);
  const snapshot = buildAppUsageSnapshot(
    queryResult({
      days: [{ dayIndex, totalTokens: 500, turnCount: 3, toolCallCount: 9 }],
    }),
    BUILD_OPTIONS,
  );
  const cell = heatmapCells(snapshot).find((entry) => entry.totalTokens === 500);
  assert.ok(cell);
  assert.equal(cell.inputTokens, undefined);
  assert.equal(cell.outputTokens, undefined);
  assert.equal(cell.cacheHitRate, undefined);
  assert.equal(cell.requestCount, undefined);
});
