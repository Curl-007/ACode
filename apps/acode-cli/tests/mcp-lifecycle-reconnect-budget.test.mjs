import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * MCP 懒重连 + 重连预算（specs/mcp-lifecycle-ttl-approval.md R1/R2/R2.1）验收测试。
 *
 * 三层覆盖：
 * 1. McpReconnectBudget / createSingleflightRunner 纯单元（确定性时钟）；
 * 2. NodeMcpAdapter 集成：真实 stdio 子进程 fixture（握手成功后在 tools/call 时
 *    自杀；后续启动在握手前崩溃），验证懒重连门禁、崩溃预算熔断、显式复位、
 *    状态变更事件与面向模型的失败文案；
 * 3. 监听器故障不影响连接生命周期。
 */

const {
  McpReconnectBudget,
  createSingleflightRunner,
  DEFAULT_MCP_RECONNECT_CRASH_BUDGET,
} = await import("../packages/adapters/src/mcp/reconnect-budget.ts");
const { createMcpAdapter } = await import("../packages/adapters/src/mcp/index.ts");

// -----------------------------------------------
// 纯单元：预算与 singleflight
// -----------------------------------------------

test("budget: 缺省预算 3，连续失败耗尽即挂起", () => {
  let now = 1_000_000;
  const budget = new McpReconnectBudget({ minRetryIntervalMs: 0, now: () => now });
  assert.equal(DEFAULT_MCP_RECONNECT_CRASH_BUDGET, 3);
  assert.deepEqual(budget.check("srv"), { allowed: true });
  assert.deepEqual(budget.recordFailure("srv"), { suspended: false, consecutiveFailures: 1 });
  assert.deepEqual(budget.recordFailure("srv"), { suspended: false, consecutiveFailures: 2 });
  const third = budget.recordFailure("srv");
  assert.equal(third.suspended, true);
  assert.equal(third.consecutiveFailures, 3);
  const verdict = budget.check("srv");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "suspended");
  assert.equal(verdict.consecutiveFailures, 3);
  assert.ok(verdict.suspension.suspendedAt);
});

test("budget: 成功与显式复位都解除挂起；计数按 server 隔离", () => {
  const budget = new McpReconnectBudget({ crashBudget: 1, minRetryIntervalMs: 0 });
  budget.recordFailure("a");
  assert.equal(budget.check("a").allowed, false);
  assert.deepEqual(budget.check("b"), { allowed: true }, "计数不得跨 server 泄漏");
  budget.recordSuccess("a");
  assert.deepEqual(budget.check("a"), { allowed: true });
  budget.recordFailure("a");
  assert.equal(budget.check("a").allowed, false);
  budget.reset("a");
  assert.deepEqual(budget.check("a"), { allowed: true });
  assert.equal(budget.suspension("a"), undefined);
});

test("budget: 最小重试间隔内拒绝，间隔过后放行", () => {
  let now = 0;
  const budget = new McpReconnectBudget({
    crashBudget: 10,
    minRetryIntervalMs: 30_000,
    now: () => now,
  });
  budget.beginAttempt("srv");
  budget.recordFailure("srv");
  now = 10_000;
  const cooling = budget.check("srv");
  assert.equal(cooling.allowed, false);
  assert.equal(cooling.reason, "cooldown");
  assert.equal(cooling.retryAfterMs, 20_000);
  now = 30_000;
  assert.deepEqual(budget.check("srv"), { allowed: true });
});

test("singleflight: 并发共享一次执行，settle 后可再次执行；失败结果原样共享", async () => {
  const run = createSingleflightRunner();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = run("srv", async () => {
    calls += 1;
    await gate;
    return "ok";
  });
  const second = run("srv", async () => {
    calls += 1;
    return "never";
  });
  release();
  assert.equal(await first, "ok");
  assert.equal(await second, "ok");
  assert.equal(calls, 1, "并发只执行一次");
  // settle 后 in-flight 清表：下一次调用重新执行（第二个 runner 函数各自计数）。
  let thirdCalls = 0;
  assert.equal(
    await run("srv", async () => {
      thirdCalls += 1;
      return "again";
    }),
    "again",
  );
  assert.equal(thirdCalls, 1, "settle 后必须重新执行");
  assert.equal(calls, 1);

  let failures = 0;
  const failing = () =>
    run("bad", async () => {
      failures += 1;
      throw new Error("boom");
    });
  const [r1, r2] = await Promise.allSettled([failing(), failing()]);
  assert.equal(r1.status, "rejected");
  assert.equal(r2.status, "rejected");
  assert.equal(failures, 1, "失败也只执行一次，错误共享给所有等待者");
});

// -----------------------------------------------
// adapter 集成：真实 stdio 子进程 fixture
// -----------------------------------------------

// 最小 stdio MCP server（newline-delimited JSON-RPC，legacy 协议，无 probe）：
// - 每次启动向 START_LOG 追加一行（spawn 计数的事实来源）；
// - RECOVER 文件存在：完整服务（tools/call 正常返回）；
// - 否则第 1 次启动：握手 + tools/list 正常，tools/call 时进程自杀（模拟崩溃 →
//   client onclose → disconnected）；第 2 次及以后启动：握手前立即退出（连接失败，
//   累积崩溃预算）。
const FAKE_SERVER_SOURCE = `
const fs = require("node:fs");
const startLog = process.env.FAKE_START_LOG;
const recoverFile = process.env.FAKE_RECOVER_FILE;
let startIndex = 1;
try {
  fs.appendFileSync(startLog, "start\\n");
  startIndex = fs.readFileSync(startLog, "utf8").split("\\n").filter(Boolean).length;
} catch {}
const recovered = Boolean(recoverFile) && fs.existsSync(recoverFile);
if (startIndex >= 2 && !recovered) {
  process.exit(1);
}
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
    if (recovered) {
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

async function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-lifecycle-"));
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
      env: { FAKE_START_LOG: startLog, FAKE_RECOVER_FILE: recoverFile },
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

test("adapter: 懒重连失败累积预算，耗尽后挂起且不再 spawn；显式重连复位", async (t) => {
  await withFixture(async ({ config, countStarts, recoverFile }) => {
    const changes = [];
    const adapter = createMcpAdapter({
      reconnect: { crashBudget: 2, minRetryIntervalMs: 0 },
      onStatusChange: (change) => changes.push(change),
    });
    t.after(() => adapter.close());

    const initial = await adapter.connectServer("fake", config);
    assert.equal(initial.status, "connected", "首次显式连接成功");
    assert.equal(countStarts(), 1);

    // 反复调用：server 在 tools/call 时自杀 → 懒重连（第 2 次起启动即崩）→ 失败累积。
    // 每轮 callTool 都必须失败；循环有界，挂起即停。
    let suspended = false;
    for (let round = 0; round < 6 && !suspended; round += 1) {
      await assert.rejects(() => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS));
      const statuses = await adapter.status();
      suspended = statuses.fake?.reconnectSuspension !== undefined;
    }
    const statuses = await adapter.status();
    assert.equal(statuses.fake.status, "failed");
    assert.ok(suspended, "崩溃预算耗尽后必须进入挂起");
    assert.equal(statuses.fake.reconnectSuspension.consecutiveFailures, 2);
    const spawnsAfterSuspension = countStarts();

    // 挂起后的调用不再 spawn，且文案带「不要循环重试」的模型指引。
    await assert.rejects(
      () => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS),
      (error) => {
        assert.match(error.message, /MCP server "fake" is unavailable/);
        assert.match(error.message, /Do not retry this tool in a loop/);
        assert.match(error.message, /suspended after 2 consecutive connection failures/);
        return true;
      },
    );
    assert.equal(countStarts(), spawnsAfterSuspension, "挂起后不得再 spawn");

    // 状态事件面：connected → … → reconnect-suspended 依序可见。
    const triggers = changes.map((change) => change.trigger);
    assert.ok(triggers.includes("connected"));
    assert.ok(triggers.includes("reconnect-suspended"));
    const suspendedEvent = changes.find((c) => c.trigger === "reconnect-suspended");
    assert.equal(suspendedEvent.serverName, "fake");
    assert.equal(suspendedEvent.status.reconnectSuspension.consecutiveFailures, 2);
    assert.ok(suspendedEvent.at);

    // 显式操作（server 已修复）复位预算并恢复服务。
    writeFileSync(recoverFile, "1", "utf8");
    const revived = await adapter.connectServer("fake", config);
    assert.equal(revived.status, "connected", "显式重连必须绕过挂起门禁");
    assert.equal(revived.reconnectSuspension, undefined);
    const result = await adapter.callTool(ECHO_REQUEST, CALL_OPTIONS);
    assert.equal(result.isError ?? false, false);
  });
});

test("adapter: 最小重试间隔内的自动重连被拒（冷却），不产生 spawn", async (t) => {
  await withFixture(async ({ config, countStarts }) => {
    const adapter = createMcpAdapter({
      reconnect: { crashBudget: 10, minRetryIntervalMs: 60_000 },
    });
    t.after(() => adapter.close());

    const initial = await adapter.connectServer("fake", config);
    assert.equal(initial.status, "connected");

    // 首轮：server 自杀 → 懒重连（启动即崩）→ 失败 1 次并登记尝试时刻。
    // SDK 断连错误的措辞与 onclose 时序存在竞态（裸错误直接冒泡 vs 下一轮走
    // disconnected 懒重连），因此循环到「确实发生过一次自动重连 spawn」为止。
    for (let round = 0; round < 4 && countStarts() < 2; round += 1) {
      await assert.rejects(() => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS));
    }
    const spawnsAfterFirstFailure = countStarts();
    assert.ok(spawnsAfterFirstFailure >= 2, "应已发生一次自动重连尝试");

    // 冷却期内的下一次调用：门禁拒绝，不再 spawn，文案带节流事实与模型指引。
    await assert.rejects(
      () => adapter.callTool(ECHO_REQUEST, CALL_OPTIONS),
      (error) => {
        assert.match(error.message, /throttled/);
        assert.match(error.message, /Do not retry this tool in a loop/);
        return true;
      },
    );
    assert.equal(countStarts(), spawnsAfterFirstFailure, "冷却期内不得再 spawn");
  });
});

test("adapter: 状态监听器抛异常不影响连接生命周期", async (t) => {
  await withFixture(async ({ config }) => {
    const adapter = createMcpAdapter({
      onStatusChange: () => {
        throw new Error("listener exploded");
      },
    });
    t.after(() => adapter.close());
    const initial = await adapter.connectServer("fake", config);
    assert.equal(initial.status, "connected", "监听器故障必须被吞掉，连接照常建立");
  });
});
