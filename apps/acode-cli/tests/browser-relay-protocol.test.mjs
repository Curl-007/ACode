import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * T1#9 browser-relay 协议层验收（specs/browser-relay-inplace-capture.md R2 / A3、A4）：
 * discovery 端点合成、Target 事件多路复用（N 下游连接 × 单 chrome.debugger 挂载）、
 * token 鉴权拒绝与 Origin 拒绝。真实回环服务端 + 假扩展 WS + Node 全局 WebSocket
 * 客户端；不启动真实 Chrome（该链路如实标注未验证）。
 */

const { startRelayServer } = await import("../packages/browser-use-plugin/src/relay/server.ts");
const { ACODE_BROWSER_RELAY_VERSION } = await import("../packages/browser-use-plugin/src/relay/bridge.ts");
const { RELAY_PROTOCOL_VERSION } = await import("../packages/browser-use-plugin/src/relay/protocol.ts");

const HTTP_TAB = {
  tabId: 11,
  url: "https://app.example.com/dashboard",
  title: "Dashboard",
  active: true,
  discarded: false,
  windowId: 1,
  pinned: false,
  groupId: -1,
};
const CHROME_TAB = {
  tabId: 12,
  url: "chrome://settings/",
  title: "Settings",
  active: false,
  discarded: false,
  windowId: 1,
  pinned: false,
  groupId: -1,
};

/** 假扩展：拨入 /ext，发 hello，自动应答一切 rpc（记录收到的 rpc 供断言）。 */
async function connectFakeExtension(port, { token, instanceId = "inst-a" } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext${token ? `?token=${encodeURIComponent(token)}` : ""}`);
  const received = [];
  const waiters = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    received.push(msg);
    if (msg.t === "rpc") {
      ws.send(JSON.stringify({ t: "rpcResult", id: msg.id, ok: true, result: {} }));
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  await waitForOpen(ws);
  ws.send(
    JSON.stringify({
      t: "hello",
      instanceId,
      userAgent: "Mozilla/5.0 (Test) Chrome/141.0.0.0",
      browserVersion: "Chrome/141.0.0.0",
      relayProtocol: RELAY_PROTOCOL_VERSION,
      tabs: [HTTP_TAB, CHROME_TAB],
      attachedTabIds: [],
    }),
  );
  return {
    ws,
    received,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (predicate, label = "extension message") =>
      waitForMessage(received, waiters, predicate, label),
    close: () => ws.close(),
  };
}

/** 假下游 CDP 客户端（puppeteer 替身）。 */
async function connectCdpClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
  const received = [];
  const waiters = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  await waitForOpen(ws);
  return {
    ws,
    received,
    send: (msg) => ws.send(JSON.stringify(msg)),
    command: (id, method, params, sessionId) => ws.send(JSON.stringify({ id, method, params, sessionId })),
    next: (predicate, label = "cdp message") =>
      waitForMessage(received, waiters, predicate, label),
    close: () => ws.close(),
  };
}

/**
 * 先扫历史再挂等待者：服务端会把多个事件背靠背发出，等待第二条时第一条往往已
 * 分发完毕，只看未来消息会永远错过已到达的匹配。
 */
function waitForMessage(received, waiters, predicate, label) {
  const past = received.find(predicate);
  if (past) return Promise.resolve(past);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 5_000);
    waiters.push({
      predicate,
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    });
  });
}

function waitForOpen(ws) {
  if (ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true });
  });
}

/** node:http 语义下带 Origin 的非升级 GET 直接落 HTTP 处理器，用于 403 断言。 */
async function fetchStatus(url, headers = {}) {
  const response = await fetch(url, { headers });
  await response.arrayBuffer().catch(() => {});
  return response.status;
}

test("A3 无扩展时 /json/version 503 且 extensionSeen=false", async () => {
  const server = startRelayServer({ port: 0 });
  try {
    await server.whenListening;
    const response = await fetch(`http://127.0.0.1:${server.port}/json/version`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.extensionSeen, false);
    assert.equal(body.acodeRelayVersion, ACODE_BROWSER_RELAY_VERSION);
    assert.equal(typeof body.uptimeMs, "number");
  } finally {
    server.stop();
    await server.whenStopped;
  }
});

test("A3 hello 后 /json/version 200 合成 discovery 端点，/json/list 只列可挂载标签", async () => {
  const server = startRelayServer({ port: 0, group: false });
  try {
    await server.whenListening;
    const extension = await connectFakeExtension(server.port);
    // hello 后 /json/version 变 200。
    let version;
    for (let i = 0; i < 50; i++) {
      const response = await fetch(`http://127.0.0.1:${server.port}/json/version`);
      if (response.status === 200) {
        version = await response.json();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(version, "/json/version never became 200 after hello");
    assert.match(version.webSocketDebuggerUrl, /ws:\/\/127\.0\.0\.1:\d+\/cdp$/);
    assert.equal(version.Browser, "Chrome/141.0.0.0");
    assert.equal(version.acodeRelayProtocol, String(RELAY_PROTOCOL_VERSION));
    assert.equal(version.acodeExtensionRelayProtocol, String(RELAY_PROTOCOL_VERSION));

    const listResponse = await fetch(`http://127.0.0.1:${server.port}/json/list`);
    const targets = await listResponse.json();
    // chrome:// 对发现完全隐藏；page 目标使用 PAGE<code>.<tabId> 合成 id。
    assert.equal(targets.length, 1);
    assert.equal(targets[0].type, "page");
    assert.match(targets[0].id, /^PAGE[^.]+\.11$/);
    assert.equal(targets[0].url, HTTP_TAB.url);

    // 扩展应用层 ping/pong。
    extension.send({ t: "ping" });
    await extension.next((msg) => msg.t === "pong", "pong");
    extension.close();
  } finally {
    server.stop();
    await server.whenStopped;
  }
});

test("A4 两个下游连接各自获得 Target 层级、独立会话与事件分发", async () => {
  const server = startRelayServer({ port: 0, group: false });
  try {
    await server.whenListening;
    const extension = await connectFakeExtension(server.port);
    await waitForVersionReady(server.port);

    const clientA = await connectCdpClient(server.port);
    const clientB = await connectCdpClient(server.port);

    // 1) setDiscoverTargets：两个连接各收到成对 tab/page targetCreated 再收到应答。
    const pageTargetIds = {};
    for (const [name, client] of [["A", clientA], ["B", clientB]]) {
      client.command(1, "Target.setDiscoverTargets", {});
      const tabCreated = await client.next(
        (msg) => msg.method === "Target.targetCreated" && msg.params.targetInfo.type === "tab",
        "tab targetCreated",
      );
      const pageCreated = await client.next(
        (msg) => msg.method === "Target.targetCreated" && msg.params.targetInfo.type === "page",
        "page targetCreated",
      );
      const reply = await client.next((msg) => msg.id === 1, "setDiscoverTargets reply");
      assert.ok(reply.result);
      assert.match(tabCreated.params.targetInfo.targetId, /^TAB[^.]+\.11$/);
      assert.match(pageCreated.params.targetInfo.targetId, /^PAGE[^.]+\.11$/);
      pageTargetIds[name] = pageCreated.params.targetInfo.targetId;
    }

    // 2) 浏览器级 setAutoAttach：扩展各挂载一次，两个连接各拿到独立 ST 会话。
    clientA.command(2, "Target.setAutoAttach", { autoAttach: true });
    clientB.command(2, "Target.setAutoAttach", { autoAttach: true });
    const attachA = await clientA.next(
      (msg) => msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "tab",
      "client A tab attached",
    );
    const attachB = await clientB.next(
      (msg) => msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "tab",
      "client B tab attached",
    );
    assert.notEqual(attachA.params.sessionId, attachB.params.sessionId);
    assert.match(attachA.params.sessionId, /^ST11\./);
    assert.match(attachB.params.sessionId, /^ST11\./);
    await extension.next(
      (msg) => msg.t === "rpc" && msg.op === "attach" && msg.tabId === 11,
      "extension attach rpc",
    );

    // 3) 各自 attachToTarget 到 page 目标，拿页面会话（SP 前缀，互不相同）。
    clientA.command(3, "Target.attachToTarget", { targetId: pageTargetIds.A });
    clientB.command(3, "Target.attachToTarget", { targetId: pageTargetIds.B });
    const pageA = await clientA.next(
      (msg) => msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "page",
      "client A page attached",
    );
    const pageB = await clientB.next(
      (msg) => msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "page",
      "client B page attached",
    );
    const sessionIdA = pageA.params.sessionId;
    const sessionIdB = pageB.params.sessionId;
    assert.match(sessionIdA, /^SP11\./);
    assert.match(sessionIdB, /^SP11\./);
    assert.notEqual(sessionIdA, sessionIdB);

    // 4) Runtime.enable：根循环经扩展转发 disable→enable；共享根 enable 是 singleflight，
    //    后到者加入在途循环（不下发第二个 disable），因此 rpc 数为 2 或 3。
    clientA.command(4, "Runtime.enable", {}, sessionIdA);
    clientB.command(4, "Runtime.enable", {}, sessionIdB);
    const methodsSeen = [];
    await extension.next(
      (msg) => {
        if (msg.t === "rpc" && msg.op === "send" && msg.method?.startsWith("Runtime.")) {
          methodsSeen.push(msg.method);
        }
        return msg.t === "rpc" && msg.op === "send" && msg.method === "Runtime.enable";
      },
      "runtime enable rpc",
    );
    await clientA.next((msg) => msg.id === 4, "A runtime.enable reply");
    await clientB.next((msg) => msg.id === 4, "B runtime.enable reply");
    // B 的应答只有在其共享/自有循环完成后才到达，此时序列已定。
    assert.equal(methodsSeen[0], "Runtime.disable");
    assert.ok(
      methodsSeen.length === 2 || methodsSeen.length === 3,
      `unexpected runtime rpc sequence: ${methodsSeen.join(",")}`,
    );
    assert.ok(methodsSeen.slice(1).every((method) => method === "Runtime.enable"));

    const contextParams = { context: { id: 7, origin: "https://app.example.com", name: "main" } };
    extension.send({ t: "cdpEvent", tabId: 11, method: "Runtime.executionContextCreated", params: contextParams });
    const contextA = await clientA.next(
      (msg) => msg.method === "Runtime.executionContextCreated" && msg.sessionId === sessionIdA,
      "A executionContextCreated",
    );
    const contextB = await clientB.next(
      (msg) => msg.method === "Runtime.executionContextCreated" && msg.sessionId === sessionIdB,
      "B executionContextCreated",
    );
    assert.deepEqual(contextA.params, contextParams);
    assert.deepEqual(contextB.params, contextParams);

    // 5) 命令经 sessionId 路由到扩展 rpc send，应答回到正确连接。
    clientA.command(5, "Runtime.evaluate", { expression: "1+1" }, sessionIdA);
    const sendRpc = await extension.next(
      (msg) => msg.t === "rpc" && msg.op === "send" && msg.method === "Runtime.evaluate",
      "evaluate rpc",
    );
    assert.equal(sendRpc.tabId, 11);
    assert.deepEqual(sendRpc.params, { expression: "1+1" });
    const evaluateReply = await clientA.next((msg) => msg.id === 5, "evaluate reply");
    assert.ok(evaluateReply.result);

    // 6) 一个连接关闭：另一连接的会话与事件不受影响；标签挂载因 B 仍在而保留。
    clientA.close();
    // 给服务端一小段时间处理 A 的关闭（撤销 A 的会话、对账分组），再验证 B 完好。
    await new Promise((resolve) => setTimeout(resolve, 50));
    clientB.command(6, "Target.getTargets", {});
    const targetsReply = await clientB.next((msg) => msg.id === 6, "getTargets reply");
    assert.equal(targetsReply.result.targetInfos.length, 1);

    clientB.close();
    extension.close();
  } finally {
    server.stop();
    await server.whenStopped;
  }
});

test("A4 token 错配 401 拒绝扩展，正确 token 放行；/cdp 带 Origin 403", async () => {
  const tokenServer = startRelayServer({ port: 0, token: "secret-token", group: false });
  try {
    await tokenServer.whenListening;

    // 无 token：握手被 401 拒绝（undici WebSocket 以 error/close 表现）。
    await assert.rejects(
      waitForOpen(new WebSocket(`ws://127.0.0.1:${tokenServer.port}/ext`)),
      /websocket open failed/,
    );
    // 错 token：同样拒绝。
    await assert.rejects(
      waitForOpen(new WebSocket(`ws://127.0.0.1:${tokenServer.port}/ext?token=wrong`)),
      /websocket open failed/,
    );
    // 正确 token：升级成功，hello 后 discovery 就绪。
    const extension = await connectFakeExtension(tokenServer.port, { token: "secret-token" });
    await waitForVersionReady(tokenServer.port);
    extension.close();

    // 带 Origin 的下游升级/请求一律 403（网页不得驱动 relay）。
    assert.equal(
      await fetchStatus(`http://127.0.0.1:${tokenServer.port}/cdp`, { Origin: "https://evil.example" }),
      403,
    );
    // 带 Origin 的扩展升级也 403（非 chrome-extension:// origin）。
    assert.equal(
      await fetchStatus(`http://127.0.0.1:${tokenServer.port}/ext`, { Origin: "https://evil.example" }),
      403,
    );
  } finally {
    tokenServer.stop();
    await tokenServer.whenStopped;
  }
});

async function waitForVersionReady(port) {
  for (let i = 0; i < 50; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (response.status === 200) {
      await response.arrayBuffer().catch(() => {});
      return;
    }
    await response.arrayBuffer().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("/json/version never became 200");
}
