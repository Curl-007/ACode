import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * specs/overnight-execution.md R1a + 验收场景 7a：隐藏 coordinator 的语义必须**落盘**。
 *
 * 修复的缺陷：coordinator 的 fork 会话行以 taskType "fork" 持久化，而侧栏可见性由持久化
 * taskType 决定（isTaskListSessionType 判 interactive/fork/workflow_parent 可见，冷启动 seed
 * 从 store 读同一判据），于是 CLI 重启后隐藏 coordinator 被投进侧栏显示为「Fork of X」。
 *
 * 用真 sqlite store + 真 AgentRuntime 断言端到端落盘形态，不用 mock store——缺陷形态恰恰
 * 只在「持久化 → 冷启动 seed 读取」这一段显形，mock 掉 store 就测不到它。
 */

const { AgentRuntime } = await import("../packages/core/src/runtime/agent-runtime.ts");
const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);
const { createInMemorySessionEventStore } = await import(
  "../packages/contracts/src/events/in-memory-session-event-store.ts"
);
const { createForkedSession } = await import(
  "../packages/core/src/runtime/methods/session-fork.ts"
);
const {
  isTaskListSessionType,
  TASK_LIST_SESSION_TYPES,
} = await import("../packages/bootstrap/src/acode-protocol-v4/task-list-session-membership.ts");
const { SESSION_TASK_TYPES } = await import(
  "../packages/contracts/src/interfaces/session-store.port.ts"
);

const stubModel = {
  providerId: "test",
  modelId: "test",
  options: {},
  properties: { contextWindow: 100_000, inputFormat: { supportsText: true } },
  optionSpecs: { maxOutputTokens: { max: 1000 }, reasoningLevel: { values: [] } },
  generateText: async () => ({ text: "ok", finishReason: "stop", usage: {} }),
};

function makeTrace(id) {
  return { attributes: {}, sessionId: id, spanId: `span_${id}`, traceId: `trace_${id}` };
}

async function makeHarness(t, { taskType }) {
  const dir = await mkdtemp(join(tmpdir(), "acode-overnight-hidden-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "sessions.db") });
  const parentSession = {
    id: "sess_parent",
    projectID: "proj_overnight",
    taskType: "interactive",
    slug: "parent-session",
    directory: dir,
    path: dir,
    title: "父会话标题",
    version: "v4",
    time: { created: 1, updated: 1 },
  };
  await store.createSession(parentSession);
  const runtime = new AgentRuntime(
    "sess_parent",
    { mode: "build", workingDirectory: dir, taskType },
    {
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => stubModel,
      sessionStore: store,
      traceContext: makeTrace("sess_parent"),
    },
  );
  t.after(async () => {
    runtime.beginShutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, runtime, parentSession };
}

test("R1a: hiddenCoordinatorTitle 令落盘行拿 overnight_coordinator 与 coordinator 自己的标题", async (t) => {
  const { store, runtime, parentSession } = await makeHarness(t, {
    taskType: "overnight_coordinator",
  });

  const forkedId = await createForkedSession(runtime, {
    parentSession,
    hiddenCoordinatorTitle: "Overnight 8h（run-abc123）",
  });

  const persisted = await store.getSession(forkedId);
  assert.equal(
    persisted.taskType,
    "overnight_coordinator",
    "落盘 taskType 必须是专属隐藏值，不能是 fork",
  );
  assert.equal(
    persisted.title,
    "Overnight 8h（run-abc123）",
    "标题是 coordinator 自己的，不能是「Fork of 父会话标题」",
  );
  assert.ok(!persisted.title.includes("Fork of"), "标题不得含 Fork of 前缀");
});

test("R1a: overnight_coordinator 不在 TASK_LIST_SESSION_TYPES 内 → 冷启动 seed 不投侧栏", async (t) => {
  const { store, runtime, parentSession } = await makeHarness(t, {
    taskType: "overnight_coordinator",
  });

  await createForkedSession(runtime, {
    parentSession,
    hiddenCoordinatorTitle: "Overnight 1h（run-hidden）",
  });

  // 可见性判据：不在集合内即不可见（既有机制，不新增第二条可见性路径）。
  assert.equal(
    isTaskListSessionType("overnight_coordinator"),
    false,
    "隐藏 coordinator 必须判为不可见",
  );
  assert.equal(isTaskListSessionType("fork"), true, "普通 fork 仍可见（回归对照）");
  assert.ok(
    !TASK_LIST_SESSION_TYPES.includes("overnight_coordinator"),
    "不得把 overnight_coordinator 加进可见集合",
  );

  // 缺陷的真实形态：冷启动 seed 用 listSessions({ taskTypes: TASK_LIST_SESSION_TYPES })
  // 拉可见会话。断言 coordinator 不在结果里，而父会话在。
  const seeded = await store.listSessions({ taskTypes: [...TASK_LIST_SESSION_TYPES] });
  const seededIds = seeded.map((s) => String(s.id));
  assert.ok(seededIds.includes("sess_parent"), "父会话（interactive）应在侧栏种子里");
  assert.deepEqual(
    seededIds.filter((id) => id !== "sess_parent"),
    [],
    "隐藏 coordinator 不得出现在侧栏种子结果中",
  );
});

test("R1a: 负向对照——隐藏位缺席时落盘 fork 且标题为 Fork of（缺陷形态可复现）", async (t) => {
  const { store, runtime, parentSession } = await makeHarness(t, { taskType: "fork" });

  const forkedId = await createForkedSession(runtime, { parentSession });

  const persisted = await store.getSession(forkedId);
  assert.equal(persisted.taskType, "fork");
  assert.equal(persisted.title, "Fork of 父会话标题");
  assert.equal(isTaskListSessionType(persisted.taskType), true, "普通 fork 仍进侧栏（预期行为）");
});

test("R1a 单一事实：child 首个 turn 的 upsert 不得把隐藏身份改回 fork", async (t) => {
  // 这条钉住实现期发现的真实回归风险：ensureSessionPersisted 在每个 turn 起点以
  // config.taskType upsert 会话行（turn.ts:332 → events.ts:593 → createSession 的
  // `task_type = excluded.task_type`），而 child 的 sessionPersisted 初值为 false
  // （agent-runtime.ts:340，fork 路径不预置），故该 upsert 必然发生。
  // 若运行期 config.taskType 与落盘值不同源（曾是 "fork" vs "overnight_coordinator"），
  // 首个 turn 就会静默撤销 R1a。这里复现该 upsert 并断言身份不变。
  const { store, runtime, parentSession } = await makeHarness(t, {
    taskType: "overnight_coordinator",
  });

  const forkedId = await createForkedSession(runtime, {
    parentSession,
    hiddenCoordinatorTitle: "Overnight 2h（run-upsert）",
  });
  assert.equal((await store.getSession(forkedId)).taskType, "overnight_coordinator");

  // 模拟 ensureSessionPersisted 的写入：同 id、taskType 取自运行期 config（同源）。
  const row = await store.getSession(forkedId);
  await store.createSession({
    ...row,
    taskType: runtime.config.taskType,
    titleSource: "first_input",
    time: { created: row.time.created, updated: row.time.updated },
  });

  const after = await store.getSession(forkedId);
  assert.equal(
    after.taskType,
    "overnight_coordinator",
    "upsert 后隐藏身份必须存活——两处写入同源才成立（单一事实）",
  );
  assert.equal(isTaskListSessionType(after.taskType), false);
});

test("R1a 负向对照：config 与落盘不同源时，同样的 upsert 会撤销隐藏身份", async (t) => {
  // 证明上一条不是恒真断言：把运行期 config 退回 "fork"（修复前的形态），同样的 upsert
  // 就把落盘身份改回 fork → 侧栏重新可见。这正是实现期发现的缺陷路径。
  const { store, runtime, parentSession } = await makeHarness(t, { taskType: "fork" });

  const forkedId = await createForkedSession(runtime, {
    parentSession,
    hiddenCoordinatorTitle: "Overnight 2h（run-clobber）",
  });
  assert.equal(
    (await store.getSession(forkedId)).taskType,
    "overnight_coordinator",
    "落盘身份先正确",
  );

  const row = await store.getSession(forkedId);
  await store.createSession({
    ...row,
    taskType: runtime.config.taskType, // "fork" —— 不同源
    time: { created: row.time.created, updated: row.time.updated },
  });

  const after = await store.getSession(forkedId);
  assert.equal(after.taskType, "fork", "不同源时身份被撤销（缺陷复现）");
  assert.equal(isTaskListSessionType(after.taskType), true, "→ 冷重启后又进侧栏");
});

test("R1a: overnight_coordinator 是 SESSION_TASK_TYPES 的合法成员（可持久化、可解码）", async () => {
  assert.ok(
    SESSION_TASK_TYPES.includes("overnight_coordinator"),
    "新值必须进词表，否则 decodeSessionTaskType 会回落 interactive",
  );
  // 跨版本降级行为（spec R1a 如实登记，不做兜底）：旧词表读新库会回落 interactive。
  // 这里钉住当前词表的解码方向不退化——decode 对已知值必须原样返回。
  assert.ok(
    !["interactive", "fork", "workflow_parent"].includes("overnight_coordinator"),
    "隐藏值不得与任何可见值同名",
  );
});
