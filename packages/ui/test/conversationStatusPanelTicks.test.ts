import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldShowWorkflowCollapsedElapsed,
  shouldTickBackgroundWorks,
  shouldTickGoal,
  shouldTickSubagents,
  shouldTickWorkflowRuns,
  toCollapsedElapsedSeconds,
} from "../src/v4/conversation-status-panel/conversationStatusPanelTicks.js";

/**
 * ConversationStatusPanel 批次 7 第二阶段：**秒针统一到 useNowTicker 的契约测试**。
 *
 * 这是「行为保持的重构」的前置契约：四个分区原先各自 `useState(now) + setInterval(1000)`，
 * 「该不该开表」写在 effect 的 early return 里，无法单测。本文件把四条开启条件与两条
 * 收起态耗时口径钉死——迁到 `useNowTicker(active)` 后语义必须逐条一致：
 * active=false 不建定时器、active 变真先重取一次 now。
 *
 * 同时钉住「0ms 显示 1 秒而非 0 秒假时长」与「workflow 无 startedAt 不显示时长」两条产品规则。
 */

// ---- 开启条件 ----

test("Terminals：列表非空即开表（每行都在展示 elapsed）", () => {
  assert.equal(shouldTickBackgroundWorks([]), false);
  assert.equal(shouldTickBackgroundWorks([{}] as never), true);
});

test("Agents：列表非空即开表（startedAt 缺席时 elapsed 恒为 0，但行仍要渲染）", () => {
  assert.equal(shouldTickSubagents([]), false);
  assert.equal(shouldTickSubagents([{}] as never), true);
});

test("Workflows：只有带 startedAt 的行才开表（一行都没有时不必每秒重渲染）", () => {
  assert.equal(shouldTickWorkflowRuns([]), false);
  assert.equal(shouldTickWorkflowRuns([{ runId: "r1" }] as never), false, "偏斜降级行无 startedAt");
  assert.equal(shouldTickWorkflowRuns([{ runId: "r1", startedAt: 100 }] as never), true);
});

test("Workflows：混合列表里只要有一行带 startedAt 就开表", () => {
  assert.equal(
    shouldTickWorkflowRuns([
      { runId: "r1" },
      { runId: "r2", startedAt: 100 },
    ] as never),
    true,
  );
});

test("Goal：可暂停的三种状态 + 有 activeRunStartedAtMs 才开表", () => {
  for (const status of ["active", "verifying", "notSatisfied"]) {
    assert.equal(shouldTickGoal({ status, activeRunStartedAtMs: 1 }), true, `${status} 应开表`);
  }
  for (const status of ["active", "verifying", "notSatisfied"]) {
    assert.equal(
      shouldTickGoal({ status, activeRunStartedAtMs: undefined }),
      false,
      `${status} 但无 run 起点时不开表`,
    );
  }
});

test("Goal：paused / verified / 未知状态一律不开表（paused 的 elapsed 不增长）", () => {
  for (const status of ["paused", "verified", undefined, "whatever"]) {
    assert.equal(
      shouldTickGoal({ status, activeRunStartedAtMs: 1 }),
      false,
      `${String(status)} 不应开表`,
    );
  }
});

// ---- 收起态耗时口径 ----

test("收起态耗时：0ms 也显示 1 秒（不显示 0 秒假时长）", () => {
  assert.equal(toCollapsedElapsedSeconds(0), 1);
  assert.equal(toCollapsedElapsedSeconds(500), 1);
});

test("收起态耗时：向下取整到整秒", () => {
  assert.equal(toCollapsedElapsedSeconds(1_999), 1);
  assert.equal(toCollapsedElapsedSeconds(2_000), 2);
  assert.equal(toCollapsedElapsedSeconds(59_999), 59);
});

test("Workflows 收起态：最长耗时为 0 时不显示时长（宁可少一段）", () => {
  assert.equal(shouldShowWorkflowCollapsedElapsed(0), false);
  assert.equal(shouldShowWorkflowCollapsedElapsed(1), true);
});
