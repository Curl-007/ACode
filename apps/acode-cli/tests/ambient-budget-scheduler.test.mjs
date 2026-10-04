import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * K6「Ambient 预算感知调度」测试（specs/ambient-budget-scheduler.md 验收场景 1-10）。
 *
 *   场景 1 账本（双 kind / getHourlyRate 排除 ambient / 损坏保守 + warn / 24h 裁剪 / 每 10 条落盘）
 *   场景 2 预算公式手工数值对照 + 两边界 clamp + fallback 10k + 降级/账本坏 → 不跑
 *   场景 3 退避 ×2 链到 cap 64 + 成功重置 1
 *   场景 4 两层取交集（提议 5min/系统 30min → 30min 醒）+ direct 到期截短 sleep
 *   场景 5 busy → Paused 零 cycle；释放后 60s 内恢复
 *   场景 6 target 三态（session 投 reminder 零 agent / spawn fork / ambient cycle）
 *   场景 7 cycle 自提议围栏有/无（Scheduled / Idle 停 + 新 schedule 可重启）
 *   场景 8 权限收紧（fork 请求带非交互上下文 + 拒绝记录；permission 主域零改动）
 *   场景 9 单例（模块 guard + 队列 claim 互斥 + 过期重认领）
 *   场景 10 默认关（flag false → 零 runner；注册面未接线；cron/off-peak 域零命中）
 *
 * 机制参照 jcode (MIT) 的双层调度语义，测试用例自撰：FakeClock + fake sleep 驱动
 * runner，无网络；文件面用 tmpdir 真实读写（账本/队列的磁盘语义是被测对象）。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;

const flush = () => new Promise((resolve) => setImmediate(resolve));
/** 真实毫秒等待：Windows 临时目录的文件 IO 是毫秒级，纯微任务轮询会在墙钟耗尽前跑完。 */
const realMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await flush();
  await realMs(2);
}

/** 等待谓词为真（真实时间预算轮询；谓词可为 async）。预算 10s：Windows 临时目录
 *  IO + tsx 编译抖动下 5s 偶发超时，这里放宽的是等待耐心、不是断言强度。 */
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await realMs(2);
  }
  assert.fail("waitFor: condition not met in time");
}

/** 假时钟：deps.sleep 注册相对定时器，advance 推进假时间并依序触发到期定时器。
 * F2（批次C）后 runner 的长 sleep 按 ≤3min20s 心跳分段、busy 重查为 60s 链——一次
 * advance 会触发「定时器 → runner 真实文件 IO → 注册下一个到期定时器」的链式推进；
 * 触发一个定时器后多轮让出真实时间（idle 自旋窗口），链不至于因 IO 未完成而断掉。
 * 这里放宽的是等待耐心，不是断言强度。 */
class FakeClock {
  now = T0;
  #timers = [];

  sleep = (ms) =>
    new Promise((resolve) => {
      this.#timers.push({ due: this.now + ms, resolve });
    });

  pendingTimers() {
    return this.#timers.length;
  }

  async advance(ms) {
    this.now += ms;
    let idleSpins = 0;
    for (;;) {
      this.#timers.sort((a, b) => a.due - b.due);
      const next = this.#timers[0];
      if (!next || next.due > this.now) {
        // 没有到期定时器：给 runner 的串行文件 IO 几轮真实时间注册下一个段定时器
        //（到期时刻 ≤ now 的链尾段在此窗口内出现即继续触发）。
        if (idleSpins >= 6) break;
        idleSpins += 1;
        await settle();
        await realMs(5);
        continue;
      }
      idleSpins = 0;
      this.#timers.shift();
      next.resolve();
      await settle();
    }
    await settle();
  }
}

/**
 * 等待 runner 泊车（注册了 sleep 定时器）再推进假时钟。
 * runner 循环内有若干串行文件 IO，其「计算 sleep」落后于测试的真实时钟；不泊车就
 * advance 会让定时器锚在被推进后的假时间上，永远不到期。
 */
async function park(clock) {
  await waitFor(() => clock.pendingTimers() > 0);
  await settle();
}

async function tempDataRoot() {
  return mkdtemp(join(tmpdir(), "acode-ambient-test-"));
}

function makeLedgerDeps(dataRootDir, { now, warn } = {}) {
  return { dataRootDir, ...(now ? { now: () => now } : {}), ...(warn ? { warn } : {}) };
}

// ---------------------------------------------------------------------------
// 场景 1：usage 滚动账本
// ---------------------------------------------------------------------------

test("场景1: 账本双 kind 记账、getHourlyRate 排除 ambient、每 10 条落盘", async () => {
  const { AmbientUsageLedger, usageLedgerPath } = await import(
    "../packages/core/src/ambient/usage-ledger.ts"
  );
  const dataRoot = await tempDataRoot();
  const ledger = new AmbientUsageLedger({ dataRootDir: dataRoot });
  await ledger.loadAndTrim();

  const now = T0;
  await ledger.append({ ts: now - 30 * MIN, tokensIn: 3000, tokensOut: 1000, taskId: "s-user", kind: "user" });
  await ledger.append({ ts: now - 20 * MIN, tokensIn: 5000, tokensOut: 5000, taskId: "s-amb", kind: "ambient" });
  await ledger.append({ ts: now - 2 * HOUR - 5 * MIN, tokensIn: 9999, tokensOut: 0, taskId: "s-old", kind: "user" });

  // 双 kind 都入账。
  assert.equal(ledger.getRecords().length, 3);
  // 1h 窗口 sum（排除 ambient；2h+ 前的旧 user 记录出窗）。
  assert.equal(ledger.getHourlyRate(now), 4000);
  // ambient 均值只看 ambient kind。
  assert.equal(ledger.getRecentCycles(5), 10_000);
  // 缓冲写：不足 10 条时磁盘无内容（无任何落盘触发时文件可以尚不存在）。
  let bufferedDisk = "";
  try {
    bufferedDisk = await readFile(usageLedgerPath(dataRoot), "utf8");
  } catch {
    bufferedDisk = "";
  }
  assert.equal(bufferedDisk.trim(), "");

  for (let i = 0; i < 8; i += 1) {
    await ledger.append({ ts: now, tokensIn: 1, tokensOut: 1, taskId: `s-${i}`, kind: "user" });
  }
  const onDisk = (await readFile(usageLedgerPath(dataRoot), "utf8")).trim().split("\n");
  assert.equal(onDisk.length, 10); // 累计第 10 条触发落盘
  assert.deepEqual(JSON.parse(onDisk[0]), {
    ts: now - 30 * MIN,
    tokensIn: 3000,
    tokensOut: 1000,
    taskId: "s-user",
    kind: "user",
  });
});

test("场景1: 损坏账本 → fail-closed 保守值 + warn（getHourlyRate=∞ → ambient 不跑）", async () => {
  const { AmbientUsageLedger, usageLedgerPath, ambientDirPath } = await import(
    "../packages/core/src/ambient/usage-ledger.ts"
  );
  const { AdaptiveScheduler } = await import("../packages/core/src/ambient/scheduler.ts");
  const { mkdir } = await import("node:fs/promises");
  const dataRoot = await tempDataRoot();
  await mkdir(ambientDirPath(dataRoot), { recursive: true });
  await writeFile(
    usageLedgerPath(dataRoot),
    `${JSON.stringify({ ts: T0, tokensIn: 1, tokensOut: 1, taskId: "x", kind: "user" })}\nNOT-JSON\n`,
    "utf8",
  );
  const warns = [];
  const ledger = new AmbientUsageLedger({ dataRootDir: dataRoot, warn: (m) => warns.push(m) });
  await ledger.loadAndTrim();

  assert.ok(ledger.isCorrupted());
  assert.equal(ledger.getHourlyRate(T0), Number.POSITIVE_INFINITY);
  assert.equal(ledger.getRecentCycles(5), null);
  assert.ok(warns.some((m) => m.includes("corrupted")), "损坏必须 warn 而不是静默");

  // 接到预算公式：速率 ∞ → headroom 为负 → 本轮不可跑（interval=∞）。
  const scheduler = new AdaptiveScheduler({
    getHourlyRate: (now) => ledger.getHourlyRate(now),
    getRecentCycles: (n) => ledger.getRecentCycles(n),
    getQuotaSnapshot: async () => ({ remainingTokens: 100_000, windowRemainingMs: 2 * HOUR }),
    now: () => T0,
  });
  const decision = await scheduler.calculateBaseInterval();
  assert.equal(decision.intervalMs, Number.POSITIVE_INFINITY);
});

test("场景1: 24h 启动裁剪（旧段丢弃、文件重写）", async () => {
  const { AmbientUsageLedger, usageLedgerPath, ambientDirPath } = await import(
    "../packages/core/src/ambient/usage-ledger.ts"
  );
  const { mkdir } = await import("node:fs/promises");
  const dataRoot = await tempDataRoot();
  await mkdir(ambientDirPath(dataRoot), { recursive: true });
  const now = T0;
  const stale = { ts: now - 25 * HOUR, tokensIn: 7, tokensOut: 7, taskId: "stale", kind: "user" };
  const fresh = { ts: now - HOUR, tokensIn: 5, tokensOut: 5, taskId: "fresh", kind: "user" };
  await writeFile(
    usageLedgerPath(dataRoot),
    `${JSON.stringify(stale)}\n${JSON.stringify(fresh)}\n`,
    "utf8",
  );
  const ledger = new AmbientUsageLedger({ dataRootDir: dataRoot, now: () => now });
  await ledger.loadAndTrim();

  assert.equal(ledger.getRecords().length, 1);
  assert.equal(ledger.getRecords()[0].taskId, "fresh");
  const onDisk = (await readFile(usageLedgerPath(dataRoot), "utf8")).trim();
  assert.ok(!onDisk.includes("stale"));
  assert.ok(onDisk.includes("fresh"));
});

test("场景1: turn 旁路写——kind 按会话 ambient 标记判定；recordTurnUsageFact 接线不抛错", async () => {
  const { AmbientUsageLedger } = await import("../packages/core/src/ambient/usage-ledger.ts");
  const { appendAmbientUsageForTurn } = await import(
    "../packages/core/src/ambient/turn-usage-hook.ts"
  );
  const { markAmbientSession, clearAmbientSessionMarkers } = await import(
    "../packages/core/src/ambient/session-kind.ts"
  );
  const dataRoot = await tempDataRoot();
  const ledger = new AmbientUsageLedger({ dataRootDir: dataRoot });
  await ledger.loadAndTrim();
  clearAmbientSessionMarkers();

  await appendAmbientUsageForTurn("sess-1", { status: "completed", inputTokens: 100, outputTokens: 50 }, { ledger });
  markAmbientSession("sess-amb");
  await appendAmbientUsageForTurn("sess-amb", { status: "completed", inputTokens: 200, outputTokens: 100 }, { ledger });
  // error/cancel 与 0-token turn 不入账。
  await appendAmbientUsageForTurn("sess-1", { status: "error", inputTokens: 300, outputTokens: 0 }, { ledger });
  await appendAmbientUsageForTurn("sess-1", { status: "completed", inputTokens: 0, outputTokens: 0 }, { ledger });

  const records = ledger.getRecords();
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => [r.taskId, r.kind]),
    [
      ["sess-1", "user"],
      ["sess-amb", "ambient"],
    ],
  );

  // 接线面：真实 recordTurnUsageFact 以空 events 调用不抛错（旁路自吞错 + 0-token 守卫）。
  const { recordTurnUsageFact } = await import(
    "../packages/core/src/runtime/methods/usage-observability.ts"
  );
  await recordTurnUsageFact(
    { sessionId: "sess-x", config: {} },
    {
      completedAt: T0,
      events: [],
      startedAt: T0,
      status: "completed",
      traceContext: { traceId: "t", turnId: "turn-1", queryId: "q" },
      turnId: "turn-1",
    },
  );

  // 源码钉住：旁路写在 usageStoreFor 早退之前（观测面缺席时预算数据照常记）。
  const source = await readFile(
    new URL("../packages/core/src/runtime/methods/usage-observability.ts", import.meta.url),
    "utf8",
  );
  const bypassAt = source.indexOf("appendAmbientUsageForTurn");
  const storeAt = source.indexOf("usageStoreFor(runtime)");
  assert.ok(bypassAt > 0 && storeAt > bypassAt, "旁路写必须位于 usageStore 早退之前");
  clearAmbientSessionMarkers();
});

// ---------------------------------------------------------------------------
// 场景 2：预算公式
// ---------------------------------------------------------------------------

test("场景2: 手工数值对照（100k/10k·h/2h/0.8/5k → 4 cycle → 30min）+ 两边界 clamp + fallback", async () => {
  const { AdaptiveScheduler } = await import("../packages/core/src/ambient/scheduler.ts");

  const scheduler = new AdaptiveScheduler({
    getHourlyRate: () => 10_000,
    getRecentCycles: () => 5000,
    getQuotaSnapshot: async () => ({ remainingTokens: 100_000, windowRemainingMs: 2 * HOUR }),
    now: () => T0,
  });
  const decision = await scheduler.calculateBaseInterval();
  // (100000 − 10000×2) × (1−0.8) = 16000；ceil(16000/5000)=4；120min/4=30min。
  //（浮点：1−0.8 = 0.19999…，容差对照。）
  assert.ok(Math.abs(decision.detail.budgetTokens - 16_000) < 1e-6);
  assert.equal(decision.detail.cyclesAvailable, 4);
  assert.equal(decision.intervalMs, 30 * MIN);
  assert.equal(decision.degraded, false);

  // 下边界：raw 3min → clamp 5min。
  const clampedLow = new AdaptiveScheduler({
    getHourlyRate: () => 0,
    getRecentCycles: () => 10_000,
    getQuotaSnapshot: async () => ({ remainingTokens: 100_000, windowRemainingMs: 6 * MIN }),
    now: () => T0,
  });
  assert.equal((await clampedLow.calculateBaseInterval()).intervalMs, 5 * MIN);

  // 上边界：cycles=1、窗口 3h → raw 180min → clamp 120min。
  const clampedHigh = new AdaptiveScheduler({
    getHourlyRate: () => 0,
    getRecentCycles: () => 5000,
    getQuotaSnapshot: async () => ({ remainingTokens: 4_000, windowRemainingMs: 3 * HOUR }),
    now: () => T0,
  });
  assert.equal((await clampedHigh.calculateBaseInterval()).intervalMs, 120 * MIN);

  // 无历史 → fallback 10000 参与计算：(100000−20000)×0.2=16000；ceil(/10000)=2 → 60min。
  const fallback = new AdaptiveScheduler({
    getHourlyRate: () => 10_000,
    getRecentCycles: () => null,
    getQuotaSnapshot: async () => ({ remainingTokens: 100_000, windowRemainingMs: 2 * HOUR }),
    now: () => T0,
  });
  const fallbackDecision = await fallback.calculateBaseInterval();
  assert.equal(fallbackDecision.detail.avgCycleTokens, 10_000);
  assert.equal(fallbackDecision.intervalMs, 60 * MIN);

  // 用户速率吃满余量 → budget ≤ 0 → 不跑。
  const exhausted = new AdaptiveScheduler({
    getHourlyRate: () => 50_000,
    getRecentCycles: () => 5000,
    getQuotaSnapshot: async () => ({ remainingTokens: 100_000, windowRemainingMs: 2 * HOUR }),
    now: () => T0,
  });
  assert.equal((await exhausted.calculateBaseInterval()).intervalMs, Number.POSITIVE_INFINITY);
});

test("场景2: 配额面不可得 → 降级模式（+∞ 额度 → interval=MAX）且 degraded 标记可见", async () => {
  const { AdaptiveScheduler } = await import("../packages/core/src/ambient/scheduler.ts");
  const scheduler = new AdaptiveScheduler({
    getHourlyRate: () => 10_000,
    getRecentCycles: () => 5000,
    // 不给 getQuotaSnapshot = 配额面不可得。
    now: () => T0,
  });
  const decision = await scheduler.calculateBaseInterval();
  assert.equal(decision.degraded, true);
  assert.equal(decision.intervalMs, 120 * MIN); // 只按速率余量约束：节奏钉在 MAX。
});

// ---------------------------------------------------------------------------
// 场景 3：指数退避
// ---------------------------------------------------------------------------

test("场景3: 连续失败 → 倍率 ×2 链到 cap 64；成功重置 1", async () => {
  const { AdaptiveScheduler } = await import("../packages/core/src/ambient/scheduler.ts");
  const scheduler = new AdaptiveScheduler({
    getHourlyRate: () => 0,
    getRecentCycles: () => 5000,
    getQuotaSnapshot: async () => ({ remainingTokens: 100_000, windowRemainingMs: 6 * MIN }),
    now: () => T0,
  });
  const base = 5 * MIN;
  assert.equal((await scheduler.currentIntervalMs()), base);

  const chain = [];
  for (let i = 0; i < 8; i += 1) {
    scheduler.reportCycleFailure();
    chain.push(await scheduler.currentIntervalMs());
  }
  assert.deepEqual(
    chain,
    [10, 20, 40, 80, 160, 320, 320, 320].map((m) => m * MIN), // cap 64：5min×64=320min 封顶
  );

  scheduler.reportCycleSuccess();
  assert.equal(scheduler.currentBackoff(), 1);
  assert.equal((await scheduler.currentIntervalMs()), base);
});

// ---------------------------------------------------------------------------
// runner 测试共用装配
// ---------------------------------------------------------------------------

async function makeRunnerFixture(options = {}) {
  const { AmbientScheduleQueue } = await import("../packages/core/src/ambient/queue.ts");
  const { AdaptiveScheduler } = await import("../packages/core/src/ambient/scheduler.ts");
  const { AmbientRunner, resetActiveAmbientRunnerForTests } = await import(
    "../packages/core/src/ambient/runner.ts"
  );
  resetActiveAmbientRunnerForTests();
  const dataRoot = await tempDataRoot();
  const clock = new FakeClock();
  const queue = new AmbientScheduleQueue({ dataRootDir: dataRoot, now: () => clock.now, newId: () => `sched-${Math.random().toString(36).slice(2, 8)}` });
  const schedulerConfig =
    options.scheduler ?? { remainingTokens: 100_000, windowRemainingMs: 2 * HOUR, hourlyRate: 10_000, avgCycle: 5000 };
  const scheduler = new AdaptiveScheduler({
    getHourlyRate: () => schedulerConfig.hourlyRate,
    getRecentCycles: () => schedulerConfig.avgCycle ?? null,
    getQuotaSnapshot: async () =>
      schedulerConfig.quotaDisabled
        ? null
        : { remainingTokens: schedulerConfig.remainingTokens, windowRemainingMs: schedulerConfig.windowRemainingMs },
    now: () => clock.now,
  });
  const events = [];
  const cycleCalls = [];
  const reminders = [];
  const spawns = [];
  const state = { busy: false };
  const cycleResults = [...(options.cycleResults ?? [])];
  // F2（批次C）后 renewClaim 对「无 claim / 他人 claim」返回 false → runner 让位停循环；
  // 直构 AmbientRunner 的装配必须与 startAmbientRunner 同序：先 tryClaim 再 run。
  const ownerId = options.ownerId ?? "test-runner";
  assert.equal(await queue.tryClaim(ownerId), true, "fixture 必须先认领 claim（runner 启动前置）");
  const runner = new AmbientRunner(
    {
      enabled: true,
      queue,
      scheduler,
      cyclePort: {
        runAmbientCycle: async (request) => {
          cycleCalls.push({ atMs: clock.now, request });
          const next = cycleResults.length > 0 ? cycleResults.shift() : { status: "completed", responseText: "ok" };
          return next;
        },
      },
      deliveryPort: {
        deliverReminder: async (item) => {
          reminders.push({ atMs: clock.now, item });
        },
        spawnTask: async (item) => {
          spawns.push({ atMs: clock.now, item });
        },
      },
      isBusy: () => state.busy,
      now: () => clock.now,
      sleep: clock.sleep,
      onEvent: (event) => events.push(event),
    },
    ownerId,
  );
  return { runner, queue, clock, events, cycleCalls, reminders, spawns, state, dataRoot, scheduler, reset: resetActiveAmbientRunnerForTests };
}

test("场景4: 两层取交集——agent 提议 5min、scheduler 算 30min → 实际 30min 醒", async () => {
  const fixture = await makeRunnerFixture();
  const { runner, queue, clock, cycleCalls } = fixture;
  // 直接以 runner 形态驱动（不经 startAmbientRunner 的模块单例，隔离本用例）。
  await queue.create({
    wakeAtMs: clock.now + 5 * MIN,
    target: "ambient",
    taskDescription: "check build",
  });
  void runner.run();
  await park(clock);

  // 提议 5min 到点：系统层 30min 未到 → 不醒。
  await clock.advance(5 * MIN + 1000);
  assert.equal(cycleCalls.length, 0);

  await clock.advance(25 * MIN); // 到 30min+1s
  await waitFor(() => cycleCalls.length === 1);
  assert.equal(cycleCalls[0].atMs, T0 + 30 * MIN + 1000);
  await runner.dispose();
});

test("场景4: direct-delivery 到期截短 sleep（30min interval 被 10min 提醒 nudge）", async () => {
  const fixture = await makeRunnerFixture();
  const { runner, queue, clock, reminders, cycleCalls } = fixture;
  await queue.create({ wakeAtMs: clock.now + 40 * MIN, target: "ambient", taskDescription: "cycle later" });
  await queue.create({ wakeAtMs: clock.now + 10 * MIN, target: "session", taskDescription: "喝水提醒" });
  void runner.run();
  await park(clock);

  await clock.advance(10 * MIN + 1000);
  await waitFor(() => reminders.length === 1);
  assert.equal(reminders[0].item.taskDescription, "喝水提醒");
  assert.equal(cycleCalls.length, 0); // ambient 未到系统边界，reminder 先行投递。
  await runner.dispose();
});

// ---------------------------------------------------------------------------
// 场景 5：busy 暂停 / 恢复
// ---------------------------------------------------------------------------

test("场景5: busy → Paused 零 cycle；释放后 60s 内恢复并跑 cycle", async () => {
  const fixture = await makeRunnerFixture({ scheduler: { remainingTokens: 100_000, windowRemainingMs: 2 * HOUR, hourlyRate: 10_000, avgCycle: 5000 } });
  const { runner, queue, clock, events, cycleCalls, state } = fixture;
  await queue.create({ wakeAtMs: clock.now + 5 * MIN, target: "ambient", taskDescription: "check" });
  state.busy = true; // 启动前即活跃：首个判定就应 Paused。
  void runner.run();
  await park(clock);

  await clock.advance(30 * MIN); // 提议与系统边界都过了，但 busy。
  await waitFor(() => events.some((e) => e.type === "paused"));
  assert.equal(cycleCalls.length, 0); // 零 cycle。
  assert.equal(runner.getStatus(), "paused");
  // busy 期间继续推进：仍是零 cycle（60s 重查节奏）。
  await clock.advance(5 * MIN);
  assert.equal(cycleCalls.length, 0);

  state.busy = false;
  await clock.advance(61 * 1000); // 释放后 60s 内恢复。
  await waitFor(() => cycleCalls.length === 1);
  assert.ok(events.some((e) => e.type === "resumed"));
  await runner.dispose();
});

// ---------------------------------------------------------------------------
// 场景 6：target 三态
// ---------------------------------------------------------------------------

test("场景6: session 投回 reminder（零 agent）、spawn fork、ambient 走 cycle", async () => {
  const fixture = await makeRunnerFixture({ scheduler: { remainingTokens: 100_000, windowRemainingMs: 6 * MIN, hourlyRate: 0, avgCycle: 10_000 } });
  const { runner, queue, clock, reminders, spawns, cycleCalls } = fixture;
  await queue.create({ wakeAtMs: clock.now + 2 * MIN, target: "session", taskDescription: "reminder-only", createdBySession: "sess-main" });
  await queue.create({ wakeAtMs: clock.now + 2 * MIN, target: "spawn", taskDescription: "spawn-work" });
  await queue.create({ wakeAtMs: clock.now + 2 * MIN, target: "ambient", taskDescription: "cycle-work" });
  void runner.run();
  await park(clock);

  await clock.advance(6 * MIN + 1000); // 系统 5min 边界（clamp MIN）也到了。
  await waitFor(() => cycleCalls.length === 1);

  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].item.taskDescription, "reminder-only");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].item.taskDescription, "spawn-work");
  assert.equal(cycleCalls.length, 1); // ambient 走 cycle（fork 由端口承载）。
  assert.equal(cycleCalls[0].request.items.length, 1);
  assert.equal(cycleCalls[0].request.items[0].taskDescription, "cycle-work");
  await runner.dispose();
});

// ---------------------------------------------------------------------------
// 场景 7：cycle 自提议
// ---------------------------------------------------------------------------

test("场景7: 围栏提议 → 保持 Scheduled（新 ambient 项入队）；无围栏 → Idle 停、新 schedule 可重启", async () => {
  // 7a：有围栏。
  const withFence = await makeRunnerFixture({
    cycleResults: [
      {
        status: "completed",
        responseText: 'checked.\n```acode-schedule\n{"wakeInMinutes": 30, "taskDescription": "再查一次", "priority": "low"}\n```',
      },
    ],
  });
  await withFence.queue.create({ wakeAtMs: withFence.clock.now + 5 * MIN, target: "ambient", taskDescription: "check" });
  void withFence.runner.run();
  await park(withFence.clock);
  await withFence.clock.advance(30 * MIN + 1000);
  await waitFor(() => withFence.cycleCalls.length === 1);
  await waitFor(async () => (await withFence.queue.countPending((i) => i.target === "ambient")) === 1);
  const queued = await withFence.queue.list();
  assert.equal(queued[0].taskDescription, "再查一次");
  assert.equal(queued[0].priority, "low");
  assert.equal(withFence.runner.getStatus(), "scheduled"); // Scheduled：循环未停。
  await withFence.runner.dispose();

  // 7b：无围栏 → Idle 停循环。
  const noFence = await makeRunnerFixture({
    cycleResults: [{ status: "completed", responseText: "checked. nothing to propose." }],
  });
  await noFence.queue.create({ wakeAtMs: noFence.clock.now + 5 * MIN, target: "ambient", taskDescription: "check" });
  void noFence.runner.run();
  await park(noFence.clock);
  await noFence.clock.advance(30 * MIN + 1000);
  await waitFor(() => noFence.cycleCalls.length === 1);
  await waitFor(() => noFence.runner.getStatus() === "idle");
  await noFence.runner.settled.then((status) => assert.equal(status, "idle"));
  // Idle 后无事发生：再推进也零 cycle。
  await noFence.clock.advance(2 * HOUR);
  assert.equal(noFence.cycleCalls.length, 1);
});

test("场景7: Idle 后新 schedule 创建 → startAmbientRunner 重启循环", async () => {
  const { AmbientScheduleQueue } = await import("../packages/core/src/ambient/queue.ts");
  const { AdaptiveScheduler } = await import("../packages/core/src/ambient/scheduler.ts");
  const {
    startAmbientRunner,
    resetActiveAmbientRunnerForTests,
  } = await import("../packages/core/src/ambient/runner.ts");

  resetActiveAmbientRunnerForTests();
  const dataRoot = await tempDataRoot();
  const clock = new FakeClock();
  const queue = new AmbientScheduleQueue({ dataRootDir: dataRoot, now: () => clock.now });
  const scheduler = new AdaptiveScheduler({
    getHourlyRate: () => 0,
    getRecentCycles: () => 10_000,
    getQuotaSnapshot: async () => ({ remainingTokens: 100_000, windowRemainingMs: 6 * MIN }),
    now: () => clock.now,
  });
  const cycleCalls = [];
  const state = { busy: false };
  const deps = () => ({
    enabled: true,
    queue,
    scheduler,
    cyclePort: {
      runAmbientCycle: async (request) => {
        cycleCalls.push({ atMs: clock.now, request });
        return { status: "completed", responseText: "done" };
      },
    },
    deliveryPort: { deliverReminder: async () => {}, spawnTask: async () => {} },
    isBusy: () => state.busy,
    now: () => clock.now,
    sleep: clock.sleep,
  });

  // 第一次：跑一个到期 ambient 项 → 无提议 → idle。
  await queue.create({ wakeAtMs: clock.now + 1 * MIN, target: "ambient", taskDescription: "first" });
  const first = await startAmbientRunner(deps());
  assert.ok(first.handle);
  await park(clock);
  await clock.advance(6 * MIN);
  await waitFor(() => cycleCalls.length === 1);
  await waitFor(() => first.handle.getStatus() === "idle");
  await first.handle.settled.then((s) => assert.equal(s, "idle"));

  // 新 schedule 创建（handler 面等价动作）→ 重新启动 → 循环复活。
  await queue.create({ wakeAtMs: clock.now + 1 * MIN, target: "ambient", taskDescription: "second" });
  const second = await startAmbientRunner(deps());
  assert.ok(second.handle);
  await park(clock);
  await clock.advance(6 * MIN);
  await waitFor(() => cycleCalls.length === 2);
  await second.handle.dispose();
});

// ---------------------------------------------------------------------------
// 场景 8：R4 权限收紧
// ---------------------------------------------------------------------------

test("场景8: fork 请求带非交互权限上下文；confirm 级拒绝事件写入 cycle 结果", async () => {
  const fixture = await makeRunnerFixture({
    cycleResults: [
      {
        status: "completed",
        responseText: "checked; skipped confirm-level write.",
        deniedOperations: ["Write(src/secret.ts): confirm-level in non-interactive ambient cycle"],
      },
    ],
    scheduler: { remainingTokens: 100_000, windowRemainingMs: 6 * MIN, hourlyRate: 0, avgCycle: 10_000 },
  });
  const { runner, queue, clock, cycleCalls, events } = fixture;
  await queue.create({ wakeAtMs: clock.now + 1 * MIN, target: "ambient", taskDescription: "check" });
  void runner.run();
  await park(clock);
  await clock.advance(6 * MIN);
  await waitFor(() => cycleCalls.length === 1);

  // fork 请求（configOverrides 层最小拒绝面的载体）必须携带非交互标记。
  assert.deepEqual(cycleCalls[0].request.permission, { nonInteractive: true });
  // 拒绝事件写入 cycle 结果面（用户回来可见）。
  const denied = events.filter((e) => e.type === "denied");
  assert.equal(denied.length, 1);
  assert.ok(denied[0].operations[0].includes("confirm-level"));
  await runner.dispose();
});

test("场景8: permission 主域零改动（ambient 不触碰 permission service；旁路不影响主域）", async () => {
  const { readFile } = await import("node:fs/promises");
  const permissionService = await readFile(
    new URL("../packages/core/src/permission/service.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!permissionService.includes("ambient"), "permission/service.ts 不得被 ambient 批次改动");

  // ambient 域不 import permission 实现（R4 落点在 fork configOverrides 注入面，不是新权限层）。
  const runnerSource = await readFile(
    new URL("../packages/core/src/ambient/runner.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!runnerSource.includes("permission/service"));
  assert.ok(runnerSource.includes("nonInteractive"));
});

// ---------------------------------------------------------------------------
// 场景 9：单例
// ---------------------------------------------------------------------------

test("场景9: 双 runner 并发启动 → 模块 guard + claim 互斥，单跑", async () => {
  const { AmbientScheduleQueue } = await import("../packages/core/src/ambient/queue.ts");
  const { AdaptiveScheduler } = await import("../packages/core/src/ambient/scheduler.ts");
  const {
    startAmbientRunner,
    resetActiveAmbientRunnerForTests,
  } = await import("../packages/core/src/ambient/runner.ts");

  resetActiveAmbientRunnerForTests();
  const dataRoot = await tempDataRoot();
  const clock = new FakeClock();
  const queue = new AmbientScheduleQueue({ dataRootDir: dataRoot, now: () => clock.now });
  const scheduler = new AdaptiveScheduler({
    getHourlyRate: () => 0,
    getRecentCycles: () => 10_000,
    getQuotaSnapshot: async () => ({ remainingTokens: 100_000, windowRemainingMs: 2 * HOUR }),
    now: () => clock.now,
  });
  const cycleCalls = [];
  const deps = (ownerId) => ({
    enabled: true,
    ownerId,
    queue,
    scheduler,
    cyclePort: {
      runAmbientCycle: async (request) => {
        cycleCalls.push(ownerId);
        return { status: "completed", responseText: "ok" };
      },
    },
    deliveryPort: { deliverReminder: async () => {}, spawnTask: async () => {} },
    isBusy: () => false,
    now: () => clock.now,
    sleep: clock.sleep,
  });

  await queue.create({ wakeAtMs: clock.now + 1 * MIN, target: "ambient", taskDescription: "only-one" });
  const first = await startAmbientRunner(deps("runner-a"));
  assert.ok(first.handle);

  // 同进程第二实例：模块 guard 拒绝。
  const second = await startAmbientRunner(deps("runner-b"));
  assert.equal(second.handle, null);
  assert.equal(second.reason, "already-running");

  await park(clock);
  await clock.advance(2 * HOUR + 1000);
  await waitFor(() => cycleCalls.length === 1);
  assert.deepEqual(cycleCalls, ["runner-a"]); // 单跑。
  await first.handle.dispose();

  // 跨进程面：claim 被他者持有 → 拒绝启动；claim 过期 → 可重认领。
  assert.equal(await queue.tryClaim("other-process"), true);
  const third = await startAmbientRunner(deps("runner-c"));
  assert.equal(third.handle, null);
  assert.equal(third.reason, "claim-held");

  await clock.advance(11 * MIN); // 超过 AMBIENT_QUEUE_CLAIM_STALE_MS。
  assert.equal(await queue.tryClaim("runner-d"), true, "过期 claim 允许重认领");
  await queue.releaseClaim("runner-d");
});

// ---------------------------------------------------------------------------
// 场景 10：默认关 + 域边界
// ---------------------------------------------------------------------------

test("场景10: flag 缺省 false → 零 runner；注册面按 flag 门接线；cron/off-peak 源码零命中", async () => {
  const { AmbientScheduleQueue } = await import("../packages/core/src/ambient/queue.ts");
  const { AdaptiveScheduler } = await import("../packages/core/src/ambient/scheduler.ts");
  const {
    startAmbientRunner,
    getActiveAmbientRunner,
    resetActiveAmbientRunnerForTests,
  } = await import("../packages/core/src/ambient/runner.ts");

  resetActiveAmbientRunnerForTests();
  const clock = new FakeClock();
  const queue = new AmbientScheduleQueue({ dataRootDir: await tempDataRoot(), now: () => clock.now });
  const scheduler = new AdaptiveScheduler({ getHourlyRate: () => 0, getRecentCycles: () => null, now: () => clock.now });
  const disabled = await startAmbientRunner({
    enabled: false, // flag 缺省 false（config.ambient.enabled 未开）。
    queue,
    scheduler,
    cyclePort: { runAmbientCycle: async () => ({ status: "completed", responseText: "" }) },
    deliveryPort: { deliverReminder: async () => {}, spawnTask: async () => {} },
    isBusy: () => false,
    now: () => clock.now,
    sleep: clock.sleep,
  });
  assert.equal(disabled.handle, null);
  assert.equal(disabled.reason, "disabled");
  assert.equal(getActiveAmbientRunner(), null); // 零 runner。

  // 注册面：接线批后 flag 门在 runtime-tools（config.ambient.enabled 显式 true &&
  // 非 subagent_child——includeAutomation 同款先例）；handlers/index 的注册段消费
  // createScheduleToolEntry 工厂。行为断言（false 零注册/true 注册）见下方「接线批」测试。
  const { readFile } = await import("node:fs/promises");
  const handlersIndex = await readFile(
    new URL("../packages/core/src/tool/handlers/index.ts", import.meta.url),
    "utf8",
  );
  const runtimeTools = await readFile(
    new URL("../packages/core/src/runtime/helpers/runtime-tools.ts", import.meta.url),
    "utf8",
  );
  assert.ok(handlersIndex.includes("createScheduleToolEntry"));
  assert.ok(runtimeTools.includes("includeAmbientSchedule"));
  // 门的三条件（端口在场 + flag 显式 true + 非 subagent_child）必须同块出现——
  // 缺任何一个条件，封闭子代理或未开 flag 的会话就会看见永远不兑现的 Schedule 提议。
  const gateIndex = runtimeTools.indexOf("includeAmbientSchedule");
  assert.ok(gateIndex > 0);
  const gateBlock = runtimeTools.slice(Math.max(0, gateIndex - 900), gateIndex + 400);
  assert.ok(gateBlock.includes("ambient?.enabled !== true"), "门必须含 flag 显式 true 判定");
  assert.ok(gateBlock.includes("subagent_child"), "门必须含 subagent_child 排除");
  assert.ok(gateBlock.includes("ambientSchedulePort === undefined"), "门必须含端口在场判定");

  // 域边界钉住：ambient 域与 Schedule 工具面不引用 cron/off-peak/定时任务 repo 域
  // （overnight 场景 10 的同款源码断言口径：全文含注释零命中）。
  const { readdir } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  async function collectFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await collectFiles(full)));
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
    return files;
  }
  const ambientDir = fileURLToPath(new URL("../packages/core/src/ambient/", import.meta.url));
  const sources = [
    ...(await collectFiles(ambientDir)),
    fileURLToPath(new URL("../packages/core/src/tool/handlers/schedule.ts", import.meta.url)),
    fileURLToPath(new URL("../packages/contracts/src/tools/schedule.ts", import.meta.url)),
  ];
  assert.ok(sources.length >= 8);
  const forbidden = /off[-_]?peak|OffPeak|CronCreate|automationRepo|automationService|automationCron|offPeakTask/i;
  for (const file of sources) {
    const content = await readFile(file, "utf8");
    assert.ok(!forbidden.test(content), `${file} 不得引用 cron/off-peak/定时任务 repo 域`);
  }
});

// ---------------------------------------------------------------------------
// Schedule 工具面（R2 补充：handler 行为）
// ---------------------------------------------------------------------------

test("Schedule 工具: create/list/cancel 与上限/校验错误", async () => {
  const { AmbientScheduleQueue, SCHEDULE_MAX_ITEMS } = await import("../packages/core/src/ambient/queue.ts");
  const { createScheduleHandler } = await import("../packages/core/src/tool/handlers/schedule.ts");
  const { ScheduleInputSchema } = await import("../packages/contracts/src/tools/schedule.ts");
  const dataRoot = await tempDataRoot();
  const clock = new FakeClock();
  const queue = new AmbientScheduleQueue({ dataRootDir: dataRoot, now: () => clock.now, newId: () => `id-${Math.random()}` });
  const created = [];
  const handler = createScheduleHandler({
    queue,
    now: () => clock.now,
    sessionId: "sess-main",
    onScheduleCreated: (item) => created.push(item),
  });

  const make = await handler({
    action: "create",
    wakeInMinutes: 8,
    target: "session",
    taskDescription: "8分钟后提醒我站起来",
  });
  assert.ok(make.scheduleId);
  assert.equal(make.item.target, "session");
  assert.equal(make.item.wakeAtMs, T0 + 8 * MIN);
  assert.equal(created.length, 1, "创建成功必须触发 nudge 回调");

  const wakeAtCreate = await handler({
    action: "create",
    wakeAt: new Date(T0 + 30 * MIN).toISOString(),
    taskDescription: "absolute wake",
  });
  assert.equal(wakeAtCreate.item.wakeAtMs, T0 + 30 * MIN);

  // 缺省 target=ambient、priority=normal。
  const ambientDefault = await handler({ action: "create", wakeInMinutes: 60, taskDescription: "check later" });
  assert.equal(ambientDefault.item.target, "ambient");
  assert.equal(ambientDefault.item.priority, "normal");

  const list = await handler({ action: "list" });
  assert.equal(list.items.length, 3);

  const cancel = await handler({ action: "cancel", scheduleId: make.scheduleId });
  assert.equal(cancel.cancelled, true);
  const cancelMiss = await handler({ action: "cancel", scheduleId: "nope" });
  assert.equal(cancelMiss.cancelled, false);

  // schema 层校验：create 缺 taskDescription / wake 双填 / 缺 wake / cancel 缺 id。
  assert.equal(ScheduleInputSchema.safeParse({ action: "create", wakeInMinutes: 5 }).success, false);
  assert.equal(
    ScheduleInputSchema.safeParse({ action: "create", wakeInMinutes: 5, wakeAt: "2026-01-01T00:00:00Z", taskDescription: "x" }).success,
    false,
  );
  assert.equal(ScheduleInputSchema.safeParse({ action: "create", taskDescription: "x" }).success, false);
  assert.equal(ScheduleInputSchema.safeParse({ action: "cancel" }).success, false);
  assert.equal(ScheduleInputSchema.safeParse({ action: "create", wakeInMinutes: 0, taskDescription: "x" }).success, false);
  assert.equal(ScheduleInputSchema.safeParse({ action: "create", wakeInMinutes: 1441, taskDescription: "x" }).success, false);

  // handler 层：过去 wakeAt 拒绝。
  await assert.rejects(
    () => handler({ action: "create", wakeAt: new Date(T0 - MIN).toISOString(), taskDescription: "past" }),
    (error) => error?.message?.includes("wakeAt is in the past"),
  );

  // 上限：SCHEDULE_MAX_ITEMS=50 可读错误（此前 cancel 掉一项，现存 2 → 补 48 到 50）。
  for (let i = 0; i < SCHEDULE_MAX_ITEMS - 2; i += 1) {
    await handler({ action: "create", wakeInMinutes: 60 + i, taskDescription: `bulk-${i}` });
  }
  await assert.rejects(
    () => handler({ action: "create", wakeInMinutes: 120, taskDescription: "over-limit" }),
    (error) => error?.message?.includes("at most 50 pending schedules"),
  );
});

// ---------------------------------------------------------------------------
// 接线批（specs/ambient-budget-scheduler.md 附录 A3）：flag 门注册面 / 装配源码钉子 /
// quota 端口绑定的 happy 与 stub 两路
// ---------------------------------------------------------------------------

test("接线: flag 门注册面——false 零注册、true+闭包注册、端口缺席不注册", async () => {
  const { registerBuiltInTools } = await import("../packages/core/src/tool/handlers/index.ts");
  const { AmbientScheduleQueue } = await import("../packages/core/src/ambient/queue.ts");
  const dataRoot = await tempDataRoot();
  const queue = new AmbientScheduleQueue({ dataRootDir: dataRoot });

  const makeRegistry = () => {
    const entries = new Map();
    return {
      entries,
      registry: {
        register: (entry) => entries.set(entry.metadata.name, entry),
      },
    };
  };

  // 门关（未传 includeAmbientSchedule，模拟 config.ambient.enabled 缺省 false）→ 零注册。
  const off = makeRegistry();
  registerBuiltInTools(off.registry, { ambientSchedule: { queue } });
  assert.ok(!off.entries.has("Schedule"), "flag 缺省 false 时 Schedule 不得注册");

  // 门开 + 闭包在场 → 注册（metadata 形态来自 contracts 工厂）。
  const created = [];
  const on = makeRegistry();
  registerBuiltInTools(on.registry, {
    includeAmbientSchedule: true,
    ambientSchedule: {
      queue,
      sessionId: "sess-main",
      onScheduleCreated: (item) => created.push(item),
    },
  });
  const entry = on.entries.get("Schedule");
  assert.ok(entry, "flag 开 + 端口在场时 Schedule 必须注册");
  assert.equal(entry.metadata.riskLevel, "low");
  assert.equal(entry.metadata.needsApproval, false);
  assert.equal(entry.permission.permission, "ambient.schedule");

  // 门开但闭包缺席（CLI 未装配 ambient 队列）→ 不注册：没有 queue 的 Schedule 只会
  // 把创建的提议写向不存在的存储。
  const noPort = makeRegistry();
  registerBuiltInTools(noPort.registry, { includeAmbientSchedule: true });
  assert.ok(!noPort.entries.has("Schedule"));

  // 注册的 handler 真实驱动一次 create：queue/nudge 闭包贯通（接线正确性，不只是存在性）。
  const made = await entry.handler({
    action: "create",
    wakeInMinutes: 5,
    target: "ambient",
    taskDescription: "wiring probe",
  });
  assert.ok(made.scheduleId);
  assert.equal(created.length, 1, "onScheduleCreated（runner nudge/重启缝）必须贯通");
  const listed = await queue.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].createdBySession, "sess-main");
});

test("接线: config 解析工厂 ambient 收口（缺省 false / 显式 true / 非布尔不开启）", async () => {
  const { resolveAppRuntimeConfig } = await import("../packages/bootstrap/src/app/runtime-config.ts");
  const baseOptions = {
    cliStorageRoot: await tempDataRoot(),
    configResult: {
      config: {
        features: {},
        hooks: {},
        mcp: { servers: {} },
        memory: { use: true },
        modelAnomalyGuard: {},
        permission: {},
        skills: { memoryBudget: 0 },
        toolConcurrency: {},
      },
      sources: { project: {}, user: {} },
    },
    options: { runtimeConfig: { workingDirectory: "C:\\w" } },
    subagentOutputRootDir: "agents",
    workingDirectory: "C:\\w",
  };
  const resolvedOff = resolveAppRuntimeConfig(baseOptions);
  assert.equal(resolvedOff.runtimeConfig.ambient.enabled, false, "缺省必须收口为 false");

  const resolvedOn = resolveAppRuntimeConfig({
    ...baseOptions,
    options: { runtimeConfig: { workingDirectory: "C:\\w", ambient: { enabled: true } } },
  });
  assert.equal(resolvedOn.runtimeConfig.ambient.enabled, true, "显式 true 透传");

  const resolvedFalsy = resolveAppRuntimeConfig({
    ...baseOptions,
    options: { runtimeConfig: { workingDirectory: "C:\\w", ambient: { enabled: "yes" } } },
  });
  assert.equal(resolvedFalsy.runtimeConfig.ambient.enabled, false, "非布尔真值不得视为开启");
});

test("接线: bootstrap 装配源码钉子（fork 链/busy/reminder/ledger/生命周期绑定）", async () => {
  const ambientRuntime = await readFile(
    new URL("../packages/bootstrap/src/app/ambient-runtime.ts", import.meta.url),
    "utf8",
  );
  // fork 端口：overnight 同款链 + active 分支选择器复用（不手写第二份分支语义）。
  assert.ok(ambientRuntime.includes("forkWorkspaceFromCheckpoint"));
  assert.ok(ambientRuntime.includes("forkSourceMessagesForSession"));
  // busy 信号：既有活跃探测面，不新造。
  assert.ok(ambientRuntime.includes("hasActiveOrQueuedTurnWork"));
  // target=session 的 reminder 载体先例。
  assert.ok(ambientRuntime.includes("recordGoalStateChangeReminder"));
  // 附录 A3/A4：会话标记登记 + 共享账本显式注入 + 显式数据根。
  assert.ok(ambientRuntime.includes("markAmbientSession"));
  assert.ok(ambientRuntime.includes("setSharedAmbientUsageLedger"));
  assert.ok(ambientRuntime.includes("defaultAmbientDataRootDir"));
  // R4：nonInteractive 翻译为 fork configOverrides 的 plan 拒绝面。
  assert.ok(ambientRuntime.includes('mode: "plan"'));
  // runner 启动面 + registry 投影 type "ambient"。
  assert.ok(ambientRuntime.includes("startAmbientRunner"));
  assert.ok(ambientRuntime.includes('type: "ambient"'));

  const createApp = await readFile(
    new URL("../packages/bootstrap/src/app/create-app.ts", import.meta.url),
    "utf8",
  );
  assert.ok(createApp.includes("createAmbientRuntimeWiring"), "create-app 必须装配 ambient wiring");
  assert.ok(createApp.includes("ambientSchedulePort: ambientWiring.port"), "runtime deps 必须注入注册门端口");
  assert.ok(createApp.includes("ambientWiring.bindRuntime"), "runtime 就绪后必须绑定驱动面");
  assert.ok(createApp.includes("await ambientWiring.start()"), "装配期必须尝试启动 runner");
  assert.ok(createApp.includes("await ambientWiring.dispose()"), "app close 必须绑定 dispose");

  // core 公开入口导出 ambient 面（bootstrap 跨包导入纪律：不开深路径）。
  const coreIndex = await readFile(
    new URL("../packages/core/src/index.ts", import.meta.url),
    "utf8",
  );
  assert.ok(coreIndex.includes("./ambient/queue.js"));
  assert.ok(coreIndex.includes("./ambient/runner.js"));
  assert.ok(coreIndex.includes("forkSourceMessagesForSession"));
});

test("接线: quota 端口绑定——happy 折算与 stub 降级两路", async () => {
  const {
    pickAmbientQuotaSnapshot,
    createAmbientQuotaSnapshotPort,
    buildAmbientQuotaBalanceUrl,
    AMBIENT_QUOTA_UNIT_TO_TOKENS,
  } = await import("../packages/bootstrap/src/app/ambient-quota.ts");
  assert.equal(AMBIENT_QUOTA_UNIT_TO_TOKENS, 1, "unit→token 折算按 1:1（spec 附录：需产品确认）");

  // 纯折算：1:1、窗口剩余、模型桶优先、无 period_end 跳过、窗口已收口 → null。
  const modelBucket = {
    remaining_units: "250000",
    period_end: T0 / 1000 + 7200,
    capabilities: ["model:glm-4.7"],
  };
  assert.deepEqual(
    pickAmbientQuotaSnapshot(
      [{ remaining_units: 1000, period_end: T0 / 1000 + 3600 }, modelBucket, { remaining_units: 5 }],
      { modelId: "glm-4.7", nowMs: T0 },
    ),
    { remainingTokens: 250000, windowRemainingMs: 7200_000 },
    "模型桶优先且 string 数值可解析",
  );
  assert.equal(pickAmbientQuotaSnapshot([], { nowMs: T0 }), null);
  assert.equal(
    pickAmbientQuotaSnapshot([{ remaining_units: 10, period_end: T0 / 1000 - 60 }], { nowMs: T0 }),
    null,
    "窗口已收口按不可得处理",
  );
  assert.ok(buildAmbientQuotaBalanceUrl({}).includes("app_version="), "URL 带真实 app_version");

  const registryWith = (access) => ({
    getProvider: () => ({ config: { access } }),
  });
  const zaiAccess = { type: "zhipu-account", accountType: "zai", mode: "individual-coding-plan", entitled: true };
  const traceContext = { traceId: "tr", spanId: "sp" };
  const selection = { providerId: "zai-coding", modelId: "glm-4.7" };
  const makeHeadersPort = (apiKey) => ({
    refreshBeforeModelRequest: async () => ({ headersApplied: true, ...(apiKey ? { requestAuth: { apiKey } } : {}) }),
  });

  // happy：装配面在场 + headers port 刷出凭据 + fetch stub 返回 envelope → 1:1 折算快照。
  const fetched = [];
  const happyPort = createAmbientQuotaSnapshotPort({
    providerRegistry: registryWith(zaiAccess),
    providerRuntimeHeadersPort: makeHeadersPort("stub-key"),
    getSelection: () => selection,
    sessionId: "sess_1",
    traceContext,
    fetchImpl: async (url, init) => {
      fetched.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({ code: 0, data: { balances: [{ remaining_units: 1200, period_end: T0 / 1000 + 1800 }] } }),
      };
    },
    now: () => T0,
  });
  assert.ok(typeof happyPort === "function", "装配面完整时端口必须绑定");
  assert.deepEqual(await happyPort(), { remainingTokens: 1200, windowRemainingMs: 1800_000 });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].init.headers.Authorization, "Bearer stub-key");
  assert.match(fetched[0].url, /app_version=/);

  // stub 1：headers port 缺席（provider 装配面不完整）→ 端口整体缺席（undefined）。
  const absentPort = createAmbientQuotaSnapshotPort({
    providerRegistry: registryWith(zaiAccess),
    getSelection: () => selection,
    sessionId: "sess_1",
    traceContext,
  });
  assert.equal(absentPort, undefined, "端口缺席降级（引擎按额度 +∞ 的降级模式处理并 warn）");

  // stub 2：非账号 provider（api-key 形态）→ 运行期 null。
  const apiKeyPort = createAmbientQuotaSnapshotPort({
    providerRegistry: registryWith({ type: "api-key", apiKey: "k" }),
    providerRuntimeHeadersPort: makeHeadersPort("k"),
    getSelection: () => selection,
    sessionId: "sess_1",
    traceContext,
  });
  assert.equal(await apiKeyPort(), null);

  // stub 3：无模型选择 / headers 刷新未生效 / HTTP 非 2xx / envelope code!==0 / 网络异常 → null。
  const makePort = (overrides) =>
    createAmbientQuotaSnapshotPort({
      providerRegistry: registryWith(zaiAccess),
      providerRuntimeHeadersPort: makeHeadersPort("stub-key"),
      getSelection: () => selection,
      sessionId: "sess_1",
      traceContext,
      now: () => T0,
      ...overrides,
    });
  assert.equal(await makePort({ getSelection: () => undefined })(), null, "无模型选择 → null");
  assert.equal(
    await makePort({ providerRuntimeHeadersPort: { refreshBeforeModelRequest: async () => ({ headersApplied: false }) } })(),
    null,
    "headers 刷新未生效 → null",
  );
  assert.equal(await makePort({ fetchImpl: async () => ({ ok: false }) })(), null, "HTTP 失败 → null");
  assert.equal(
    await makePort({
      fetchImpl: async () => ({ ok: true, json: async () => ({ code: 401, msg: "unauthorized" }) }),
    })(),
    null,
    "envelope 业务码非 0 → null",
  );
  assert.equal(
    await makePort({ fetchImpl: async () => Promise.reject(new Error("network down")) })(),
    null,
    "网络异常 → null（不反噬 runner）",
  );
});

// ---------------------------------------------------------------------------
// 批次C对抗复核回归（spec 附录 A6：F2/F3/F7/F8/F9/F10/F11/F12）
// ---------------------------------------------------------------------------

test("F2: claim 被接管 → 原 runner 下一心跳检测 renew=false 让位停循环（双跑防护）", async () => {
  const fixture = await makeRunnerFixture();
  const { runner, queue, clock, events, cycleCalls } = fixture;
  // 长睡眠场景：ambient 项 120min 后到期，系统 interval 30min → 单次 sleep 120min，
  // 远超 CLAIM_STALE=10min（正是 POC 实证的双跑窗口）。
  await queue.create({ wakeAtMs: clock.now + 120 * MIN, target: "ambient", taskDescription: "later" });
  void runner.run();
  await park(clock);

  // 推进一个心跳段：段醒必须续租（claimedAtMs 前移）。
  await clock.advance(4 * MIN);
  await waitFor(async () => (await queue.getClaim()).claimedAtMs > T0);
  const claimBefore = await queue.getClaim();
  assert.equal(claimBefore.ownerId, "test-runner");

  // 他进程接管：tryClaim 传 STALE 之后的时刻 → 旧 claim 视为过期可重认领。
  assert.equal(await queue.tryClaim("hostile-takeover", clock.now + 11 * MIN), true);

  // 原 runner 下一个心跳段（≤ AMBIENT_CLAIM_RENEW_SEGMENT_MS 后）检测 renew=false → 停止。
  await clock.advance(4 * MIN);
  await waitFor(() => runner.getStatus() === "stopped");
  assert.ok(events.some((e) => e.type === "claim-lost"), "必须发 claim-lost 事件（可观测面）");
  await runner.settled.then((s) => assert.equal(s, "stopped"));

  // 停止后不得再消费（cycles 不再增加）。
  const cyclesAtStop = cycleCalls.length;
  await clock.advance(30 * MIN);
  assert.equal(cycleCalls.length, cyclesAtStop, "让位后原 runner 不得再跑 cycle");

  // 让位不误伤接管者的 claim（不 release 他人锁；显式 dispose 也不得清掉它）。
  await runner.dispose();
  assert.equal((await queue.getClaim()).ownerId, "hostile-takeover");
  await queue.releaseClaim("hostile-takeover");
});

test("F2: 120min 长 sleep 期间每 ≈3min20s 心跳续租（claim 不落入 STALE 窗口）", async () => {
  const fixture = await makeRunnerFixture();
  const { runner, queue, clock } = fixture;
  await queue.create({ wakeAtMs: clock.now + 120 * MIN, target: "ambient", taskDescription: "later" });
  void runner.run();
  await park(clock);

  // 逐段推进并采样：每段醒 claimedAtMs 前移，且与当前时刻的差始终 < CLAIM_STALE。
  let lastSeen = -Infinity;
  for (let i = 0; i < 4; i += 1) {
    await clock.advance(3 * MIN + 30 * 1000);
    await waitFor(async () => (await queue.getClaim()).claimedAtMs > lastSeen);
    const claim = await queue.getClaim();
    assert.equal(claim.ownerId, "test-runner");
    lastSeen = claim.claimedAtMs;
    assert.ok(clock.now - lastSeen < 10 * MIN, `claim 不得落到 STALE 之外（第 ${i + 1} 段）`);
  }
  await runner.dispose();
});

test("F3: 同进程并发 create×N 与 popReady 交错——串行化后无丢写无异常", async () => {
  const { AmbientScheduleQueue } = await import("../packages/core/src/ambient/queue.ts");
  const dataRoot = await tempDataRoot();
  let seq = 0;
  const queue = new AmbientScheduleQueue({
    dataRootDir: dataRoot,
    now: () => T0,
    newId: () => `sched-${seq++}`,
  });
  const N = 25;
  const operations = [];
  for (let i = 0; i < N; i += 1) {
    operations.push(
      queue.create({ wakeAtMs: T0 + i, target: "ambient", taskDescription: `c-${i}` }),
    );
  }
  const popPromise = queue.popReady(T0 + 1000); // 与 create 并发交错（全部 due）。
  operations.push(popPromise);
  const results = await Promise.all(operations); // 任一异常都会在此炸出（fail-loud）。
  const popped = results[results.length - 1];
  const remaining = await queue.list();
  assert.equal(remaining.length + popped.length, N, "无丢写：创建数 = 剩余 + 取走");
  const ids = new Set([...remaining, ...popped].map((item) => item.scheduleId));
  assert.equal(ids.size, N, "无重复/无丢失的 scheduleId");

  // tmp 唯一性与 ENOENT 瞬态名单的源码钉子（并发 rename 撞共享 tmp 是丢写根因）。
  const source = await readFile(
    new URL("../packages/core/src/ambient/queue.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /randomUUID\(\)\.slice\(0, 8\)/u, "tmp 名必须带 uuid 唯一段");
  assert.match(source, /process\.pid/u, "tmp 名必须带 pid 段");
  assert.match(
    source, /code === "EPERM" \|\| code === "EBUSY" \|\| code === "EACCES" \|\| code === "ENOENT"/u,
    "ENOENT 必须并入瞬态 rename 名单",
  );
  assert.match(source, /private enqueue/u, "队列变更必须经串行化入口");
});

test("F7: 半截尾行宽容（不判 corrupted 正常跑）+ 小裁剪不触发全量重写", async () => {
  const { AmbientUsageLedger, usageLedgerPath, ambientDirPath } = await import(
    "../packages/core/src/ambient/usage-ledger.ts"
  );
  const { mkdir } = await import("node:fs/promises");

  // 1) 半截尾行：追加写的天然中间态（无结尾换行 + JSON 撕裂）→ 丢弃该行、不判 corrupted。
  const tornRoot = await tempDataRoot();
  await mkdir(ambientDirPath(tornRoot), { recursive: true });
  const good1 = { ts: T0 - 30 * MIN, tokensIn: 3000, tokensOut: 1000, taskId: "g1", kind: "user" };
  const good2 = { ts: T0 - 20 * MIN, tokensIn: 5000, tokensOut: 5000, taskId: "g2", kind: "user" };
  await writeFile(
    usageLedgerPath(tornRoot),
    `${JSON.stringify(good1)}\n${JSON.stringify(good2)}\n{"ts":123,"tokensIn":`,
    "utf8",
  );
  const warns = [];
  const tornLedger = new AmbientUsageLedger({ dataRootDir: tornRoot, now: () => T0, warn: (m) => warns.push(m) });
  await tornLedger.loadAndTrim();
  assert.equal(tornLedger.isCorrupted(), false, "半截尾行不是整本损坏");
  assert.equal(tornLedger.getRecords().length, 2, "完整行保留");
  assert.ok(Number.isFinite(tornLedger.getHourlyRate(T0)), "该进程正常跑（速率有限）");
  assert.ok(warns.some((m) => m.includes("torn tail")), "撕裂尾行应有 warn（不静默）");

  // 2) 小裁剪：20 行里 1 行过期（5% ≤ 10% 阈值）→ 不重写（磁盘保留原样）。
  const trimRoot = await tempDataRoot();
  await mkdir(ambientDirPath(trimRoot), { recursive: true });
  const lines = [];
  for (let i = 0; i < 19; i += 1) {
    lines.push(JSON.stringify({ ts: T0 - HOUR, tokensIn: 1, tokensOut: 1, taskId: `f-${i}`, kind: "user" }));
  }
  const staleLine = JSON.stringify({ ts: T0 - 25 * HOUR, tokensIn: 9, tokensOut: 9, taskId: "stale", kind: "user" });
  lines.push(staleLine);
  await writeFile(usageLedgerPath(trimRoot), `${lines.join("\n")}\n`, "utf8");
  const trimLedger = new AmbientUsageLedger({ dataRootDir: trimRoot, now: () => T0 });
  await trimLedger.loadAndTrim();
  assert.equal(trimLedger.getRecords().length, 19, "内存按 24h 窗口裁剪");
  const onDisk = await readFile(usageLedgerPath(trimRoot), "utf8");
  assert.ok(onDisk.includes("stale"), "小裁剪不触发全量重写（缩小多进程交错窗口）");
});

test("F8: flush 失败回填 pendingLines 头部重试；回填仍有界（超限丢最旧）", async () => {
  const { AmbientUsageLedger, usageLedgerPath, ambientDirPath } = await import(
    "../packages/core/src/ambient/usage-ledger.ts"
  );
  const { USAGE_LEDGER_MAX_PENDING_LINES } = await import(
    "../packages/core/src/ambient/constants.ts"
  );
  const { mkdir, rm } = await import("node:fs/promises");
  const dataRoot = await tempDataRoot();
  await mkdir(ambientDirPath(dataRoot), { recursive: true });
  // 让 usage.jsonl 成为一个目录：appendFile 必失败（注入 flush 故障的最小手段）。
  await mkdir(usageLedgerPath(dataRoot), { recursive: true });
  const warns = [];
  const ledger = new AmbientUsageLedger({ dataRootDir: dataRoot, now: () => T0, warn: (m) => warns.push(m) });
  await ledger.loadAndTrim();

  for (let i = 0; i < 3; i += 1) {
    await ledger.append({ ts: T0, tokensIn: i + 1, tokensOut: 0, taskId: `r-${i}`, kind: "user" });
  }
  await ledger.flush();
  assert.equal(ledger.getPendingLineCount(), 3, "失败后缓冲回填（不丢行）");
  assert.ok(warns.some((m) => m.includes("flush failed")), "失败必须 warn");
  assert.equal(ledger.getRecords().length, 3, "内存面不受 flush 失败影响");

  // 故障恢复：移除目录占位 → 重试 flush 成功 → 行完整落盘且顺序保持（头部回填语义）。
  await rm(usageLedgerPath(dataRoot), { recursive: true });
  await ledger.flush();
  assert.equal(ledger.getPendingLineCount(), 0);
  const onDisk = (await readFile(usageLedgerPath(dataRoot), "utf8")).trim().split("\n");
  assert.equal(onDisk.length, 3);
  assert.equal(JSON.parse(onDisk[0]).taskId, "r-0");

  // 有界：持续失败下 pending 封顶在 USAGE_LEDGER_MAX_PENDING_LINES（丢最旧）。
  await rm(usageLedgerPath(dataRoot), { recursive: true });
  await mkdir(usageLedgerPath(dataRoot), { recursive: true });
  for (let i = 3; i < 3 + USAGE_LEDGER_MAX_PENDING_LINES + 12; i += 1) {
    await ledger.append({ ts: T0, tokensIn: 1, tokensOut: 0, taskId: `r-${i}`, kind: "user" });
  }
  assert.equal(ledger.getPendingLineCount(), USAGE_LEDGER_MAX_PENDING_LINES, "缓冲有界");
  await rm(usageLedgerPath(dataRoot), { recursive: true });
  await ledger.flush();
  const bounded = (await readFile(usageLedgerPath(dataRoot), "utf8")).trim().split("\n");
  assert.equal(bounded.length, USAGE_LEDGER_MAX_PENDING_LINES);
  assert.equal(
    JSON.parse(bounded[0]).taskId,
    "r-15",
    "超限丢最旧（r-0..r-2 已落盘；r-3..r-14 共 12 行被挤出 1000 上限）",
  );
});

test("F9: spawn 的 fork 不标记 ambient session——turn 用量按 kind=user 计入用户速率", async () => {
  const { AmbientUsageLedger } = await import("../packages/core/src/ambient/usage-ledger.ts");
  const { appendAmbientUsageForTurn } = await import(
    "../packages/core/src/ambient/turn-usage-hook.ts"
  );
  const { clearAmbientSessionMarkers } = await import(
    "../packages/core/src/ambient/session-kind.ts"
  );
  clearAmbientSessionMarkers();
  const dataRoot = await tempDataRoot();
  const ledger = new AmbientUsageLedger({ dataRootDir: dataRoot });
  await ledger.loadAndTrim();

  // 行为面：未标记会话（spawn 的 fork 不标）的 turn 用量 → kind="user"（计入用户速率）。
  // turn-usage-hook 的 ts 取真实 Date.now()（旁路写不注入假时钟），速率窗口锚真实时刻。
  await appendAmbientUsageForTurn(
    "spawn-forked-session",
    { status: "completed", inputTokens: 700, outputTokens: 300 },
    { ledger },
  );
  assert.equal(ledger.getRecords()[0].kind, "user");
  assert.equal(ledger.getHourlyRate(Date.now()), 1000, "spawn 消耗计入用户 1h 速率");

  // 源码钉子：spawnTask 的 fork 传 "spawn"（不标 ambient）；标记仅 cycle 路径。
  const ambientRuntime = await readFile(
    new URL("../packages/bootstrap/src/app/ambient-runtime.ts", import.meta.url),
    "utf8",
  );
  assert.match(ambientRuntime, /forkAmbientChildRuntime\("spawn"\)/u, "spawn 必须走不标记的 fork 路径");
  assert.match(
    ambientRuntime, /if \(kind === "ambient-cycle"\) \{\s*\r?\n\s*markAmbientSession/u,
    "markAmbientSession 必须仅 cycle 路径调用",
  );
  clearAmbientSessionMarkers();
});

test("F10: subagent_child / workflow_child / nested_workflow_child 三类子会话均不注册 Schedule", async () => {
  const source = await readFile(
    new URL("../packages/core/src/runtime/helpers/runtime-tools.ts", import.meta.url),
    "utf8",
  );
  const gateIndex = source.indexOf("includeAmbientSchedule");
  assert.ok(gateIndex > 0);
  const gateBlock = source.slice(Math.max(0, gateIndex - 1200), gateIndex + 400);
  for (const taskType of ["subagent_child", "workflow_child", "nested_workflow_child"]) {
    assert.ok(
      gateBlock.includes(`runtime.config.taskType === "${taskType}"`),
      `注册门必须排除 ${taskType}（防 workflow 子会话自建唤醒提议）`,
    );
  }
  // 主对话（interactive 等其余 taskType）不在排除清单——照常注册。
  assert.ok(!gateBlock.includes('runtime.config.taskType === "interactive"'));
});

test("F11: 上限按 createdBySession 计数——每会话 50 各自计、全局软上限 200", async () => {
  const { AmbientScheduleQueue, SCHEDULE_MAX_ITEMS, SCHEDULE_GLOBAL_MAX_ITEMS } = await import(
    "../packages/core/src/ambient/queue.ts"
  );
  // 每会话 50：a 满 50 后拒绝；b 仍可创建（旧全局 50 语义下会拒绝）。
  const dataRootA = await tempDataRoot();
  const queueA = new AmbientScheduleQueue({ dataRootDir: dataRootA, now: () => T0, newId: () => `a-${Math.random()}` });
  for (let i = 0; i < SCHEDULE_MAX_ITEMS; i += 1) {
    await queueA.create({ wakeAtMs: T0 + i + 1, target: "ambient", taskDescription: `a-${i}`, createdBySession: "sess-a" });
  }
  await assert.rejects(
    () => queueA.create({ wakeAtMs: T0 + 10_000, target: "ambient", taskDescription: "over", createdBySession: "sess-a" }),
    (error) => error?.message?.includes("at most 50 pending schedules"),
  );
  const fromB = await queueA.create({ wakeAtMs: T0 + 10_001, target: "ambient", taskDescription: "b-ok", createdBySession: "sess-b" });
  assert.ok(fromB.scheduleId, "其他会话不受 a 的 50 上限影响");

  // 全局软上限 200：四个会话各 50 填满 → 任何会话的第 201 项拒绝。
  const dataRootG = await tempDataRoot();
  const queueG = new AmbientScheduleQueue({ dataRootDir: dataRootG, now: () => T0, newId: () => `g-${Math.random()}` });
  for (let s = 0; s < 4; s += 1) {
    for (let i = 0; i < 50; i += 1) {
      await queueG.create({ wakeAtMs: T0 + i + 1, target: "ambient", taskDescription: `g-${s}-${i}`, createdBySession: `sess-${s}` });
    }
  }
  assert.equal(SCHEDULE_GLOBAL_MAX_ITEMS, 200);
  await assert.rejects(
    () => queueG.create({ wakeAtMs: T0 + 20_000, target: "ambient", taskDescription: "global-over", createdBySession: "sess-new" }),
    (error) => error?.message?.includes("at most 200 pending schedules"),
  );
});

test("F11: list 默认只列当前会话；all:true 列全部；cancel 他人项给可读错误", async () => {
  const { AmbientScheduleQueue } = await import("../packages/core/src/ambient/queue.ts");
  const { createScheduleHandler } = await import("../packages/core/src/tool/handlers/schedule.ts");
  const dataRoot = await tempDataRoot();
  const queue = new AmbientScheduleQueue({ dataRootDir: dataRoot, now: () => T0, newId: () => `h-${Math.random()}` });
  const handlerA = createScheduleHandler({ queue, now: () => T0, sessionId: "sess-a" });
  const handlerB = createScheduleHandler({ queue, now: () => T0, sessionId: "sess-b" });

  const madeA = await handlerA({ action: "create", wakeInMinutes: 5, taskDescription: "a-item" });
  const madeB = await handlerB({ action: "create", wakeInMinutes: 6, taskDescription: "b-item" });

  // list 默认过滤：A 只见自己的项；all:true 显式要求才见全部。
  const listA = await handlerA({ action: "list" });
  assert.equal(listA.items.length, 1);
  assert.equal(listA.items[0].scheduleId, madeA.scheduleId);
  const listAll = await handlerA({ action: "list", all: true });
  assert.equal(listAll.items.length, 2, "all:true 列全部（多窗口共写一份数据根）");

  // cancel 他人项：可读错误（不静默 false——误删并行窗口的工作单比拒绝更糟）。
  await assert.rejects(
    () => handlerA({ action: "cancel", scheduleId: madeB.scheduleId }),
    (error) => error?.message?.includes("created by another session"),
  );
  // 自己的项照常可取消。
  const cancelA = await handlerA({ action: "cancel", scheduleId: madeA.scheduleId });
  assert.equal(cancelA.cancelled, true);
});

test("F12: 配额窗口非正（0/负）→ 不可跑判定（保守方向，不再 clamp 到 MIN）", async () => {
  const { AdaptiveScheduler } = await import("../packages/core/src/ambient/scheduler.ts");
  for (const windowRemainingMs of [0, -5 * MIN]) {
    const scheduler = new AdaptiveScheduler({
      getHourlyRate: () => 0,
      getRecentCycles: () => 5000,
      getQuotaSnapshot: async () => ({ remainingTokens: 100_000, windowRemainingMs }),
      now: () => T0,
    });
    const decision = await scheduler.calculateBaseInterval();
    assert.equal(
      decision.intervalMs,
      Number.POSITIVE_INFINITY,
      `windowRemainingMs=${windowRemainingMs} 必须判不可跑（宁可不振醒）`,
    );
    assert.equal(decision.detail.cyclesAvailable, 0);
  }
});
