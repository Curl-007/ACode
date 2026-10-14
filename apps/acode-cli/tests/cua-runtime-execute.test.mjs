/**
 * index.js createComputerUseRuntime（角色 B 增量 3）测试——链路乙 execute 的 SDK-facing 结果契约。
 *
 * 覆盖 wire spec §5（CUA_NOT_READY 信封与 warming-up 翻译，openQuestion #1 裁决为方案 b：
 * 链路乙发 broker_unavailable 传输错误、由 execute 归一为非-error 信封）与 §4（应用层失败
 * 必须以 isError 结果携带 broker code，因为链路甲 cua-broker.ts:103 会把 execute 的抛错降成
 * 丢码的 error 字符串，而 SDK 的 brokerErrorCodeOf 只从 result 对象读码）。
 *
 * 测试两端都在本文件内（fixture 起链路乙服务端），故不依赖角色 A 的真实 Helper——
 * 验证的是「execute 对已裁决契约的遵守」，非对不存在 Helper 的猜测。
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";

import { createComputerUseRuntime } from "../../../packages/acode-cua/index.js";
import { mintBrokerSocketPath } from "../../../packages/acode-cua/broker.js";

/** 起链路乙服务端夹具；onRequest(request) 返回 { respond } 或 { hold } 或 { raw }。 */
async function startBrokerFixture(onRequest) {
  const socketPath = mintBrokerSocketPath();
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        request = undefined;
      }
      const decision = onRequest(request);
      if (decision.hold) return;
      // 读完请求行后直接断开：请求已写出但拿不到收据 = 传输层歧义（possiblySent=true），
      // 用于瞬时触发 possibly_sent 分支，不必等满超时预算。
      if (decision.destroyAfterRequest) {
        socket.destroy();
        return;
      }
      if (typeof decision.raw === "string") {
        socket.write(decision.raw);
        socket.end();
        return;
      }
      socket.write(`${JSON.stringify(decision.respond)}\n`);
      socket.end();
    });
  });
  server.on("error", () => {});
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(socketPath);
  });
  return {
    socketPath,
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 取单文本块结果的解析 JSON（模拟 SDK unwrapEnvelope / notReadyEnvelopeOf 的读取方式）。 */
function parsedText(result) {
  assert.ok(Array.isArray(result?.content), "结果必须有 content 数组（CallToolResult 形态）");
  const textBlocks = result.content.filter((b) => b?.type === "text" && typeof b.text === "string");
  assert.equal(textBlocks.length, 1, "本测试的路径都应是单文本块");
  return JSON.parse(textBlocks[0].text);
}

const CTX = { sessionId: "s1", runtimeScope: "main", workspaceKey: "wk" };

// ─────────────────────────────────────────────────────────────────────────────
// 组 1：无 socketPath → 保持占位的 fail-closed unavailable 语义
// ─────────────────────────────────────────────────────────────────────────────

test("execute：未配置 brokerSocketPath → isError 结果（不抛、不假成功）", async () => {
  const rt = createComputerUseRuntime({});
  const result = await rt.execute({ toolName: "list_apps", context: CTX });
  assert.equal(result.isError, true, "必须 isError（fail-closed）");
  const payload = parsedText(result);
  assert.equal(payload.code, "internal", "无 code 时 SDK 会归 INTERNAL——与占位的可观测映射一致");
  assert.match(payload.error.message, /not available in this build/u, "保留占位的不可用文案");
});

test("execute：未配置 socketPath 时也不抛错（抛会被链路甲降成丢码字符串）", async () => {
  const rt = createComputerUseRuntime();
  await assert.doesNotReject(rt.execute({ toolName: "get_app_state", context: CTX }));
});

test("execute：缺 toolName → isError + invalid_request（不发起连接）", async () => {
  const rt = createComputerUseRuntime({ brokerSocketPath: mintBrokerSocketPath() });
  const result = await rt.execute({ context: CTX });
  assert.equal(result.isError, true);
  assert.equal(parsedText(result).code, "invalid_request");
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 2：成功路径——原样返回 Helper 的 CallToolResult（不改写形态）
// ─────────────────────────────────────────────────────────────────────────────

test("execute：ok:true → 原样返回 result（含 content/structuredContent/_meta 不被改写）", async () => {
  const helperResult = {
    content: [{ type: "text", text: "app: com.example pid=123 \"Example\"" }],
    structuredContent: { state_id: "st-1", app: { bundle_id: "com.example" } },
    _meta: { "acode.cua/app-associations-v1": { primary: { appKey: "com.example" } } },
  };
  const fx = await startBrokerFixture((req) => {
    assert.equal(req.method, "get_app_state", "execute 把 toolName 作为链路乙 method 发出");
    return { respond: { ok: true, result: helperResult } };
  });
  try {
    const rt = createComputerUseRuntime({ brokerSocketPath: fx.socketPath });
    const got = await rt.execute({ toolName: "get_app_state", arguments: { app: "x" }, context: CTX });
    assert.deepEqual(got, helperResult, "成功结果必须原样透传（SDK unwrapEnvelope 依赖其形态）");
    assert.equal(got.isError, undefined, "成功结果不得带 isError");
  } finally {
    await fx.close();
  }
});

test("execute：arguments 作为 params 透传到链路乙", async () => {
  let seenParams;
  const fx = await startBrokerFixture((req) => {
    seenParams = req.params;
    return { respond: { ok: true, result: { content: [] } } };
  });
  try {
    const rt = createComputerUseRuntime({ brokerSocketPath: fx.socketPath });
    await rt.execute({ toolName: "type", arguments: { text: "hello" }, context: CTX });
    assert.deepEqual(seenParams, { text: "hello" });
  } finally {
    await fx.close();
  }
});

test("execute：ensureBrokerAvailable 钩子在调用前被执行（懒启动触发点）", async () => {
  const order = [];
  const fx = await startBrokerFixture(() => {
    order.push("broker-call");
    return { respond: { ok: true, result: { content: [] } } };
  });
  try {
    const rt = createComputerUseRuntime({
      brokerSocketPath: fx.socketPath,
      ensureBrokerAvailable: async () => {
        order.push("ensure");
      },
    });
    await rt.execute({ toolName: "list_apps", context: CTX });
    assert.deepEqual(order, ["ensure", "broker-call"], "ensureBrokerAvailable 必须先于 broker 调用");
  } finally {
    await fx.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 3：warming-up → CUA_NOT_READY 非-error 信封（§5，裁决方案 b）
// ─────────────────────────────────────────────────────────────────────────────

test("execute：broker_unavailable → CUA_NOT_READY retryable=true 且非 error 结果（SDK 才会重试）", async () => {
  const fx = await startBrokerFixture(() => ({
    respond: { ok: false, error: { message: "helper warming up", code: "broker_unavailable" } },
  }));
  try {
    const rt = createComputerUseRuntime({ brokerSocketPath: fx.socketPath });
    const result = await rt.execute({ toolName: "get_app_state", context: CTX });
    // 关键：isError 必须不为 true——SDK notReadyEnvelopeOf 对 isError===true 直接返回 undefined，
    // 信封会被丢掉（上游 computer-use-client.mjs:255-262 记录的历史 bug 形态）。
    assert.notEqual(result.isError, true, "warming-up 必须是非-error 结果，否则 SDK 重试环永不命中");
    const envelope = parsedText(result);
    assert.equal(envelope.kind, "CUA_NOT_READY");
    assert.equal(envelope.reasonCode, "broker_not_accepting");
    assert.equal(envelope.retryable, true);
    assert.match(envelope.message, /starting up|brief wait/u);
  } finally {
    await fx.close();
  }
});

test("execute：连接被拒（Helper 未 bind）→ 同样归 CUA_NOT_READY retryable=true", async () => {
  const rt = createComputerUseRuntime({ brokerSocketPath: mintBrokerSocketPath() });
  const result = await rt.execute({ toolName: "list_apps", context: CTX });
  const envelope = parsedText(result);
  assert.equal(envelope.kind, "CUA_NOT_READY");
  assert.equal(envelope.retryable, true, "连不上 = Helper 未就绪，可重试");
  assert.notEqual(result.isError, true);
});

test("execute：stale_socket 也按 warming-up 处理（可重试）", async () => {
  const fx = await startBrokerFixture(() => ({
    respond: { ok: false, error: { message: "socket rotated", code: "stale_socket" } },
  }));
  try {
    const rt = createComputerUseRuntime({ brokerSocketPath: fx.socketPath });
    const envelope = parsedText(await rt.execute({ toolName: "list_apps", context: CTX }));
    assert.equal(envelope.kind, "CUA_NOT_READY");
    assert.equal(envelope.retryable, true);
  } finally {
    await fx.close();
  }
});

test("execute：ensureBrokerAvailable 抛 broker_unavailable → CUA_NOT_READY（懒启动失败视为 warming-up）", async () => {
  const { BrokerError } = await import("../../../packages/acode-cua/broker.js");
  const rt = createComputerUseRuntime({
    brokerSocketPath: mintBrokerSocketPath(),
    ensureBrokerAvailable: async () => {
      throw new BrokerError("helper still spawning", { code: "broker_unavailable" });
    },
  });
  const envelope = parsedText(await rt.execute({ toolName: "list_apps", context: CTX }));
  assert.equal(envelope.kind, "CUA_NOT_READY");
  assert.equal(envelope.retryable, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 4：possibly_sent 红线——绝不重放变更类动作（§5.2 / C08）
// ─────────────────────────────────────────────────────────────────────────────

test("execute：请求已写出但拿不到收据（possiblySent）→ 信封 retryable=false，SDK 不会重放", async () => {
  // 夹具读完请求行后立即断开：请求行已 write ⇒ possiblySent=true（传输层歧义，保守方向）。
  // 用「读后即断」而非「hold 到超时」，是为了瞬时触发同一分支——两者对 execute 的语义完全一致
  // （都是「已发出、无收据」），但前者不必等满 10s 变更类超时预算（那会拖慢每次 CI）。
  const fx = await startBrokerFixture(() => ({ destroyAfterRequest: true }));
  try {
    const rt = createComputerUseRuntime({ brokerSocketPath: fx.socketPath });
    // 变更类方法 + 传输层歧义：动作可能已落地，绝不可自动重放（C08）。
    const result = await rt.execute({ toolName: "left_click", context: CTX });
    const envelope = parsedText(result);
    // wire spec §5.1/§5.2：possibly_sent 仍走 CUA_NOT_READY 信封形态，但 retryable=false。
    // SDK 的 call() 环据此「notReady.retryable !== true」直接抛 ComputerUseError(CONTROLLER_BUSY)，
    // 不再退避重试——即「不自动重放可能已产生的副作用」。
    assert.equal(envelope.kind, "CUA_NOT_READY");
    assert.equal(envelope.reasonCode, "possibly_sent", "传输层歧义 ⇒ reasonCode 标 possibly_sent");
    assert.equal(envelope.retryable, false, "红线：possibly_sent 必须 retryable=false，绝不可重试");
    assert.notEqual(result.isError, true, "信封是非-error 结果（isError 会让 SDK 丢掉 not-ready 信号）");
  } finally {
    await fx.close();
  }
});

test("execute：只读方法遇传输层歧义同样 retryable=false（保守方向不因只读而放松）", async () => {
  // 只读方法（list_apps）虽无副作用，但传输层无法证明「未送达」，仍按保守方向不重试。
  const fx = await startBrokerFixture(() => ({ destroyAfterRequest: true }));
  try {
    const rt = createComputerUseRuntime({ brokerSocketPath: fx.socketPath });
    const envelope = parsedText(await rt.execute({ toolName: "list_apps", context: CTX }));
    assert.equal(envelope.retryable, false);
    assert.equal(envelope.reasonCode, "possibly_sent");
  } finally {
    await fx.close();
  }
});

test("execute：producer 自报 possibly_sent 经 ok:true 收据原样透传（不由客户端伪造）", async () => {
  // §4.5：producer 判断动作可能已落地时，经 ok:true 的收据携 dispatch_status:"possibly_sent"。
  // execute 对成功结果原样透传，SDK 的 receiptOf/assertOk 从收据读取——客户端不得凭传输状态改写。
  const receipt = {
    content: [{ type: "text", text: JSON.stringify({ dispatch_status: "possibly_sent", action_sent: true, code: "controller_busy" }) }],
  };
  const fx = await startBrokerFixture(() => ({ respond: { ok: true, result: receipt } }));
  try {
    const rt = createComputerUseRuntime({ brokerSocketPath: fx.socketPath });
    const got = await rt.execute({ toolName: "left_click", context: CTX });
    assert.deepEqual(got, receipt, "producer 收据必须原样透传，不被 execute 改写或吞掉");
    assert.equal(got.isError, undefined, "收据是 ok:true 成功结果，execute 不加 isError");
  } finally {
    await fx.close();
  }
});

test("execute：应用层失败（permission_denied）→ isError 结果携带 broker code 供 SDK 映射", async () => {
  const fx = await startBrokerFixture(() => ({
    respond: { ok: false, error: { message: "user denied", code: "permission_denied" } },
  }));
  try {
    const rt = createComputerUseRuntime({ brokerSocketPath: fx.socketPath });
    const result = await rt.execute({ toolName: "left_click", context: CTX });
    assert.equal(result.isError, true);
    const payload = parsedText(result);
    // SDK brokerErrorCodeOf 从 text block 解析 code，再经 ERROR_CODE_BY_BROKER 映射为 PERMISSION_DENIED。
    assert.equal(payload.code, "permission_denied", "必须携带原始 broker code（不做 SDK 侧映射）");
    assert.equal(payload.error.message, "user denied");
    assert.equal(payload.error.code, "permission_denied");
  } finally {
    await fx.close();
  }
});

test("execute：应用层失败但请求未写出（连不上）时不标 possibly_sent", async () => {
  // 非 warming-up 码 + 未写出：构造一个 ok:false 但 code 非 warming-up 的响应需要连得上，
  // 故用「连不上 + 变更类方法」验证：连不上是 broker_unavailable（warming-up 路径），
  // 且 possiblySent=false ⇒ retryable 仍为 true（未送达，可安全重试）。
  const rt = createComputerUseRuntime({ brokerSocketPath: mintBrokerSocketPath() });
  const envelope = parsedText(await rt.execute({ toolName: "type", context: CTX }));
  assert.equal(envelope.kind, "CUA_NOT_READY");
  assert.equal(envelope.reasonCode, "broker_not_accepting", "未写出 ⇒ 不是 possibly_sent");
  assert.equal(envelope.retryable, true, "确定未送达，可安全重试");
});

test("execute：非法 JSON 响应 → isError internal（不静默成功、不泄露底层 parse 文本）", async () => {
  const fx = await startBrokerFixture(() => ({ raw: "garbage-not-json\n" }));
  try {
    const rt = createComputerUseRuntime({ brokerSocketPath: fx.socketPath });
    const result = await rt.execute({ toolName: "list_apps", context: CTX });
    assert.equal(result.isError, true);
    const payload = parsedText(result);
    assert.equal(payload.code, "internal");
    assert.doesNotMatch(payload.error.message, /SyntaxError|JSON\.parse/u);
  } finally {
    await fx.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 5：接口契约（closeSession / dispose）
// ─────────────────────────────────────────────────────────────────────────────

test("createComputerUseRuntime：返回对象满足 ComputerUseRuntime 接口三方法", async () => {
  const rt = createComputerUseRuntime({ brokerSocketPath: mintBrokerSocketPath() });
  assert.equal(typeof rt.execute, "function");
  assert.equal(typeof rt.closeSession, "function");
  assert.equal(typeof rt.dispose, "function");
  await assert.doesNotReject(rt.closeSession(CTX), "链路乙无常驻会话，closeSession 是安全 no-op");
  await assert.doesNotReject(rt.dispose(), "无常驻连接，dispose 是安全 no-op");
});

test("createComputerUseRuntime：非法 options（非字符串 socketPath / 非函数钩子）不抛、走不可用路径", async () => {
  const rt = createComputerUseRuntime({
    brokerSocketPath: 123,
    refreshMarkerPath: null,
    ensureBrokerAvailable: "not-a-function",
  });
  const result = await rt.execute({ toolName: "list_apps", context: CTX });
  assert.equal(result.isError, true, "非法 socketPath 视同未配置 → fail-closed 不可用");
});
