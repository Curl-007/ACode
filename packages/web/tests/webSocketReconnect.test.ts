// specs/web-reconnect.md 验收：指数退避重连逻辑（注入假 timer / 假 connect，无真实墙钟依赖）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeReconnectBackoffMs,
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
