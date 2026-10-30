import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 完全访问事后传播的验收测试（apps/acode-cli/specs/subagent-parent-inheritance.md
 * 「完全访问事后传播（2026-10-30 增补）」验收场景 1–5）。
 *
 * 守护的性质：
 * - 根会话授予完全访问（applyRuntimeExecutionState 切 bypass 档，或
 *   grantPermissionFullAccess 弹窗路径）同步广播到同谱系活 child runtime（含孙级递归）；
 *   child 持久化 / SessionModeChanged 审计 / 托管策略地板校验全部复用
 *   applyRuntimeExecutionState 既有语义，不新写第二条模式写入路径。
 * - child planEnabled 不随广播改变（plan vessel 不被静默解除）；child 已在 bypass 档时
 *   同档早退，无事件刷屏；单个 child 失败（modePolicyForbidden / busy）warn-skip，
 *   不回滚根授权。
 * - 子弹窗放开 origin 抑制：子来源 permission payload 也带 fullAccessOption；
 *   optionsPolicy（托管选项策略）抑制保留。
 */

const { AgentRuntime } = await import("../packages/core/src/runtime/agent-runtime.ts");
const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);
const { createInMemorySessionEventStore } = await import(
  "../packages/contracts/src/events/in-memory-session-event-store.ts"
);
const { PermissionService, defaultPermissionConfig } = await import(
  "../packages/core/src/permission/service.ts"
);
const {
  registerLiveChildRuntime,
  unregisterLiveChildRuntime,
  liveChildRuntimes,
} = await import("../packages/core/src/runtime/subagent-child-registry.ts");
const { applyRuntimeExecutionState, propagateBypassModeToLiveChildren } = await import(
  "../packages/core/src/runtime/execution-state.ts"
);
const { ProductProjection } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/product-projection.ts"
);

const traceOf = (sessionId) => ({
  attributes: {},
  sessionId,
  spanId: `span_${sessionId}`,
  traceId: `trace_${sessionId}`,
});

function makeLogger(captured) {
  const logger = {
    debug() {},
    info() {},
    warn(message, context) {
      captured.push({ message, context });
    },
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}

async function makeRuntime(t, { sessionId, store, eventStore, config = {}, deps = {} }) {
  const dir = await mkdtemp(join(tmpdir(), "acode-full-access-propagation-"));
  await store.createSession({
    directory: dir,
    id: sessionId,
    projectID: "proj_full_access_propagation",
    slug: sessionId,
    title: sessionId,
    version: "v4",
  });
  const runtime = new AgentRuntime(
    sessionId,
    { mode: "build", workingDirectory: dir, ...config },
    {
      eventStore,
      modelFactory: () => {
        throw new Error("propagation fixture must not request a model");
      },
      sessionStore: store,
      traceContext: traceOf(sessionId),
      ...deps,
    },
  );
  t.after(async () => {
    runtime.beginShutdown();
    await rm(dir, { recursive: true, force: true });
  });
  return runtime;
}

async function makeFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "acode-full-access-propagation-store-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "sessions.db") });
  const eventStore = createInMemorySessionEventStore();
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, eventStore };
}

const modeChangedEvents = async (eventStore, sessionId) =>
  (await eventStore.getEvents(sessionId)).filter((event) => event.type === "session_mode_changed");

test("注册表：登记/注销/快照语义；注销幂等；快照是拷贝", () => {
  const parent = {};
  const childA = {};
  const childB = {};

  assert.deepEqual(liveChildRuntimes(parent), [], "未登记的父返回空数组");

  registerLiveChildRuntime(parent, childA);
  registerLiveChildRuntime(parent, childB);
  registerLiveChildRuntime(parent, childA);
  assert.deepEqual(liveChildRuntimes(parent), [childA, childB], "Set 去重，重复登记幂等");

  // 快照是数组拷贝：调用方改写快照不污染注册表。
  const snapshot = liveChildRuntimes(parent);
  snapshot.length = 0;
  assert.equal(liveChildRuntimes(parent).length, 2);

  unregisterLiveChildRuntime(parent, childA);
  assert.deepEqual(liveChildRuntimes(parent), [childB]);
  unregisterLiveChildRuntime(parent, childA);
  assert.deepEqual(liveChildRuntimes(parent), [childB], "重复注销是 no-op");
  unregisterLiveChildRuntime(parent, childB);
  assert.deepEqual(liveChildRuntimes(parent), []);

  // WeakMap 不延寿由类型与结构保证（WeakMap 键不阻止 GC）；Node 的 gc 时序不可靠，
  // 不做 gc 断言。
});

test("(场景1) 先派后授决策面：父切 yolo 广播到活 child，child 落 SessionModeChanged", async (t) => {
  const { store, eventStore } = await makeFixture(t);
  const parent = await makeRuntime(t, { sessionId: "sess_parent", store, eventStore });
  const child = await makeRuntime(t, { sessionId: "sess_child", store, eventStore });
  registerLiveChildRuntime(parent, child);

  // 场景 3 对照半：授权前 child 冻结在 spawn 档。
  assert.equal(child.config.mode, "build");

  await applyRuntimeExecutionState(parent, { mode: "yolo" }, { source: "command" });

  assert.equal(parent.config.mode, "yolo");
  assert.equal(child.config.mode, "yolo", "活 child 被广播收敛到 bypass 档");
  assert.equal(child.config.planEnabled, false);
  const childModeEvents = await modeChangedEvents(eventStore, "sess_child");
  assert.equal(childModeEvents.length, 1, "child 会话收到恰好一条 SessionModeChanged");
  assert.equal(childModeEvents[0].payload.mode, "yolo");
  assert.equal(childModeEvents[0].payload.previousMode, "build");
});

test("(场景4) plan child 不被广播解除 plan：planEnabled 保持 true，mode 升 yolo", async (t) => {
  const { store, eventStore } = await makeFixture(t);
  const parent = await makeRuntime(t, { sessionId: "sess_parent", store, eventStore });
  const planChild = await makeRuntime(t, {
    sessionId: "sess_plan_child",
    store,
    eventStore,
    // childMode === "plan" 的构造形态（methods/subagent.ts）：mode 继承父档、planEnabled 置位。
    config: { mode: "build", planEnabled: true },
  });
  registerLiveChildRuntime(parent, planChild);

  await applyRuntimeExecutionState(parent, { mode: "yolo" }, { source: "command" });

  assert.equal(planChild.config.mode, "yolo");
  assert.equal(
    planChild.config.planEnabled,
    true,
    "resolveExecutionState 对只传 {mode} 会把 planEnabled 归 false；传播必须显式保留 child 当前值",
  );
  const events = await modeChangedEvents(eventStore, "sess_plan_child");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.planEnabled, true);
});

test("(语义3) child 已在 bypass 档：重播同档早退，无事件刷屏", async (t) => {
  const { store, eventStore } = await makeFixture(t);
  const parent = await makeRuntime(t, { sessionId: "sess_parent", store, eventStore });
  const child = await makeRuntime(t, { sessionId: "sess_child", store, eventStore });
  registerLiveChildRuntime(parent, child);

  await applyRuntimeExecutionState(parent, { mode: "yolo" }, { source: "command" });
  assert.equal((await modeChangedEvents(eventStore, "sess_child")).length, 1);

  // 重授/重复广播：child apply 同档早退，不再落事件。
  await propagateBypassModeToLiveChildren(parent, { source: "command" });
  assert.equal(
    (await modeChangedEvents(eventStore, "sess_child")).length,
    1,
    "同档早退：第二次广播不产新事件",
  );

  // 父侧同档：applyRuntimeExecutionState 早退在传播触发之前，父也不重播。
  await applyRuntimeExecutionState(parent, { mode: "yolo" }, { source: "command" });
  assert.equal((await modeChangedEvents(eventStore, "sess_parent")).length, 1);
  assert.equal((await modeChangedEvents(eventStore, "sess_child")).length, 1);
});

test("(场景5) 托管地板 child：warn-skip 不回滚根授权；其余 child 照常收敛", async (t) => {
  const { store, eventStore } = await makeFixture(t);
  const warns = [];
  const parent = await makeRuntime(t, {
    sessionId: "sess_parent",
    store,
    eventStore,
    deps: { logger: makeLogger(warns) },
  });
  const managedChild = await makeRuntime(t, {
    sessionId: "sess_managed_child",
    store,
    eventStore,
    deps: {
      permissionService: new PermissionService({
        ...defaultPermissionConfig,
        policyFloor: { deny: [], ask: [], disallowedTools: [], disableBypassPermissionsMode: true },
      }),
    },
  });
  const normalChild = await makeRuntime(t, {
    sessionId: "sess_normal_child",
    store,
    eventStore,
  });
  registerLiveChildRuntime(parent, managedChild);
  registerLiveChildRuntime(parent, normalChild);

  await applyRuntimeExecutionState(parent, { mode: "yolo" }, { source: "command" });

  assert.equal(parent.config.mode, "yolo", "根授权不被 child 失败回滚");
  assert.equal(managedChild.config.mode, "build", "托管地板拒绝 bypass，child 维持原档");
  assert.equal(normalChild.config.mode, "yolo", "单个 child 失败不阻断其余 child");
  assert.equal((await modeChangedEvents(eventStore, "sess_managed_child")).length, 0);
  const skip = warns.find((entry) => entry.context?.event === "runtime.permission.propagation_skip");
  assert.ok(skip, "warn-skip 必须落 runtime.permission.propagation_skip 日志");
  assert.equal(skip.context.childSessionId, "sess_managed_child");
  assert.match(skip.context.reason, /modePolicyForbidden/);
});

test("注销后不再传播：turn 结算的 child 不是广播目标", async (t) => {
  const { store, eventStore } = await makeFixture(t);
  const parent = await makeRuntime(t, { sessionId: "sess_parent", store, eventStore });
  const settledChild = await makeRuntime(t, {
    sessionId: "sess_settled_child",
    store,
    eventStore,
  });
  registerLiveChildRuntime(parent, settledChild);
  unregisterLiveChildRuntime(parent, settledChild);

  await applyRuntimeExecutionState(parent, { mode: "yolo" }, { source: "command" });

  assert.equal(settledChild.config.mode, "build");
  assert.equal((await modeChangedEvents(eventStore, "sess_settled_child")).length, 0);
});

test("孙级递归：广播经 child 的 apply 触达 grandchild", async (t) => {
  const { store, eventStore } = await makeFixture(t);
  const parent = await makeRuntime(t, { sessionId: "sess_parent", store, eventStore });
  const child = await makeRuntime(t, { sessionId: "sess_child", store, eventStore });
  const grandchild = await makeRuntime(t, {
    sessionId: "sess_grandchild",
    store,
    eventStore,
  });
  registerLiveChildRuntime(parent, child);
  registerLiveChildRuntime(child, grandchild);

  await applyRuntimeExecutionState(parent, { mode: "yolo" }, { source: "command" });

  assert.equal(child.config.mode, "yolo");
  assert.equal(grandchild.config.mode, "yolo", "孙级由 child 的 apply 递归收敛");
  assert.equal((await modeChangedEvents(eventStore, "sess_grandchild")).length, 1);
});

test("(场景2 根授权半) grantPermissionFullAccess 弹窗路径同样广播", async (t) => {
  const { store, eventStore } = await makeFixture(t);
  const parent = await makeRuntime(t, { sessionId: "sess_parent", store, eventStore });
  const child = await makeRuntime(t, { sessionId: "sess_child", store, eventStore });
  registerLiveChildRuntime(parent, child);

  await parent.grantPermissionFullAccess("ixn_full_access_1");

  assert.equal(parent.config.mode, "yolo");
  assert.equal(child.config.mode, "yolo", "弹窗授权路径不经 applyRuntimeExecutionState，显式广播");
  assert.equal((await modeChangedEvents(eventStore, "sess_child")).length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 子弹窗放开（验收场景 2 的投影面）：origin 抑制移除，optionsPolicy 抑制保留。
// ─────────────────────────────────────────────────────────────────────────────

const PROJECTION_SID = "sess_projection";

let projectionSeq = 0;
const projectionEvent = (payload) => ({
  id: `ev-${++projectionSeq}`,
  sessionId: PROJECTION_SID,
  type: "permission_requested",
  timestamp: new Date(1_700_000_000_000 + projectionSeq * 1_000),
  traceId: "trace-full-access-projection",
  sequenceNumber: projectionSeq,
  payload,
});

const CHILD_ORIGIN = {
  kind: "subagent",
  agentId: "agent_child",
  agentType: "general-purpose",
  childSessionId: "sess_child",
  childTurnId: "turn_child",
  description: "probe",
  parentSessionId: PROJECTION_SID,
};

function permissionPayload(overrides = {}) {
  return {
    requestId: `req-${++projectionSeq}`,
    toolCallId: `tc-${projectionSeq}`,
    toolName: "Write",
    riskLevel: "medium",
    reason: "probe",
    input: {},
    suggestedPermissionUpdates: [],
    fullAccessSupported: true,
    ...overrides,
  };
}

function pendingInteractionFrom(deltas) {
  const patch = deltas.filter((delta) => delta.op === "state.updated").at(-1)?.patch;
  return patch?.pendingInteractions?.at(-1);
}

test("(场景2) 子来源 permission payload 现在带 fullAccessOption；optionsPolicy 仍抑制", () => {
  // 子来源（origin 在场）：R7 移除 origin 抑制后必须带 fullAccessOption，origin 原样保留。
  const withOrigin = new ProductProjection(PROJECTION_SID, "epoch-propagation-origin");
  const originInteraction = pendingInteractionFrom(
    withOrigin.applyEvent(projectionEvent(permissionPayload({ origin: CHILD_ORIGIN }))),
  );
  assert.ok(
    originInteraction?.payload.fullAccessOption,
    "origin 不再抑制 fullAccessOption（R7）",
  );
  assert.deepEqual(originInteraction.payload.origin, CHILD_ORIGIN, "origin 事实原样保留");

  // 根来源（无 origin）：既有行为不变。
  const withoutOrigin = new ProductProjection(PROJECTION_SID, "epoch-propagation-root");
  const rootInteraction = pendingInteractionFrom(
    withoutOrigin.applyEvent(projectionEvent(permissionPayload())),
  );
  assert.ok(rootInteraction?.payload.fullAccessOption, "根来源照旧带 fullAccessOption");

  // 托管选项策略在场：抑制保留，origin 在场也不例外。
  const withPolicy = new ProductProjection(PROJECTION_SID, "epoch-propagation-policy");
  const policyInteraction = pendingInteractionFrom(
    withPolicy.applyEvent(
      projectionEvent(
        permissionPayload({ origin: CHILD_ORIGIN, optionsPolicy: "no-always-allow" }),
      ),
    ),
  );
  assert.equal(
    policyInteraction?.payload.fullAccessOption,
    undefined,
    "optionsPolicy（托管选项策略）抑制保留",
  );
});

// 无集成级 spawn harness 可承载「先派后授」端到端断言（真实 spawn 需模型工厂与整轮
// turn 执行，现有 subagent 测试均为决策层/源文本守护），spawn 接线用源文本锚定
// （仿 tests/no-telemetry.test.mjs 与 subagent-topology-invariants.test.mjs 模式）。
test("接线锚定：spawn 登记 / turn finally 注销 / 弹窗路径广播 在场", async () => {
  const cliRoot = new URL("../", import.meta.url);
  // core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
  const read = (path) =>
    readFile(new URL(path, cliRoot), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

  const subagent = await read("packages/core/src/runtime/methods/subagent.ts");
  assert.ok(
    subagent.includes("registerLiveChildRuntime(this,"),
    "child runtime 构造完成后必须登记（R7）",
  );
  assert.ok(
    subagent.includes("unregisterLiveChildRuntime(this,"),
    "child turn 结算 finally 必须注销（覆盖构造后所有退出路径）",
  );

  const fullAccess = await read("packages/core/src/runtime/permission-full-access.ts");
  assert.ok(
    fullAccess.includes("propagateBypassModeToLiveChildren(this,"),
    "弹窗授权路径必须显式广播（不经 applyRuntimeExecutionState）",
  );

  const broker = await read("packages/bootstrap/src/acode-protocol-v4/interaction-broker.ts");
  assert.equal(
    /!request\.origin\s*&&\s*\n?\s*!request\.optionsPolicy/.test(broker),
    false,
    "broker 的 fullAccess 注册不得再抑制 origin（R7）",
  );
  const projection = await read("packages/bootstrap/src/acode-protocol-v4/product-projection.ts");
  assert.equal(
    projection.includes("payload.fullAccessSupported === true && !payload.origin"),
    false,
    "投影的 fullAccessOption 不得再抑制 origin（R7）",
  );
});
