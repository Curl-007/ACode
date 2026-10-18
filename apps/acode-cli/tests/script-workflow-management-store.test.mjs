// 脚本工作流管理面读数：store 层（真实 SQLite，迁移后库）。
// 依据：apps/acode-cli/specs/script-workflow-management-surface.md §4.2 与 §10 测试计划
// （adapters 层对着真实库跑，不用假 store——CHECK/FK 约束只有真实库会说话）。
// 验收对应：A2（cwd 过滤）、A5（limit 截断）、A7（statuses×limit：逻辑态过滤下推）、
// B1（upsert 两行回两行）的存储层部分。
//
// 本文件还钉住两处「SQL 判据 ↔ cli-workflow 唯一所有者」的一致性（P2 修复引入）：
//   1. logicalStatuses 的 SQL 展开 ↔ logicalScriptWorkflowStatus（physical→logical 唯一映射）；
//   2. hasScriptWorkflowUsageIncomplete 的 exists 探测 ↔ scriptWorkflowActivityUsageIncomplete
//      （账本不完整标记判据）。json_extract 在 SQL 层重述判据，没有真实库的互钉就会漂移。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { createSqliteSessionStore } =
  await import("../packages/adapters/src/storage/session-store/sqlite-session-store.ts");
const { logicalScriptWorkflowStatus, SCRIPT_WORKFLOW_INTERRUPTED_CODE } =
  await import("../packages/cli-workflow/src/script-workflow-run-status.ts");
const { scriptWorkflowActivityUsageIncomplete } =
  await import("../packages/cli-workflow/src/script-workflow-format.ts");
const { SCRIPT_WORKFLOW_RUN_STATUSES } =
  await import("../packages/contracts/src/workflow/script.ts");

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "acode-script-mgmt-"));
  const dbPath = join(dir, "sessions.db");
  const store = createSqliteSessionStore({ dbPath });
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const sessionId = "sess_mgmt_parent";
  await store.createSession({
    directory: dir,
    id: sessionId,
    projectID: "proj_mgmt",
    slug: sessionId,
    title: "mgmt fixture",
    version: "v4",
  });
  return { store, sessionId, cwd: dir };
}

const definitionInput = (id, name, scriptPath) => ({
  id,
  name,
  source: "user",
  scope: "project",
  scriptHash: `hash-${id}`,
  scriptPath,
  meta: { name, description: `${name} desc`, phases: [{ title: "p1" }, { title: "p2" }] },
  trusted: true,
});

test("空库：listScriptWorkflowDefinitions 回空数组（B1 前置）", async (t) => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.listScriptWorkflowDefinitions(), []);
});

test("upsert 两个 definition → 回两行，time_updated desc 排序，行内事实完整", async (t) => {
  const { store } = await fixture(t);
  await store.upsertScriptWorkflowDefinition(
    definitionInput("script_aaa", "first", "/tmp/first.ts"),
  );
  // 保证 time_updated 严格更晚（排序断言的确定性；并列时还有 id desc tiebreaker 兜底）
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.upsertScriptWorkflowDefinition(
    definitionInput("script_bbb", "second", "/tmp/second.ts"),
  );
  const rows = await store.listScriptWorkflowDefinitions();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "script_bbb");
  assert.equal(rows[1].id, "script_aaa");
  assert.equal(rows[0].meta.phases.map((p) => p.title).join(","), "p1,p2");
  assert.equal(rows[0].scope, "project");
  assert.equal(rows[0].scriptPath, "/tmp/second.ts");
  assert.equal(rows[0].enabled, true);
});

test("limit 生效：limit=1 只回最近一行", async (t) => {
  const { store } = await fixture(t);
  await store.upsertScriptWorkflowDefinition(
    definitionInput("script_aaa", "first", "/tmp/first.ts"),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.upsertScriptWorkflowDefinition(
    definitionInput("script_bbb", "second", "/tmp/second.ts"),
  );
  const rows = await store.listScriptWorkflowDefinitions({ limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "script_bbb");
});

test("listScriptWorkflowRuns 按 cwd 精确过滤 + limit 截断（A2/A5 存储层）", async (t) => {
  const { store, sessionId, cwd } = await fixture(t);
  const mkRun = (id, runCwd) =>
    store.createScriptWorkflowRun({
      id,
      name: id,
      cwd: runCwd,
      scriptHash: "h",
      parentSessionId: sessionId,
      status: "completed",
      toolCallId: `tc_${id}`,
    });
  await mkRun("wf_a1", cwd);
  await mkRun("wf_a2", cwd);
  await mkRun("wf_b1", "/other/project");

  const sameProject = await store.listScriptWorkflowRuns({ cwd, limit: 50 });
  assert.deepEqual(
    sameProject.map((r) => r.id).sort(),
    ["wf_a1", "wf_a2"],
    "另一项目目录的 run 不出现在本项目列表",
  );
  const capped = await store.listScriptWorkflowRuns({ cwd, limit: 1 });
  assert.equal(capped.length, 1);
  assert.equal((await store.listScriptWorkflowRuns({})).length, 3, "无 cwd 过滤时全量回");
});

// ---------------------------------------------------------------------------
// logicalStatuses（逻辑态过滤下推，A7 存储层）
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 夹具：覆盖「用户取消 / 他码取消 / interrupted / 四个直通物理词」的六行 run。 */
async function statusFixture(t) {
  const { store, sessionId, cwd } = await fixture(t);
  const create = async (id, status) => {
    // time_updated 严格递增，排序断言才有确定性（并列时还有 id desc tiebreaker）。
    await sleep(5);
    await store.createScriptWorkflowRun({
      id,
      name: id,
      cwd,
      scriptHash: "h",
      parentSessionId: sessionId,
      status,
      toolCallId: `tc_${id}`,
    });
  };
  await create("wf_completed", "completed");
  await create("wf_failed", "failed");
  await create("wf_running", "running");
  await create("wf_user_cancelled", "cancelled"); // 用户停的：不写 failure
  await create("wf_other_code", "cancelled");
  await store.updateScriptWorkflowRun({
    id: "wf_other_code",
    failure: { code: "SomeOtherCode", message: "not the interrupted marker" },
  });
  await create("wf_interrupted", "cancelled");
  await store.updateScriptWorkflowRun({
    id: "wf_interrupted",
    failure: {
      code: SCRIPT_WORKFLOW_INTERRUPTED_CODE,
      message: "owning process exited before the run settled",
    },
  });
  return { store, cwd };
}

const STATUS_FIXTURE_IDS = [
  "wf_completed",
  "wf_failed",
  "wf_running",
  "wf_user_cancelled",
  "wf_other_code",
  "wf_interrupted",
];

test("logicalStatuses 过滤与唯一映射逐行互钉：SQL 展开 = logicalScriptWorkflowStatus 全词表", async (t) => {
  const { store, cwd } = await statusFixture(t);
  const allRows = await store.listScriptWorkflowRuns({ cwd });
  assert.deepEqual(allRows.map((r) => r.id).sort(), [...STATUS_FIXTURE_IDS].sort());
  // 全仓唯一的映射函数给出每一行的逻辑态；SQL 过滤对每个逻辑词的答案必须逐行一致。
  const logicalByRow = new Map(allRows.map((row) => [row.id, logicalScriptWorkflowStatus(row)]));
  const logicalWords = [...SCRIPT_WORKFLOW_RUN_STATUSES, "interrupted"];
  for (const word of logicalWords) {
    const filtered = await store.listScriptWorkflowRuns({ cwd, logicalStatuses: [word] });
    assert.deepEqual(
      filtered.map((r) => r.id).sort(),
      [...logicalByRow]
        .filter(([, logical]) => logical === word)
        .map(([id]) => id)
        .sort(),
      `logicalStatuses=[${word}] 必须与唯一映射的逐行投影一致`,
    );
  }
});

test("cancelled 与 interrupted 同物理词：按 failure code 分流，他码取消仍归用户取消", async (t) => {
  const { store, cwd } = await statusFixture(t);
  const cancelled = await store.listScriptWorkflowRuns({ cwd, logicalStatuses: ["cancelled"] });
  assert.deepEqual(
    cancelled.map((r) => r.id).sort(),
    ["wf_other_code", "wf_user_cancelled"],
    "cancelled = 无 code 或他码，interrupted 行不得混入",
  );
  const interrupted = await store.listScriptWorkflowRuns({ cwd, logicalStatuses: ["interrupted"] });
  assert.deepEqual(
    interrupted.map((r) => r.id),
    ["wf_interrupted"],
    "只认结构化 code 命中的行",
  );
  // 两词同时请求：不分流，一切 cancelled 行都匹配其一。
  const both = await store.listScriptWorkflowRuns({
    cwd,
    logicalStatuses: ["cancelled", "interrupted"],
  });
  assert.equal(both.length, 3);
});

test("组合闭集 + limit：截断按匹配行计（A7 存储层）", async (t) => {
  const { store, cwd } = await statusFixture(t);
  const combo = await store.listScriptWorkflowRuns({
    cwd,
    logicalStatuses: ["interrupted", "completed"],
    limit: 2,
  });
  assert.deepEqual(
    combo.map((r) => r.id),
    ["wf_interrupted", "wf_completed"],
    "只回匹配行（time_updated desc），其他物理词的行不占页",
  );
  const all = await store.listScriptWorkflowRuns({
    cwd,
    logicalStatuses: ["interrupted", "completed"],
  });
  assert.equal(all.length, 2);
  // 空数组 = 不过滤（与缺省同语义）。
  assert.equal((await store.listScriptWorkflowRuns({ cwd, logicalStatuses: [] })).length, 6);
});

// ---------------------------------------------------------------------------
// hasScriptWorkflowUsageIncomplete（usageIncomplete 存在性读面）
// ---------------------------------------------------------------------------

test("usage 存在性读面：exists 探测与判据对同一批 activity 互钉", async (t) => {
  const { store, sessionId, cwd } = await fixture(t);
  await store.createScriptWorkflowRun({
    id: "wf_usage_hit",
    name: "hit",
    cwd,
    scriptHash: "h",
    parentSessionId: sessionId,
    status: "completed",
  });
  const mkActivity = async (runId, activityId, result) => {
    await store.createScriptWorkflowActivity({
      runId,
      callIndex: 0,
      callPath: `phase.${activityId}`,
      id: activityId,
      inputHash: `hash-${activityId}`,
      type: "agent",
    });
    if (result !== undefined) {
      await store.updateScriptWorkflowActivity({ id: activityId, result });
    }
  };
  await mkActivity("wf_usage_hit", "act_clean", { usageAccounting: { status: "complete" } });
  await mkActivity("wf_usage_hit", "act_marker", { usageAccounting: { status: "incomplete" } });
  await store.createScriptWorkflowRun({
    id: "wf_usage_clean",
    name: "clean",
    cwd,
    scriptHash: "h",
    parentSessionId: sessionId,
    status: "completed",
  });
  await mkActivity("wf_usage_clean", "act_plain", { other: true });
  await store.createScriptWorkflowRun({
    id: "wf_usage_none",
    name: "none",
    cwd,
    scriptHash: "h",
    parentSessionId: sessionId,
    status: "pending",
  });

  for (const runId of ["wf_usage_hit", "wf_usage_clean", "wf_usage_none"]) {
    const activities = await store.listScriptWorkflowActivities({ runId });
    const expected = activities.some(scriptWorkflowActivityUsageIncomplete);
    assert.equal(
      await store.hasScriptWorkflowUsageIncomplete({ runId }),
      expected,
      `SQL exists 探测必须与判据（scriptWorkflowActivityUsageIncomplete）同判：${runId}`,
    );
  }
  assert.equal(
    await store.hasScriptWorkflowUsageIncomplete({ runId: "wf_usage_hit" }),
    true,
    "任一 activity 命中标记即为 true",
  );
  assert.equal(
    await store.hasScriptWorkflowUsageIncomplete({ runId: "wf_usage_none" }),
    false,
    "无 activity 的 run 不完整不成立",
  );
});
