import assert from "node:assert/strict";
import test from "node:test";

/**
 * M2-7 automation/offPeak 端口收口测试（apps/acode-cli/specs/m2-7-automation-offpeak.md §5 C 节）。
 * 钉住：v4-first + −32601 回落（偏斜方向：新 CLI + 旧 host）、非 −32601 不回落、
 * checkTaskBinding 回落走 legacy automationList 筛选（不经 legacy checkTaskBinding）、
 * 归属守卫的 fail-closed、递归守卫、创建上限错误映射、offPeak 终态过滤与失败分类透传。
 */
const { createProtocolAutomationPort } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/automation-port.ts"
);
const { createProtocolOffPeakPort } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/offpeak-port.ts"
);
const { ProtocolRequestError } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/server-types.ts"
);

const methodNotFound = (method) =>
  new ProtocolRequestError(-32601, `Unsupported ACode Protocol request: ${method}`);

/** 按脚本顺序消费 requestClient 调用；记录每次调用的方法名与参数。 */
function makeContext(script, sessionRecords = new Map()) {
  const calls = [];
  return {
    calls,
    context: {
      sessions: sessionRecords,
      logger: undefined,
      requestClient: async (method, params) => {
        calls.push({ method, params });
        const step = script.shift();
        if (!step) {
          throw new Error(`unexpected requestClient call: ${method}`);
        }
        assert.equal(method, step.method, `call #${calls.length} 方法名不匹配`);
        if (step.error) throw step.error;
        return step.result;
      },
    },
  };
}

const automationWire = {
  automationId: "auto-1",
  title: "每日巡检",
  cronExpr: "0 2 * * *",
  prompt: "跑巡检",
  enabled: true,
  lifecycleStatus: "active",
  runCount: 0,
  recurring: true,
};

const offPeakWireTask = {
  offPeakTaskId: "op-1",
  title: "夜间批跑",
  status: "queued",
  sessionId: "s1",
  createdAt: 1_735_000_000_000,
};

const createInput = { cron: "0 2 * * *", prompt: "跑巡检", title: "每日巡检" };

// ── automation create：dual-form 与守卫 ──────────────────────────────────────

test("automation create: v4 命中（checkTaskBinding + create 各一次，无 legacy 调用）", async () => {
  const { context, calls } = makeContext([
    { method: "v4/automation/checkTaskBinding", result: { bound: false } },
    { method: "v4/automation/create", result: { automation: automationWire } },
  ]);
  const port = createProtocolAutomationPort(context);
  const result = await port.create(createInput, { sessionId: "s1" });
  assert.equal(result.automationId, "auto-1");
  assert.equal(result.title, "每日巡检");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["v4/automation/checkTaskBinding", "v4/automation/create"],
  );
  const createCall = calls[1];
  assert.equal(createCall.params.cronExpr, "0 2 * * *");
  assert.equal(createCall.params.prompt, "跑巡检");
  assert.equal(createCall.params.recurring, true);
  assert.equal(createCall.params.targetTaskId, "s1", "会话内创建必须绑定当前会话");
});

test("automation create: −32601 时回落 legacy（两形态参数不变，只换方法名）", async () => {
  const { context, calls } = makeContext([
    { method: "v4/automation/checkTaskBinding", error: methodNotFound("v4/automation/checkTaskBinding") },
    { method: "automation/list", result: { automations: [] } },
    { method: "v4/automation/create", error: methodNotFound("v4/automation/create") },
    { method: "automation/create", result: { automation: automationWire } },
  ]);
  const port = createProtocolAutomationPort(context);
  const result = await port.create(createInput, { sessionId: "s1" });
  assert.equal(result.automationId, "auto-1");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["v4/automation/checkTaskBinding", "automation/list", "v4/automation/create", "automation/create"],
  );
  // legacy 回落沿用同一份 params（逐字同形）。
  assert.deepEqual(calls[3].params, calls[2].params);
});

test("automation create: 非 −32601 错误不回落，原样抛出", async () => {
  const { context, calls } = makeContext([
    { method: "v4/automation/checkTaskBinding", result: { bound: false } },
    {
      method: "v4/automation/create",
      error: new ProtocolRequestError(-32000, "host internal failure"),
    },
  ]);
  const port = createProtocolAutomationPort(context);
  await assert.rejects(
    () => port.create(createInput, { sessionId: "s1" }),
    /host internal failure/,
  );
  assert.equal(calls.length, 2, "非 −32601 不得触发 legacy 回落");
});

test("automation create: checkTaskBinding 命中绑定 → 拒绝创建", async () => {
  const { context } = makeContext([
    { method: "v4/automation/checkTaskBinding", result: { bound: true } },
  ]);
  const port = createProtocolAutomationPort(context);
  await assert.rejects(
    () => port.create(createInput, { sessionId: "s1" }),
    /already belongs to a scheduled task/,
  );
});

test("automation create: checkTaskBinding −32601 → legacy automationList 筛选（不经 legacy checkTaskBinding）", async () => {
  const { context, calls } = makeContext([
    { method: "v4/automation/checkTaskBinding", error: methodNotFound("v4/automation/checkTaskBinding") },
    {
      method: "automation/list",
      result: { automations: [{ ...automationWire, targetTaskId: "s1" }] },
    },
  ]);
  const port = createProtocolAutomationPort(context);
  await assert.rejects(
    () => port.create(createInput, { sessionId: "s1" }),
    /already belongs to a scheduled task/,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["v4/automation/checkTaskBinding", "automation/list"],
    "回落不得走 legacy checkTaskBinding（该法在 legacy 侧未实现）",
  );
});

test("automation create: legacy 列表中无本会话绑定 → 正常放行", async () => {
  const { context } = makeContext([
    { method: "v4/automation/checkTaskBinding", error: methodNotFound("v4/automation/checkTaskBinding") },
    {
      method: "automation/list",
      result: { automations: [{ ...automationWire, targetTaskId: "other-session" }] },
    },
    { method: "v4/automation/create", result: { automation: automationWire } },
  ]);
  const port = createProtocolAutomationPort(context);
  const result = await port.create(createInput, { sessionId: "s1" });
  assert.equal(result.automationId, "auto-1");
});

test("automation create: 归属查询失败（非 −32601）→ fail-closed 拒绝", async () => {
  const { context } = makeContext([
    {
      method: "v4/automation/checkTaskBinding",
      error: new ProtocolRequestError(-32000, "sqlite busy"),
    },
  ]);
  const port = createProtocolAutomationPort(context);
  await assert.rejects(
    () => port.create(createInput, { sessionId: "s1" }),
    /Cannot verify whether this session belongs to a scheduled task/,
  );
});

test("automation create: legacy 回落查询失败同样 fail-closed", async () => {
  const { context } = makeContext([
    { method: "v4/automation/checkTaskBinding", error: methodNotFound("v4/automation/checkTaskBinding") },
    { method: "automation/list", error: new Error("db down") },
  ]);
  const port = createProtocolAutomationPort(context);
  await assert.rejects(
    () => port.create(createInput, { sessionId: "s1" }),
    /Cannot verify whether this session belongs to a scheduled task/,
  );
});

test("automation create: automation 派发轮内禁止递归创建（不发任何请求）", async () => {
  const sessions = new Map([["s1", { activeAutomationId: "auto-parent" }]]);
  const { context, calls } = makeContext([], sessions);
  const port = createProtocolAutomationPort(context);
  await assert.rejects(
    () => port.create(createInput, { sessionId: "s1" }),
    /while running a scheduled task/,
  );
  assert.equal(calls.length, 0, "递归守卫命中时不得触碰协议");
});

test("automation create: 上限错误映射为 AutomationCreateLimitError", async () => {
  const { context } = makeContext([
    { method: "v4/automation/checkTaskBinding", result: { bound: false } },
    {
      method: "v4/automation/create",
      error: new ProtocolRequestError(-32000, "limit: AUTOMATION_CREATE_LIMIT_REACHED"),
    },
  ]);
  const port = createProtocolAutomationPort(context);
  await assert.rejects(
    () => port.create(createInput, { sessionId: "s1" }),
    (error) =>
      error.name === "AutomationCreateLimitError" &&
      error.code === "AUTOMATION_CREATE_LIMIT_REACHED",
  );
});

// ── automation update/list/delete：dual-form ─────────────────────────────────

test("automation update: interval carrier 原子切换为无限循环（recurring:true + maxRuns:null）", async () => {
  const { context, calls } = makeContext([
    {
      method: "v4/automation/update",
      result: { automation: { ...automationWire, recurring: true, maxRuns: undefined } },
    },
  ]);
  const port = createProtocolAutomationPort(context);
  await port.update({ id: "auto-1", intervalUnit: "hourly", interval: 50 });
  assert.deepEqual(calls[0].params, {
    automationId: "auto-1",
    recurring: true,
    maxRuns: null,
    intervalUnit: "hourly",
    interval: 50,
  });
});

test("automation update: −32601 回落 legacy", async () => {
  const { context, calls } = makeContext([
    { method: "v4/automation/update", error: methodNotFound("v4/automation/update") },
    {
      method: "automation/update",
      result: { automation: { ...automationWire, title: "改名" } },
    },
  ]);
  const port = createProtocolAutomationPort(context);
  const result = await port.update({ id: "auto-1", title: "改名" });
  assert.equal(result.title, "改名");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["v4/automation/update", "automation/update"],
  );
});

test("automation list: v4 命中与 −32601 回落", async () => {
  const { context: v4Context } = makeContext([
    { method: "v4/automation/list", result: { automations: [automationWire] } },
  ]);
  const v4Port = createProtocolAutomationPort(v4Context);
  const v4List = await v4Port.list();
  assert.equal(v4List.length, 1);
  assert.equal(v4List[0].automationId, "auto-1");

  const { context: legacyContext, calls } = makeContext([
    { method: "v4/automation/list", error: methodNotFound("v4/automation/list") },
    { method: "automation/list", result: { automations: [automationWire] } },
  ]);
  const legacyPort = createProtocolAutomationPort(legacyContext);
  const legacyList = await legacyPort.list();
  assert.equal(legacyList.length, 1);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["v4/automation/list", "automation/list"],
  );
});

test("automation delete: v4 命中与 −32601 回落", async () => {
  const { context: v4Context } = makeContext([
    { method: "v4/automation/delete", result: { deleted: true } },
  ]);
  const v4Port = createProtocolAutomationPort(v4Context);
  assert.equal(await v4Port.delete({ id: "auto-1" }), true);

  const { context: legacyContext } = makeContext([
    { method: "v4/automation/delete", error: methodNotFound("v4/automation/delete") },
    { method: "automation/delete", result: { deleted: false } },
  ]);
  const legacyPort = createProtocolAutomationPort(legacyContext);
  assert.equal(await legacyPort.delete({ id: "auto-1" }), false);
});

// ── offPeak create/list：dual-form 与守卫 ────────────────────────────────────

test("offpeak create: v4 命中（offPeakList 绑定检查 + offPeakCreate）", async () => {
  const { context, calls } = makeContext([
    { method: "v4/offPeak/list", result: { tasks: [] } },
    { method: "v4/offPeak/create", result: { ok: true, task: offPeakWireTask } },
  ]);
  const port = createProtocolOffPeakPort(context);
  const result = await port.create({ title: "夜间批跑", prompt: "跑全量回归" }, { sessionId: "s1" });
  assert.deepEqual(result, { ok: true, task: { ...offPeakWireTask, queuePosition: undefined } });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["v4/offPeak/list", "v4/offPeak/create"],
  );
  assert.equal(calls[1].params.boundSessionId, "s1", "会话内创建必须绑定当前会话");
});

test("offpeak create: −32601 回落 legacy（list 与 create 两个站点）", async () => {
  const { context, calls } = makeContext([
    { method: "v4/offPeak/list", error: methodNotFound("v4/offPeak/list") },
    { method: "offPeak/list", result: { tasks: [] } },
    { method: "v4/offPeak/create", error: methodNotFound("v4/offPeak/create") },
    { method: "offPeak/create", result: { ok: true, task: offPeakWireTask } },
  ]);
  const port = createProtocolOffPeakPort(context);
  const result = await port.create({ title: "夜间批跑", prompt: "跑全量回归" }, { sessionId: "s1" });
  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["v4/offPeak/list", "offPeak/list", "v4/offPeak/create", "offPeak/create"],
  );
});

test("offpeak create: 本会话存在未终态任务 → 拒绝（终态任务放行）", async () => {
  const running = makeContext([
    {
      method: "v4/offPeak/list",
      result: { tasks: [{ ...offPeakWireTask, status: "running" }] },
    },
  ]);
  const runningPort = createProtocolOffPeakPort(running.context);
  await assert.rejects(
    () => runningPort.create({ title: "t", prompt: "p" }, { sessionId: "s1" }),
    /already has a pending idle-time task/,
  );

  const terminal = makeContext([
    {
      method: "v4/offPeak/list",
      result: { tasks: [{ ...offPeakWireTask, status: "completed" }] },
    },
    { method: "v4/offPeak/create", result: { ok: true, task: offPeakWireTask } },
  ]);
  const terminalPort = createProtocolOffPeakPort(terminal.context);
  const result = await terminalPort.create({ title: "t", prompt: "p" }, { sessionId: "s1" });
  assert.equal(result.ok, true, "终态任务不得阻塞同会话再次创建");
});

test("offpeak create: 绑定查询失败 → fail-closed", async () => {
  const { context } = makeContext([
    { method: "v4/offPeak/list", error: new ProtocolRequestError(-32000, "sqlite busy") },
  ]);
  const port = createProtocolOffPeakPort(context);
  await assert.rejects(
    () => port.create({ title: "t", prompt: "p" }, { sessionId: "s1" }),
    /Cannot verify whether this session already has a pending idle-time task/,
  );
});

test("offpeak create: 闲时派发轮内禁止递归创建（不发任何请求）", async () => {
  const sessions = new Map([["s1", { activeOffPeakTaskId: "op-parent" }]]);
  const { context, calls } = makeContext([], sessions);
  const port = createProtocolOffPeakPort(context);
  await assert.rejects(
    () => port.create({ title: "t", prompt: "p" }, { sessionId: "s1" }),
    /while running an idle-time task/,
  );
  assert.equal(calls.length, 0);
});

test("offpeak create: 失败分类原样透传（不降级为字符串）", async () => {
  const { context } = makeContext([
    { method: "v4/offPeak/list", result: { tasks: [] } },
    {
      method: "v4/offPeak/create",
      result: {
        ok: false,
        failureStage: "client_validation",
        errorCategory: "client_validation",
        errorCode: "offpeak_disabled",
      },
    },
  ]);
  const port = createProtocolOffPeakPort(context);
  const result = await port.create({ title: "t", prompt: "p" }, { sessionId: "s1" });
  assert.deepEqual(result, {
    ok: false,
    failureStage: "client_validation",
    errorCategory: "client_validation",
    errorCode: "offpeak_disabled",
  });
});

test("offpeak list: v4 命中与 −32601 回落", async () => {
  const { context: v4Context } = makeContext([
    { method: "v4/offPeak/list", result: { tasks: [offPeakWireTask] } },
  ]);
  const v4Port = createProtocolOffPeakPort(v4Context);
  const v4List = await v4Port.list();
  assert.equal(v4List.length, 1);
  assert.equal(v4List[0].offPeakTaskId, "op-1");

  const { context: legacyContext, calls } = makeContext([
    { method: "v4/offPeak/list", error: methodNotFound("v4/offPeak/list") },
    { method: "offPeak/list", result: { tasks: [offPeakWireTask] } },
  ]);
  const legacyPort = createProtocolOffPeakPort(legacyContext);
  const legacyList = await legacyPort.list();
  assert.equal(legacyList.length, 1);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["v4/offPeak/list", "offPeak/list"],
  );
});
