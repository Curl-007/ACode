import assert from "node:assert/strict";
import test from "node:test";
import {
  createCancellablePollLoop,
  resolveBindCountdown,
  shouldCollapseBindCode,
  shouldPollBindResult,
  shouldPollFeishuRegistration,
  shouldPollWeixinActivation,
  shouldPollWeixinRegistration,
  shouldTickBindCountdown,
  type PollTimers,
} from "../src/BotsDialog/botsDialogPolling.js";

/**
 * BotsDialog 批次 7 外迁（botsDialogPolling.ts）的时序 + 决策表测试。
 *
 * **本文件的核心是批次 6 报告点名的「轮询取消后不回写」时序测试**：`createCancellablePollLoop`
 * 收口了原实现四处手写的 `let cancelled = false` + timer 清理 + `if (cancelled) return;`。
 * 用注入的假计时器驱动，验证 stop() 之后：① 定时器不再触发新 run；② 已在途的 run 通过
 * isCancelled() 放弃写回（这就是「取消后不回写」）；③ serial 模式不堆叠 RPC。
 */

/** 假计时器：手动推进，记录所有已注册/已清理的 handle。 */
function createFakeTimers() {
  let nextHandle = 1;
  const intervals = new Map<number, { callback: () => void; delayMs: number }>();
  const timeouts = new Map<number, { callback: () => void; delayMs: number }>();
  const cleared: number[] = [];

  const timers: PollTimers = {
    setInterval: (callback, delayMs) => {
      const handle = nextHandle++;
      intervals.set(handle, { callback, delayMs });
      return handle;
    },
    clearInterval: (handle) => {
      cleared.push(handle as number);
      intervals.delete(handle as number);
    },
    setTimeout: (callback, delayMs) => {
      const handle = nextHandle++;
      timeouts.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeout: (handle) => {
      cleared.push(handle as number);
      timeouts.delete(handle as number);
    },
  };

  return {
    timers,
    cleared,
    intervalDelays: () => [...intervals.values()].map((entry) => entry.delayMs),
    timeoutDelays: () => [...timeouts.values()].map((entry) => entry.delayMs),
    activeIntervalCount: () => intervals.size,
    activeTimeoutCount: () => timeouts.size,
    /** 触发一次 interval 回调（模拟到点）。 */
    tickInterval: () => {
      // 快照后再遍历：回调会在 tick 内再注册/清除 interval，直接迭代活 Map 会把
      // 迭代中新增的条目也在本轮触发（与 fireTimeout 同款纪律）。
      const entries = [...intervals.values()];
      for (const { callback } of entries) callback();
    },
    /** 触发一次 timeout 回调（模拟串行模式的下一次调度到点）。 */
    fireTimeout: () => {
      const entries = [...timeouts.entries()];
      if (entries.length === 0) return false;
      const [handle, { callback }] = entries[0];
      timeouts.delete(handle);
      callback();
      return true;
    },
  };
}

/** 等待微任务队列清空（run 是 async，写回发生在 await 之后）。 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---- 时序：interval 模式 ----

test("时序1: interval 模式立即先跑一次，再按 intervalMs 注册定时器", async () => {
  const fake = createFakeTimers();
  const runs: number[] = [];
  const loop = createCancellablePollLoop({
    mode: "interval",
    intervalMs: 2000,
    timers: fake.timers,
    run: async () => {
      runs.push(1);
    },
  });
  loop.start();
  await flush();
  assert.equal(runs.length, 1, "start 后应立即跑一次");
  assert.deepEqual(fake.intervalDelays(), [2000]);
  loop.stop();
});

test("时序2: interval 模式每次到点都触发 run", async () => {
  const fake = createFakeTimers();
  let count = 0;
  const loop = createCancellablePollLoop({
    mode: "interval",
    intervalMs: 1000,
    timers: fake.timers,
    run: async () => {
      count += 1;
    },
  });
  loop.start();
  await flush();
  fake.tickInterval();
  await flush();
  fake.tickInterval();
  await flush();
  assert.equal(count, 3);
  loop.stop();
});

test("时序3【核心】stop() 之后定时器被清理，不再触发新的 run", async () => {
  const fake = createFakeTimers();
  let count = 0;
  const loop = createCancellablePollLoop({
    mode: "interval",
    intervalMs: 1000,
    timers: fake.timers,
    run: async () => {
      count += 1;
    },
  });
  loop.start();
  await flush();
  assert.equal(count, 1);
  loop.stop();
  assert.equal(fake.activeIntervalCount(), 0, "stop 必须清理 interval handle");
  assert.equal(loop.isCancelled(), true);
  // 即使外部还持有旧的 tick（防御性），run 也不会再执行。
  fake.tickInterval();
  await flush();
  assert.equal(count, 1, "stop 之后不得再触发 run");
});

test("时序4【核心】已在途的 run 在 stop() 后通过 isCancelled() 放弃写回（取消后不回写）", async () => {
  const fake = createFakeTimers();
  const written: string[] = [];
  let releaseRun: (() => void) | null = null;
  const loop = createCancellablePollLoop({
    mode: "interval",
    intervalMs: 1000,
    timers: fake.timers,
    run: async (isCancelled) => {
      // 模拟慢 RPC：await 挂起，期间组件卸载（stop）
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      if (isCancelled()) return;
      written.push("write-back");
    },
  });
  loop.start();
  await flush();
  // run 已挂起在 await 上，此时 stop（等价于 effect cleanup）
  loop.stop();
  assert.equal(loop.isCancelled(), true);
  // 放行在途请求：它必须看到 isCancelled() 为真并放弃写回
  releaseRun?.();
  await flush();
  assert.deepEqual(written, [], "取消后不得写回");
});

test("时序5: 未取消时在途 run 正常写回（对照组，防测试恒真）", async () => {
  const fake = createFakeTimers();
  const written: string[] = [];
  let releaseRun: (() => void) | null = null;
  const loop = createCancellablePollLoop({
    mode: "interval",
    intervalMs: 1000,
    timers: fake.timers,
    run: async (isCancelled) => {
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      if (isCancelled()) return;
      written.push("write-back");
    },
  });
  loop.start();
  await flush();
  releaseRun?.();
  await flush();
  assert.deepEqual(written, ["write-back"]);
  loop.stop();
});

// ---- 时序：serial 模式 ----

test("时序6: serial 模式立即先跑一次，且只在下一次 await 落定后才排定时器", async () => {
  const fake = createFakeTimers();
  let finished = 0;
  let releaseFirst: (() => void) | null = null;
  const loop = createCancellablePollLoop({
    mode: "serial",
    intervalMs: 1000,
    timers: fake.timers,
    run: async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      finished += 1;
    },
  });
  loop.start();
  await flush();
  assert.equal(fake.activeTimeoutCount(), 0, "首轮未落定前不得排下一次");
  releaseFirst?.();
  await flush();
  assert.equal(finished, 1);
  assert.equal(fake.activeTimeoutCount(), 1, "落定后才排下一次");
  loop.stop();
});

test("时序7【核心】serial 模式不堆叠 RPC：上一次未返回时到点不会并发起第二次", async () => {
  const fake = createFakeTimers();
  let inFlight = 0;
  let maxInFlight = 0;
  const releases: (() => void)[] = [];
  const loop = createCancellablePollLoop({
    mode: "serial",
    intervalMs: 1000,
    timers: fake.timers,
    run: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      inFlight -= 1;
    },
  });
  loop.start();
  await flush();
  // 首轮仍在途：此时没有定时器可触发，因此不会并发第二次
  assert.equal(fake.activeTimeoutCount(), 0);
  assert.equal(maxInFlight, 1);
  releases.shift()?.();
  await flush();
  // 落定后排了下一次；触发它 → 仍只有一个在途
  fake.fireTimeout();
  await flush();
  assert.equal(maxInFlight, 1, "串行轮询的并发上限恒为 1");
  releases.shift()?.();
  await flush();
  loop.stop();
});

test("时序8【核心】serial 模式 stop() 后不再排下一次", async () => {
  const fake = createFakeTimers();
  let count = 0;
  let releaseFirst: (() => void) | null = null;
  const loop = createCancellablePollLoop({
    mode: "serial",
    intervalMs: 1000,
    timers: fake.timers,
    run: async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      count += 1;
    },
  });
  loop.start();
  await flush();
  loop.stop();
  assert.equal(fake.activeTimeoutCount(), 0);
  releaseFirst?.();
  await flush();
  assert.equal(fake.activeTimeoutCount(), 0, "stop 后不得排下一次");
  assert.equal(count, 1);
});

// ---- 守卫决策 ----

test("倒计时守卫：弹窗打开且有绑定码才走 250ms 节拍", () => {
  assert.equal(shouldTickBindCountdown({ open: true, bindCode: null }), false);
  assert.equal(shouldTickBindCountdown({ open: false, bindCode: null }), false);
  assert.equal(
    shouldTickBindCountdown({ open: true, bindCode: { botId: "b" } as never }),
    true,
  );
});

test("绑定码轮询守卫：过期后不再轮询（30 秒有效期边界）", () => {
  const bindCode = { botId: "b" } as never;
  assert.equal(shouldPollBindResult({ open: true, bindCode, bindExpired: false }), true);
  assert.equal(shouldPollBindResult({ open: true, bindCode, bindExpired: true }), false);
  assert.equal(shouldPollBindResult({ open: false, bindCode, bindExpired: false }), false);
  assert.equal(shouldPollBindResult({ open: true, bindCode: null, bindExpired: false }), false);
});

test("绑定码收起守卫：当前 Bot 已带 providerUserId 且码属于该 Bot", () => {
  const bindCode = { botId: "bot-1" } as never;
  assert.equal(
    shouldCollapseBindCode({ bindCode, selectedBotId: "bot-1", selectedBotProviderUserId: "u1" }),
    true,
  );
  assert.equal(
    shouldCollapseBindCode({ bindCode, selectedBotId: "bot-2", selectedBotProviderUserId: "u1" }),
    false,
    "码属于别的 Bot 时不能收起",
  );
  assert.equal(
    shouldCollapseBindCode({ bindCode, selectedBotId: "bot-1", selectedBotProviderUserId: undefined }),
    false,
    "尚未绑定不得收起",
  );
  assert.equal(
    shouldCollapseBindCode({ bindCode: null, selectedBotId: "bot-1", selectedBotProviderUserId: "u1" }),
    false,
  );
});

test("微信激活守卫：有凭据、未激活、且 provider 为 weixin 才轮询", () => {
  assert.equal(
    shouldPollWeixinActivation({
      open: true,
      provider: "weixin",
      credentialRef: "cred",
      weixinActivatedAt: undefined,
    }),
    true,
  );
  assert.equal(
    shouldPollWeixinActivation({
      open: true,
      provider: "weixin",
      credentialRef: "cred",
      weixinActivatedAt: 1,
    }),
    false,
    "已激活不再轮询",
  );
  assert.equal(
    shouldPollWeixinActivation({
      open: true,
      provider: "telegram",
      credentialRef: "cred",
      weixinActivatedAt: undefined,
    }),
    false,
  );
  assert.equal(
    shouldPollWeixinActivation({
      open: true,
      provider: "weixin",
      credentialRef: undefined,
      weixinActivatedAt: undefined,
    }),
    false,
    "无凭据不轮询",
  );
});

test("飞书注册守卫：只有 pending 才轮询（success/expired/error 停表）", () => {
  const base = { open: true, hasSelectedBot: true, isFeishuProvider: true };
  assert.equal(
    shouldPollFeishuRegistration({
      ...base,
      registration: { status: "pending" } as never,
    }),
    true,
  );
  for (const status of ["success", "expired", "error", "access_denied"] as const) {
    assert.equal(
      shouldPollFeishuRegistration({ ...base, registration: { status } as never }),
      false,
      `${status} 不得继续轮询`,
    );
  }
  assert.equal(shouldPollFeishuRegistration({ ...base, registration: null }), false);
});

test("微信注册守卫：pending 与 scanned 才轮询", () => {
  const base = { open: true, hasSelectedBot: true, provider: "weixin" };
  assert.equal(
    shouldPollWeixinRegistration({ ...base, registration: { status: "pending" } as never }),
    true,
  );
  assert.equal(
    shouldPollWeixinRegistration({ ...base, registration: { status: "scanned" } as never }),
    true,
  );
  for (const status of ["success", "expired", "error"] as const) {
    assert.equal(
      shouldPollWeixinRegistration({ ...base, registration: { status } as never }),
      false,
      `${status} 不得继续轮询`,
    );
  }
  assert.equal(
    shouldPollWeixinRegistration({ ...base, provider: "telegram", registration: { status: "pending" } as never }),
    false,
  );
});

// ---- 倒计时读数 ----

test("倒计时读数：无绑定码时三项归零且不算过期", () => {
  assert.deepEqual(resolveBindCountdown(null, 1000), { remainingMs: 0, expired: false, progress: 0 });
});

test("倒计时读数：中途按剩余比例算进度", () => {
  const bindCode = { expiresAt: 2000, ttlMs: 30000 } as never;
  const countdown = resolveBindCountdown(bindCode, 1000);
  assert.equal(countdown.remainingMs, 1000);
  assert.equal(countdown.expired, false);
  assert.ok(countdown.progress > 3 && countdown.progress < 4, "1000/30000 ≈ 3.3%");
});

test("倒计时读数：到点后 remaining=0、expired=true、progress=0（不出现负进度）", () => {
  const bindCode = { expiresAt: 2000, ttlMs: 30000 } as never;
  const countdown = resolveBindCountdown(bindCode, 2001);
  assert.equal(countdown.remainingMs, 0);
  assert.equal(countdown.expired, true);
  assert.equal(countdown.progress, 0);
});

test("倒计时读数：进度上限 100%（时钟回拨导致的超长剩余不会画出格）", () => {
  const bindCode = { expiresAt: 2000, ttlMs: 1000 } as never;
  const countdown = resolveBindCountdown(bindCode, 0);
  assert.equal(countdown.progress, 100);
});
