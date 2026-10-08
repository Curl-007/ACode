import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { WebSocketServer } from "ws";

// spec: packages/desktop/specs/provisioning-transport-encryption-gate.md「token 传输」验收。
// 安全修复（审计 M5 顺带项）：/ws 升级握手的 token 改经 Authorization: Bearer 头，
// 不再写 URL query（query 会泄漏进代理/访问日志）。服务端 hasValidLiteToken 对升级请求
// 同样优先读 Bearer 头，本测试用真实 HTTP+WS server 验证握手事实与连接可用性。
const { connectToRemoteServerTarget } = await import("../src/host/serverRemoteConnection.ts");

const TOKEN = "test-lite-token-secret-value";

/** 满足 serverRemoteInfoSchema 的最小合法应答（protocolVersion/capabilities 是 zod literal）。 */
function createServerInfo(authRequired) {
  return {
    serverId: "test-server-id",
    version: "0.0.0-test",
    protocolVersion: 1,
    authRequired,
    workspaces: [],
    capabilities: { desktopContinuous: true, websocketRpc: true },
  };
}

async function startTestServer(authRequired = true) {
  const requests = { info: null, upgrade: null };
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/server-info")) {
      requests.info = { url: req.url, authorization: req.headers.authorization };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(createServerInfo(authRequired)));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    requests.upgrade = { url: req.url, authorization: req.headers.authorization };
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    requests,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("server-info 与 /ws 升级握手都走 Authorization: Bearer 头，URL query 不带 token", async () => {
  const harness = await startTestServer();
  let connection;
  try {
    connection = await connectToRemoteServerTarget({
      kind: "server",
      url: `http://127.0.0.1:${harness.port}`,
      token: TOKEN,
    });

    // 1) server-info 请求（R2 既有行为回归守护）：Bearer 头、无 query token。
    assert.ok(harness.requests.info, "server-info 请求必须发生");
    assert.equal(harness.requests.info.authorization, `Bearer ${TOKEN}`);
    assert.equal(
      new URL(harness.requests.info.url, "http://127.0.0.1").searchParams.get("token"),
      null,
      "server-info URL 不得携带 query token",
    );

    // 2) /ws 升级握手（本次修复）：Bearer 头、query 无 token、路径正确。
    assert.ok(harness.requests.upgrade, "ws 升级请求必须发生");
    assert.equal(
      harness.requests.upgrade.authorization,
      `Bearer ${TOKEN}`,
      "升级握手必须携带 Authorization: Bearer 头",
    );
    const upgradeUrl = new URL(harness.requests.upgrade.url, "http://127.0.0.1");
    assert.equal(upgradeUrl.pathname, "/ws");
    assert.equal(
      upgradeUrl.searchParams.get("token"),
      null,
      "升级握手 URL query 不得携带 token（会泄漏进代理/日志）",
    );
    assert.ok(
      !harness.requests.upgrade.url.includes(TOKEN),
      "升级请求行任何位置都不得出现 token 原文",
    );

    // 3) 连接可用性：attach 正常完成（services/client 就绪），dispose 干净收口。
    assert.ok(connection.services, "连接必须产出 RemoteServiceAccess");
    assert.ok(connection.client, "连接必须产出 ChannelClient");
  } finally {
    if (connection) {
      connection.dispose();
      await connection.disposeAndWait({ timeoutMs: 2_000 });
    }
    await harness.close();
  }
});

test("无 token 的 server 连接照常建立，升级握手不携带 Authorization 头", async () => {
  const harness = await startTestServer(false);
  let connection;
  try {
    connection = await connectToRemoteServerTarget({
      kind: "server",
      url: `http://127.0.0.1:${harness.port}`,
    });
    assert.ok(connection.services, "连接必须产出 RemoteServiceAccess");
    assert.ok(harness.requests.upgrade, "ws 升级请求必须发生");
    assert.equal(
      harness.requests.upgrade.authorization,
      undefined,
      "无 token 时不得注入 Authorization 头（header 注入是条件性的）",
    );
  } finally {
    if (connection) {
      connection.dispose();
      await connection.disposeAndWait({ timeoutMs: 2_000 });
    }
    await harness.close();
  }
});
