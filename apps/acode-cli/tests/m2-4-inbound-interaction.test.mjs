import assert from "node:assert/strict";
import test from "node:test";

/**
 * M2-4 inbound 交互面双形态测试（apps/acode-cli/specs/m2-4-inbound-interaction.md §5 C 节）。
 * 钉住：race wrapper（v4 应答命中 / legacy 响应先行 / 外层 abort 原样上抛 / 晚到 resolve noop）、
 * permission broker 双形态（v4 命中 / -32601 回落同形参数 / 非 -32601 不回落 / 未知 optionId deny /
 * legacy deny 缺 reason 回填）、真 server 上的 announce+ack hold 生命周期（ack 后不占
 * pendingClientRequests、shutdown 计数不变）与 hostV4InboundEstablished 置位/复位/门控、
 * CUA 通知形态门控、providerRuntimeHeaders 取消通知形态绑定（= 触发请求形态）。
 */
const { raceClientRequestWithV4Interaction } = await import(
  "../packages/bootstrap/src/acode-protocol/interaction-response-race.ts"
);
const { createProtocolInteractionBroker } = await import(
  "../packages/bootstrap/src/acode-protocol/interaction-broker.ts"
);
const { createProviderRuntimeHeadersPort } = await import(
  "../packages/bootstrap/src/acode-protocol/provider-runtime-headers.ts"
);
const { ProtocolRequestError } = await import(
  "../packages/bootstrap/src/acode-protocol/server-types.ts"
);
const { V4InteractionRegistry } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/interaction-registry.ts"
);
const { ACodeProtocolAgentServer } = await import(
  "../packages/bootstrap/src/acode-protocol/server.ts"
);
const { onSessionEvent } = await import(
  "../packages/bootstrap/src/acode-protocol/server-operations.ts"
);
const { SessionEventType } = await import(
  "../packages/contracts/src/events/session-event-type.ts"
);
const { PERMISSION_DENIED_BY_USER_CONTENT } = await import(
  "../packages/bootstrap/src/permission-options.ts"
);

const methodNotFound = (method) =>
  new ProtocolRequestError(-32601, `Unsupported ACode Protocol request: ${method}`);

/** 按脚本顺序消费 requestClient 调用；记录每次调用的方法名与参数对象引用。 */
function makeContext(script, extra = {}) {
  const calls = [];
  return {
    calls,
    context: {
      v4Interactions: new V4InteractionRegistry(),
      sessions: new Map(),
      logger: undefined,
      notify: () => {},
      hostV4InboundEstablished: false,
      deps: {},
      ...extra,
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

const PERMISSION_REQUEST = {
  requestId: "perm-1",
  sessionId: "s1",
  toolName: "Bash",
  toolCallId: "tc-1",
  turnId: "t1",
  input: { command: "ls" },
  reason: "运行 ls",
  riskLevel: "medium",
};

// ── 1. race wrapper 接缝 ─────────────────────────────────────────────────────

test("race wrapper: v4 应答先达 → abort 级联 → mapAnswer 收口", async () => {
  const { context } = makeContext([]);
  const registry = context.v4Interactions;
  const pending = raceClientRequestWithV4Interaction(
    context,
    "race-1",
    undefined,
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new ProtocolRequestError(-32021, "Client request cancelled"));
        });
      }),
    (answer) => ({ mapped: answer.optionId }),
    { sessionId: "s1", kind: "other" },
  );
  // v4 应答先达：registry resolve → v4Answer 置位 + abort 级联 → hold/startRequest 收口。
  assert.equal(registry.resolve("race-1", { optionId: "allowOnce" }), true);
  const result = await pending;
  assert.deepEqual(result, { mapped: "allowOnce" });
  // 已在 finally 注销：晚到 resolve noop。
  assert.equal(registry.has("race-1"), false);
});

test("race wrapper: legacy 响应先行 → 原样返回（v4 未命中）", async () => {
  const { context } = makeContext([]);
  const result = await raceClientRequestWithV4Interaction(
    context,
    "race-2",
    undefined,
    () => Promise.resolve("legacy"),
    (answer) => ({ mapped: answer.optionId }),
    { sessionId: "s1", kind: "other" },
  );
  assert.equal(result, "legacy");
});

test("race wrapper: 外层 abort（无 v4 应答）→ 取消错误原样上抛，同一实例", async () => {
  const { context } = makeContext([]);
  const outer = new AbortController();
  const marker = new Error("outer-cancel");
  const pending = raceClientRequestWithV4Interaction(
    context,
    "race-3",
    outer.signal,
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(marker));
      }),
    () => "mapped",
    { sessionId: "s1", kind: "other" },
  );
  outer.abort();
  await assert.rejects(pending, (error) => error === marker);
});

test("race wrapper: 收口后晚到的 v4 resolve → false（registry 已注销）", async () => {
  const { context } = makeContext([]);
  const registry = context.v4Interactions;
  await raceClientRequestWithV4Interaction(
    context,
    "race-4",
    undefined,
    () => Promise.resolve("legacy"),
    () => "mapped",
    { sessionId: "s1", kind: "other" },
  );
  assert.equal(registry.resolve("race-4", { optionId: "allowOnce" }), false);
});

// ── 2. permission broker 双形态 ──────────────────────────────────────────────

test("broker: v4 announce 命中 → hold 等 registry 应答 → allow", async () => {
  const { context, calls } = makeContext([
    { method: "v4/interaction/requestPermission", result: {} },
  ]);
  const broker = createProtocolInteractionBroker(context);
  const pending = broker.requestPermission(PERMISSION_REQUEST);
  // announce 是同步消费脚本的第一步；ack 后 broker 挂在 registry 上。
  assert.equal(calls.length, 1);
  assert.equal(context.v4Interactions.resolve(PERMISSION_REQUEST.requestId, { optionId: "allowOnce" }), true);
  const result = await pending;
  assert.equal(result.decision, "allow");
  assert.equal(result.reason, "Approved once");
  assert.ok(result.resolvedAt instanceof Date);
  assert.equal(calls.length, 1, "v4 命中不得再发 legacy");
});

test("broker: -32601 回落 legacy，params 逐字同形（同一对象引用）", async () => {
  const { context, calls } = makeContext([
    {
      method: "v4/interaction/requestPermission",
      error: methodNotFound("v4/interaction/requestPermission"),
    },
    {
      method: "interaction/requestPermission",
      result: { decision: "allow", reason: "ok" },
    },
  ]);
  const broker = createProtocolInteractionBroker(context);
  const result = await broker.requestPermission(PERMISSION_REQUEST);
  assert.equal(result.decision, "allow");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params, calls[0].params, "回落只换方法名，不换载荷");
});

test("broker: 非 -32601 错误不回落，原样上抛", async () => {
  const { context, calls } = makeContext([
    {
      method: "v4/interaction/requestPermission",
      error: new ProtocolRequestError(-32000, "boom"),
    },
  ]);
  const broker = createProtocolInteractionBroker(context);
  await assert.rejects(
    broker.requestPermission(PERMISSION_REQUEST),
    (error) => error instanceof ProtocolRequestError && error.code === -32000,
  );
  assert.equal(calls.length, 1);
});

test("broker: 未知 optionId → deny 兜底（权限语义宁可拒绝）", async () => {
  const { context } = makeContext([
    { method: "v4/interaction/requestPermission", result: {} },
  ]);
  const broker = createProtocolInteractionBroker(context);
  const pending = broker.requestPermission(PERMISSION_REQUEST);
  context.v4Interactions.resolve(PERMISSION_REQUEST.requestId, { optionId: "bogus" });
  const result = await pending;
  assert.equal(result.decision, "deny");
  assert.ok(result.reason.length > 0);
});

test("broker: legacy deny 缺 reason → 回填 PERMISSION_DENIED_BY_USER_CONTENT", async () => {
  const { context } = makeContext([
    {
      method: "v4/interaction/requestPermission",
      error: methodNotFound("v4/interaction/requestPermission"),
    },
    { method: "interaction/requestPermission", result: { decision: "deny" } },
  ]);
  const broker = createProtocolInteractionBroker(context);
  const result = await broker.requestPermission(PERMISSION_REQUEST);
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, PERMISSION_DENIED_BY_USER_CONTENT);
});

// ── 3. 真 server：announce+ack hold 生命周期 + established flag ──────────────

/**
 * 构造最小真 server（createACodeApp 永不被调——本组测试不创建 session）。
 * setNotificationSink 必须在首个 requestClient 前调用，否则 sink 缺失抛 -32020。
 */
async function makeServer() {
  const server = new ACodeProtocolAgentServer({
    createACodeApp: async () => {
      throw new Error("unused in m2-4 host-flag tests");
    },
    env: {},
  });
  const outbound = [];
  server.setNotificationSink((message) => {
    outbound.push(message);
  });
  return { server, outbound };
}

/** 模拟 host 回一条 JSON-RPC response（result / error 二选一）。 */
function replyTo(server, id, outcome) {
  return server.handleMessage(
    outcome.error
      ? { jsonrpc: "2.0", id, error: outcome.error }
      : { jsonrpc: "2.0", id, result: outcome.result ?? {} },
  );
}

test("server: v4/interaction/* 成功响应置位 established flag（legacy 方法不置位）", async () => {
  const { server, outbound } = await makeServer();
  try {
    const ctx = server.officialMcpAuthRequestContext;
    assert.equal(ctx.hostV4InboundEstablished, false);

    // v4 请求成功 → 置位。
    const v4Promise = ctx.requestClient("v4/interaction/requestPermission", {}, { parse: (raw) => raw });
    const announce = outbound.at(-1);
    await replyTo(server, announce.id, {});
    await v4Promise;
    assert.equal(ctx.hostV4InboundEstablished, true);

    // 复位：setNotificationSink 是连接重附着点——复位证据位的同时也换了出网通道，
    // 后续请求必须由新 sink 记录，否则回复无从投递。
    const reconnected = [];
    server.setNotificationSink((message) => reconnected.push(message));
    assert.equal(ctx.hostV4InboundEstablished, false);

    // legacy 方法成功不置位（旧 host 也能服务 legacy，不构成 v4 证据）。
    const legacyPromise = ctx.requestClient("interaction/requestPermission", {}, { parse: (raw) => raw });
    await replyTo(server, reconnected.at(-1).id, { decision: "allow", reason: "ok" });
    await legacyPromise;
    assert.equal(ctx.hostV4InboundEstablished, false);
  } finally {
    await server.shutdown();
  }
});

test("server: v4 请求错误响应不置位（-32000 拒绝 → ProtocolRequestError）", async () => {
  const { server, outbound } = await makeServer();
  try {
    const ctx = server.officialMcpAuthRequestContext;
    const failing = ctx
      .requestClient("v4/interaction/requestPermission", {}, { parse: (raw) => raw })
      .catch((error) => error);
    await replyTo(server, outbound.at(-1).id, { error: { code: -32000, message: "boom" } });
    const error = await failing;
    assert.ok(error instanceof ProtocolRequestError);
    assert.equal(error.code, -32000);
    assert.equal(ctx.hostV4InboundEstablished, false);
  } finally {
    await server.shutdown();
  }
});

test("server: broker 经真 server —— ack 后 hold 不占 pendingClientRequests，registry 应答收口", async () => {
  const { server, outbound } = await makeServer();
  try {
    const ctx = server.officialMcpAuthRequestContext;
    const broker = createProtocolInteractionBroker(ctx);
    const pending = broker.requestPermission({
      ...PERMISSION_REQUEST,
      requestId: "perm-server-1",
    });

    // announce 已出网（server-1）：此刻占一条 pending。
    assert.equal(server.pendingClientRequests.size, 1);
    await replyTo(server, outbound.at(-1).id, {}); // host immediate ack

    // hold promise 只活在 broker 闭包内，不登记假条目——shutdown 计数不变。
    assert.equal(server.pendingClientRequests.size, 0);
    // v4 应答（resolveInteraction 语义）→ allow 收口。
    assert.equal(ctx.v4Interactions.resolve("perm-server-1", { optionId: "allowOnce" }), true);
    const result = await pending;
    assert.equal(result.decision, "allow");
    assert.equal(server.pendingClientRequests.size, 0);
  } finally {
    await server.shutdown();
  }
});

// ── 4. CUA 通知形态门控（onSessionEvent）──────────────────────────────────────

const turnStartedEvent = () => ({
  id: "e1",
  sequenceNumber: 1,
  sessionId: "s1",
  timestamp: new Date(1_735_000_000_000),
  turnId: "t1",
  type: SessionEventType.TurnStarted,
  payload: {},
  traceId: "tr1",
});

function makeNotifyContext(hostV4InboundEstablished) {
  const notifications = [];
  const context = {
    notify: (message) => {
      notifications.push(message);
    },
    hostV4InboundEstablished,
    logger: undefined,
    sessions: new Map(),
    v4Gateway: undefined,
  };
  const record = { app: { sessionId: "s1" }, persistence: "immediate", updatedAt: 0 };
  return { notifications, context, record };
}

test("onSessionEvent: flag false → legacy 形态（旧 host 唯一可消费形态）", async () => {
  const { notifications, context, record } = makeNotifyContext(false);
  await onSessionEvent(context, record, turnStartedEvent());
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "computer-use/operation-event");
});

test("onSessionEvent: flag true → v4 形态，params 与 legacy 逐字同构", async () => {
  const legacy = makeNotifyContext(false);
  await onSessionEvent(legacy.context, legacy.record, turnStartedEvent());
  const v4 = makeNotifyContext(true);
  await onSessionEvent(v4.context, v4.record, turnStartedEvent());

  assert.equal(v4.notifications[0].method, "v4/cua/operationEvent");
  assert.deepEqual(v4.notifications[0].params, legacy.notifications[0].params);
  assert.equal(v4.notifications[0].params.kind, "turn-started");
  assert.equal(v4.notifications[0].params.timestamp, 1_735_000_000_000);
});

// ── 5. providerRuntimeHeaders 端口 + 取消通知形态绑定 ─────────────────────────

const WORKSPACE = { workspaceKey: "w1", workspacePath: "/w" };
const HEADERS_INPUT = {
  sessionId: "s1",
  turnId: "t1",
  providerId: "p1",
  modelId: "m1",
  reason: "account-refresh",
  traceContext: {},
};

const HEADERS_OK = { headersApplied: true };
const TIMED_OUT = () => new ProtocolRequestError(-32022, "timeout");

test("headers port: v4 命中 → 一次调用直通", async () => {
  const { context, calls } = makeContext(
    [{ method: "v4/interaction/requestProviderRuntimeHeaders", result: HEADERS_OK }],
    { notify: () => {} },
  );
  const port = createProviderRuntimeHeadersPort(context, WORKSPACE);
  const result = await port.refreshBeforeModelRequest(HEADERS_INPUT);
  assert.deepEqual(result, HEADERS_OK);
  assert.equal(calls.length, 1);
});

test("headers port: -32601 回落 legacy，params 同一对象引用", async () => {
  const { context, calls } = makeContext(
    [
      {
        method: "v4/interaction/requestProviderRuntimeHeaders",
        error: methodNotFound("v4/interaction/requestProviderRuntimeHeaders"),
      },
      { method: "interaction/requestProviderRuntimeHeaders", result: HEADERS_OK },
    ],
    { notify: () => {} },
  );
  const port = createProviderRuntimeHeadersPort(context, WORKSPACE);
  await port.refreshBeforeModelRequest(HEADERS_INPUT);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params, calls[0].params);
});

test("headers port: v4 请求超时 → v4 形态取消通知 + -32022 重抛（cause 保留）", async () => {
  const notifications = [];
  const original = TIMED_OUT();
  const { context } = makeContext(
    [{ method: "v4/interaction/requestProviderRuntimeHeaders", error: original }],
    { notify: (message) => notifications.push(message) },
  );
  const port = createProviderRuntimeHeadersPort(context, WORKSPACE);
  const error = await port.refreshBeforeModelRequest(HEADERS_INPUT).catch((e) => e);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "v4/interaction/providerRuntimeHeadersCancelled");
  assert.ok(String(notifications[0].params.requestId).startsWith("s1:provider-runtime-headers:"));
  assert.ok(error instanceof ProtocolRequestError);
  assert.equal(error.code, -32022);
  assert.match(error.message, /timed out/);
  assert.equal(error.cause, original);
});

test("headers port: legacy 回落后超时 → 取消通知发 legacy 形态（形态绑定 = 触发请求）", async () => {
  const notifications = [];
  const { context } = makeContext(
    [
      {
        method: "v4/interaction/requestProviderRuntimeHeaders",
        error: methodNotFound("v4/interaction/requestProviderRuntimeHeaders"),
      },
      { method: "interaction/requestProviderRuntimeHeaders", error: TIMED_OUT() },
    ],
    { notify: (message) => notifications.push(message) },
  );
  const port = createProviderRuntimeHeadersPort(context, WORKSPACE);
  await port.refreshBeforeModelRequest(HEADERS_INPUT).catch(() => {});
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "interaction/providerRuntimeHeadersCancelled");
});

test("headers port: 外层 abort → v4 取消通知 + 原取消错误上抛", async () => {
  const notifications = [];
  const { context } = makeContext(
    [
      {
        method: "v4/interaction/requestProviderRuntimeHeaders",
        error: new ProtocolRequestError(-32021, "cancelled"),
      },
    ],
    { notify: (message) => notifications.push(message) },
  );
  const port = createProviderRuntimeHeadersPort(context, WORKSPACE);
  const controller = new AbortController();
  controller.abort();
  const error = await port
    .refreshBeforeModelRequest({ ...HEADERS_INPUT, abortSignal: controller.signal })
    .catch((e) => e);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "v4/interaction/providerRuntimeHeadersCancelled");
  assert.ok(error instanceof ProtocolRequestError);
  assert.equal(error.code, -32021);
});

test("headers port: headersApplied=false → -32031（errorMessage 透传）", async () => {
  const { context } = makeContext(
    [
      {
        method: "v4/interaction/requestProviderRuntimeHeaders",
        result: { headersApplied: false, errorMessage: "creds missing" },
      },
    ],
    { notify: () => {} },
  );
  const port = createProviderRuntimeHeadersPort(context, WORKSPACE);
  await assert.rejects(
    port.refreshBeforeModelRequest(HEADERS_INPUT),
    (error) => error instanceof ProtocolRequestError && error.code === -32031 && /creds missing/.test(error.message),
  );
});
