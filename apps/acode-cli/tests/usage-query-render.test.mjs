import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * /usage 报表渲染快照（specs/usage-statusbar.md 验收场景 4）：
 * zh/en、空数据、today 有数据、week 按日、models 按天细分、sessions 条目、
 * 非法参数回执与取数失败回执。假 UsageStorePort（in-memory fixture），不碰真 SQLite。
 * 数字口径：总用量 = input + output（cache_read 已含于 input，不重复相加）。
 */

const { executeUsageQuery } = await import("../packages/core/src/usage-query/index.ts");

const TZ = 8 * 3_600_000; // UTC+8
const NOW = Date.UTC(2026, 9, 15, 4, 30, 0); // 本地 2026-10-15 12:30
const TODAY_SINCE = Date.UTC(2026, 9, 14, 16, 0, 0); // 本地 2026-10-15 00:00
const WEEK_SINCE = Date.UTC(2026, 9, 8, 16, 0, 0); // 本地 2026-10-09 00:00

function emptyAppUsageResult() {
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
  };
}

function emptyTaskUsage(sessionID) {
  return {
    sessionID,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelRequestCount: 0,
    modelErrorCount: 0,
    inputBaselineBySource: {},
  };
}

function makeDeps({ appUsage, taskUsage = {}, sessions = [], failWith } = {}) {
  const calls = { queryAppUsage: [], queryTaskUsage: [], listSessions: [] };
  return {
    calls,
    deps: {
      usageStore: {
        async queryAppUsage(input) {
          calls.queryAppUsage.push(input);
          if (failWith) throw failWith;
          return appUsage ?? emptyAppUsageResult();
        },
        async queryTaskUsage(input) {
          calls.queryTaskUsage.push(input);
          return taskUsage[input.sessionID] ?? emptyTaskUsage(input.sessionID);
        },
      },
      async listSessions(input) {
        calls.listSessions.push(input);
        return sessions;
      },
      tzOffsetMs: TZ,
      now: NOW,
    },
  };
}

function sessionInfo(overrides) {
  return {
    id: "ses_x",
    projectID: "proj_1",
    taskType: "interactive",
    slug: "x",
    directory: "/work/acode",
    title: "T",
    version: "0.0.0",
    time: { created: NOW, updated: NOW },
    ...overrides,
  };
}

const TODAY_TOTALS = {
  totalTokens: 1_500_000,
  inputTokens: 1_200_000,
  outputTokens: 300_000,
  reasoningTokens: 20_000,
  cacheCreationTokens: 30_000,
  cacheReadTokens: 600_000,
  modelRequestCount: 42,
  modelErrorCount: 1,
  avgTimeToFirstTokenMs: 1234,
};

function todayResult(overrides = {}) {
  const base = emptyAppUsageResult();
  return {
    ...base,
    totals: { ...base.totals, ...TODAY_TOTALS },
    turnTotals: {
      totalSessions: 3,
      totalTurns: 25,
      avgTurnDurationMs: 45_200,
      longestSessionMs: 750_000,
    },
    toolTotals: { toolCallCount: 120, toolErrorCount: 2 },
    ...overrides,
  };
}

test("render: today 有数据（zh）——总用量=输入+输出、命中率、TTFT、轮次/工具", async () => {
  const { calls, deps } = makeDeps({ appUsage: todayResult() });
  const result = await executeUsageQuery({ args: "", locale: "zh-CN", deps });
  assert.equal(result.ok, true);
  assert.deepEqual(result.scope, { kind: "range", range: "today", days: 1 });
  // today 窗口 = 本地日零点 → now，tzOffsetMs 透传给 port。
  assert.deepEqual(calls.queryAppUsage, [
    { since: TODAY_SINCE, until: NOW, tzOffsetMs: TZ },
  ]);
  assert.equal(
    result.text,
    [
      "今日用量（本地日）",
      "范围：2026-10-15 00:00 → 现在（UTC+8）",
      "总用量：1,500,000 tokens（输入 1,200,000 / 输出 300,000）",
      "缓存命中率：50.0%（cache_read 600,000 / 输入 1,200,000）",
      "思考 tokens：20,000　缓存写入：30,000",
      "模型请求：42（错误 1）　平均 TTFT：1.2 s",
      "会话：3　轮次：25　平均轮耗时：45.2 s　最长会话：12m 30s",
      "工具调用：120（错误 2）",
    ].join("\n"),
  );
});

test("render: today 有数据（en）", async () => {
  const { deps } = makeDeps({ appUsage: todayResult() });
  const result = await executeUsageQuery({ args: "today", locale: "en-US", deps });
  assert.equal(result.ok, true);
  assert.equal(
    result.text,
    [
      "Today's usage (local day)",
      "Range: 2026-10-15 00:00 → now (UTC+8)",
      "Total: 1,500,000 tokens (input 1,200,000 / output 300,000)",
      "Cache hit rate: 50.0% (cache_read 600,000 / input 1,200,000)",
      "Reasoning tokens: 20,000   Cache write: 30,000",
      "Model requests: 42 (errors 1)   Avg TTFT: 1.2 s",
      "Sessions: 3   Turns: 25   Avg turn: 45.2 s   Longest session: 12m 30s",
      "Tool calls: 120 (errors 2)",
    ].join("\n"),
  );
});

test("render: 空数据（zh/en）——无请求/轮次/工具时给空态而不是全零表", async () => {
  const zh = makeDeps({});
  const zhResult = await executeUsageQuery({ args: "today", locale: "zh-CN", deps: zh.deps });
  assert.equal(zhResult.text, ["今日用量（本地日）", "该范围内没有用量数据。"].join("\n"));
  const en = makeDeps({});
  const enResult = await executeUsageQuery({ args: "today", locale: "en-US", deps: en.deps });
  assert.equal(
    enResult.text,
    ["Today's usage (local day)", "No usage data in this range."].join("\n"),
  );
});

test("render: week 按日行（zh）——dayCount>1 时渲染按日细分", async () => {
  const appUsage = todayResult({
    days: [
      { dayIndex: 20_740, totalTokens: 500, turnCount: 2, toolCallCount: 3 },
      { dayIndex: 20_741, totalTokens: 700, turnCount: 4, toolCallCount: 5 },
    ],
  });
  const { calls, deps } = makeDeps({ appUsage });
  const result = await executeUsageQuery({ args: "week", locale: "zh-CN", deps });
  assert.deepEqual(calls.queryAppUsage, [{ since: WEEK_SINCE, until: NOW, tzOffsetMs: TZ }]);
  assert.equal(
    result.text,
    [
      "近 7 天用量",
      "范围：2026-10-09 00:00 → 现在（UTC+8）",
      "总用量：1,500,000 tokens（输入 1,200,000 / 输出 300,000）",
      "缓存命中率：50.0%（cache_read 600,000 / 输入 1,200,000）",
      "思考 tokens：20,000　缓存写入：30,000",
      "模型请求：42（错误 1）　平均 TTFT：1.2 s",
      "会话：3　轮次：25　平均轮耗时：45.2 s　最长会话：12m 30s",
      "工具调用：120（错误 2）",
      "按日：",
      "  2026-10-14　tokens 500　轮次 2　工具 3",
      "  2026-10-15　tokens 700　轮次 4　工具 5",
    ].join("\n"),
  );
});

test("render: models 按天模型细分（zh）——未知模型、0 token 日过滤、按日升序", async () => {
  const appUsage = todayResult({
    models: [
      {
        modelId: "anthropic/claude-sonnet",
        totalTokens: 900,
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 5,
      },
      { modelId: null, totalTokens: 100, inputTokens: 0, outputTokens: 0, requestCount: 1 },
    ],
    dayModels: [
      { dayIndex: 20_741, modelId: "anthropic/claude-sonnet", totalTokens: 400 },
      { dayIndex: 20_740, modelId: "anthropic/claude-sonnet", totalTokens: 500 },
      { dayIndex: 20_739, modelId: "anthropic/claude-sonnet", totalTokens: 0 },
      { dayIndex: 20_741, modelId: null, totalTokens: 100 },
    ],
  });
  const { deps } = makeDeps({ appUsage });
  const result = await executeUsageQuery({ args: "models", locale: "zh-CN", deps });
  assert.equal(result.ok, true);
  assert.deepEqual(result.scope, { kind: "models", days: 7 });
  assert.equal(
    result.text,
    [
      "按天模型细分（近 7 天）",
      "范围：2026-10-09 00:00 → 现在（UTC+8）",
      "anthropic/claude-sonnet　合计 900　请求 5",
      "  2026-10-14　500",
      "  2026-10-15　400",
      "（未知模型）　合计 100　请求 1",
      "  2026-10-15　100",
    ].join("\n"),
  );
});

test("render: sessions 条目（zh）——子会话并入根、命中率、无标题回落、合计行", async () => {
  const sessions = [
    sessionInfo({
      id: "ses_r1",
      title: "重构登录",
      time: { created: NOW, updated: NOW - 3_600_000 },
    }),
    sessionInfo({
      id: "ses_c1",
      parentID: "ses_r1",
      taskType: "subagent_child",
      title: "子代理",
      time: { created: NOW, updated: NOW - 1_800_000 },
    }),
    sessionInfo({
      id: "ses_r2",
      title: "  ",
      time: { created: NOW, updated: NOW - 7_200_000 },
    }),
  ];
  const taskUsage = {
    ses_r1: {
      ...emptyTaskUsage("ses_r1"),
      totalTokens: 1000,
      inputTokens: 800,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 400,
      modelRequestCount: 3,
      modelErrorCount: 0,
    },
    ses_c1: {
      ...emptyTaskUsage("ses_c1"),
      totalTokens: 500,
      inputTokens: 400,
      outputTokens: 100,
      modelRequestCount: 1,
      modelErrorCount: 1,
    },
  };
  const { calls, deps } = makeDeps({ sessions, taskUsage });
  const result = await executeUsageQuery({ args: "sessions", locale: "zh-CN", deps });
  assert.equal(result.ok, true);
  // 子会话消耗只计一次：queryTaskUsage 覆盖根 + 全部后代，条目只有根。
  assert.deepEqual(
    calls.queryTaskUsage.map((call) => call.sessionID).sort(),
    ["ses_c1", "ses_r1", "ses_r2"],
  );
  assert.equal(
    result.text,
    [
      "最近 10 个会话（累计用量）",
      "- 重构登录　[ses_r1]　更新 2026-10-15 11:30",
      "  总用量 1,500（输入 1,200 / 输出 300）　请求 4（错误 1）　缓存命中 33.3%　已合并子会话 1",
      "- （无标题）　[ses_r2]　更新 2026-10-15 10:30",
      "  总用量 0（输入 0 / 输出 0）　请求 0（错误 0）",
      "合计：1,500 tokens　会话 2 个　请求 4（错误 1）",
    ].join("\n"),
  );
});

test("render: 非法参数回执（zh/en）——不触 store、附完整用法帮助", async () => {
  const zh = makeDeps({ appUsage: todayResult() });
  const zhResult = await executeUsageQuery({ args: "bogus", locale: "zh-CN", deps: zh.deps });
  assert.equal(zhResult.ok, false);
  assert.equal(zhResult.scope, null);
  assert.equal(zh.calls.queryAppUsage.length, 0);
  assert.equal(zh.calls.listSessions.length, 0);
  assert.ok(zhResult.text.startsWith('无法识别的 /usage 参数："bogus"。\n\n用法：/usage [scope]'));
  assert.ok(zhResult.text.includes("  current            最近 30 分钟内有请求的会话"));

  const en = makeDeps({ appUsage: todayResult() });
  const enResult = await executeUsageQuery({ args: "days:0", locale: "en-US", deps: en.deps });
  assert.equal(enResult.ok, false);
  assert.ok(
    enResult.text.startsWith('N out of allowed range 1-365; got: "days:0".\n\nUsage: /usage [scope]'),
  );
});

test("render: 取数失败给可读回执（不抛裸异常），scope 保留", async () => {
  const { deps } = makeDeps({ failWith: new Error("boom") });
  const result = await executeUsageQuery({ args: "today", locale: "zh-CN", deps });
  assert.equal(result.ok, false);
  assert.equal(result.text, "用量查询失败：boom");
  assert.deepEqual(result.scope, { kind: "range", range: "today", days: 1 });
});
