import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * /usage workspace:/session: 父子合并去重单测（specs/usage-statusbar.md
 * 「/usage 命令族」节：workspace: 查询按父子关系合并子代理消耗避免重复计算）。
 * 父子关系用 SessionInfo.parentID（port 面既有字段），合并在 usage-query 模块内完成，
 * 不改 session-store.port.ts。假 UsageStorePort（in-memory fixture），不碰真 SQLite。
 */

const { runUsageQuery } = await import("../packages/core/src/usage-query/index.ts");

const TZ = 0;
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
          throw new Error("session scopes must not call queryAppUsage");
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

// 森林 fixture：
// ses_p（/work/acode）├─ ses_c1（/work/acode，子代理）└─ ses_c2（/tmp/other，未命中关键词）
//                        └─ ses_g1（/work/acode，孙代理，挂在 ses_c1 下）
// ses_q（/other）      └─ ses_qc（/work/acode，子命中而父不命中）
function forestFixture() {
  const sessions = [
    sessionInfo({
      id: "ses_p",
      title: "父任务",
      directory: "/work/acode",
      time: { created: NOW, updated: NOW - 10 * MIN },
    }),
    sessionInfo({
      id: "ses_c1",
      parentID: "ses_p",
      taskType: "subagent_child",
      title: "子代理1",
      directory: "/work/acode",
      time: { created: NOW, updated: NOW - 5 * MIN },
    }),
    sessionInfo({
      id: "ses_g1",
      parentID: "ses_c1",
      taskType: "subagent_child",
      title: "孙代理",
      directory: "/work/acode",
      time: { created: NOW, updated: NOW - 4 * MIN },
    }),
    sessionInfo({
      id: "ses_c2",
      parentID: "ses_p",
      taskType: "subagent_child",
      title: "子代理2（外部目录）",
      directory: "/tmp/other",
      time: { created: NOW, updated: NOW - 3 * MIN },
    }),
    sessionInfo({
      id: "ses_q",
      title: "别的任务",
      directory: "/other",
      time: { created: NOW, updated: NOW - 30 * MIN },
    }),
    sessionInfo({
      id: "ses_qc",
      parentID: "ses_q",
      taskType: "subagent_child",
      title: "命中子代理",
      directory: "/work/acode",
      time: { created: NOW, updated: NOW - 20 * MIN },
    }),
  ];
  const usageBySession = {
    ses_p: taskUsage("ses_p", { totalTokens: 100, inputTokens: 80, outputTokens: 20, modelRequestCount: 2 }),
    ses_c1: taskUsage("ses_c1", { totalTokens: 50, inputTokens: 40, outputTokens: 10, modelRequestCount: 1 }),
    ses_g1: taskUsage("ses_g1", { totalTokens: 25, inputTokens: 20, outputTokens: 5, modelRequestCount: 1 }),
    ses_c2: taskUsage("ses_c2", { totalTokens: 13, inputTokens: 10, outputTokens: 3, modelRequestCount: 1 }),
    ses_q: taskUsage("ses_q", { totalTokens: 777, modelRequestCount: 7 }),
    ses_qc: taskUsage("ses_qc", { totalTokens: 9, inputTokens: 6, outputTokens: 3, modelRequestCount: 1 }),
  };
  return { sessions, usageBySession };
}

test("workspace: 关键词命中父与子孙时合并为一条，消耗只计一次", async () => {
  const { sessions, usageBySession } = forestFixture();
  const { calls, deps } = makeDeps(sessions, usageBySession);
  const report = await runUsageQuery(deps, { kind: "workspace", keyword: "acode" });
  assert.equal(report.kind, "workspace");
  const byId = new Map(report.entries.map((entry) => [entry.session.id, entry]));
  // ses_p / ses_c1 / ses_g1 / ses_qc 都含 "acode"；ses_p 与 ses_qc 是有效根
  //（ses_c1、ses_g1 的消耗由 ses_p 承载，不再单独成行）。
  assert.deepEqual([...byId.keys()].sort(), ["ses_p", "ses_qc"]);
  const parent = byId.get("ses_p");
  // 整棵子树并入（包括目录未命中关键词的 ses_c2——同属一个任务的消耗）。
  assert.deepEqual([...parent.mergedChildIds].sort(), ["ses_c1", "ses_c2", "ses_g1"]);
  assert.equal(parent.usage.totalTokens, 100 + 50 + 25 + 13);
  assert.equal(parent.usage.modelRequestCount, 5);
  // 父未命中的子会话独立成行，不带上父会话的消耗。
  const orphan = byId.get("ses_qc");
  assert.deepEqual(orphan.mergedChildIds, []);
  assert.equal(orphan.usage.totalTokens, 9);
  // 每个会话的 task usage 恰好查一次（无重复计算）。
  assert.deepEqual(calls.queryTaskUsage.sort(), [
    "ses_c1",
    "ses_c2",
    "ses_g1",
    "ses_p",
    "ses_qc",
  ]);
});

test("workspace: 关键词大小写不敏感，且匹配 directory/path/workspaceID", async () => {
  const { sessions, usageBySession } = forestFixture();
  sessions.push(
    sessionInfo({
      id: "ses_wsid",
      title: "远端会话",
      directory: "/remote/mnt",
      path: "/remote/mnt",
      workspaceID: "remote:ssh://ACode-Host/x",
      time: { created: NOW, updated: NOW - 2 * MIN },
    }),
  );
  const { deps } = makeDeps(sessions, usageBySession);
  const report = await runUsageQuery(deps, { kind: "workspace", keyword: "ACODE" });
  const ids = report.entries.map((entry) => entry.session.id).sort();
  // ses_p 子树（directory 命中）+ ses_qc（directory 命中）+ ses_wsid（workspaceID 命中）。
  assert.deepEqual(ids, ["ses_p", "ses_qc", "ses_wsid"]);
});

test("workspace: 无命中时空 entries（渲染层给 noSessions 空态）", async () => {
  const { sessions, usageBySession } = forestFixture();
  const { calls, deps } = makeDeps(sessions, usageBySession);
  const report = await runUsageQuery(deps, { kind: "workspace", keyword: "nowhere" });
  assert.equal(report.kind, "workspace");
  assert.deepEqual(report.entries, []);
  assert.deepEqual(calls.queryTaskUsage, []);
});

test("session: ID 前缀命中父与子时同样按祖先合并去重", async () => {
  const sessions = [
    sessionInfo({ id: "ses_abc", title: "父", time: { created: NOW, updated: NOW - 8 * MIN } }),
    sessionInfo({
      id: "ses_abc_child",
      parentID: "ses_abc",
      taskType: "subagent_child",
      title: "子",
      time: { created: NOW, updated: NOW - 6 * MIN },
    }),
    sessionInfo({ id: "ses_xyz", title: "无关", time: { created: NOW, updated: NOW - 1 * MIN } }),
  ];
  const usageBySession = {
    ses_abc: taskUsage("ses_abc", { totalTokens: 10, modelRequestCount: 1 }),
    ses_abc_child: taskUsage("ses_abc_child", { totalTokens: 5, modelRequestCount: 1 }),
    ses_xyz: taskUsage("ses_xyz", { totalTokens: 99, modelRequestCount: 2 }),
  };
  const { deps } = makeDeps(sessions, usageBySession);
  const report = await runUsageQuery(deps, { kind: "session", prefix: "SES_ABC" });
  assert.equal(report.kind, "session");
  assert.deepEqual(
    report.entries.map((entry) => entry.session.id),
    ["ses_abc"],
  );
  assert.deepEqual(report.entries[0].mergedChildIds, ["ses_abc_child"]);
  assert.equal(report.entries[0].usage.totalTokens, 15);
});

test("sessions: limit 截取最近更新的根会话，子会话并入不占名额", async () => {
  const sessions = [];
  const usageBySession = {};
  for (let index = 0; index < 5; index += 1) {
    sessions.push(
      sessionInfo({
        id: `ses_root${index}`,
        title: `根${index}`,
        time: { created: NOW, updated: NOW - index * 10 * MIN },
      }),
    );
    sessions.push(
      sessionInfo({
        id: `ses_root${index}_child`,
        parentID: `ses_root${index}`,
        taskType: "subagent_child",
        time: { created: NOW, updated: NOW - index * 10 * MIN - MIN },
      }),
    );
    usageBySession[`ses_root${index}`] = taskUsage(`ses_root${index}`, {
      totalTokens: (index + 1) * 100,
      modelRequestCount: 1,
    });
    usageBySession[`ses_root${index}_child`] = taskUsage(`ses_root${index}_child`, {
      totalTokens: 1,
      modelRequestCount: 1,
    });
  }
  const { deps } = makeDeps(sessions, usageBySession);
  const report = await runUsageQuery(deps, { kind: "sessions", limit: 2 });
  assert.equal(report.kind, "sessions");
  assert.equal(report.limit, 2);
  // 最近更新的两个根（root0、root1），子会话并入而不占 limit 名额。
  assert.deepEqual(
    report.entries.map((entry) => entry.session.id),
    ["ses_root0", "ses_root1"],
  );
  assert.equal(report.entries[0].usage.totalTokens, 101);
  assert.deepEqual(report.entries[0].mergedChildIds, ["ses_root0_child"]);
});
