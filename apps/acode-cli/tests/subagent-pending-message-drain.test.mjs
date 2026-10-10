import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * peer-5 悬挂 bug 修复的验收（specs/subagent-pending-message-drain.md 场景 1-5）：
 * sink 注册 flush 与 turn 启动的竞态输掉后，回队消息由 turn 起点 drain 钩子在
 * 确定性边界补投；钩子/ drain 失败保持 re-queue 语义；终态守卫防向死 run 投递；
 * 修复是事件驱动单点（无周期轮询）。
 *
 * harness 沿 subagent-background-tristate.test.mjs 的桩件模式：假 runExploreAgent +
 * 自定义 profile + 临时 outputRootDir。
 */

const { createExploreSubagentPort } = await import("../packages/core/src/subagent/runner.ts");
const { createSessionId, createTraceId } = await import(
  "../packages/contracts/src/interfaces/shared.ts"
);

const cliRoot = new URL("../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (base, path) =>
  readFile(new URL(path, base), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

function makeProfile() {
  return {
    description: "probe agent",
    name: "probe-agent",
    source: "user",
    systemPrompt: "probe",
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function launchRequest(dir) {
  return {
    agentType: "probe-agent",
    description: "probe run",
    parentToolCallId: "toolu_probe",
    prompt: "probe",
    sessionId: createSessionId("sess_drain_parent"),
    trace: { traceId: createTraceId() },
    workingDirectory: dir,
    workspaceRoot: dir,
  };
}

function sendRequest(dir, to, message) {
  return {
    message,
    parentToolCallId: "toolu_probe",
    sessionId: createSessionId("sess_drain_parent"),
    summary: "probe steer",
    to,
    trace: { traceId: createTraceId() },
    workingDirectory: dir,
    workspaceRoot: dir,
  };
}

/** 可控桩：send 按 turnActive 标志成败；捕获 agentId 与 drainQueuedMessages 钩子。 */
function makeHarness(dir) {
  const harness = {
    agentId: undefined,
    delivered: [],
    drainHook: undefined,
    registered: deferred(),
    release: deferred(),
    sendAttempts: 0,
    turnActive: false,
  };
  const port = createExploreSubagentPort({
    emitParentEvent: async () => undefined,
    outputRootDir: dir,
    profiles: [makeProfile()],
    runExploreAgent: async (request) => {
      harness.agentId = request.agentId;
      request.registerMessageSink?.({
        send: async (message) => {
          harness.sendAttempts += 1;
          if (!harness.turnActive) {
            // 模拟竞态窗口：turn 未激活 → steer 以 no_active_turn 拒绝（sink 抛错 → 回队）。
            throw new Error("Subagent message rejected: no_active_turn");
          }
          harness.delivered.push(message.message);
          return "steered";
        },
      });
      harness.drainHook = request.drainQueuedMessages;
      harness.registered.resolve();
      await request.onSessionReady?.();
      await harness.release.promise;
      return { events: [], response: "probe done", traceId: request.traceContext.traceId };
    },
  });
  return { harness, port };
}

test("(场景1) 竞态输掉 → queued → turn 起点 drain 补投，无双投递", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-drain-"));
  try {
    const { harness, port } = makeHarness(dir);
    const running = port.run(launchRequest(dir));
    await harness.registered.promise;
    assert.ok(harness.agentId, "桩未拿到 agentId");
    assert.equal(typeof harness.drainHook, "function", "drainQueuedMessages 钩子未随请求下发");

    // turn 未激活（竞态窗口）：send 抛错 → 消息回队，SendMessage 返回 queued 语义。
    const queued = await port.sendMessage(sendRequest(dir, harness.agentId, "steer-1"));
    assert.equal(queued.delivery, "queued");
    assert.deepEqual(harness.delivered, []);

    // turn 激活 → drain 钩子（turn.ts onTurnStarted 的转调点）补投。
    harness.turnActive = true;
    harness.drainHook();
    await waitFor(() => harness.delivered.length === 1);
    assert.deepEqual(harness.delivered, ["steer-1"]);
    // 双触发不双投递：再 drain 一次，队列已空。
    harness.drainHook();
    await tick();
    assert.deepEqual(harness.delivered, ["steer-1"]);

    harness.release.resolve();
    const output = await running;
    assert.equal(output.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(场景2) drain 失败保持 re-queue 语义：消息不丢，修好后下一次 drain 送达", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-drain-"));
  try {
    const { harness, port } = makeHarness(dir);
    const running = port.run(launchRequest(dir));
    await harness.registered.promise;

    await port.sendMessage(sendRequest(dir, harness.agentId, "steer-2"));
    // turn 仍未激活：drain 的 flush 同样失败 → 回队（不丢）。
    harness.drainHook();
    await tick();
    assert.deepEqual(harness.delivered, []);
    assert.ok(harness.sendAttempts >= 2, "drain 未尝试重放");

    harness.turnActive = true;
    harness.drainHook();
    await waitFor(() => harness.delivered.length === 1);
    assert.deepEqual(harness.delivered, ["steer-2"]);

    harness.release.resolve();
    await running;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(场景3) 终态守卫：run 结束后 drain 为 no-op，不向死 run 投递", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-drain-"));
  try {
    const { harness, port } = makeHarness(dir);
    const running = port.run(launchRequest(dir));
    await harness.registered.promise;

    // 竞态窗口内入队，随后 run 直接完成（消息滞留队列）。
    await port.sendMessage(sendRequest(dir, harness.agentId, "steer-3"));
    harness.release.resolve();
    const output = await running;
    assert.equal(output.status, "completed");

    const attemptsBefore = harness.sendAttempts;
    harness.turnActive = true;
    harness.drainHook();
    await tick();
    assert.equal(harness.sendAttempts, attemptsBefore, "终态任务上 drain 仍尝试投递");
    assert.deepEqual(harness.delivered, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(场景4) 接线不变量：turn 激活点回调、subagent 转调、runner 单点实现带终态守卫", async () => {
  const turn = await read(cliRoot, "packages/core/src/runtime/methods/turn.ts");
  const beginIdx = turn.indexOf("beginActiveTurn(turnId, turnTraceContext");
  const hookIdx = turn.indexOf("options?.onTurnStarted?.();");
  assert.ok(beginIdx >= 0, "beginActiveTurn 激活点未找到");
  assert.ok(hookIdx > beginIdx, "onTurnStarted 回调不在 turn 激活点之后");
  assert.ok(/try \{\s*\n\s*options\?\.onTurnStarted\?\.\(\);\s*\n\s*\} catch \{/.test(turn), "钩子调用未被 try/catch 兜底（R2）");

  const subagent = await read(cliRoot, "packages/core/src/runtime/methods/subagent.ts");
  assert.ok(/onTurnStarted: \(\) => \{/.test(subagent), "executeTurn 未传 onTurnStarted");
  assert.ok(/request\.drainQueuedMessages\?\.\(\);/.test(subagent), "钩子未转调 drainQueuedMessages");

  const runner = await read(cliRoot, "packages/core/src/subagent/runner.ts");
  assert.ok(/drainQueuedMessages: \(\) => \{/.test(runner), "runner 未提供 drainQueuedMessages 实现");
  const drainIdx = runner.indexOf("drainQueuedMessages: () => {");
  const guardSlice = runner.slice(drainIdx, drainIdx + 700);
  assert.ok(/isTerminalRuntimeTask\(task\)/.test(guardSlice), "drain 实现缺终态守卫");
  assert.ok(/flushPendingMessages\(options, lifecycle, registry, task\.messageSink\)/.test(guardSlice));

  const types = await read(cliRoot, "packages/core/src/runtime/types.ts");
  assert.ok(/onTurnStarted\?: \(\) => void;/.test(types), "ExecuteTurnOptionsBase 未声明 onTurnStarted");
});

test("(场景5) 负向断言：drain 是事件驱动单点，无周期轮询", async () => {
  const runner = await read(cliRoot, "packages/core/src/subagent/runner.ts");
  assert.equal(/setInterval/.test(runner), false, "runner 出现周期 drain（违反 R3 事件驱动单点）");
  const turn = await read(cliRoot, "packages/core/src/runtime/methods/turn.ts");
  // 钩子每 turn 恰好一处调用点（单一触发面，防散落多点重复 drain）。
  assert.equal(turn.split("options?.onTurnStarted?.();").length - 1, 1);
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await tick();
  }
}
