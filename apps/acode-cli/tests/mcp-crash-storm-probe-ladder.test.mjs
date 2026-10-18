import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * MCP 崩溃风暴熔断 + 静默探测阶梯（specs/mcp-startup-gate-breaker.md R2/R3）验收测试。
 *
 * 覆盖：
 * 1. 熔断纯单元（确定性时钟：滑动窗口 30s >5 次 → 熔断；老化出局；显式复位；
 *    按 server 隔离）；
 * 2. 阶梯纯单元（15s 起步 ×2 至 5min 封顶；幂等武装；stop 语义）；
 * 3. adapter 集成：stdio 反复崩溃触发熔断 → 懒重连被拒（不再 spawn）→ 显式重连
 *    复位并复活；stdio 永不武装探测；
 * 4. adapter 集成：真实本地 http MCP server 失联 → 静默探测武装 → 指数退避 →
 *    server 恢复后探测自愈（connected，阶梯拆除）。
 */

const {
  MCP_CRASH_STORM_LIMIT,
  MCP_CRASH_STORM_WINDOW_MS,
  McpCrashStormBreaker,
} = await import("../packages/adapters/src/mcp/crash-storm-breaker.ts");
const {
  MCP_PROBE_BASE_DELAY_MS,
  MCP_PROBE_MAX_DELAY_MS,
  McpProbeLadder,
} = await import("../packages/adapters/src/mcp/probe-ladder.ts");
const { createMcpAdapter } = await import("../packages/adapters/src/mcp/index.ts");

test("breaker: 缺省窗口 30s 上限 5 次；第 6 次入列即熔断", () => {
  assert.equal(MCP_CRASH_STORM_WINDOW_MS, 30_000);
  assert.equal(MCP_CRASH_STORM_LIMIT, 5);
  let now = 0;
  const breaker = new McpCrashStormBreaker({ now: () => now });
  for (let i = 0; i < 5; i++) {
    const outcome = breaker.recordDisconnect("srv");
    assert.equal(outcome.tripped, false, `第 ${i + 1} 次断连不得熔断`);
  }
  const sixth = breaker.recordDisconnect("srv");
  assert.equal(sixth.tripped, true, "第 6 次入列（>5）即熔断");
  assert.equal(sixth.trip.windowCount, 6);
  assert.equal(breaker.isTripped("srv"), true);
  assert.equal(breaker.windowCount("srv"), 6);
});

test("breaker: 窗口老化出局；显式复位；按 server 隔离", () => {
  let now = 0;
  const breaker = new McpCrashStormBreaker({ now: () => now });
  for (let i = 0; i < 6; i++) {
    breaker.recordDisconnect("a");
    now += 6_000;
  }
  // 第 1 次已老化出窗（5×6s=30s 边界外），后续不得累计熔断。
  assert.equal(breaker.isTripped("a"), false, "旧断连随窗口老化，不无限累积");

  const dense = new McpCrashStormBreaker({ now: () => now });
  for (let i = 0; i < 6; i++) dense.recordDisconnect("b");
  assert.equal(dense.isTripped("b"), true);
  dense.reset("b");
  assert.equal(dense.isTripped("b"), false, "显式复位清除熔断");

  dense.recordDisconnect("c");
  assert.equal(dense.isTripped("b"), false, "按 server 隔离");
  assert.equal(dense.isTripped("c"), false);
});

test("ladder: 缺省 15s 起步 ×2 至 5min 封顶；武装幂等；stop 清累积", () => {
  assert.equal(MCP_PROBE_BASE_DELAY_MS, 15_000);
  assert.equal(MCP_PROBE_MAX_DELAY_MS, 300_000);
  const armedDelays = [];
  let fireLatest;
  const ladder = new McpProbeLadder({
    arm: (name, delayMs, fire) => {
      armedDelays.push(delayMs);
      fireLatest = fire;
      return () => {};
    },
  });
  const onProbe = () => {};
  ladder.arm("srv", onProbe);
  assert.deepEqual(armedDelays, [15_000]);
  assert.equal(ladder.isArmed("srv"), true);
  ladder.arm("srv", onProbe);
  assert.deepEqual(armedDelays, [15_000], "已武装时幂等 no-op（单一定时器所有者）");

  // 到点 → 解除武装 → onProbe；失败后调用方重新 arm → 下一档退避（×2，封顶 5min）。
  fireLatest();
  assert.equal(ladder.isArmed("srv"), false);
  for (const expected of [30_000, 60_000, 120_000, 240_000, 300_000]) {
    ladder.arm("srv", onProbe);
    fireLatest();
    assert.deepEqual(armedDelays.at(-1), expected);
  }
  assert.deepEqual(armedDelays, [15_000, 30_000, 60_000, 120_000, 240_000, 300_000]);

  // stop 清除状态：重新武装从 base 起步（恢复后的新一轮失联，不再背旧累积）。
  ladder.arm("srv", onProbe);
  ladder.stop("srv");
  assert.equal(ladder.isArmed("srv"), false);
  ladder.arm("srv", onProbe);
  assert.deepEqual(armedDelays.at(-1), 15_000, "stop 后重新从 base 起步");
  ladder.stopAll();
  assert.equal(ladder.isArmed("srv"), false);
});

// -----------------------------------------------
// adapter 集成：stdio 崩溃风暴 → 熔断 → 显式恢复
// -----------------------------------------------

// 最小 stdio MCP server（newline-delimited JSON-RPC，legacy 协议，无 probe）：
// RECOVER 文件存在时正常服务；否则完成 initialize + tools/list 后立即退出——
// 「连得上、活不过窗口」的风暴形态（R1 预算计数器的盲区，熔断的靶子）。
const STORM_SERVER_SOURCE = `
const fs = require("node:fs");
const startLog = process.env.FAKE_START_LOG;
const recoverFile = process.env.FAKE_RECOVER_FILE;
try {
  if (startLog) fs.appendFileSync(startLog, "start\\n");
} catch {}
const recovered = Boolean(recoverFile) && fs.existsSync(recoverFile);
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "storm-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          { name: "echo", description: "echo tool", inputSchema: { type: "object", properties: {} } },
        ],
      },
    });
    if (!recovered) process.exit(0);
    return;
  }
  if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.resume();
`;

const ECHO_REQUEST = { serverName: "storm", toolName: "echo", arguments: {} };
const CALL_OPTIONS = { timeoutMs: 15_000 };

test("breaker(adapter): 30s 内反复断连触发熔断；懒重连被拒不再 spawn；显式重连复位", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-crash-storm-"));
  try {
    const serverPath = join(dir, "storm-server.cjs");
    writeFileSync(serverPath, STORM_SERVER_SOURCE, "utf8");
    const recoverFile = join(dir, "recover.flag");
    const startLog = join(dir, "starts.log");
    const config = {
      type: "stdio",
      command: process.execPath,
      args: [serverPath],
      protocolVersion: "legacy",
      timeoutMs: 15_000,
      env: { FAKE_RECOVER_FILE: recoverFile, FAKE_START_LOG: startLog },
    };
    const countStarts = () =>
      existsSync(startLog)
        ? readFileSync(startLog, "utf8").split("\n").filter(Boolean).length
        : 0;
    const probeArms = [];
    const adapter = createMcpAdapter({
      // R1 预算调高、冷却清零：单独考察风暴熔断，不让预算先挂起。
      reconnect: { crashBudget: 100, minRetryIntervalMs: 0 },
      probeLadder: {
        arm: (name, delayMs, fire) => {
          probeArms.push({ name, delayMs });
          return () => {};
        },
      },
    });
    t.after(() => adapter.close());

    const initial = await adapter.connectServer("storm", config);
    assert.equal(initial.status, "connected", "首次显式连接成功（随后进程自退）");

    // 反复调用：每轮懒重连 spawn 一次、连接成功后进程再退——断连事件在 30s 窗口
    // 内累积到 >5。循环有界，熔断即停。
    let tripped = false;
    for (let round = 0; round < 12 && !tripped; round += 1) {
      await assert.rejects(() => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS));
      const statuses = await adapter.status();
      tripped = statuses.storm?.reconnectSuspension !== undefined;
    }
    assert.ok(tripped, "窗口内断连超限后必须熔断（状态携带挂起事实）");

    // 熔断后的调用被门禁拒绝：不再 spawn，文案点名 crash-storm breaker 与显式恢复。
    const spawnsAtTrip = countStarts();
    await assert.rejects(
      () => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS),
      (error) => {
        assert.match(error.message, /crash-storm breaker/);
        assert.match(error.message, /Do not retry this tool in a loop/);
        assert.match(error.message, /explicit reconnect/);
        return true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(countStarts(), spawnsAtTrip, "熔断后不得再 spawn");
    assert.equal(probeArms.length, 0, "stdio 风暴不武装静默探测");

    // 显式恢复：修复 server（RECOVER 预置）后显式 connectServer 复位熔断并复活。
    writeFileSync(recoverFile, "1", "utf8");
    const revived = await adapter.connectServer("storm", config);
    assert.equal(revived.status, "connected", "显式重连必须绕过熔断门禁");
    assert.equal(revived.reconnectSuspension, undefined);
    const result = await adapter.callTool(ECHO_REQUEST, CALL_OPTIONS);
    assert.equal(result.isError ?? false, false, "复活后工具调用恢复");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe(adapter): stdio server 永不武装静默探测（按需拉起，防 fork 风暴）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-probe-stdio-"));
  try {
    const serverPath = join(dir, "storm-server.cjs");
    writeFileSync(serverPath, STORM_SERVER_SOURCE, "utf8");
    const config = {
      type: "stdio",
      command: process.execPath,
      args: [serverPath],
      protocolVersion: "legacy",
      timeoutMs: 15_000,
      env: {},
    };
    const probeArms = [];
    const adapter = createMcpAdapter({
      probeLadder: {
        arm: (name, delayMs, fire) => {
          probeArms.push({ name, delayMs });
          return () => {};
        },
      },
    });
    t.after(() => adapter.close());

    const status = await adapter.connectServer("storm", config);
    assert.equal(status.status, "connected");
    // 进程自退 → onclose 意外断连 → 状态 disconnected。stdio 不得武装探测。
    assert.ok(
      await waitUntilStatus(adapter, "storm", "disconnected"),
      "进程退出后状态应转为 disconnected",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(probeArms.length, 0, "stdio 失联绝不武装静默探测");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitUntilStatus(adapter, name, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statuses = await adapter.status();
    if (statuses[name]?.status === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

// -----------------------------------------------
// adapter 集成：http server 失联 → 静默探测阶梯 → 自愈
// -----------------------------------------------

// 最小 Streamable HTTP MCP server：JSON 响应 initialize / tools/list / tools/call，
// notifications 回 202，GET（SSE）回 405（SDK 容忍无 SSE 的 server）。
// 重启必须落在同一端口（探测打的是配置 URL 的固定端点），先探测一个空闲端口复用。
function startHttpMcpServer(port) {
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(405, { "content-type": "text/plain" });
      response.end("SSE not supported");
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion || "2024-11-05",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "http-mcp", version: "0.0.1" },
            },
          }),
        );
        return;
      }
      if (message.id === undefined || message.id === null) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "echo",
                  description: "echo tool",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      );
    });
  });
  const connections = new Set();
  server.on("connection", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.connectionsSet = connections;
      resolve(server);
    });
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // 立即掐断所有 keep-alive 连接，让客户端 transport 立刻感知失联。
    for (const connection of [...(server.connectionsSet ?? [])]) {
      connection.destroy();
    }
  });
}

async function findFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("probe(adapter): 曾连接的 http server 失联后武装静默探测，指数退避，恢复后自愈", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-probe-http-"));
  const port = await findFreePort();
  let server = await startHttpMcpServer(port);
  try {
    const config = {
      type: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      protocolVersion: "legacy",
      timeoutMs: 10_000,
    };
    const armedDelays = [];
    const fires = [];
    const adapter = createMcpAdapter({
      env: { ACODE_DATA_BASE_DIR: dir },
      probeLadder: {
        baseDelayMs: 20,
        maxDelayMs: 80,
        arm: (name, delayMs, fire) => {
          armedDelays.push(delayMs);
          fires.push(fire);
          return () => {};
        },
      },
    });
    t.after(() => adapter.close());

    const status = await adapter.connectServer("remote", config);
    assert.equal(status.status, "connected", "首次显式连接成功");
    assert.equal(armedDelays.length, 0, "连接期间不武装");

    // 失联：掐掉 server，ping 判死（「无声死亡」的确定性显式化）→ 武装探测。
    await closeHttpServer(server);
    assert.equal(await adapter.pingServer("remote"), false);
    assert.equal(armedDelays.length, 1, "失联即武装第一次静默探测");
    assert.equal(armedDelays[0], 20);

    // 探测失败（server 仍死）→ 指数退避 20 → 40 → 80（封顶）。
    for (const expected of [40, 80, 80]) {
      fires.at(-1)();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(armedDelays.at(-1), expected, `探测失败后退避到 ${expected}ms`);
    }

    // server 恢复（同端口重启）→ 下一次静默探测自愈：connected、阶梯拆除。
    server = await startHttpMcpServer(port);
    t.after(() => closeHttpServer(server));
    fires.at(-1)();
    assert.ok(
      await waitUntilStatus(adapter, "remote", "connected"),
      "静默探测必须在 server 恢复后重连",
    );
    const tools = await adapter.listTools();
    assert.equal(tools.length, 1, "重连后工具清单恢复");

    // 恢复后的新一轮失联从 base 重新起步（stop 清除了退避累积）。
    await closeHttpServer(server);
    assert.equal(await adapter.pingServer("remote"), false);
    assert.equal(armedDelays.at(-1), 20, "自愈后重新失联从 base 起步");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await closeHttpServer(server);
  }
});
