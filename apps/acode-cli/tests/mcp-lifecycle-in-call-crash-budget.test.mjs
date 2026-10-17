import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * MCP 重连预算第二计数器「连续中途崩溃」（specs/mcp-lifecycle-ttl-approval.md R1，
 * 验收场景 15/16）验收测试：真实 stdio 子进程 fixture。
 *
 * 覆盖 2026-10-16 真实模型 E2E 实证的缝：「连接必成功、每次 tools/call 都崩溃」的
 * server 过去每轮懒重连的连接成功都会清零计数，永不挂起、错误永远是裸
 * Connection closed。现在：
 * - 每杀形态：第 crashBudget 次中途崩溃即挂起（suspendedBy=in_call_crashes），
 *   下一次调用起即拒（不 spawn、带模型指引），显式 connectServer 复活且计数复位；
 * - 交替形态：完整成功的调用复位中途计数，成功/崩溃交替永不挂起。
 */

const { McpReconnectBudget } = await import("../packages/adapters/src/mcp/reconnect-budget.ts");
const { createMcpAdapter } = await import("../packages/adapters/src/mcp/index.ts");

// -----------------------------------------------
// 纯单元：双计数器语义
// -----------------------------------------------

test("budget: 中途崩溃计数连接成功不复位，工具调用完整成功才复位", () => {
  const budget = new McpReconnectBudget({ minRetryIntervalMs: 0 });
  assert.deepEqual(budget.recordInCallCrash("srv"), {
    suspended: false,
    consecutiveInCallCrashes: 1,
  });
  assert.deepEqual(budget.recordInCallCrash("srv"), {
    suspended: false,
    consecutiveInCallCrashes: 2,
  });
  // 每轮懒重连的连接成功不得清零中途崩溃计数（fixture B 的缝）。
  budget.recordSuccess("srv");
  assert.deepEqual(budget.check("srv"), { allowed: true });
  assert.deepEqual(budget.recordInCallCrash("srv"), {
    suspended: true,
    consecutiveInCallCrashes: 3,
  });
  const verdict = budget.check("srv");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "suspended");
  assert.equal(verdict.suspendedBy, "in_call_crashes");
  assert.equal(verdict.suspension.consecutiveInCallCrashes, 3);
  assert.equal(verdict.suspension.consecutiveFailures, 0);
  assert.ok(verdict.suspension.suspendedAt);
  assert.equal(budget.suspension("srv").suspendedBy, "in_call_crashes");
  // 挂起只能由显式复位解除。
  budget.reset("srv");
  assert.deepEqual(budget.check("srv"), { allowed: true });
  assert.equal(budget.suspension("srv"), undefined);

  // 复位点 = 一次工具调用完整成功：清零后重新计数。
  budget.recordInCallCrash("srv");
  budget.recordInCallCrash("srv");
  budget.recordToolCallSuccess("srv");
  budget.recordInCallCrash("srv");
  budget.recordInCallCrash("srv");
  assert.deepEqual(budget.check("srv"), { allowed: true }, "成功调用后计数必须重新开始");
});

test("budget: 连接失败挂起仍由连接成功解除，且不受中途崩溃计数影响", () => {
  const budget = new McpReconnectBudget({ crashBudget: 2, minRetryIntervalMs: 0 });
  budget.recordInCallCrash("srv");
  budget.recordFailure("srv");
  assert.deepEqual(budget.check("srv"), { allowed: true });
  const second = budget.recordFailure("srv");
  assert.equal(second.suspended, true);
  assert.equal(budget.check("srv").reason, "suspended");
  assert.equal(budget.check("srv").suspendedBy, "connect_failures");
  // 连接成功解除 connect_failures 挂起（既有语义零回归），但保留中途崩溃计数：
  // 保留的 1 次 + 本次崩溃即达阈值。
  budget.recordSuccess("srv");
  assert.deepEqual(budget.check("srv"), { allowed: true });
  const crash = budget.recordInCallCrash("srv");
  assert.equal(crash.suspended, true);
  assert.equal(crash.consecutiveInCallCrashes, 2);
  assert.equal(budget.check("srv").suspendedBy, "in_call_crashes");
});

// -----------------------------------------------
// adapter 集成：真实 stdio 子进程 fixture
// -----------------------------------------------

// 最小 stdio MCP server（newline-delimited JSON-RPC，legacy 协议）：连接与
// tools/list 永远成功；tools/call 行为由 FAKE_MODE 控制：
// - kill：每次 tools/call 进程自杀（fixture B 每杀形态）；
// - alternate：每进程第 1 次 tools/call 正常返回、第 2 次自杀（fixture A 交替形态）；
// - RECOVER 文件存在：tools/call 一律正常返回（模拟「server 已修复」）。
// 每次启动向 START_LOG 追加一行（spawn 计数的事实来源）。
const FAKE_SERVER_SOURCE = `
const fs = require("node:fs");
const startLog = process.env.FAKE_START_LOG;
const recoverFile = process.env.FAKE_RECOVER_FILE;
const mode = process.env.FAKE_MODE || "kill";
try {
  fs.appendFileSync(startLog, "start\\n");
} catch {}
const recovered = () => Boolean(recoverFile) && fs.existsSync(recoverFile);
let callCount = 0;
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
          {
            name: "echo",
            description: "echo tool",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: false },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    callCount += 1;
    const crash = mode === "alternate" ? callCount >= 2 : true;
    if (!crash || recovered()) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "ok" }] },
      });
      return;
    }
    process.exit(3);
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

async function withFixture(mode, fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-in-call-crash-"));
  try {
    const serverPath = join(dir, "fake-server.cjs");
    writeFileSync(serverPath, FAKE_SERVER_SOURCE, "utf8");
    const startLog = join(dir, "starts.log");
    const recoverFile = join(dir, "recover.flag");
    const config = {
      type: "stdio",
      command: process.execPath,
      args: [serverPath],
      protocolVersion: "legacy",
      timeoutMs: 15_000,
      env: { FAKE_MODE: mode, FAKE_START_LOG: startLog, FAKE_RECOVER_FILE: recoverFile },
    };
    const countStarts = () =>
      existsSync(startLog) ? readFileSync(startLog, "utf8").split("\n").filter(Boolean).length : 0;
    return await fn({ config, countStarts, dir, recoverFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CALL_OPTIONS = { timeoutMs: 15_000 };
const ECHO_REQUEST = { serverName: "fake", toolName: "echo", arguments: {} };

test("adapter: 每次 tools/call 都崩溃——第 3 次中途崩溃挂起，第 4 次调用即拒；显式重连复活且计数复位", async (t) => {
  await withFixture("kill", async ({ config, countStarts, recoverFile }) => {
    const changes = [];
    const adapter = createMcpAdapter({
      reconnect: { crashBudget: 3, minRetryIntervalMs: 0 },
      onStatusChange: (change) => changes.push(change),
    });
    t.after(() => adapter.close());

    const initial = await adapter.connectServer("fake", config);
    assert.equal(initial.status, "connected", "连接必成功是本形态的前提");
    assert.equal(countStarts(), 1);

    // 第 1、2 次调用：连接成功后 tools/call 中途崩溃，累计但未达阈值，照常失败。
    await assert.rejects(() => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS));
    await assert.rejects(() => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS));
    let statuses = await adapter.status();
    assert.equal(
      statuses.fake.reconnectSuspension,
      undefined,
      "未达阈值不得挂起（每轮懒重连的连接成功不清零中途计数，也不触发挂起）",
    );

    // 第 3 次调用：中途崩溃达到阈值 → 挂起，错误当场换成带模型指引的文案。
    await assert.rejects(
      () => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS),
      (error) => {
        assert.match(error.message, /MCP server "fake" is unavailable/);
        assert.match(
          error.message,
          /suspended after 3 consecutive tool calls crashed the connection mid-call/,
        );
        assert.match(error.message, /Do not retry this tool in a loop/);
        return true;
      },
    );
    statuses = await adapter.status();
    assert.equal(statuses.fake.status, "disconnected");
    assert.ok(statuses.fake.reconnectSuspension, "挂起后状态必须携带 reconnectSuspension");
    assert.equal(statuses.fake.reconnectSuspension.suspendedBy, "in_call_crashes");
    assert.equal(statuses.fake.reconnectSuspension.consecutiveInCallCrashes, 3);
    assert.ok(statuses.fake.reconnectSuspension.suspendedAt);
    const spawnsAtSuspension = countStarts();
    assert.equal(spawnsAtSuspension, 3, "三次崩溃对应三次 spawn（初始连接 + 两轮懒重连）");

    // 事件面：reconnect-suspended 依序可见且携带来源维度。
    const suspendedEvent = changes.find((c) => c.trigger === "reconnect-suspended");
    assert.ok(suspendedEvent, "必须派发 reconnect-suspended 事件");
    assert.equal(suspendedEvent.serverName, "fake");
    assert.equal(suspendedEvent.status.reconnectSuspension.suspendedBy, "in_call_crashes");

    // 第 4 次调用起即拒：不再 spawn，指引文案在错误里。
    await assert.rejects(
      () => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS),
      (error) => {
        assert.match(error.message, /MCP server "fake" is unavailable/);
        assert.match(error.message, /Do not retry this tool in a loop/);
        return true;
      },
    );
    assert.equal(countStarts(), spawnsAtSuspension, "挂起后不得再 spawn");

    // 显式 connectServer（server 已修复）复活：复位预算、正常连接、调用成功。
    writeFileSync(recoverFile, "1", "utf8");
    const revived = await adapter.connectServer("fake", config);
    assert.equal(revived.status, "connected", "显式重连必须绕过挂起门禁");
    assert.equal(revived.reconnectSuspension, undefined);
    const result = await adapter.callTool(ECHO_REQUEST, CALL_OPTIONS);
    assert.equal(result.isError ?? false, false);
    assert.equal(result.content[0].text, "ok");

    // 计数复位的证明：撤掉修复后再崩两次（若未复位，此时累计已 ≥3 会立刻挂起）。
    rmSync(recoverFile, { force: true });
    await assert.rejects(() => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS));
    await assert.rejects(() => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS));
    statuses = await adapter.status();
    assert.equal(
      statuses.fake.reconnectSuspension,
      undefined,
      "显式重连必须把中途崩溃计数复位到零",
    );
  });
});

test("adapter: 成功/崩溃交替 ≥6 轮不挂起——完整成功的调用复位中途计数", async (t) => {
  await withFixture("alternate", async ({ config, countStarts }) => {
    const adapter = createMcpAdapter({
      reconnect: { crashBudget: 3, minRetryIntervalMs: 0 },
    });
    t.after(() => adapter.close());

    const initial = await adapter.connectServer("fake", config);
    assert.equal(initial.status, "connected");

    for (let round = 1; round <= 6; round += 1) {
      const ok = await adapter.callTool(ECHO_REQUEST, CALL_OPTIONS);
      assert.equal(ok.isError ?? false, false, `第 ${round} 轮成功调用必须返回 ok`);
      assert.equal(ok.content[0].text, "ok");
      await assert.rejects(
        () => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS),
        undefined,
        `第 ${round} 轮崩溃调用必须失败`,
      );
    }

    // 6 次中途崩溃 ≥ crashBudget，但每次崩溃前的调用都完整成功并复位了计数：
    // 永不挂起，懒重连每轮生效（server 半可用，继续服务）。
    const statuses = await adapter.status();
    assert.equal(statuses.fake.reconnectSuspension, undefined, "交替形态不得挂起");
    assert.equal(countStarts(), 6, "初始连接 + 每轮崩溃后的懒重连各 spawn 一次");

    // 下一轮成功调用（第 7 轮）依旧可用：懒重连未被任何门禁挡住。
    const ok = await adapter.callTool(ECHO_REQUEST, CALL_OPTIONS);
    assert.equal(ok.content[0].text, "ok");
    assert.equal((await adapter.status()).fake.reconnectSuspension, undefined);
  });
});
