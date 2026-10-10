import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

/**
 * 编排方案 Phase 1 的存储层验收（specs/subagent-topology-persistence.md 验收场景
 * 1/2/3/4/6）：0030 迁移形状、upsert/settle(first-wins)/重臂/收敛/递归 descendants。
 * harness 形状照 workflow-run-owner-lease.test.mjs（createSqliteSessionStore 自动跑迁移，
 * raw DatabaseSync 只做 schema 断言）。
 */

const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);

async function createStore(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `acode-${label}-`));
  const dbPath = join(directory, "sessions.db");
  const store = createSqliteSessionStore({ dbPath });
  const raw = new DatabaseSync(dbPath);
  t.after(async () => {
    raw.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.createSession({
    directory,
    id: "sess_parent",
    projectID: "proj_topology",
    slug: "sess_parent",
    title: "topology parent",
    version: "v4",
  });
  return { raw, store };
}

const spawnEdge = (overrides = {}) => ({
  agentId: "agent_a",
  agentType: "Explore",
  background: true,
  childSessionId: "sess_child_a",
  description: "deep search",
  model: "provider/model",
  outputFile: join(tmpdir(), "agent_a.output"),
  parentSessionId: "sess_parent",
  parentToolCallId: "call_1",
  startedAt: 1_000,
  status: "running",
  ...overrides,
});

const rowByAgentId = (rows, agentId) => rows.find((row) => row.agent_id === agentId);

test("migration 0030 registers subagent_edge: 14 columns, no FK, parent index", async (t) => {
  const { raw, store } = await createStore(t, "edge-schema");

  assert.ok(store.debugMigrationIds().includes("0030_subagent_edge"));

  const columns = raw
    .prepare("pragma table_info(subagent_edge)")
    .all()
    .map((row) => row.name);
  assert.deepEqual(columns, [
    "agent_id",
    "parent_session_id",
    "child_session_id",
    "agent_type",
    "parent_tool_call_id",
    "description",
    "background",
    "model",
    "output_file",
    "status",
    "started_at",
    "ended_at",
    "total_tokens",
    "error",
  ]);

  // R7：不加 FK（0019 纪律）——子会话可能无 session 行，FK 会挡合法记录。
  assert.deepEqual(raw.prepare("pragma foreign_key_list(subagent_edge)").all(), []);

  const index = raw
    .prepare("select name from sqlite_master where type = 'index' and name = 'subagent_edge_parent_idx'")
    .get();
  assert.ok(index);
});

test("upsert inserts the spawn edge and lists it back without a child session row", async (t) => {
  const { store } = await createStore(t, "edge-upsert");

  // sess_child_a 刻意不建 session 行：无 FK 纪律下这必须合法（spawn 事件先于子会话落库的窗口）。
  await store.upsertSubagentEdge(spawnEdge());

  const rows = await store.readSubagentEdges({ sessionID: "sess_parent" });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.agent_id, "agent_a");
  assert.equal(row.parent_session_id, "sess_parent");
  assert.equal(row.child_session_id, "sess_child_a");
  assert.equal(row.agent_type, "Explore");
  assert.equal(row.parent_tool_call_id, "call_1");
  assert.equal(row.description, "deep search");
  assert.equal(row.background, 1);
  assert.equal(row.model, "provider/model");
  assert.equal(row.status, "running");
  assert.equal(row.started_at, 1_000);
  assert.equal(row.ended_at, null);
  assert.equal(row.total_tokens, null);
  assert.equal(row.error, null);
});

test("settle is terminal first-wins; settling a missing row inserts with NULL started_at", async (t) => {
  const { store } = await createStore(t, "edge-settle");

  await store.upsertSubagentEdge(spawnEdge());

  const applied = await store.settleSubagentEdge({
    agentId: "agent_a",
    endedAt: 2_000,
    parentSessionId: "sess_parent",
    status: "completed",
    totalTokens: 42,
  });
  assert.equal(applied, true);
  let rows = await store.readSubagentEdges({ sessionID: "sess_parent" });
  let row = rowByAgentId(rows, "agent_a");
  assert.equal(row.status, "completed");
  assert.equal(row.ended_at, 2_000);
  assert.equal(row.total_tokens, 42);
  assert.equal(row.started_at, 1_000);
  // spawn 铸入的谱系字段不被 settle 冲掉
  assert.equal(row.child_session_id, "sess_child_a");
  assert.equal(row.agent_type, "Explore");

  // R2：第二个终态被拒（对齐 registry 的 terminal first-wins 纪律）。
  const rejected = await store.settleSubagentEdge({
    agentId: "agent_a",
    endedAt: 3_000,
    error: "late failure",
    parentSessionId: "sess_parent",
    status: "failed",
  });
  assert.equal(rejected, false);
  rows = await store.readSubagentEdges({ sessionID: "sess_parent" });
  row = rowByAgentId(rows, "agent_a");
  assert.equal(row.status, "completed");
  assert.equal(row.error, null);

  // spawn 边写入曾失败（行缺失）时，settle 直插终态行；started_at 诚实置 NULL。
  const inserted = await store.settleSubagentEdge({
    agentId: "agent_b",
    endedAt: 3_500,
    error: "boom",
    parentSessionId: "sess_parent",
    status: "failed",
  });
  assert.equal(inserted, true);
  rows = await store.readSubagentEdges({ sessionID: "sess_parent" });
  row = rowByAgentId(rows, "agent_b");
  assert.equal(row.status, "failed");
  assert.equal(row.started_at, null);
  assert.equal(row.error, "boom");
});

test("re-arm: a resumed spawn upsert resets a settled edge to running", async (t) => {
  const { store } = await createStore(t, "edge-rearm");

  await store.upsertSubagentEdge(spawnEdge());
  await store.settleSubagentEdge({
    agentId: "agent_a",
    endedAt: 2_000,
    error: "boom",
    parentSessionId: "sess_parent",
    status: "failed",
    totalTokens: 7,
  });

  // resume 复用同一 agentId（runner.ts resumeTerminalAgentInBackground）：重臂是新生命。
  await store.upsertSubagentEdge(spawnEdge({ startedAt: 3_000 }));

  const rows = await store.readSubagentEdges({ sessionID: "sess_parent" });
  const row = rowByAgentId(rows, "agent_a");
  assert.equal(row.status, "running");
  assert.equal(row.started_at, 3_000);
  assert.equal(row.ended_at, null);
  assert.equal(row.total_tokens, null);
  assert.equal(row.error, null);
});

test("resume convergence turns only running edges into lost/session_resumed", async (t) => {
  const { store } = await createStore(t, "edge-converge");

  await store.upsertSubagentEdge(spawnEdge());
  await store.upsertSubagentEdge(spawnEdge({ agentId: "agent_c", childSessionId: "sess_child_c" }));
  await store.settleSubagentEdge({
    agentId: "agent_c",
    endedAt: 2_000,
    parentSessionId: "sess_parent",
    status: "completed",
  });

  const converged = await store.convergeSubagentEdges({ now: 5_000, sessionID: "sess_parent" });
  assert.equal(converged, 1);

  const rows = await store.readSubagentEdges({ sessionID: "sess_parent" });
  const stale = rowByAgentId(rows, "agent_a");
  assert.equal(stale.status, "lost");
  assert.equal(stale.error, "session_resumed");
  assert.equal(stale.ended_at, 5_000);
  const settled = rowByAgentId(rows, "agent_c");
  assert.equal(settled.status, "completed");
  assert.equal(settled.ended_at, 2_000);

  // 幂等：第二次收敛无可动行。
  assert.equal(await store.convergeSubagentEdges({ now: 6_000, sessionID: "sess_parent" }), 0);
});

test("descendants walks parent_session_id → child_session_id recursively with depth", async (t) => {
  const { store } = await createStore(t, "edge-descendants");

  await store.upsertSubagentEdge(spawnEdge());
  // 孙层边：父会话是 agent_a 的子会话。当前硬深度 1 下不会出现，形状为放开嵌套预留；
  // 无 FK 纪律下父行不存在也合法。
  await store.upsertSubagentEdge(
    spawnEdge({
      agentId: "agent_b",
      childSessionId: "sess_child_b",
      parentSessionId: "sess_child_a",
      parentToolCallId: "call_2",
    }),
  );
  // 无关节：另一个根会话的边不得混入。
  await store.upsertSubagentEdge(
    spawnEdge({ agentId: "agent_x", parentSessionId: "sess_other", childSessionId: "sess_child_x" }),
  );

  const descendants = await store.listSubagentDescendants({ sessionID: "sess_parent" });
  assert.equal(descendants.length, 2);
  const byId = new Map(descendants.map((row) => [row.agent_id, row]));
  assert.equal(byId.get("agent_a").depth, 1);
  assert.equal(byId.get("agent_b").depth, 2);
  assert.equal(byId.has("agent_x"), false);
});
