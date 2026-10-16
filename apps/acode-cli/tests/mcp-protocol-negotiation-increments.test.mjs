import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * MCP 协议协商增量（specs/mcp-protocol-negotiation-increments.md R1-R4 +
 * specs/mcp-lifecycle-ttl-approval.md R2.2）验收测试：
 * - R1 协商记忆：往返 / TTL 过期 / 代际失效 / forget / fail-open / 身份键稳定性；
 * - R2 403 快速失败：真实 http fixture——连接失败后 callTool 直接抛解释文案，
 *   不再向 server 发任何请求（不消耗重连循环）；
 * - R3 128 字符工具名剔除：边界判定；
 * - R4 防双跑：stdio 中途断连 → outcome-unknown 文案（cause 保留原错误）；
 * - R2.2 文案面：降级阶梯三段、缺席即诊断、既有「Do not retry」短语保留。
 */

const {
  createMcpNegotiationMemory,
  mcpServerNegotiationIdentityKey,
  MCP_NEGOTIATION_MEMORY_TTL_MS,
} = await import("../packages/adapters/src/mcp/negotiation-memory.ts");
const { exceedsMcpToolNameLimit, MCP_TOOL_NAME_MAX_LENGTH } = await import(
  "../packages/adapters/src/mcp/descriptor.ts"
);
const {
  buildMcpAccessDeniedError,
  buildMcpNotConnectedMessage,
  buildMcpOutcomeUnknownError,
  buildMcpReconnectRefusalError,
} = await import("../packages/adapters/src/mcp/model-guidance.ts");
const { createMcpAdapter } = await import("../packages/adapters/src/mcp/index.ts");

// -----------------------------------------------
// R1 协商记忆：纯单元（临时文件 + 注入时钟）
// -----------------------------------------------

function memoryFixture() {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-negotiation-memory-"));
  const filePath = join(dir, "protocol-memory.json");
  let nowMs = 1_000_000;
  const memory = createMcpNegotiationMemory({ filePath, now: () => nowMs });
  return {
    dir,
    filePath,
    memory,
    advance(ms) {
      nowMs += ms;
    },
    reopen() {
      return createMcpNegotiationMemory({ filePath, now: () => nowMs });
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const STDIO_CONFIG = { type: "stdio", command: "node", args: ["slow-server.mjs"] };

test("R1 记忆往返：rememberLegacy 落盘，新实例新鲜窗内命中；forget 清除", async (t) => {
  const fixture = memoryFixture();
  t.after(fixture.cleanup);
  assert.equal(await fixture.memory.isRememberedLegacy(STDIO_CONFIG), false);
  await fixture.memory.rememberLegacy(STDIO_CONFIG);
  assert.ok(existsSync(fixture.filePath), "记忆必须落盘（跨进程重启可用）");
  assert.equal(await fixture.reopen().isRememberedLegacy(STDIO_CONFIG), true);
  await fixture.memory.forget(STDIO_CONFIG);
  assert.equal(await fixture.reopen().isRememberedLegacy(STDIO_CONFIG), false);
});

test("R1 新鲜窗：7 天内有效，超窗失效；代际不符（模拟 SDK 升级）失效", async (t) => {
  const fixture = memoryFixture();
  t.after(fixture.cleanup);
  await fixture.memory.rememberLegacy(STDIO_CONFIG);
  fixture.advance(MCP_NEGOTIATION_MEMORY_TTL_MS - 1000);
  assert.equal(await fixture.reopen().isRememberedLegacy(STDIO_CONFIG), true);
  fixture.advance(2000);
  assert.equal(await fixture.reopen().isRememberedLegacy(STDIO_CONFIG), false);

  // 代际失效：手工把条目的 latestProtocolVersion 改成旧代际。
  await fixture.memory.rememberLegacy(STDIO_CONFIG);
  const raw = JSON.parse(readFileSync(fixture.filePath, "utf8"));
  const key = Object.keys(raw.verdicts)[0];
  raw.verdicts[key].latestProtocolVersion = "1999-01-01";
  writeFileSync(fixture.filePath, JSON.stringify(raw), "utf8");
  assert.equal(await fixture.reopen().isRememberedLegacy(STDIO_CONFIG), false);
});

test("R1 fail-open：损坏 / 超大 / 未来版本文件一律当作没有记忆，不抛错", async (t) => {
  const fixture = memoryFixture();
  t.after(fixture.cleanup);
  writeFileSync(fixture.filePath, "not-json{{{", "utf8");
  assert.equal(await fixture.reopen().isRememberedLegacy(STDIO_CONFIG), false);
  writeFileSync(fixture.filePath, "x".repeat(300 * 1024), "utf8");
  assert.equal(await fixture.reopen().isRememberedLegacy(STDIO_CONFIG), false);
  writeFileSync(
    fixture.filePath,
    JSON.stringify({ version: 2, verdicts: {} }),
    "utf8",
  );
  assert.equal(await fixture.reopen().isRememberedLegacy(STDIO_CONFIG), false);
});

test("R1 身份键：env 顺序无关；command/args/url 变化即换键", () => {
  const a = mcpServerNegotiationIdentityKey({
    type: "stdio",
    command: "node",
    args: ["s.mjs"],
    env: { A: "1", B: "2" },
  });
  const b = mcpServerNegotiationIdentityKey({
    type: "stdio",
    command: "node",
    args: ["s.mjs"],
    env: { B: "2", A: "1" },
  });
  assert.equal(a, b, "env 排序后摘要必须与声明顺序无关");
  const c = mcpServerNegotiationIdentityKey({
    type: "stdio",
    command: "node",
    args: ["other.mjs"],
    env: { A: "1", B: "2" },
  });
  assert.notEqual(a, c);
  const http = mcpServerNegotiationIdentityKey({ type: "http", url: "https://x.example/mcp" });
  assert.ok(http.startsWith("http:"));
  assert.notEqual(
    http,
    mcpServerNegotiationIdentityKey({ type: "http", url: "https://x.example/other" }),
  );
});

// -----------------------------------------------
// R3 128 字符工具名剔除：边界判定
// -----------------------------------------------

test("R3 工具名上限：128 放行、129 剔除", () => {
  const atLimit = { name: "m".repeat(MCP_TOOL_NAME_MAX_LENGTH) };
  const overLimit = { name: "m".repeat(MCP_TOOL_NAME_MAX_LENGTH + 1) };
  assert.equal(exceedsMcpToolNameLimit(atLimit), false);
  assert.equal(exceedsMcpToolNameLimit(overLimit), true);
});

// -----------------------------------------------
// R2.2 文案面：降级阶梯 + 缺席即诊断
// -----------------------------------------------

test("R2.2 not-connected 阶梯：稍晚连上 → 稍候重试一次 → 说出来并交付替代产物", () => {
  const message = buildMcpNotConnectedMessage("docs");
  assert.match(message, /^MCP server is not connected: docs\./, "保留既有前缀");
  assert.match(message, /may still be starting up/);
  assert.match(message, /shortly after the session begins/);
  assert.match(message, /wait a moment and retry once/);
  assert.match(message, /instead of immediately falling back/);
  assert.match(message, /say so in your reply/);
  assert.match(message, /instead of leaving the task undone/);
  assert.match(message, /Do not retry this tool in a loop/);
});

test("R2.2 缺席即诊断：挂起文案从缺席推断环境状态并让模型停止重试", () => {
  const suspendedConnect = buildMcpNotConnectedMessage("browser", {
    reconnectSuspension: {
      consecutiveFailures: 3,
      suspendedAt: new Date().toISOString(),
      suspendedBy: "connect_failures",
    },
  });
  assert.match(suspendedConnect, /most likely not running or offline/);
  assert.match(suspendedConnect, /infer that from its absence and stop retrying/);
  assert.match(suspendedConnect, /Do not retry this tool in a loop/);

  const refusal = buildMcpReconnectRefusalError("srv", {
    allowed: false,
    reason: "suspended",
    consecutiveFailures: 3,
    suspendedBy: "in_call_crashes",
    suspension: {
      consecutiveFailures: 0,
      consecutiveInCallCrashes: 3,
      suspendedAt: new Date().toISOString(),
      suspendedBy: "in_call_crashes",
    },
  });
  assert.match(refusal.message, /MCP server "srv" is unavailable/);
  assert.match(refusal.message, /crashing on every request/);
  assert.match(refusal.message, /Do not retry this tool in a loop/);
});

test("R2/R4 新文案：403 快速失败与 outcome-unknown 都含勿循环重试指引", () => {
  const denied = buildMcpAccessDeniedError("proxy-srv");
  assert.match(denied.message, /denied access \(HTTP 403\)/);
  assert.match(denied.message, /Retrying cannot change this outcome/);
  assert.match(denied.message, /do not retry this tool in a loop/i);

  const cause = new Error("Connection closed");
  const unknown = buildMcpOutcomeUnknownError("srv", "send_email", cause);
  assert.match(unknown.message, /outcome is unknown/);
  assert.match(unknown.message, /may have completed on the server, may still be running/);
  assert.match(unknown.message, /do not resend the same call blindly/i);
  assert.equal(unknown.cause, cause, "原错误必须保留在 cause 链");
});

// -----------------------------------------------
// adapter 集成：真实子进程 / 真实 http fixture
// -----------------------------------------------

const FAKE_SERVER_SOURCE = `
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
        serverInfo: { name: "fake-mcp", version: "0.0.1" },
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
          { name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    // 请求已读入、响应永不回：进程自杀模拟「已写上线后连接断开」。
    process.exit(3);
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
    try {
      handle(JSON.parse(line));
    } catch {}
  }
});
process.stdin.resume();
`;

test("R4 集成：stdio 中途断连 → outcome-unknown 文案（不是裸 Connection closed）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-outcome-unknown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const serverPath = join(dir, "fake-server.cjs");
  writeFileSync(serverPath, FAKE_SERVER_SOURCE, "utf8");
  const memoryFile = join(dir, "protocol-memory.json");
  const adapter = createMcpAdapter({
    negotiationMemory: createMcpNegotiationMemory({ filePath: memoryFile }),
    reconnect: { crashBudget: 3, minRetryIntervalMs: 0 },
  });
  t.after(() => adapter.close());
  const status = await adapter.connectServer("fake", {
    type: "stdio",
    command: process.execPath,
    args: [serverPath],
    protocolVersion: "legacy",
    timeoutMs: 15_000,
  });
  assert.equal(status.status, "connected");
  const error = await adapter
    .callTool(
      { serverName: "fake", toolName: "echo", arguments: {} },
      { timeoutMs: 15_000 },
    )
    .then(
      () => undefined,
      (thrown) => thrown,
    );
  assert.ok(error instanceof Error, "中途断连必须抛错");
  assert.match(error.message, /outcome is unknown/);
  assert.match(error.message, /do not resend the same call blindly/i);
  assert.ok(error.cause !== undefined, "原错误保留在 cause 链");
});

test("R2 集成：http 403 → 连接失败即终态，callTool 快速失败且不再发任何请求", async (t) => {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-403-"));
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const adapter = createMcpAdapter({
    negotiationMemory: createMcpNegotiationMemory({ filePath: join(dir, "protocol-memory.json") }),
    reconnect: { crashBudget: 3, minRetryIntervalMs: 0 },
  });
  t.after(() => adapter.close());
  const config = { type: "http", url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 8_000 };
  const status = await adapter.connectServer("denied", config);
  assert.equal(status.status, "failed");
  const requestsAfterConnect = requestCount;
  assert.ok(requestsAfterConnect > 0, "连接尝试必须真的打到 server");

  const error = await adapter
    .callTool({ serverName: "denied", toolName: "anything", arguments: {} }, { timeoutMs: 8_000 })
    .then(
      () => undefined,
      (thrown) => thrown,
    );
  assert.ok(error instanceof Error);
  assert.match(error.message, /denied access \(HTTP 403\)/);
  assert.match(error.message, /do not retry this tool in a loop/i);
  assert.equal(
    requestCount,
    requestsAfterConnect,
    "403 快速失败门必须在 spawn/请求之前拒绝（不做三连重试）",
  );
});
