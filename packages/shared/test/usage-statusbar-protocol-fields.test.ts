import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runningSubagentSummarySchema,
  sessionUsageLastRequestSchema,
  sessionUsageStateSchema,
} from "../src/acode-protocol-v4/snapshot.js";
import { turnHeaderRowSchema, turnHeaderStatsSchema } from "../src/acode-protocol-v4/rows.js";

/**
 * usage-statusbar 协议面 additive 字段验收（apps/acode-cli/specs/usage-statusbar.md
 * 验收场景 1）：旧形状（不含新字段）解析兼容、新字段 strict 校验（负数/错型/缺键拒绝）。
 */

// ── 旧形状 fixture（新字段全部缺席，模拟旧 CLI 发送端 / 旧快照）──

const legacyUsageState = {
  contextWindow: null,
  cumulative: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 5 },
};

const legacyTurnHeaderRow = {
  rowId: 7,
  turnId: "turn-1",
  createdAt: 1_000,
  createdAtSeq: 3,
  kind: "turnHeader" as const,
  origin: "userInput" as const,
  state: "completedSuccess" as const,
  startedAt: 1_000,
  endedAt: 2_000,
};

const legacySubagentSummary = {
  childSessionId: "sess_child_1",
  subagentType: "general",
  title: "explore repo",
  status: "running" as const,
};

test("旧形状（无新字段）解析兼容", () => {
  assert.ok(sessionUsageStateSchema.safeParse(legacyUsageState).success);
  assert.ok(turnHeaderRowSchema.safeParse(legacyTurnHeaderRow).success);
  assert.ok(runningSubagentSummarySchema.safeParse(legacySubagentSummary).success);
});

test("新字段合法值解析通过", () => {
  const usage = sessionUsageStateSchema.safeParse({
    ...legacyUsageState,
    cumulative: { ...legacyUsageState.cumulative, reasoningTokens: 12 },
    lastRequest: {
      outputTokens: 40,
      generationMs: 1_500,
      timeToFirstTokenMs: 300,
      completedAtMs: 2_000,
    },
  });
  assert.ok(usage.success);

  // lastRequest = null（会话尚无已完成模型请求）与缺席（旧快照）都合法。
  assert.ok(sessionUsageStateSchema.safeParse({ ...legacyUsageState, lastRequest: null }).success);

  const stats = {
    inputTokens: 100,
    outputTokens: 40,
    reasoningTokens: 12,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    timeToFirstTokenMs: 300,
    generationMs: 1_500,
    modelRequestCount: 2,
  };
  assert.ok(turnHeaderStatsSchema.safeParse(stats).success);
  assert.ok(turnHeaderRowSchema.safeParse({ ...legacyTurnHeaderRow, stats }).success);
  // stats = null：纯问答轮（无模型事实）。
  assert.ok(turnHeaderRowSchema.safeParse({ ...legacyTurnHeaderRow, stats: null }).success);
  // timeToFirstTokenMs / generationMs 为 optional：无首字时间戳的轮可缺席。
  assert.ok(
    turnHeaderStatsSchema.safeParse({
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 12,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      modelRequestCount: 2,
    }).success,
  );

  // D5 增补：servedModels（≤4×256）与 promptCacheMisses 合法形态 + 越界拒绝。
  assert.ok(
    turnHeaderStatsSchema.safeParse({
      ...stats,
      servedModels: ["provider/model-a", "provider/model-b"],
      promptCacheMisses: 3,
    }).success,
  );
  assert.ok(
    !turnHeaderStatsSchema.safeParse({
      ...stats,
      servedModels: ["a", "b", "c", "d", "e"],
    }).success,
  );
  assert.ok(!turnHeaderStatsSchema.safeParse({ ...stats, promptCacheMisses: -1 }).success);
  assert.ok(!turnHeaderStatsSchema.safeParse({ ...stats, servedModels: [""] }).success);

  assert.ok(
    runningSubagentSummarySchema.safeParse({ ...legacySubagentSummary, cumulativeTokens: 0 })
      .success,
  );
  assert.ok(
    runningSubagentSummarySchema.safeParse({ ...legacySubagentSummary, cumulativeTokens: 1_234 })
      .success,
  );
});

test("非法值拒绝：负数", () => {
  assert.ok(
    !sessionUsageStateSchema.safeParse({
      ...legacyUsageState,
      cumulative: { ...legacyUsageState.cumulative, reasoningTokens: -1 },
    }).success,
  );
  assert.ok(
    !sessionUsageLastRequestSchema.safeParse({
      outputTokens: -1,
      generationMs: 10,
      completedAtMs: 1,
    }).success,
  );
  assert.ok(
    !sessionUsageLastRequestSchema.safeParse({
      outputTokens: 1,
      generationMs: -10,
      completedAtMs: 1,
    }).success,
  );
  assert.ok(
    !sessionUsageLastRequestSchema.safeParse({
      outputTokens: 1,
      generationMs: 10,
      timeToFirstTokenMs: -1,
      completedAtMs: 1,
    }).success,
  );
  assert.ok(
    !turnHeaderStatsSchema.safeParse({
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 1,
      cacheReadTokens: -1,
      cacheWriteTokens: 1,
      modelRequestCount: 1,
    }).success,
  );
  assert.ok(
    !runningSubagentSummarySchema.safeParse({ ...legacySubagentSummary, cumulativeTokens: -5 })
      .success,
  );
});

test("非法值拒绝：错型与缺键", () => {
  // completedAtMs 是 lastRequest 的必带键。
  assert.ok(
    !sessionUsageLastRequestSchema.safeParse({ outputTokens: 1, generationMs: 10 }).success,
  );
  assert.ok(
    !sessionUsageStateSchema.safeParse({
      ...legacyUsageState,
      lastRequest: { outputTokens: "40", generationMs: 10, completedAtMs: 1 },
    }).success,
  );
  // modelRequestCount 必须是整数且必带。
  assert.ok(
    !turnHeaderStatsSchema.safeParse({
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      modelRequestCount: 1.5,
    }).success,
  );
  assert.ok(
    !turnHeaderStatsSchema.safeParse({
      outputTokens: 1,
      reasoningTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      modelRequestCount: 1,
    }).success,
  );
  // stats 挂在 row 上时同样拒绝非法载荷。
  assert.ok(
    !turnHeaderRowSchema.safeParse({
      ...legacyTurnHeaderRow,
      stats: { inputTokens: -1 },
    }).success,
  );
  assert.ok(
    !runningSubagentSummarySchema.safeParse({ ...legacySubagentSummary, cumulativeTokens: "12" })
      .success,
  );
});
