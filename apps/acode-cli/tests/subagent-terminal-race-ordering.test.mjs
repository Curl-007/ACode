import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * D3 审计问题 3 的证据测试：cancel / complete 竞态的次序语义。
 *
 * 覆盖规格 apps/acode-cli/specs/command-terminal-state-audit.md 的 R1 问题 3（3a/3b/3c）
 * 与 R2 的 E1/E2/E3。
 *
 * **本文件已从「断言缺口存在」翻转为「断言缺口已闭合」**，依据是
 * specs/subagent-terminal-first-wins.md 验收场景 9：「既有
 * subagent-terminal-race-ordering.test.mjs 里『断言缺口存在』的用例随修复更新为
 * 『断言缺口已闭合』」。修正项 #3（原语层 first-wins 守卫）与 #4（CommandInbox 约定文字）
 * 已落地，原审计结论据实更新如下：
 *   - 子代理侧的三处 finalize 守卫（runner.ts 的 finalizeBackgroundCompletion /
 *     finalizeBackgroundFailure / createBackgroundStoppedTask）**仍是非原子的快速路径**——
 *     守卫与写入之间依旧夹着真实文件 I/O（writeCompleted/Stopped/FailedAgentArtifacts，
 *     见 (6)），但并发方向现在由底层原语兜住：`InMemoryRuntimeTaskRegistry.update()`
 *     拒绝「终态 → 另一个终态」的覆盖并返回赢家快照（见 (1)，spec R1/R2）。
 *   - 两条读通道不再分叉：`waitForTerminal` 与 `registry.get()` 报告同一个终态
 *     （见 (2)，spec R5）。
 *   - 约定文字已补齐并与守卫同处一地（spec R4）：registry.ts 的 `update()` 与 runner.ts
 *     三处守卫都能 grep 到 first-wins 约定；对照物 dynamic-workflow 的 engine-settlement
 *     保持原样（本项不改一行，见 (6)）。
 *   - CommandInbox 侧 settle 幂等是同步原子的；ack 枚举里**没有 cancelled**，取消被归一成
 *     `failed`，再由 retryAck 的「failed 是终态事实」保住（见 (7)）；修正项 #4 已把这条
 *     归一**显式写进 retryAck 的约定文字**，取消方向不再只是「顺带覆盖」（见 (8)）。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const CLI = "apps/acode-cli/packages";

const { InMemoryRuntimeTaskRegistry, isTerminalRuntimeTask } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { createExploreSubagentPort } = await import("../packages/core/src/subagent/runner.ts");
const { CommandInbox } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/command-inbox.ts"
);
const { createSessionId, createTraceId } = await import(
  "../packages/contracts/src/interfaces/shared.ts"
);

function snapshot(overrides = {}) {
  return {
    agentId: "agent_1",
    agentType: "general-purpose",
    description: "audit probe",
    startedAt: new Date(1_700_000_000_000),
    status: "running",
    taskId: "agent_1",
    type: "local_agent",
    ...overrides,
  };
}

// ── 3b：registry 原语层 ─────────────────────────────────────────────

test("(1) registry.update() 有终态守卫：终态不可被另一终态双向覆盖，拒绝时返回赢家快照", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot());

  registry.update("agent_1", (task) => ({ ...task, status: "completed" }));
  assert.equal(registry.get("agent_1").status, "completed");
  assert.equal(isTerminalRuntimeTask(registry.get("agent_1")), true);

  // completed → killed：原语层拒绝（spec R1 判据：写入前后 status 都是终态且不相等）。
  const rejected = registry.update("agent_1", (task) => ({ ...task, status: "killed" }));
  assert.equal(
    registry.get("agent_1").status,
    "completed",
    "update() 覆盖了终态：registry 层的 first-wins 守卫失效",
  );
  // spec R2 / 验收场景 4：拒绝时返回**赢家快照**，不是 undefined——undefined 在本接口里的
  // 既有含义是「条目不存在」，调用方据此走 task_missing 分支，两个信号不得混淆。
  assert.notEqual(rejected, undefined, "被拒的写入不得返回 undefined（那是「条目不存在」）");
  assert.equal(rejected.status, "completed");

  // 反向同样被拒（killed/completed 对称，不存在「哪个终态更权威」的偏序）。
  registry.update("agent_1", (task) => ({ ...task, status: "killed" }));
  assert.equal(registry.get("agent_1").status, "completed");

  // spec R3：同终态条目上**不改 status** 的字段写入必须放行（notified 认领令牌、
  // output/usage/resultText 补齐都走这条路），否则通知层与产物补齐会被误挡。
  const patched = registry.update("agent_1", (task) => ({
    ...task,
    notified: true,
    resultText: "late artifact",
  }));
  assert.equal(patched.notified, true);
  assert.equal(registry.get("agent_1").resultText, "late artifact");
  assert.equal(registry.get("agent_1").status, "completed");

  // spec R3：终态 → **非终态**放行（background-task-registry.ts 的晚挂载合并依赖它）。
  registry.update("agent_1", (task) => ({ ...task, status: "running" }));
  assert.equal(registry.get("agent_1").status, "running");
});

test("(2) 两条读通道不再分叉：waiter 与 registry.get() 报告同一个终态", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot());
  const waited = registry.waitForTerminal("agent_1");

  registry.update("agent_1", (task) => ({ ...task, status: "killed" }));
  registry.update("agent_1", (task) => ({ ...task, status: "completed" }));

  // waiter 只结算一次（resolveWaiters 先 delete 整组），拿到的是**第一个**终态；
  // 第二次覆盖被 R1 拒绝，所以事后读快照（TaskOutput / 后台面板投影走的就是这条）
  // 停在同一个终态。spec R5：一致性由 R1 保证，waiter 语义本身未改。
  assert.equal((await waited).status, "killed");
  assert.equal(registry.get("agent_1").status, "killed");
});

test("(3) 其余原语守住了终态：requestBackground 拒绝、已终态立即返回、未知 id 不等待", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot({ status: "completed" }));
  assert.equal(registry.requestBackground("agent_1"), false, "终态不得再被转后台");
  assert.equal((await registry.waitForTerminal("agent_1")).status, "completed");

  // 未知 id：waitForTerminal **立即**以 undefined 收口，不会等 register。
  // 这正是 runner.ts 读快照时要用 `?? { status: "lost" }` 兜底的原因。
  const unknown = new InMemoryRuntimeTaskRegistry();
  assert.equal(await unknown.waitForTerminal("agent_missing"), undefined);

  // 已登记的非终态任务才真正挂起，并被后续终态 update 唤醒。
  const live = new InMemoryRuntimeTaskRegistry();
  live.register(snapshot({ agentId: "agent_2", status: "running", taskId: "agent_2" }));
  let resolved = false;
  const waited = live.waitForTerminal("agent_2").then((task) => {
    resolved = true;
    return task;
  });
  await Promise.resolve();
  assert.equal(resolved, false, "非终态任务的 waitForTerminal 不得提前收口");
  live.update("agent_2", (task) => ({ ...task, status: "failed" }));
  assert.equal((await waited).status, "failed");
});

// ── 3a：真实 port 的两个串行方向 ────────────────────────────────────

const PROBE_PROFILE = {
  description: "audit probe",
  name: "general-purpose",
  source: "user",
  systemPrompt: "probe",
};

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function startRequest(dir) {
  return {
    agentType: "general-purpose",
    description: "audit probe run",
    parentToolCallId: "toolu_probe",
    prompt: "do the work",
    sessionId: createSessionId("sess_d3_race"),
    trace: { traceId: createTraceId() },
    workingDirectory: dir,
    workspaceRoot: dir,
  };
}

async function flush(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    // 终态结算链上有真实文件 I/O（mkdir + writeFile），需要多轮 macrotask 才落地。
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makeHarness(dir, registry, runExploreAgent) {
  const notifications = [];
  const events = [];
  const port = createExploreSubagentPort({
    createAgentId: () => "agent_probe",
    emitParentEvent: async (event) => {
      events.push(event);
    },
    enqueueParentTaskNotification: (notification) => {
      notifications.push(notification);
      return undefined;
    },
    outputRootDir: dir,
    profiles: [PROBE_PROFILE],
    runtimeTaskRegistry: registry,
    runExploreAgent,
  });
  return { events, notifications, port };
}

test("(4) 串行方向 A：先完成后取消 → stopTask 原样返回 completed，不追发 stopped 通知", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-d3-race-a-"));
  try {
    const registry = new InMemoryRuntimeTaskRegistry();
    const gate = deferred();
    const { notifications, port } = makeHarness(dir, registry, async (request) => {
      await request.onSessionReady?.();
      await gate.promise;
      return { events: [], response: "probe result", traceId: request.traceContext.traceId };
    });

    await port.start(startRequest(dir));
    assert.equal(registry.get("agent_probe").status, "running");

    gate.resolve();
    // 修复（2026-09-29，全量套件偶发红的根因）：此处原用固定 12 轮 setTimeout(0)（flush）
    // 等 completion finalize 链落地，但轮数与链上真实文件 I/O（mkdir+writeFile）的耗时
    // 没有因果关系——29 个测试文件并发跑全量时（其他用例会 spawn 真子进程抢占 CPU 与
    // fs 线程池），I/O 回调可能晚于 12 轮 macrotask，下面的断言偶发读到 running
    // （实测：全量合跑红一次，单文件跑全绿）。改用产品原语 waitForTerminal 确定性等待
    // 终态快照写盘；通知入队与 registry.update 在 finalizeBackgroundCompletion 的同一
    // 同步块内（enqueueBackgroundNotification 是同步调用、先于任何 await），所以
    // waitForTerminal 解析时 notifications 必然已可见。断言语义不变。
    await registry.waitForTerminal("agent_probe");
    assert.equal(registry.get("agent_probe").status, "completed");
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /<status>completed<\/status>/u);

    // stopTask 的终态早退（runner.ts `if (isTerminalRuntimeTask(task)) return task;`）生效。
    const stopped = await port.stopTask("agent_probe");
    assert.equal(stopped.status, "completed", "已 completed 不得被改写成 killed");
    await flush();
    assert.equal(registry.get("agent_probe").status, "completed");
    assert.equal(notifications.length, 1, "不得追发一条 stopped 通知");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(5) 串行方向 B：先取消后失败 → killed 不被随后的 child 失败覆盖，且四通道词表一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-d3-race-b-"));
  try {
    const registry = new InMemoryRuntimeTaskRegistry();
    const { events, notifications, port } = makeHarness(dir, registry, async (request, runOptions) => {
      await request.onSessionReady?.();
      // stopTask 的 onCommitted 会 abort 这个 signal；child 据此抛错 → 触发
      // finalizeBackgroundFailure，用来验证它的终态守卫是否早退。
      await new Promise((resolve, reject) => {
        const signal = runOptions?.signal;
        if (!signal) return resolve(undefined);
        if (signal.aborted) return reject(new Error("child aborted"));
        signal.addEventListener("abort", () => reject(new Error("child aborted")), {
          once: true,
        });
        return undefined;
      });
      return { events: [], response: "unreachable", traceId: request.traceContext.traceId };
    });

    await port.start(startRequest(dir));
    assert.equal(registry.get("agent_probe").status, "running");

    const stopped = await port.stopTask("agent_probe");
    assert.equal(stopped.status, "killed");
    assert.equal(notifications.length, 1);

    // 四通道词表（BACKGROUND_AGENT_STOPPED_STATE）：registry=killed、notification/subagentEvent
    // =stopped、backgroundEvent=cancelled。跨通道一致性必须按这张表判，不能按字符串相等判。
    assert.match(notifications[0].text, /<status>stopped<\/status>/u);
    assert.match(
      notifications[0].text,
      /<summary>Agent general-purpose task &quot;audit probe run&quot; stopped\.<\/summary>/u,
    );
    const backgroundCompleted = events.filter(
      (event) => event.type === "background_task_completed",
    );
    assert.ok(backgroundCompleted.length >= 1, "缺 background_task_completed 事件");
    assert.equal(backgroundCompleted[0].payload.status, "cancelled");
    const subagentStopped = events.filter((event) => event.type === "subagent_stopped");
    assert.equal(subagentStopped.at(-1).payload.status, "stopped");

    // 让 child 的 abort 失败结算跑完。
    await flush();
    assert.equal(
      registry.get("agent_probe").status,
      "killed",
      "finalizeBackgroundFailure 的终态守卫失效：killed 被改写成 failed",
    );
    assert.equal(notifications.length, 1, "不得追发第二条通知");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(6) 约定文字核查：子代理侧与 workflow 侧都有 first-wins 约定，且与守卫同处一地", async () => {
  const runner = await read(`${CLI}/core/src/subagent/runner.ts`);
  const registry = await read(`${CLI}/core/src/runtime-task/registry.ts`);
  const settlement = await read(`${CLI}/dynamic-workflow/src/engine/engine-settlement.ts`);

  // 子代理侧：三处守卫的形状未变（仍是快速路径），但现在**每处都写明了谁是赢家/为什么**。
  assert.equal(
    runner.match(/if \(current && isTerminalRuntimeTask\(current\)\) return;/gu)?.length,
    2,
    "completion/failure 两处终态守卫的形状变了，本结论需复核",
  );
  assert.match(runner, /if \(!current \|\| isTerminalRuntimeTask\(current\)\) return undefined;/u);
  // spec R4 / 验收场景 8：约定文字必须与守卫同处一地。三条 finalize 路径各一条
  // 「终态 first-wins 的快速路径」注释（completion / failure / stopped）。
  assert.equal(
    runner.match(/终态 first-wins/gu)?.length,
    3,
    "runner.ts 三处 finalize 守卫的 first-wins 约定文字数量变了（spec R4）",
  );
  // 原语层的约定写在被守的 update() 上，而不是写在某个调用方（R4 的落点要求）。
  assert.match(registry, /first-wins/u);
  assert.match(
    registry,
    /不得被\*\*另一个终态\*\*/u,
    "registry.update() 的「终态不得被另一个终态覆盖」约定文字变了（spec R1/R4）",
  );
  // R2 的返回值约定也在案：被拒时返回赢家快照，不是 undefined。
  assert.match(registry, /返回 `current`（而不是 undefined）/u);

  // 守卫与写入之间**依旧**夹着 await（非原子窗口没有消失，spec 明确选择保留产物写入顺序）：
  // completion 路径 guard → await 产物落盘 → update。修复不是消除窗口，而是让原语层兜住它。
  const completionGuard = runner.indexOf("if (current && isTerminalRuntimeTask(current)) return;");
  const completionUpdate = runner.indexOf("const task = registry.update(lifecycle.agentId", completionGuard);
  assert.ok(completionGuard > 0 && completionUpdate > completionGuard);
  assert.match(
    runner.slice(completionGuard, completionUpdate),
    /await writeCompletedAgentArtifacts\(/u,
    "守卫与 update 之间的 await 消失了：非原子窗口的兜底理由需复核",
  );

  // workflow 侧（对照物，本项不改一行）：约定写进了模块注释，守卫与 markSettled 同步相邻。
  assert.match(settlement, /first-wins 由 `isRunSettled\(\)` 守在每条路径的第一行/u);
  assert.match(settlement, /first-wins 自然成立/u);
  assert.equal(
    settlement.match(/if \(state\.isRunSettled\(\)\) return;\n {2}state\.markSettled\(/gu)?.length,
    3,
    "三条终态路径的同步 first-wins 守卫形状变了",
  );
});

// ── 3c：CommandInbox 侧 ─────────────────────────────────────────────

const INBOX_SESSION = "sess_d3";

function makeInbox() {
  return new CommandInbox({
    getLogEpoch: () => null,
    getRevision: (sessionId) => (sessionId === INBOX_SESSION ? 3 : null),
    now: () => 1_700_000_000_000,
  });
}

function stopEnvelope(commandId) {
  return {
    clientId: "client-d3",
    commandId,
    issuedAt: 1_700_000_000_000,
    payload: {},
    sessionId: INBOX_SESSION,
    type: "stop",
  };
}

test("(7) CommandInbox settle 是同步原子的 first-wins，晚到 duplicate 拿同一终态", async () => {
  const inbox = makeInbox();
  const raw = stopEnvelope("cmd_race");
  const first = await inbox.handle(raw);
  assert.equal(first.kind, "execute");

  // 「取消」与「完成」同时到达：两次 settle 只有第一次生效（`if (settled) return` 是同步的）。
  first.settle({ reasonCode: "fault.command.inputCancelled", status: "failed" });
  first.settle({ status: "accepted" });

  const [row] = await inbox.query([{ commandId: "cmd_race", sessionId: INBOX_SESSION }]);
  assert.equal(row.result.status, "failed");
  assert.equal(row.result.reasonCode, "fault.command.inputCancelled");

  // 晚到 duplicate 拿到的仍是 failed，不被折叠成 duplicate（retryAck 的终态事实条款）。
  const replay = await inbox.handle(raw);
  assert.equal(replay.kind, "ack");
  assert.equal(replay.ack.status, "failed");
  assert.equal(replay.ack.reasonCode, "fault.command.inputCancelled");
});

test("(8) ack 枚举仍无 cancelled：取消靠归一成 failed 覆盖，且约定文字已显式点名该方向", async () => {
  const schema = await read("packages/shared/src/acode-protocol-v4/command.ts");
  assert.match(
    schema,
    /status: z\.enum\(\["accepted", "rejected", "stale", "duplicate", "noop", "failed"\]\)/u,
    "CommandAck.status 枚举变了：3c 的取消方向结论需复核",
  );

  // 归一发生在持久事实层：cancelled/discarded 的 session_input 一律投影成 status:"failed"。
  const facts = await read(`${CLI}/bootstrap/src/acode-protocol-v4/persistent-command-facts.ts`);
  assert.match(facts, /status: "failed",/u);
  assert.match(facts, /fault\.command\.inputCancelled/u);
  // 而 savePersistentCommandFact 的类型只接受 timeline|child —— admission 前的丢弃无法落盘。
  assert.match(facts, /source: Extract<PersistentCommandFactSource, "timeline" \| "child">/u);

  // 修正项 #4（只补约定文字，不改行为）：retryAck 的注释此前只点名 failed，取消方向是被
  // 「取消 → failed」这一步归一**顺带**覆盖、约定文字里查不到；现在它显式点名了这条归一，
  // 并写明「改 status 枚举或改归一投影时必须重新核对本处」。机制本身没变——枚举里依然没有
  // `cancelled`，取消依然走 failed 分支——所以下面同时钉住**文字已补**与**行为未改**两半。
  const inbox = await read(`${CLI}/bootstrap/src/acode-protocol-v4/command-inbox.ts`);
  const retryAck = inbox.slice(inbox.indexOf("private retryAck("));
  const retryAckBody = retryAck.slice(0, retryAck.indexOf("\n  }\n"));
  assert.match(retryAckBody, /failed 是终态事实，不得被 duplicate 状态覆盖/u);
  assert.match(
    retryAckBody,
    /cancel 方向靠归一化覆盖/u,
    "retryAck 的取消方向约定文字变了：修正项 #4 已落地，缺失即回退",
  );
  // 约定文字必须把「上下两半」都点到：枚举无 cancelled（上）+ 持久事实层归一投影（下）。
  assert.match(retryAckBody, /枚举里没有/u);
  assert.match(retryAckBody, /fault\.command\.inputCancelled/u);
  assert.match(retryAckBody, /persistent-command-facts\.ts/u);
  // 行为未改（修正项 #4 标注「否（纯注释）」）：仍是同一条三元表达式。
  assert.match(
    retryAckBody,
    /ack\.status === "failed" \? ack : \{ \.\.\.ack, status: "duplicate" \}/u,
  );
});
