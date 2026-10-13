import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * node_repl CUA 桥的传输层不变量测试。
 *
 * 重写自上游 zai-org/ZCode（Apache-2.0, Copyright 2026 Z.AI Co., Ltd）的
 * apps/zcode-cli/packages/node-repl-host/test/cua-bridge.test.ts。
 * 上游用 vitest，本仓测试栈是 node:test，故为等价覆盖的独立重写而非逐字移植，
 * 不构成 Apache-2.0 意义上的派生复制（裁决记录见 docs/upgrades/product-and-support-2026-10.md §7.5 阶段 0）。
 * 覆盖 spec: docs/upgrades/product-and-support-2026-10.md §7.7 阶段 0 门槛。
 *
 * 被测对象是 apps/acode-cli/packages/node-repl-host/src/cua-bridge.ts（204 行），
 * 归它管的三条不变量：generation 防陈旧、subagent 拒绝、32 MiB 响应上限。
 * token 鉴权与 1 MiB 请求上限属 cua-broker.ts，由 cua-broker.test.mjs 覆盖；
 * 上游第 6 个用例（rejects a forged broker token）因此不在本文件，改由那套夹具承担。
 *
 * 导入路径说明（实测）：从 apps/acode-cli/tests/ 按名 import @acode/node-repl-host
 * 与 @acode/acode-cua 都是 ERR_MODULE_NOT_FOUND（apps/acode-cli/package.json 未声明这两个
 * 依赖），故一律用相对/深路径。
 */
const {
  createComputerUseBridgeGlobals,
  NODE_REPL_CUA_BRIDGE_SYMBOL,
  CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE,
} = await import("../packages/node-repl-host/src/cua-bridge.ts");
const { createNodeReplCuaBroker } = await import("../packages/node-repl-host/src/cua-broker.ts");
const { CUA_APP_ASSOCIATIONS_META_KEY } = await import(
  "../../../packages/acode-cua/host-display-contract.js"
);

/** 与 cua-bridge.ts:9 的私有常量同值；该常量未导出，测试内镜像一份用于构造超上限响应。 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DOCUMENTATION_ROOT = "/tmp/acode-cua-docs";
/** 夹具 broker 的 token；桥必须原样把它放到上线请求里。 */
const FIXTURE_TOKEN = "fixture-broker-token";
/**
 * Windows 命名管道前缀用字符串拼接构造，不写字面量 "\\\\.\\pipe\\"。
 * 反斜杠在多层转义（源码字符串 / shell heredoc）里极易被吞，实测踩过坑。
 */
const PIPE_PREFIX = "\\" + "\\" + "." + "\\" + "pipe" + "\\";
/** cua-bridge.ts:39 的稳定错误文本；按上游做法只断关键子串，不钉死整句措辞。 */
const STALE_MESSAGE_PATTERN = /runtime binding is stale/u;

const PRIMARY_APP = { appKey: "darwin:com.apple.notes", displayName: "Notes" };

/**
 * 自建 broker 夹具：按行读取桥写来的请求，交给 handler 决定回写什么。
 *
 * 用真实 broker（createNodeReplCuaBroker）时响应形态被 broker 自己钉死（只回
 * {id, ok, result}，见 cua-broker.ts:99），无法构造 responseMeta、代际中途失效、
 * 超上限单行响应这三类场景，所以这三类必须走自建 server。
 */
async function startBrokerFixture(handler) {
  const dir =
    process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "acode-cua-t4-"));
  const socketPath =
    process.platform === "win32"
      ? `${PIPE_PREFIX}acode-cua-t4-${randomUUID()}`
      : join(dir, `broker-${randomUUID()}.sock`);

  const sockets = new Set();
  const requests = [];
  let connections = 0;

  const server = createServer((sock) => {
    // 硬约束：桥命中 32 MiB 上限后会 socket.destroy()（cua-bridge.ts:164），服务端后续
    // write 立刻 EPIPE/ECONNRESET。未挂 error handler 时它会成为 uncaught exception
    // 直接终止整个测试进程，连断言输出都留不下（plan1 §4.6 实测教训）。
    sock.on("error", () => {});
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    connections += 1;

    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const payload = JSON.parse(line);
      requests.push(payload);
      const response = handler(payload, { requests });
      for (const part of response.chunks) sock.write(part);
      // 超上限用例刻意不 end()：要让桥在读到换行之前就先撞上字节上限。
      if (response.end !== false) sock.end();
    });
  });
  // 同理：server 侧也要吞掉 listen 之后的 socket 错误。
  server.on("error", () => {});

  const listening = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.listen(socketPath);
  try {
    await listening;
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    connection: { socketPath, token: FIXTURE_TOKEN },
    socketPath,
    requests,
    connectionCount: () => connections,
    close: async () => {
      // 先销毁残留连接，否则 server.close() 会一直等待半开的 socket。
      for (const sock of sockets) sock.destroy();
      sockets.clear();
      if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 真实 broker 用的假 runtime：ComputerUseRuntime 三个成员都要给（execute/closeSession/dispose）。 */
function makeFakeRuntime(execute) {
  return {
    execute,
    closeSession: async () => undefined,
    dispose: async () => undefined,
  };
}

/** 会话桩：桥只用 mergeResponseMeta 与 recordCuaAppIdentity 两个方法（cua-bridge.ts:71/:76）。 */
function makeSessionStub() {
  const recorded = [];
  const merged = [];
  return {
    recorded,
    merged,
    session: {
      mergeResponseMeta: (meta) => merged.push(meta),
      recordCuaAppIdentity: (app) => recorded.push(app),
    },
  };
}

/** 活动调用桩；用 holder 包装以便用例在中途把代际改陈旧。 */
function makeActiveCall(overrides = {}) {
  return {
    generation: 1,
    requestMeta: { runtime_scope: "main", session_id: "session-1", workspace_key: "ws" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeBridge({ broker, generation, active, stub }) {
  const globals = createComputerUseBridgeGlobals({
    ...(broker ? { broker } : {}),
    documentationRoot: DOCUMENTATION_ROOT,
    generation,
    getActiveCall: () => active.value,
    session: () => stub.session,
  });
  return { globals, bridge: globals[NODE_REPL_CUA_BRIDGE_SYMBOL] };
}

function okLine(payload, result, extra = {}) {
  return {
    chunks: [`${JSON.stringify({ id: payload.id, ok: true, result, ...extra })}\n`],
  };
}

function associationsResult(method, associations) {
  return {
    content: [{ type: "text", text: method }],
    ...(associations === undefined
      ? {}
      : { _meta: { [CUA_APP_ASSOCIATIONS_META_KEY]: associations } }),
  };
}

test("(1) 完整可信请求上下文透传到共享 runtime", async () => {
  const calls = [];
  // 必须传 platform: process.platform——不传时 broker 走 POSIX 分支建 tmpdir/*.sock，
  // 而 Windows 的 net.Server.listen 只接受命名管道，给文件路径直接 EACCES，
  // 于是这条用例在 Windows 上从来没跑过（上游注释记载的跨平台纪律）。
  const broker = createNodeReplCuaBroker({
    runtime: makeFakeRuntime(async (input) => {
      calls.push(input);
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { state_id: "state-1" },
      };
    }),
    platform: process.platform,
  });
  try {
    await broker.ready;
    const stub = makeSessionStub();
    const active = {
      value: makeActiveCall({
        generation: 3,
        requestMeta: {
          runtime_scope: "main",
          session_id: "session-1",
          workspace_path: "/workspace",
          workspace_identity: "ssh://host/workspace",
          workspace_key: "ssh://host/workspace",
          remote_session_id: "remote-1",
          turn_id: "turn-1",
          client_mode: "web-remote-replayable",
          delivery_kind: "web-remote-replayable",
          trace_id: "trace-1",
          span_id: "span-1",
        },
      }),
    };
    const { bridge } = makeBridge({
      broker: broker.connection,
      generation: active.value.generation,
      active,
      stub,
    });

    const result = await bridge.call("screenshot", { display_id: 1 });

    assert.deepEqual(result.structuredContent, { state_id: "state-1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, "screenshot");
    assert.deepEqual(calls[0].arguments, { display_id: 1 });
    assert.ok(calls[0].signal instanceof AbortSignal, "runtime 必须收到可取消的 signal");
    // deepEqual 对键集合是精确的：多一个键或少一个键都会失败。
    assert.deepEqual(calls[0].context, {
      runtimeScope: "main",
      sessionId: "session-1",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      workspaceKey: "ssh://host/workspace",
      remoteSessionId: "remote-1",
      turnId: "turn-1",
      clientMode: "web-remote-replayable",
      deliveryKind: "web-remote-replayable",
      trace: { traceId: "trace-1", spanId: "span-1" },
    });
    // broker 不回 responseMeta（cua-broker.ts:99 只写 {id,ok,result}），故此处必须为空。
    assert.deepEqual(stub.merged, []);
    assert.deepEqual(stub.recorded, []);
  } finally {
    await broker.close();
  }
});

test("(2) 上线 context 由桥自身构造：trim、回落链与默认值", async () => {
  const fixture = await startBrokerFixture((payload) =>
    okLine(payload, { content: [{ type: "text", text: "ok" }] }, {
      responseMeta: { "acode/toolSurface": { stateId: "state-9" } },
    }),
  );
  try {
    const stub = makeSessionStub();
    const active = { value: makeActiveCall() };
    const { bridge } = makeBridge({
      broker: fixture.connection,
      generation: 1,
      active,
      stub,
    });

    // 第一发：session_id/workspace_path 带空白需 trim；workspace_identity 全空白等于缺失，
    // 于是 workspace_key 回落到 workspacePath；client_mode 缺失走 desktop-continuous 默认，
    // delivery_kind 缺失等于 clientMode；remote_session_id 非字符串不上线；
    // 无 trace_id 时即使有 parent_span_id 也整体不产生 trace 键。
    active.value = makeActiveCall({
      requestMeta: {
        runtime_scope: "main",
        session_id: "  session-2  ",
        workspace_path: " /workspace ",
        workspace_identity: "   ",
        remote_session_id: 42,
        turn_id: "turn-2",
        parent_span_id: "orphan-span",
      },
    });
    await bridge.call("screenshot", { display_id: 2 });

    assert.equal(fixture.requests.length, 1);
    const wire = fixture.requests[0];
    assert.equal(typeof wire.id, "string", "桥必须为每次调用生成请求 id");
    assert.equal(wire.token, FIXTURE_TOKEN, "token 必须原样上线，由 broker 侧鉴权");
    assert.equal(wire.method, "screenshot");
    assert.deepEqual(wire.input, { display_id: 2 });
    assert.deepEqual(wire.context, {
      runtimeScope: "main",
      sessionId: "session-2",
      workspacePath: "/workspace",
      workspaceKey: "/workspace",
      turnId: "turn-2",
      clientMode: "desktop-continuous",
      deliveryKind: "desktop-continuous",
    });
    // responseMeta 由桥合并回会话（cua-bridge.ts:71），真实 broker 不透传，只有自建夹具能验。
    assert.deepEqual(stub.merged, [{ "acode/toolSurface": { stateId: "state-9" } }]);

    // 第二发：workspace_key 缺失但 workspace_identity 有效时回落到 identity，
    // 且 web-remote-replayable 的 client_mode 会带出同名 delivery_kind。
    active.value = makeActiveCall({
      requestMeta: {
        runtime_scope: "main",
        session_id: "session-3",
        workspace_identity: "ssh://host/other",
        client_mode: "web-remote-replayable",
        trace_id: "trace-3",
      },
    });
    await bridge.call("list_apps", {});

    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(fixture.requests[1].context, {
      runtimeScope: "main",
      sessionId: "session-3",
      workspaceIdentity: "ssh://host/other",
      workspaceKey: "ssh://host/other",
      clientMode: "web-remote-replayable",
      deliveryKind: "web-remote-replayable",
      trace: { traceId: "trace-3" },
    });

    // runtime_scope 非 "subagent" 的任何取值都归一化成 "main"（cua-bridge.ts:125）。
    active.value = makeActiveCall({
      requestMeta: { runtime_scope: "weird-scope", session_id: "session-4", workspace_key: "ws" },
    });
    await bridge.call("list_apps", {});
    assert.equal(fixture.requests[2].context.runtimeScope, "main");

    // session_id 缺失或全空白时桥在开 socket 之前就拒绝（cua-bridge.ts:117）。
    active.value = makeActiveCall({ requestMeta: { runtime_scope: "main", workspace_key: "ws" } });
    await assert.rejects(bridge.call("list_apps", {}), /missing session_id metadata/u);
    // workspaceKey 三处回落全空时同样在开 socket 之前拒绝（cua-bridge.ts:121）。
    active.value = makeActiveCall({ requestMeta: { runtime_scope: "main", session_id: "s" } });
    await assert.rejects(bridge.call("list_apps", {}), /missing workspaceKey metadata/u);
    assert.equal(fixture.requests.length, 3, "两条元数据缺失的调用不得触达 broker");
  } finally {
    await fixture.close();
  }
});

test("(3) app 身份只从 broker 响应 _meta 取，sandbox 侧没有身份写入口", async () => {
  const inlineIcon = { mimeType: "image/png", data: "iVBORw0KGgo=" };
  const fixture = await startBrokerFixture((payload) =>
    okLine(payload, {
      content: [{ type: "text", text: "clicked" }],
      _meta: {
        [CUA_APP_ASSOCIATIONS_META_KEY]: {
          schemaVersion: 1,
          primary: { appKey: " darwin:com.apple.notes ", displayName: "  Notes  ", icon: inlineIcon },
        },
      },
    }),
  );
  try {
    const stub = makeSessionStub();
    const active = { value: makeActiveCall() };
    const { globals, bridge } = makeBridge({
      broker: fixture.connection,
      generation: 1,
      active,
      stub,
    });

    const result = await bridge.call("left_click", { app_ref: { pid: 1 } });

    // 身份取自 broker 响应这一跳——模型看不见也改不了；appKey/displayName 都要 trim，
    // 内联 icon PNG 刻意不落（会话协议不承载图标字节，UI 按 appKey 派生 locator）。
    assert.deepEqual(stub.recorded, [
      { appKey: "darwin:com.apple.notes", displayName: "Notes" },
    ]);
    // 返回值仍原样带 _meta 交给上层投影，桥只读不删。
    assert.deepEqual(result._meta[CUA_APP_ASSOCIATIONS_META_KEY].primary.icon, inlineIcon);

    // 「不是从 sandbox 代码取」的另一半证据：注入给 cell 的 globals 只有桥本身，
    // recordCuaAppIdentity / mergeResponseMeta 都不在其中，模型无法自称操作了别的应用。
    assert.deepEqual(Object.getOwnPropertySymbols(globals), [NODE_REPL_CUA_BRIDGE_SYMBOL]);
    assert.deepEqual(Object.keys(globals), []);
    assert.deepEqual(Object.keys(bridge).sort(), ["assertAvailable", "call", "documentationRoot"]);
    assert.equal(bridge.documentationRoot, DOCUMENTATION_ROOT);
  } finally {
    await fixture.close();
  }
});

test("(4) 无 primary 的 items/none 模式不覆盖同一 cell 已确立的身份", async () => {
  const fixture = await startBrokerFixture((payload) => {
    // list_apps 声明 items 模式（按结果下标关联），request_access / stop_computer_control
    // 声明 none；三者都不该覆盖前面 left_click 已经确立的身份。
    const associations =
      payload.method === "left_click"
        ? { schemaVersion: 1, primary: PRIMARY_APP }
        : payload.method === "list_apps"
          ? {
              schemaVersion: 1,
              items: [{ resultIndex: 0, application: { appKey: "darwin:com.apple.finder" } }],
            }
          : { schemaVersion: 1 };
    return okLine(payload, associationsResult(payload.method, associations));
  });
  try {
    const stub = makeSessionStub();
    const active = { value: makeActiveCall() };
    const { bridge } = makeBridge({
      broker: fixture.connection,
      generation: 1,
      active,
      stub,
    });

    await bridge.call("left_click", { x: 1, y: 2 });
    assert.deepEqual(stub.recorded, [PRIMARY_APP], "primary 模式确立身份");

    const listResult = await bridge.call("list_apps", {});
    assert.equal(listResult.content[0].text, "list_apps", "items 调用本身必须成功返回");
    assert.deepEqual(stub.recorded, [PRIMARY_APP], "items 模式不得覆盖已确立身份");

    const accessResult = await bridge.call("request_access", {});
    assert.equal(accessResult.content[0].text, "request_access");
    assert.deepEqual(stub.recorded, [PRIMARY_APP], "none 模式不得覆盖已确立身份");

    assert.equal(fixture.requests.length, 3);
  } finally {
    await fixture.close();
  }
});

test("(5) subagent 在开 broker 之前被拒", async () => {
  const fixture = await startBrokerFixture((payload) =>
    okLine(payload, { content: [{ type: "text", text: "should not run" }] }),
  );
  try {
    const stub = makeSessionStub();
    const active = {
      value: makeActiveCall({
        requestMeta: { runtime_scope: "subagent", session_id: "subagent-1", workspace_key: "ws" },
      }),
    };
    // 关键：这里**给了**一个可用的 broker 连接，才能证明拒绝发生在开 socket 之前，
    // 而不是因为「没配 broker」而顺带失败（上游用例不传 broker，区分不出这两者）。
    const { bridge } = makeBridge({
      broker: fixture.connection,
      generation: 1,
      active,
      stub,
    });

    assert.throws(bridge.assertAvailable, { message: CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE });
    await assert.rejects(bridge.call("screenshot", {}), {
      message: CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE,
    });

    assert.equal(fixture.connectionCount(), 0, "subagent 拒绝必须早于任何 socket 连接");
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(stub.recorded, []);
    assert.deepEqual(stub.merged, []);
  } finally {
    await fixture.close();
  }
});

test("(6) worker generation 变更后 fail closed（前置检查）", async () => {
  const fixture = await startBrokerFixture((payload) =>
    okLine(payload, { content: [{ type: "text", text: "should not run" }] }),
  );
  try {
    const stub = makeSessionStub();
    // 桥捕获的 generation 比当前活动调用新：kernel reset 后旧绑定必须整体失效。
    const active = { value: makeActiveCall({ generation: 1 }) };
    const { bridge } = makeBridge({
      broker: fixture.connection,
      generation: 2,
      active,
      stub,
    });

    assert.throws(bridge.assertAvailable, STALE_MESSAGE_PATTERN);
    await assert.rejects(bridge.call("screenshot", {}), STALE_MESSAGE_PATTERN);
    assert.equal(fixture.connectionCount(), 0, "陈旧绑定不得开 socket");
    assert.equal(fixture.requests.length, 0);

    // 没有活动调用（cell 已结束）与代际不符是同一条 fail-closed 路径。
    active.value = undefined;
    assert.throws(bridge.assertAvailable, STALE_MESSAGE_PATTERN);
    await assert.rejects(bridge.call("screenshot", {}), STALE_MESSAGE_PATTERN);
    assert.equal(fixture.connectionCount(), 0);
  } finally {
    await fixture.close();
  }
});

test("(7) 响应到达后代际已变 → 仍 fail closed，身份与 meta 都不落", async () => {
  let holder;
  const fixture = await startBrokerFixture((payload) => {
    // 在写响应之前把活动调用抽走：模拟 worker 在 broker 往返期间被 reset。
    // 桥必须在拿到 ok 响应之后**再复检一次**代际（cua-bridge.ts:70），否则会把
    // 上一代的结果与 app 身份写进新会话。
    holder.value = undefined;
    return okLine(
      payload,
      associationsResult(payload.method, { schemaVersion: 1, primary: PRIMARY_APP }),
      { responseMeta: { "acode/toolSurface": { stateId: "stale" } } },
    );
  });
  try {
    const stub = makeSessionStub();
    holder = { value: makeActiveCall({ generation: 1 }) };
    const { bridge } = makeBridge({
      broker: fixture.connection,
      generation: 1,
      active: holder,
      stub,
    });

    await assert.rejects(bridge.call("left_click", {}), STALE_MESSAGE_PATTERN);

    assert.equal(fixture.requests.length, 1, "请求确实上过线，拒绝发生在响应之后");
    assert.deepEqual(stub.recorded, [], "陈旧代际不得记录 app 身份");
    assert.deepEqual(stub.merged, [], "陈旧代际不得合并 responseMeta");
  } finally {
    await fixture.close();
  }
});

test("(8) 响应超 32 MiB 上限被拒", async () => {
  const FILLER_CHUNK_BYTES = 8 * 1024 * 1024;
  const FILLER_CHUNKS = 5; // 40 MiB > MAX_RESPONSE_BYTES
  const filler = Buffer.alloc(FILLER_CHUNK_BYTES, 0x41);
  assert.ok(
    FILLER_CHUNK_BYTES * FILLER_CHUNKS > MAX_RESPONSE_BYTES,
    "夹具响应必须真的超过 32 MiB 上限",
  );

  const fixture = await startBrokerFixture((payload) => {
    const head = `{"id":${JSON.stringify(payload.id)},"ok":true,"result":{"content":[{"type":"text","text":"`;
    const tail = '"}]}}\n';
    // 单行响应：整条 JSON 直到最后才有换行，桥必须在解析之前就撞上字节上限。
    const chunks = [head];
    for (let index = 0; index < FILLER_CHUNKS; index += 1) chunks.push(filler);
    chunks.push(tail);
    return { chunks, end: false };
  });
  try {
    const stub = makeSessionStub();
    const active = { value: makeActiveCall() };
    const { bridge } = makeBridge({
      broker: fixture.connection,
      generation: 1,
      active,
      stub,
    });

    await assert.rejects(bridge.call("screenshot", {}), /exceeded the 32 MiB limit/u);

    assert.equal(fixture.requests.length, 1, "请求已上线，拒绝发生在响应读取阶段");
    assert.deepEqual(stub.recorded, []);
    assert.deepEqual(stub.merged, []);
  } finally {
    await fixture.close();
  }
});
