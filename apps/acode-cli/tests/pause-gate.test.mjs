import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * WI-10 验收测试（specs/stable-prefix-pause-gate.md R4）：PauseGate 进程级冻结闸门。
 *
 * 覆盖：
 * 1. 状态机：pause/resume 返回值与幂等、pausedAt、listener containment；
 * 2. park/解 park：闸门关闭时 waiter 挂起、resume 唤醒；未 paused 直通；
 * 3. abort 只解本 waiter（闸门保持关闭，其他 loop 继续冻结）；
 * 4. resume 后同步再 pause：waiter 必须重新 park（omp while 循环语义）；
 * 5. 双安全点冻结（假 loop）：SP① 模型调用前 / SP② 工具调用前都停走，
 *    resume 后从中断点继续；abort 期间解绕且闸门不释放；
 * 6. 安全点在位断言：turn-loop.ts 的 park 位于 runModelBackedTurnStep 之前、
 *    turn-tools.ts 的 park 位于 executeTools 之前（源级回归护栏）。
 *
 * 时序纪律（波 1 教训）：零真实计时器、零忙等。全部用 deferred + 有界微任务
 * flush 精确控制推进；每个「冻结」断言都在受控 deferred 边界上做。
 */

const { AgentPauseGate, agentPauseGate, parkAtPauseSafePoint } = await import(
  "../packages/core/src/agent/pause-gate.ts"
);

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const TURN_LOOP_PATH = join(
  TESTS_DIR,
  "..",
  "packages",
  "core",
  "src",
  "runtime",
  "methods",
  "turn-loop.ts",
);
const TURN_TOOLS_PATH = join(
  TESTS_DIR,
  "..",
  "packages",
  "core",
  "src",
  "runtime",
  "methods",
  "turn-tools.ts",
);

function createDeferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 有界微任务 flush：只推进已就绪的 promise 链，绝不轮询真实时钟。 */
async function tick(times = 12) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * 判定 promise 在当前微任务边界是否已 settle（确定性，无计时器）。
 * 用 flag 跟踪而不是 Promise.race：race 的哨兵与 .then 派生 promise 的微任务
 * 跳数不对称，会把已 resolved 的 promise 误判为 pending。已 resolve 的 promise
 * 其 .then 反应必在有界 flush 内执行；真正 park 的 promise 再多 flush 也不 settle。
 */
async function settleState(promise) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick(8);
  return settled ? "resolved" : "pending";
}

// ── 1. 状态机 ─────────────────────────────────────────────────────

test("(状态机) pause/resume 返回值、幂等与 pausedAt", () => {
  const gate = new AgentPauseGate();
  assert.equal(gate.paused, false);
  assert.equal(gate.pausedAt, undefined);
  assert.equal(gate.resume(), undefined, "未 paused 时 resume 无操作返回 undefined");

  assert.equal(gate.pause(), true);
  assert.equal(gate.paused, true);
  assert.equal(typeof gate.pausedAt, "number");
  assert.equal(gate.pause(), false, "重复 pause 幂等返回 false");

  const duration = gate.resume();
  assert.equal(typeof duration, "number");
  assert.ok(duration >= 0);
  assert.equal(gate.paused, false);
  assert.equal(gate.pausedAt, undefined);
});

test("(状态机) listener 收到 true/false 转变；抛错 listener 不破坏闸门", () => {
  const gate = new AgentPauseGate();
  const seen = [];
  const off = gate.onChange((paused) => seen.push(paused));
  gate.onChange(() => {
    throw new Error("host listener boom");
  });
  const afterThrow = [];
  gate.onChange((paused) => afterThrow.push(paused));

  gate.pause();
  gate.resume();
  assert.deepEqual(seen, [true, false]);
  assert.deepEqual(afterThrow, [true, false], "抛错 listener 之后的监听器仍被通知");

  off();
  gate.pause();
  gate.resume();
  assert.deepEqual(seen, [true, false], "退订后不再收到通知");
});

// ── 2/3/4. park / abort / 重新 park ──────────────────────────────

test("(park) 未 paused 时 waitUntilResumed 直通", async () => {
  const gate = new AgentPauseGate();
  assert.equal(await settleState(gate.waitUntilResumed()), "resolved");
});

test("(park) 闸门关闭 → waiter 挂起；resume → 唤醒", async () => {
  const gate = new AgentPauseGate();
  gate.pause();
  const waiter = gate.waitUntilResumed();
  await tick();
  assert.equal(await settleState(waiter), "pending", "paused 期间必须 park");

  gate.resume();
  await waiter;
  assert.equal(gate.paused, false);
});

test("(abort) signal 只解本 waiter：闸门保持关闭、新 waiter 继续 park", async () => {
  const gate = new AgentPauseGate();
  gate.pause();
  const controller = new AbortController();
  const waiter = gate.waitUntilResumed(controller.signal);
  await tick();
  assert.equal(await settleState(waiter), "pending");

  controller.abort();
  await waiter;
  assert.equal(gate.paused, true, "abort 释放 park 但不释放闸门");
  assert.equal(gate.pausedAt !== undefined, true);

  const other = gate.waitUntilResumed();
  await tick();
  assert.equal(await settleState(other), "pending", "其他 loop 继续冻结");
  gate.resume();
  await other;
});

test("(abort) 已 aborted 的 signal 进 park 立即返回", async () => {
  const gate = new AgentPauseGate();
  gate.pause();
  const controller = new AbortController();
  controller.abort();
  await gate.waitUntilResumed(controller.signal);
  assert.equal(gate.paused, true);
  gate.resume();
});

test("(重新 park) resume 后同步再 pause：waiter 不得漏过", async () => {
  const gate = new AgentPauseGate();
  gate.pause();
  const waiter = gate.waitUntilResumed();
  await tick();
  assert.equal(await settleState(waiter), "pending");

  gate.resume();
  gate.pause(); // waiter 续体执行前闸门重新关闭
  await tick();
  assert.equal(await settleState(waiter), "pending", "必须重新 park");

  gate.resume();
  await waiter;
});

// ── 5. 双安全点假 loop（冻结/解 park/解绕） ──────────────────────

/**
 * 假 loop：复刻 turn loop 的两个安全点结构（SP① 模型调用前、SP② 工具调用前），
 * 每次模型调用后经 testControl deferred 交还控制权——测试端由此精确决定何时
 * pause/resume/abort，不依赖任何真实时序。
 */
function createScriptedLoop(gate, signal, controls) {
  const state = { modelCalls: 0, toolCalls: 0, done: false, aborted: false };
  const park = (sig) => (gate.paused ? gate.waitUntilResumed(sig) : Promise.resolve());
  const run = (async () => {
    for (let i = 0; i < 3; i++) {
      await park(signal); // SP①
      if (signal.aborted) {
        state.aborted = true;
        break;
      }
      state.modelCalls++;
      const control = controls.shift();
      if (control) await control.promise;
      await park(signal); // SP②
      if (signal.aborted) {
        state.aborted = true;
        break;
      }
      state.toolCalls++;
    }
    state.done = true;
  })();
  return { state, run };
}

test("(双安全点) 闸门全程开启：loop 跑满 3 轮模型+工具", async () => {
  const gate = new AgentPauseGate();
  const controller = new AbortController();
  const { state, run } = createScriptedLoop(gate, controller.signal, []);
  await run;
  assert.deepEqual(
    { m: state.modelCalls, t: state.toolCalls, done: state.done, aborted: state.aborted },
    { m: 3, t: 3, done: true, aborted: false },
  );
});

test("(双安全点) SP① 冻结：pause 后模型调用停走，resume 从中断点继续", async () => {
  const gate = new AgentPauseGate();
  const controller = new AbortController();
  gate.pause(); // loop 启动即 park 在 SP①
  const { state, run } = createScriptedLoop(gate, controller.signal, []);
  await tick();
  assert.equal(state.modelCalls, 0, "冻结期间不得发起模型调用");
  assert.equal(state.done, false);

  gate.resume();
  await run;
  assert.equal(state.modelCalls, 3);
  assert.equal(state.toolCalls, 3);
  assert.equal(state.done, true);
});

test("(双安全点) SP② 冻结：模型调用后 pause，工具调用停走", async () => {
  const gate = new AgentPauseGate();
  const controller = new AbortController();
  const afterFirstModel = createDeferred();
  const { state, run } = createScriptedLoop(gate, controller.signal, [afterFirstModel]);
  await tick();
  assert.equal(state.modelCalls, 1, "第一轮模型调用已完成");
  assert.equal(state.toolCalls, 0, "loop 停在受控边界");

  gate.pause(); // 在 SP② 之前关闭闸门
  afterFirstModel.resolve();
  await tick();
  assert.equal(state.toolCalls, 0, "冻结期间不得进入工具调用");
  assert.equal(state.modelCalls, 1);

  gate.resume();
  await run;
  assert.equal(state.modelCalls, 3);
  assert.equal(state.toolCalls, 3);
});

test("(双安全点) park 期间 abort：loop 解绕、闸门保持关闭", async () => {
  const gate = new AgentPauseGate();
  const controller = new AbortController();
  gate.pause();
  const { state, run } = createScriptedLoop(gate, controller.signal, []);
  await tick();
  assert.equal(state.modelCalls, 0);

  controller.abort(); // 单 run 取消不需要解冻全进程
  await run;
  assert.equal(state.aborted, true);
  assert.equal(state.done, true);
  assert.equal(gate.paused, true, "闸门对其他 loop 保持关闭");
  gate.resume();
});

test("(单例) parkAtPauseSafePoint：开启直通、关闭挂起、resume 放行", async () => {
  assert.equal(agentPauseGate.paused, false, "前置：单例必须处于开启态");
  await parkAtPauseSafePoint();

  agentPauseGate.pause();
  try {
    const controller = new AbortController();
    const parked = parkAtPauseSafePoint(controller.signal);
    await tick();
    assert.equal(await settleState(parked), "pending");
    agentPauseGate.resume();
    await parked;
  } finally {
    // 单例是进程级共享面：无论断言结果如何都必须恢复开启态。
    if (agentPauseGate.paused) agentPauseGate.resume();
  }
  assert.equal(agentPauseGate.paused, false);
});

// ── 6. 安全点在位断言（源级回归护栏） ────────────────────────────

test("(在位) turn-loop.ts：SP① park 位于 runModelBackedTurnStep 之前", async () => {
  const source = await readFile(TURN_LOOP_PATH, "utf8");
  const parkIndex = source.indexOf("await parkAtPauseSafePoint(state.turnAbortSignal)");
  const modelStepIndex = source.indexOf("runModelBackedTurnStep.call(this, state");
  assert.ok(parkIndex >= 0, "turn-loop.ts 必须含安全点① park 调用");
  assert.ok(modelStepIndex >= 0, "turn-loop.ts 必须含模型 step 调用");
  assert.ok(parkIndex < modelStepIndex, "park 必须在模型调用之前");
  assert.match(source, /import \{ parkAtPauseSafePoint \} from "\.\.\/\.\.\/agent\/pause-gate\.js";/);
});

test("(在位) turn-tools.ts：SP② park 位于 executeTools 之前", async () => {
  const source = await readFile(TURN_TOOLS_PATH, "utf8");
  const parkIndex = source.indexOf("await parkAtPauseSafePoint(state.turnAbortSignal)");
  const executeIndex = source.indexOf("await this.executeTools(pendingToolCalls");
  assert.ok(parkIndex >= 0, "turn-tools.ts 必须含安全点② park 调用");
  assert.ok(executeIndex >= 0, "turn-tools.ts 必须含 executeTools 调用");
  assert.ok(parkIndex < executeIndex, "park 必须在工具批执行之前");
});
