// specs/web-reconnect.md 验收：指数退避重连逻辑（注入假 timer / 假 connect，无真实墙钟依赖）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeReconnectBackoffMs,
  createWebConnectionGenerationGuard,
  createWebReconnectController,
  type WebReconnectState,
} from "../src/reconnect/webSocketReconnect.js";

/** 假 timer：手动推进，记录所有挂起的 (handler, ms)，验证清理无泄漏。 */
function makeFakeTimers() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimeoutFn(handler: () => void, _ms: number) {
      const id = nextId++;
      pending.set(id, handler);
      return id;
    },
    clearTimeoutFn(handle: number) {
      pending.delete(handle);
    },
    /** 触发所有当前挂起的 timer（模拟退避到期），返回触发数量。 */
    fireAll(): number {
      const handlers = [...pending.values()];
      pending.clear();
      for (const handler of handlers) handler();
      return handlers.length;
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}

/** 把 promise 队列排空（controller 内部有 await，需要让微任务跑完）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

test("computeReconnectBackoffMs grows exponentially and is capped at maxDelayMs", () => {
  // random 固定为 1：去掉 jitter 随机性，只看指数增长与封顶。
  const opts = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 1 };
  assert.equal(computeReconnectBackoffMs(1, opts), 100); // 100 * 2^0
  assert.equal(computeReconnectBackoffMs(2, opts), 200); // 100 * 2^1
  assert.equal(computeReconnectBackoffMs(3, opts), 400); // 100 * 2^2
  assert.equal(computeReconnectBackoffMs(4, opts), 800); // 100 * 2^3
  assert.equal(computeReconnectBackoffMs(5, opts), 1000); // 1600 → capped 1000
  assert.equal(computeReconnectBackoffMs(50, opts), 1000); // 溢出安全，仍封顶
});

test("computeReconnectBackoffMs full jitter keeps result within [0, cap]", () => {
  // random=0 → 0；random=0.5 → cap/2；确保抖动不越上界。
  const base = { baseDelayMs: 1000, maxDelayMs: 1000 };
  assert.equal(computeReconnectBackoffMs(1, { ...base, random: () => 0 }), 0);
  assert.equal(computeReconnectBackoffMs(1, { ...base, random: () => 0.5 }), 500);
  assert.equal(computeReconnectBackoffMs(1, { ...base, random: () => 0.999 }), 999);
});

test("controller: retries with backoff on failure, emits waiting/connecting, stops on success", async () => {
  const timers = makeFakeTimers();
  const states: WebReconnectState[] = [];
  let connectCalls = 0;
  const reconnected: unknown[] = [];

  const controller = createWebReconnectController<string, number>({
    connect: async () => {
      connectCalls += 1;
      if (connectCalls < 3) {
        throw new Error("boom");
      }
      return "services-3";
    },
    onReconnected: (result) => reconnected.push(result),
    onStateChange: (state) => states.push(state),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  });

  controller.start();
  // 第一次退避挂起。
  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(states.at(-1), { phase: "waiting", attempt: 1, retryInMs: 100 });

  timers.fireAll(); // attempt 1 发起
  await flush();
  assert.equal(connectCalls, 1);
  assert.deepEqual(states.at(-2), { phase: "connecting", attempt: 1 });
  // 失败 → 第二次退避挂起（attempt 2, 200ms）。
  assert.deepEqual(states.at(-1), { phase: "waiting", attempt: 2, retryInMs: 200 });

  timers.fireAll(); // attempt 2 发起
  await flush();
  assert.equal(connectCalls, 2);
  assert.deepEqual(states.at(-1), { phase: "waiting", attempt: 3, retryInMs: 400 });

  timers.fireAll(); // attempt 3 成功
  await flush();
  assert.equal(connectCalls, 3);
  assert.deepEqual(reconnected, ["services-3"]);
  assert.deepEqual(states.at(-1), { phase: "reconnected" });
  assert.equal(controller.attempt, 0, "attempt counter resets after success");
  // 成功后不再有挂起 timer。
  assert.equal(timers.pendingCount(), 0);
});

test("controller: start() is idempotent while a loop is in flight", () => {
  const timers = makeFakeTimers();
  const controller = createWebReconnectController<string, number>({
    connect: () => new Promise<string>(() => {}), // 永不 settle，保持 connecting 态
    onReconnected: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
  });
  controller.start();
  controller.start(); // 第二次应被 looping 守卫吞掉
  assert.equal(timers.pendingCount(), 1, "concurrent start() must not double-schedule");
});

test("controller: cancel() clears pending timer and stops the loop (no leak)", async () => {
  const timers = makeFakeTimers();
  let connectCalls = 0;
  const controller = createWebReconnectController<string, number>({
    connect: async () => {
      connectCalls += 1;
      throw new Error("boom");
    },
    onReconnected: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
  });
  controller.start();
  assert.equal(timers.pendingCount(), 1);
  controller.cancel();
  assert.equal(timers.pendingCount(), 0, "cancel must clear the pending backoff timer");
  timers.fireAll(); // 已被 cancel 清空，不应触发任何 connect
  await flush();
  assert.equal(connectCalls, 0, "no connect after cancel");
});

test("controller: finite maxAttempts transitions to exhausted and stops scheduling", async () => {
  const timers = makeFakeTimers();
  const states: WebReconnectState[] = [];
  let connectCalls = 0;
  const controller = createWebReconnectController<string, number>({
    connect: async () => {
      connectCalls += 1;
      throw new Error("boom");
    },
    onReconnected: () => {},
    onStateChange: (state) => states.push(state),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
    baseDelayMs: 10,
    maxAttempts: 2,
  });
  controller.start();
  timers.fireAll();
  await flush(); // attempt 1 失败 → 调度 attempt 2
  timers.fireAll();
  await flush(); // attempt 2 失败 → 达上限
  assert.equal(connectCalls, 2);
  assert.deepEqual(states.at(-1), { phase: "exhausted", attempts: 2 });
  assert.equal(timers.pendingCount(), 0, "exhausted must not schedule another retry");
});

// ── bfcache 生命周期（pause/resume 非终态）：specs/web-reconnect.md R1.8 / 验收 8-9 ──
// pagehide(persisted=true) → pause()；pageshow(persisted=true) → resume()。不变量：真卸载不泄漏
// timer（cancel 终态），bfcache 恢复必唤醒循环（resume 非终态）。

test("controller: pause() clears the pending timer without entering the terminal state", () => {
  const timers = makeFakeTimers();
  const controller = createWebReconnectController<string, number>({
    connect: () => new Promise<string>(() => {}),
    onReconnected: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
  });
  controller.start();
  assert.equal(timers.pendingCount(), 1, "backoff timer armed");
  controller.pause();
  // 冻结期不泄漏 timer（真卸载不变量在 bfcache 路径同样成立）。
  assert.equal(timers.pendingCount(), 0, "pause must clear the pending backoff timer");
  controller.pause(); // 幂等
  assert.equal(timers.pendingCount(), 0, "pause is idempotent");
});

test("controller: resume() re-arms backoff after a bfcache pause (non-terminal round-trip)", async () => {
  const timers = makeFakeTimers();
  let connectCalls = 0;
  const controller = createWebReconnectController<string, number>({
    connect: async () => {
      connectCalls += 1;
      throw new Error("boom");
    },
    onReconnected: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
    baseDelayMs: 100,
  });
  controller.start(); // 退避等待中（looping=true）
  controller.pause(); // bfcache 进入
  assert.equal(timers.pendingCount(), 0, "frozen: no timer");
  timers.fireAll();
  await flush();
  assert.equal(connectCalls, 0, "frozen: no connect fires while paused");

  controller.resume(); // bfcache 恢复：按当前 attempt 重新武装
  assert.equal(timers.pendingCount(), 1, "resume must re-arm the backoff loop");
  timers.fireAll();
  await flush();
  assert.equal(connectCalls, 1, "resume wakes the loop → a connect fires");
});

test("controller: start() during a paused (bfcache) window is honored on resume", () => {
  const timers = makeFakeTimers();
  const controller = createWebReconnectController<string, number>({
    connect: () => new Promise<string>(() => {}),
    onReconnected: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
  });
  // 场景：socket 在后台被回收，其 close 在 pageshow 之前触发 start()（此时仍冻结）。
  controller.pause(); // 空闲态进入 bfcache（looping=false）
  controller.start(); // 冻结期收到 close：记住意图，不立即排 timer
  assert.equal(timers.pendingCount(), 0, "start() while paused must not arm a timer yet");
  controller.resume(); // pageshow：解冻，推进重连
  assert.equal(timers.pendingCount(), 1, "resume must honor the close that arrived while paused");
});

test("controller: pause()/resume() are no-ops after cancel() (terminal)", () => {
  const timers = makeFakeTimers();
  const controller = createWebReconnectController<string, number>({
    connect: () => new Promise<string>(() => {}),
    onReconnected: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
  });
  controller.start();
  controller.cancel(); // 真卸载：终态
  assert.equal(timers.pendingCount(), 0);
  controller.pause(); // cancel 后 no-op
  controller.resume(); // cancel 后 no-op，不得复活循环
  assert.equal(timers.pendingCount(), 0, "resume must not resurrect a cancelled controller");
  controller.start();
  assert.equal(timers.pendingCount(), 0, "start() is a permanent no-op after cancel");
});

// pause/resume 与在途 connect() 的交叠（bfcache 在 connect 期间进入/退出）：不变量是
// resume() 不得在 in-flight connect 之上补排 timer（否则多开 socket + 双发 onReconnected）。

test("controller: pause/resume during an in-flight connect() does NOT arm a duplicate timer (success path)", async () => {
  const timers = makeFakeTimers();
  let connectCalls = 0;
  let resolveConnect!: (value: string) => void;
  const connectPromise = new Promise<string>((resolve) => {
    resolveConnect = resolve;
  });
  const reconnected: string[] = [];
  const controller = createWebReconnectController<string, number>({
    connect: () => {
      connectCalls += 1;
      return connectPromise; // 保持 connecting 态在途
    },
    onReconnected: (r) => reconnected.push(r),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
    baseDelayMs: 0,
  });
  controller.start();
  timers.fireAll(); // 发起 connect（in-flight）
  await flush();
  assert.equal(connectCalls, 1);
  // bfcache 在 connect 在途时进入又退出。
  controller.pause();
  controller.resume();
  assert.equal(timers.pendingCount(), 0, "resume must NOT arm a timer while a connect is in flight");
  assert.equal(connectCalls, 1, "no duplicate connect while the first is in flight");
  // 在途 connect 成功：驱动一次 onReconnected（且不因 resume 而重复）。
  resolveConnect("services");
  await flush();
  assert.deepEqual(reconnected, ["services"], "exactly one onReconnected from the in-flight connect");
  assert.equal(timers.pendingCount(), 0);
});

test("controller: pause/resume during an in-flight connect() resumes backoff when that connect fails", async () => {
  const timers = makeFakeTimers();
  let connectCalls = 0;
  let rejectConnect!: (error: Error) => void;
  const connectPromise = new Promise<string>((_resolve, reject) => {
    rejectConnect = reject;
  });
  const controller = createWebReconnectController<string, number>({
    connect: () => {
      connectCalls += 1;
      return connectPromise; // 在途，稍后 reject
    },
    onReconnected: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
    baseDelayMs: 100,
  });
  controller.start();
  timers.fireAll(); // 发起 connect（in-flight）
  await flush();
  assert.equal(connectCalls, 1);
  controller.pause(); // bfcache 进入（connect 仍在途）
  controller.resume(); // bfcache 退出：不补排（in-flight），等 connect 结果驱动
  assert.equal(timers.pendingCount(), 0, "no timer while connect still in flight");
  // 在途 connect 失败 → catch 走 scheduleNext 重新武装退避。
  rejectConnect(new Error("boom"));
  await flush();
  assert.equal(timers.pendingCount(), 1, "failed in-flight connect re-arms backoff exactly once");
  timers.fireAll();
  await flush();
  assert.equal(connectCalls, 2, "exactly one follow-up connect after the failure");
});

// ── 孤儿连接处置（onDiscard）：specs/web-reconnect.md R1.9 / R7 / 验收 10 ──

test("controller: connect() resolving after cancel() is handed to onDiscard, not dropped", async () => {
  const timers = makeFakeTimers();
  let resolveConnect!: (value: string) => void;
  const connectPromise = new Promise<string>((resolve) => {
    resolveConnect = resolve;
  });
  const reconnected: string[] = [];
  const discarded: string[] = [];
  const controller = createWebReconnectController<string, number>({
    connect: () => connectPromise,
    onReconnected: (r) => reconnected.push(r),
    onDiscard: (r) => discarded.push(r),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
    baseDelayMs: 0, // 立即发起 connect
  });
  controller.start();
  timers.fireAll(); // 发起 connect（in-flight）
  await flush();
  controller.cancel(); // 换代/卸载：控制器进入终态
  resolveConnect("orphan-services"); // 孤儿 connect 迟到 resolve
  await flush();
  assert.deepEqual(discarded, ["orphan-services"], "orphan connect result must be handed to onDiscard");
  assert.deepEqual(reconnected, [], "orphan must NOT be treated as a successful reconnect");
  assert.equal(timers.pendingCount(), 0, "no timer leaked after cancel");
});

// ── 代际隔离（retryNow 换代后旧代 start() 不影响新代）：验收 11 ──
// main.tsx 用 generation token 让孤儿 socket 的 onClose 成为 no-op；此处验证控制器级隔离：
// 旧 controller cancel 后再 start() 是 no-op，不会干扰独立的新 controller。

test("controller: a cancelled (old-generation) controller does not drive a new one", async () => {
  const timers = makeFakeTimers();
  const newReconnected: string[] = [];
  let oldConnectCalls = 0;

  const oldController = createWebReconnectController<string, number>({
    connect: () => {
      oldConnectCalls += 1;
      return new Promise<string>(() => {});
    },
    onReconnected: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
    baseDelayMs: 0,
  });
  const newController = createWebReconnectController<string, number>({
    connect: async () => "new-services",
    onReconnected: (r) => newReconnected.push(r),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 1,
    baseDelayMs: 0,
  });

  oldController.start();
  timers.fireAll();
  await flush(); // 旧 controller 发起一次 connect（in-flight，永不 settle）
  assert.equal(oldConnectCalls, 1);
  oldController.cancel(); // retryNow 换代：旧 controller 终态
  // 旧 controller 的孤儿 socket 迟到 close → start()（模拟 onClose 若未做代际守卫会误驱动）。
  oldController.start();
  newController.start(); // 新 controller 独立推进
  timers.fireAll();
  await flush();
  assert.deepEqual(newReconnected, ["new-services"], "only the new controller drives a reconnect");
  // 旧 controller 已终态：孤儿 start() 是永久 no-op，不再发起任何 connect、不排 timer。
  assert.equal(oldConnectCalls, 1, "cancelled controller fires no further connect after orphan start()");
  assert.equal(timers.pendingCount(), 0, "no timer leaked from the cancelled controller");
});

// ── 连接代际守卫（createWebConnectionGenerationGuard）：specs/web-reconnect.md R5.4 / 验收 11 ──

test("generation guard: capture() tracks the generation it was taken in", () => {
  const guard = createWebConnectionGenerationGuard(1);
  const isGen1 = guard.capture();
  assert.equal(guard.current, 1);
  assert.equal(isGen1(), true, "captured generation is current before any next()");
});

test("generation guard: next() invalidates previously captured generations (orphan close)", () => {
  const guard = createWebConnectionGenerationGuard(1);
  const firstConnect = guard.capture(); // 首连那一代
  guard.next(); // retryNow 换代
  const secondConnect = guard.capture(); // 新代
  // 孤儿代（首连 socket 迟到 close）判定为 false → 其 onClose 是 no-op，不驱动当前控制器。
  assert.equal(firstConnect(), false, "old generation must no longer be current after next()");
  assert.equal(secondConnect(), true, "current generation remains current");
  assert.equal(guard.current, 2);
});

test("generation guard: reconnect attempts within one controller generation all stay current", () => {
  // 一个控制器生命周期内退避重试会多次 establish()（多次 capture），它们同属一代：
  // 只要没 next()，全部 capture 谓词都保持 true（同代 socket 的 close 都能驱动重连）。
  const guard = createWebConnectionGenerationGuard(1);
  const attempt1 = guard.capture();
  const attempt2 = guard.capture();
  const attempt3 = guard.capture();
  assert.equal(attempt1() && attempt2() && attempt3(), true);
  guard.next(); // 换代后，该代所有 capture 一并失效
  assert.equal(attempt1() || attempt2() || attempt3(), false);
});
