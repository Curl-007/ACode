import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * /usage current 口径单测（specs/usage-statusbar.md 数据口径 8）：
 * current = 最近 30 分钟内有请求的会话，用既有查询组合实现——
 * time.updated 落在窗口内（消息持久化会 touch 会话行）且 queryTaskUsage
 * 的 modelRequestCount > 0。假 UsageStorePort（in-memory fixture），不碰真 SQLite。
 */

const { runUsageQuery, CURRENT_WINDOW_MINUTES } = await import(
  "../packages/core/src/usage-query/index.ts"
);

const TZ = 8 * 3_600_000;
const NOW = Date.UTC(2026, 9, 15, 4, 30, 0);
const MIN = 60_000;

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

function taskUsage(sessionID, overrides = {}) {
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
    ...overrides,
  };
}

function makeDeps(sessions, usageBySession) {
  const calls = { queryTaskUsage: [] };
  return {
    calls,
    deps: {
      usageStore: {
        async queryAppUsage() {
          throw new Error("current scope must not call queryAppUsage");
        },
        async queryTaskUsage(input) {
          calls.queryTaskUsage.push(input.sessionID);
          return usageBySession[input.sessionID] ?? taskUsage(input.sessionID);
        },
      },
      async listSessions() {
        return sessions;
      },
      tzOffsetMs: TZ,
      now: NOW,
    },
  };
}

test("current: 30 分钟常量与 spec 口径一致", () => {
  assert.equal(CURRENT_WINDOW_MINUTES, 30);
});

test("current: 窗口内有请求的会话入选；窗口外/无请求的排除", async () => {
  const sessions = [
    // 窗口内（5 分钟前）且有模型请求 → 入选。
    sessionInfo({
      id: "ses_active",
      title: "活跃会话",
      time: { created: NOW, updated: NOW - 5 * MIN },
    }),
    // 窗口内（2 分钟前）但从未有模型请求（纯非模型活动）→ 排除。
    sessionInfo({
      id: "ses_no_model",
      title: "无请求会话",
      time: { created: NOW, updated: NOW - 2 * MIN },
    }),
    // 窗口外（40 分钟前）即使有请求 → 排除，且不查它的 task usage。
    sessionInfo({
      id: "ses_old",
      title: "旧会话",
      time: { created: NOW, updated: NOW - 40 * MIN },
    }),
  ];
  const usageBySession = {
    ses_active: taskUsage("ses_active", {
      totalTokens: 1000,
      inputTokens: 800,
      outputTokens: 200,
      modelRequestCount: 3,
    }),
    ses_no_model: taskUsage("ses_no_model", { modelRequestCount: 0 }),
    ses_old: taskUsage("ses_old", { totalTokens: 999, modelRequestCount: 9 }),
  };
  const { calls, deps } = makeDeps(sessions, usageBySession);
  const report = await runUsageQuery(deps, { kind: "current" });
  assert.equal(report.kind, "current");
  assert.equal(report.windowMinutes, 30);
  assert.equal(report.windowStart, NOW - 30 * MIN);
  assert.deepEqual(
    report.entries.map((entry) => entry.session.id),
    ["ses_active"],
  );
  assert.equal(report.entries[0].usage.totalTokens, 1000);
  // ses_no_model 需要 queryTaskUsage 判请求数；ses_old 在窗口外，不发起查询。
  assert.deepEqual(calls.queryTaskUsage.sort(), ["ses_active", "ses_no_model"]);
});

test("current: 窗口边界——恰好 30 分钟前的活动入选（>= windowStart）", async () => {
  const sessions = [
    sessionInfo({
      id: "ses_edge",
      time: { created: NOW, updated: NOW - 30 * MIN },
    }),
  ];
  const usageBySession = {
    ses_edge: taskUsage("ses_edge", { totalTokens: 7, modelRequestCount: 1 }),
  };
  const { deps } = makeDeps(sessions, usageBySession);
  const report = await runUsageQuery(deps, { kind: "current" });
  assert.deepEqual(
    report.entries.map((entry) => entry.session.id),
    ["ses_edge"],
  );
});

test("current: 窗口内子代理消耗并入同样窗口内的父会话（不重复成行）", async () => {
  const sessions = [
    sessionInfo({
      id: "ses_parent",
      title: "父任务",
      time: { created: NOW, updated: NOW - 4 * MIN },
    }),
    sessionInfo({
      id: "ses_child",
      parentID: "ses_parent",
      taskType: "subagent_child",
      title: "子代理",
      time: { created: NOW, updated: NOW - 3 * MIN },
    }),
    // 父不在窗口内的子会话：独立成行，并标注父 ID 供追溯。
    sessionInfo({
      id: "ses_orphan_child",
      parentID: "ses_sleeping_parent",
      taskType: "subagent_child",
      title: "孤儿子代理",
      time: { created: NOW, updated: NOW - 1 * MIN },
    }),
    sessionInfo({
      id: "ses_sleeping_parent",
      title: "沉睡父任务",
      time: { created: NOW, updated: NOW - 120 * MIN },
    }),
  ];
  const usageBySession = {
    ses_parent: taskUsage("ses_parent", { totalTokens: 100, inputTokens: 80, outputTokens: 20, modelRequestCount: 2 }),
    ses_child: taskUsage("ses_child", { totalTokens: 50, inputTokens: 40, outputTokens: 10, modelRequestCount: 1 }),
    ses_orphan_child: taskUsage("ses_orphan_child", { totalTokens: 30, inputTokens: 20, outputTokens: 10, modelRequestCount: 1 }),
    ses_sleeping_parent: taskUsage("ses_sleeping_parent", { totalTokens: 999, modelRequestCount: 9 }),
  };
  const { calls, deps } = makeDeps(sessions, usageBySession);
  const report = await runUsageQuery(deps, { kind: "current" });
  const byId = new Map(report.entries.map((entry) => [entry.session.id, entry]));
  assert.deepEqual([...byId.keys()].sort(), ["ses_orphan_child", "ses_parent"]);
  // 父子合并：消耗求和、子会话只计一次。
  const parent = byId.get("ses_parent");
  assert.deepEqual(parent.mergedChildIds, ["ses_child"]);
  assert.equal(parent.usage.totalTokens, 150);
  assert.equal(parent.usage.modelRequestCount, 3);
  // 孤儿（父在窗口外）：独立成行，不合并窗口外父会话的消耗。
  const orphan = byId.get("ses_orphan_child");
  assert.deepEqual(orphan.mergedChildIds, []);
  assert.equal(orphan.usage.totalTokens, 30);
  assert.equal(orphan.session.parentID, "ses_sleeping_parent");
  // 窗口外父会话不发起查询。
  assert.deepEqual(calls.queryTaskUsage.sort(), [
    "ses_child",
    "ses_orphan_child",
    "ses_parent",
  ]);
});

test("current: 窗口内没有任何会话时 entries 为空（渲染层给空态文案）", async () => {
  const sessions = [
    sessionInfo({ id: "ses_old", time: { created: NOW, updated: NOW - 60 * MIN } }),
  ];
  const { deps } = makeDeps(sessions, {});
  const report = await runUsageQuery(deps, { kind: "current" });
  assert.equal(report.kind, "current");
  assert.deepEqual(report.entries, []);
});
