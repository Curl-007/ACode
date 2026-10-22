import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 第一方 MCP server 写审计（specs/mcp-lifecycle-ttl-approval.md R3）验收测试：
 * readOnlyHint → is_write 推导、每次调用审计条目（server/tool/is_write/耗时/状态）、
 * 注册期未覆盖写工具告警（写工具 ∩ allowedTools）。
 */

const {
  deriveMcpToolIsWrite,
  registerMcpTools,
  setMcpCallAuditSink,
} = await import("../packages/core/src/mcp/index.ts");

const { auditMcpToolCall, registerMcpCallAuditSink } = await import(
  "../packages/core/src/mcp/call-audit.ts"
);

function makeDescriptor(overrides) {
  return {
    serverName: "srv",
    toolName: "do_thing",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

function makeRegistry() {
  const entries = new Map();
  return {
    entries,
    register(entry) {
      entries.set(entry.metadata.name, entry);
    },
  };
}

function makeContext() {
  return {
    toolCallId: "tc-1",
    traceId: "trace-1",
    sessionId: "sess-1",
    abortSignal: new AbortController().signal,
  };
}

function makePort(resultOrError) {
  return {
    calls: [],
    async callTool(request) {
      this.calls.push(request);
      if (resultOrError instanceof Error) throw resultOrError;
      if (typeof resultOrError === "function") return resultOrError();
      return resultOrError ?? { content: [{ type: "text", text: "ok" }] };
    },
  };
}

async function withAuditSink(fn) {
  const events = [];
  setMcpCallAuditSink((event) => events.push(event));
  try {
    return await fn(events);
  } finally {
    setMcpCallAuditSink(undefined);
  }
}

// -----------------------------------------------
// is_write 推导（fail-closed 方向）
// -----------------------------------------------

test("deriveMcpToolIsWrite: hint 缺席按写对待，readOnlyHint=true 才是读", () => {
  assert.equal(deriveMcpToolIsWrite(undefined), true, "annotations 缺席 = 写（fail-closed）");
  assert.equal(deriveMcpToolIsWrite({}), true, "readOnlyHint 缺席 = 写");
  assert.equal(deriveMcpToolIsWrite({ readOnlyHint: false }), true);
  assert.equal(deriveMcpToolIsWrite({ readOnlyHint: true }), false);
  assert.equal(
    deriveMcpToolIsWrite({ readOnlyHint: true, destructiveHint: true }),
    true,
    "自相矛盾的 annotations 按更严的写对待",
  );
});

// -----------------------------------------------
// 调用审计
// -----------------------------------------------

test("第一方 server 的每次调用产生审计条目（is_write/耗时/状态）", async () => {
  await withAuditSink(async (events) => {
    const registry = makeRegistry();
    const port = makePort();
    registerMcpTools(
      registry,
      port,
      [
        makeDescriptor({
          serverName: "node_repl",
          toolName: "run_task",
          annotations: {},
        }),
        makeDescriptor({
          serverName: "remote-official",
          toolName: "search",
          official: true,
          annotations: { readOnlyHint: true },
        }),
      ],
      {},
    );

    const writeEntry = registry.entries.get("mcp__node_repl__run_task");
    const readEntry = registry.entries.get("mcp__remote-official__search");
    assert.ok(writeEntry && readEntry);

    await writeEntry.handler({}, makeContext());
    await readEntry.handler({}, makeContext());

    const calls = events.filter((event) => event.kind === "tool-call");
    assert.equal(calls.length, 2);
    const [writeCall, readCall] = calls;
    assert.equal(writeCall.serverName, "node_repl");
    assert.equal(writeCall.toolName, "run_task");
    assert.equal(writeCall.isWrite, true);
    assert.equal(writeCall.firstPartyBasis, "builtin-node-repl");
    assert.equal(writeCall.status, "completed");
    assert.equal(typeof writeCall.durationMs, "number");
    assert.equal(writeCall.sessionId, "sess-1");
    assert.equal(readCall.isWrite, false);
    assert.equal(readCall.firstPartyBasis, "official-http");
    assert.equal(readCall.status, "completed");
  });
});

test("in-band isError 记 tool-error；传输级异常记 failed 且异常照常冒泡", async () => {
  await withAuditSink(async (events) => {
    const registry = makeRegistry();
    const toolErrorPort = makePort({
      content: [{ type: "text", text: "quota exhausted" }],
      isError: true,
    });
    registerMcpTools(
      registry,
      toolErrorPort,
      [makeDescriptor({ serverName: "node_repl", toolName: "run_task" })],
      {},
    );
    await registry.entries.get("mcp__node_repl__run_task").handler({}, makeContext());
    const toolErrorEvent = events.find((event) => event.kind === "tool-call");
    assert.equal(toolErrorEvent.status, "tool-error");

    events.length = 0;
    const failingRegistry = makeRegistry();
    const failingPort = makePort(new Error("transport died"));
    registerMcpTools(
      failingRegistry,
      failingPort,
      [makeDescriptor({ serverName: "node_repl", toolName: "run_task" })],
      {},
    );
    await assert.rejects(
      () => failingRegistry.entries.get("mcp__node_repl__run_task").handler({}, makeContext()),
      /transport died/,
    );
    const failedEvent = events.find((event) => event.kind === "tool-call");
    assert.equal(failedEvent.status, "failed");
  });
});

test("第三方 server 的调用不进第一方审计面", async () => {
  await withAuditSink(async (events) => {
    const registry = makeRegistry();
    registerMcpTools(
      registry,
      makePort(),
      [
        makeDescriptor({
          serverName: "third-party",
          toolName: "mutate",
          annotations: { readOnlyHint: false },
        }),
      ],
      {},
    );
    await registry.entries.get("mcp__third-party__mutate").handler({}, makeContext());
    assert.equal(
      events.filter((event) => event.kind === "tool-call").length,
      0,
      "第三方调用由 adapters.mcp 的 mcp.tool.call 日志承担，不进本审计面",
    );
  });
});

test("官方 CUA（authority 验明）按第一方审计；未验明的同名 server 不算", async () => {
  await withAuditSink(async (events) => {
    const registry = makeRegistry();
    const cuaName = "computer-use";
    registerMcpTools(
      registry,
      makePort(),
      [makeDescriptor({ serverName: cuaName, toolName: "click" })],
      { officialCuaServerNames: new Set([cuaName]) },
    );
    const names = [...registry.entries.keys()];
    assert.equal(names.length, 1);
    await registry.entries.get(names[0]).handler({ title: "t" }, makeContext());
    const call = events.find((event) => event.kind === "tool-call");
    assert.equal(call.firstPartyBasis, "official-cua");
  });
});

// -----------------------------------------------
// 未覆盖写工具告警（写工具 ∩ allowedTools，每次注册一次）
// -----------------------------------------------

test("第一方写工具被 allowedTools 放行时告警一次；读工具与无 allow 列表不告警", async () => {
  await withAuditSink(async (events) => {
    const registry = makeRegistry();
    registerMcpTools(
      registry,
      makePort(),
      [
        makeDescriptor({ serverName: "node_repl", toolName: "run_task", annotations: {} }),
        makeDescriptor({ serverName: "node_repl", toolName: "peek", annotations: { readOnlyHint: true } }),
      ],
      { allowedTools: ["mcp__node_repl__run_task", "mcp__node_repl__peek"] },
    );
    const warnings = events.filter((event) => event.kind === "uncovered-write-tools");
    assert.equal(warnings.length, 1, "按 server 聚合、每次注册一次");
    assert.equal(warnings[0].serverName, "node_repl");
    assert.deepEqual(warnings[0].toolNames, ["run_task"], "只告警写工具；读工具被 allow 不告警");

    events.length = 0;
    registerMcpTools(
      makeRegistry(),
      makePort(),
      [makeDescriptor({ serverName: "node_repl", toolName: "run_task", annotations: {} })],
      {},
    );
    assert.equal(
      events.filter((event) => event.kind === "uncovered-write-tools").length,
      0,
      "无 allowedTools 时默认审批门（needsApproval）仍生效，无需告警",
    );

    events.length = 0;
    registerMcpTools(
      makeRegistry(),
      makePort(),
      [makeDescriptor({ serverName: "third-party", toolName: "mutate", annotations: {} })],
      { allowedTools: ["mcp__third-party__mutate"] },
    );
    assert.equal(
      events.filter((event) => event.kind === "uncovered-write-tools").length,
      0,
      "第三方 server 不在第一方告警面内",
    );
  });
});

test("审计 sink 抛异常不影响工具调用结果", async () => {
  setMcpCallAuditSink(() => {
    throw new Error("sink exploded");
  });
  try {
    const registry = makeRegistry();
    registerMcpTools(
      registry,
      makePort(),
      [makeDescriptor({ serverName: "node_repl", toolName: "run_task" })],
      {},
    );
    const output = await registry.entries
      .get("mcp__node_repl__run_task")
      .handler({}, makeContext());
    assert.ok(output !== undefined);
  } finally {
    setMcpCallAuditSink(undefined);
  }
});

// -----------------------------------------------
// CLI-04 同类残余：按 sessionId 注册表路由（双 App 不串线）
// -----------------------------------------------

function toolCallEntry(sessionId) {
  return {
    kind: "tool-call",
    serverName: "node_repl",
    toolName: "run_task",
    registeredName: "mcp__node_repl__run_task",
    isWrite: true,
    durationMs: 1,
    status: "completed",
    firstPartyBasis: "builtin-node-repl",
    sessionId,
  };
}

test("CLI-04 残余：双 App 交错写 MCP 审计，各自归属正确 trace，一个 close 不影响另一个", () => {
  const seenA = [];
  const seenB = [];
  const seenDefault = [];
  // 进程级缺省 sink：未注册 sessionId 的 emit 回落这里（stderr 兜底的替身）。
  setMcpCallAuditSink((event) => seenDefault.push(event));
  const unregisterA = registerMcpCallAuditSink("sess_app_a", (event) => seenA.push(event));
  registerMcpCallAuditSink("sess_app_b", (event) => seenB.push(event));
  try {
    // App A、B 交错写：各按 entry.sessionId 落到自己的 sink，不串线。
    auditMcpToolCall(toolCallEntry("sess_app_a"));
    auditMcpToolCall(toolCallEntry("sess_app_b"));
    auditMcpToolCall(toolCallEntry("sess_app_a"));
    assert.equal(seenA.length, 2, "App A 的两条落 App A sink");
    assert.equal(seenB.length, 1, "App B 的一条落 App B sink");
    assert.equal(seenDefault.length, 0, "已注册 sessionId 不回落进程级缺省");
    assert.ok(seenA.every((event) => event.sessionId === "sess_app_a"));
    assert.ok(seenB.every((event) => event.sessionId === "sess_app_b"));

    // 未注册 sessionId 的 emit 回落进程级缺省（不丢记录）。
    auditMcpToolCall(toolCallEntry("sess_unknown"));
    assert.equal(seenDefault.length, 1, "未注册 sessionId 回落缺省 sink");

    // App A close（幂等释放自己的注册项）：App B 的审计通道不受影响。
    unregisterA();
    seenA.length = 0;
    seenB.length = 0;
    seenDefault.length = 0;
    auditMcpToolCall(toolCallEntry("sess_app_a"));
    auditMcpToolCall(toolCallEntry("sess_app_b"));
    assert.equal(seenA.length, 0, "App A 释放后其 emit 回落缺省，不再落 A sink");
    assert.equal(seenDefault.length, 1, "释放后 sess_app_a 回落进程级缺省");
    assert.equal(seenB.length, 1, "App A close 不得影响在跑 App B 的审计");
  } finally {
    setMcpCallAuditSink(undefined);
    unregisterA();
  }
});

test("CLI-04 残余：registerMcpTools 透传 sessionId，未覆盖写工具告警按会话路由", () => {
  const seenA = [];
  const unregisterA = registerMcpCallAuditSink("sess_reg_a", (event) => seenA.push(event));
  const seenDefault = [];
  setMcpCallAuditSink((event) => seenDefault.push(event));
  try {
    registerMcpTools(
      makeRegistry(),
      makePort(),
      [makeDescriptor({ serverName: "node_repl", toolName: "run_task", annotations: {} })],
      { allowedTools: ["mcp__node_repl__run_task"], sessionId: "sess_reg_a" },
    );
    const warnings = seenA.filter((event) => event.kind === "uncovered-write-tools");
    assert.equal(warnings.length, 1, "注册期告警按注册上下文 sessionId 路由到 App sink");
    assert.equal(warnings[0].sessionId, "sess_reg_a");
    assert.equal(
      seenDefault.filter((event) => event.kind === "uncovered-write-tools").length,
      0,
      "带 sessionId 的告警不回落进程级缺省",
    );
  } finally {
    setMcpCallAuditSink(undefined);
    unregisterA();
  }
});

