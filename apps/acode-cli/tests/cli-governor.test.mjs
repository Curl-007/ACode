// CliGovernor 验收（apps/acode-cli/specs/cli-governor.md 场景 1-12 + R4 恢复面）：
// cap 公式、spawn 分类表（user 永不阻塞 / warm 让路 / at-cap 驱逐）、idle guard、
// 驱逐端口缺席 fail-safe、per-level 限速、repeat 抑制、demand 上限、粘滞 peek
// 防死循环、release 幂等、轮询源阈值与读取失败、舰队组合面（LRU peek 排除在跑
// 会话 + governor_evict 可恢复语义）。机制面走注入端口，组合面走 fleet 单例。
import assert from "node:assert/strict";
import test from "node:test";

const { CliGovernor } = await import("../packages/core/src/runtime/cli-governor.ts");
const { computeSessionCap, evaluateMemoryPressureLevel, createPollingMemoryPressureSource } =
  await import("../packages/core/src/runtime/memory-pressure.ts");
const {
  attachCliGovernorEvictionPort,
  configureCliGovernor,
  getCliGovernor,
  peekFleetLruIdleVictim,
  resetCliGovernorForTest,
} = await import("../packages/core/src/fleet/governor.ts");
const { resetFleetRegistryForTest } = await import("../packages/core/src/fleet/registry.ts");
const { InMemoryRuntimeTaskRegistry } =
  await import("../packages/core/src/runtime-task/registry.ts");

const GIB = 1024 ** 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 时钟基座取大值：初始 lastSweepAt=0 不会挡住首个压力信号。 */
function createHarness({ cap = 2, records = [], t0 = 1_000_000_000, ...configOverrides } = {}) {
  const events = [];
  const clock = { t: t0 };
  const evicted = [];
  const governor = new CliGovernor({
    cap: () => cap,
    countActive: () => records.length,
    peekLruIdleVictim: () => {
      let best = null;
      for (const record of records) {
        const idleSeconds = Math.max(0, Math.round((clock.t - record.lastActivityAt) / 1000));
        if (best === null || idleSeconds > best.idleSeconds) {
          best = { sessionId: record.sessionId, idleSeconds };
        }
      }
      return best;
    },
    evictVictim: (sessionId, context) => {
      evicted.push({ sessionId, ...context });
      // 真实驱逐会收口受害者：从清单移除（否则 peek 粘滞，循环靠守卫 break）。
      const index = records.findIndex((record) => record.sessionId === sessionId);
      if (index >= 0) records.splice(index, 1);
    },
    onEvent: (event) => events.push(event),
    now: () => clock.t,
    ...configOverrides,
  });
  return { governor, events, clock, records, evicted };
}

function idleRecord(sessionId, clock, idleSeconds) {
  return { sessionId, lastActivityAt: clock.t - idleSeconds * 1000 };
}

// ── 场景 1：cap 公式 max(6, floor(RAM/3GiB)) ─────────────────────────

test("cap: max(6, floor(RAM/3GiB)) with floor and degenerate-input fallbacks", () => {
  assert.equal(computeSessionCap(24 * GIB), 8);
  assert.equal(computeSessionCap(18 * GIB), 6);
  assert.equal(computeSessionCap(8 * GIB), 6, "floor 兜底：8GiB → 6");
  assert.equal(computeSessionCap(48 * GIB), 16);
  assert.equal(computeSessionCap(17.9 * GIB), 6, "17.9GiB floor → 5 → 抬到 6");
  assert.equal(computeSessionCap(0), 6);
  assert.equal(computeSessionCap(Number.NaN), 6);
});

// ── 场景 2/11：user 超限放行 + 记因；release 幂等 ─────────────────────

test("user spawn at cap passes (never blocked) and records soft_cap_exceeded", async () => {
  const { governor, events, clock, records } = createHarness({ cap: 2 });
  records.push(idleRecord("sess_a", clock, 300), idleRecord("sess_b", clock, 200));
  const slot = await governor.acquireSlot("user");
  assert.equal(slot.yielded, false, "user spawn 永不阻塞");
  assert.equal(governor.inFlight, 1);
  const softCap = events.filter((event) => event.type === "governor_soft_cap_exceeded");
  assert.equal(softCap.length, 1);
  assert.equal(softCap[0].cap, 2);
  assert.equal(softCap[0].effective, 2);
  assert.equal(softCap[0].countActive, 2);
  assert.equal(softCap[0].hadEvictable, true, "记因含可驱逐观测");
  assert.equal(
    events.some((event) => event.type === "governor_evict"),
    false,
    "user 路径不驱逐",
  );
  // release 幂等：双调用只减一次。
  slot.release();
  slot.release();
  assert.equal(governor.inFlight, 0);
});

// ── 场景 3：warm at-cap 无可驱逐 → yield 不占 inFlight ─────────────────

test("warm spawn at cap without evictable victim yields without consuming inFlight", async () => {
  const { governor, events, clock, records } = createHarness({ cap: 2 });
  records.push(idleRecord("sess_a", clock, 10), idleRecord("sess_b", clock, 5));
  const slot = await governor.acquireSlot("warm");
  assert.equal(slot.yielded, true);
  assert.equal(governor.inFlight, 0, "yield 不占槽位");
  slot.release(); // yielded 槽位 release 为 no-op
  assert.equal(governor.inFlight, 0);
  const yielded = events.filter((event) => event.type === "governor_yielded");
  assert.equal(yielded.length, 1);
  assert.equal(yielded[0].reason, "warm");
  assert.equal(yielded[0].hadEvictable, false, "idle<60s 受害者不够格");
});

// ── 场景 4：warm at-cap 有 idle≥60s 受害者 → 驱逐后放行 ─────────────────

test("warm spawn at cap evicts idle victim (pause-not-kill) and acquires", async () => {
  const { governor, events, clock, records, evicted } = createHarness({ cap: 2 });
  records.push(idleRecord("sess_idle", clock, 120), idleRecord("sess_fresh", clock, 10));
  const slot = await governor.acquireSlot("warm");
  assert.equal(slot.yielded, false);
  assert.equal(governor.inFlight, 1);
  assert.deepEqual(evicted, [{ sessionId: "sess_idle", trigger: "warm_spawn", idleSeconds: 120 }]);
  const wouldEvict = events.find((event) => event.type === "governor_would_evict");
  assert.equal(wouldEvict.evicted, true);
  assert.equal(wouldEvict.victimSessionId, "sess_idle");
  const evictEvent = events.find((event) => event.type === "governor_evict");
  assert.equal(evictEvent.sessionId, "sess_idle");
  assert.equal(evictEvent.trigger, "warm_spawn");
  slot.release();
});

// ── 场景 5：warm over-cap → yield 不叠加驱逐 ───────────────────────────

test("warm spawn over cap yields even with an eligible victim", async () => {
  const { governor, events, clock, records, evicted } = createHarness({ cap: 2 });
  records.push(
    idleRecord("sess_a", clock, 300),
    idleRecord("sess_b", clock, 200),
    idleRecord("sess_c", clock, 100),
  );
  const slot = await governor.acquireSlot("warm");
  assert.equal(slot.yielded, true, "effective(3) > cap(2)：只让路不驱逐");
  assert.equal(evicted.length, 0);
  assert.equal(
    events.some((event) => event.type === "governor_evict"),
    false,
  );
});

// ── 场景 6：idle guard 边界（59s 不够格 / 60s 够格） ───────────────────

test("idle guard: 59s victim blocks eviction, 60s victim qualifies", async () => {
  const guarded = createHarness({ cap: 1 });
  guarded.records.push(idleRecord("sess_v", guarded.clock, 59));
  assert.equal((await guarded.governor.acquireSlot("warm")).yielded, true);
  assert.equal(guarded.evicted.length, 0);

  const qualified = createHarness({ cap: 1 });
  qualified.records.push(idleRecord("sess_v", qualified.clock, 60));
  assert.equal((await qualified.governor.acquireSlot("warm")).yielded, false);
  assert.deepEqual(qualified.evicted, [
    { sessionId: "sess_v", trigger: "warm_spawn", idleSeconds: 60 },
  ]);
});

// ── 场景 7：驱逐端口缺席 → fail-safe（只观测不收口） ───────────────────

test("eviction port absent: warm yields at cap, would_evict reports evicted=false", async () => {
  const { governor, events, clock, records } = createHarness({
    cap: 1,
    evictVictim: undefined,
    evictionEnabled: undefined,
  });
  records.push(idleRecord("sess_v", clock, 300));
  assert.equal(governor.evictionOn(), false);
  const slot = await governor.acquireSlot("warm");
  assert.equal(slot.yielded, true);
  const wouldEvict = events.find((event) => event.type === "governor_would_evict");
  assert.equal(wouldEvict.evicted, false);
  assert.equal(
    events.some((event) => event.type === "governor_evict"),
    false,
  );
});

// ── 场景 8：per-level 60s 限速 ────────────────────────────────────────

test("pressure sweeps are rate-limited per level (60s), levels independent", () => {
  const { governor, events, clock } = createHarness({ cap: 4 });
  governor.onSignal("critical");
  assert.equal(events.filter((event) => event.type === "governor_pressure").length, 1);
  clock.t += 30_000;
  governor.onSignal("critical");
  assert.equal(
    events.filter((event) => event.type === "governor_pressure").length,
    1,
    "30s 内同 level 被限速",
  );
  governor.onSignal("warning");
  assert.equal(
    events.filter((event) => event.type === "governor_pressure").length,
    2,
    "不同 level 各自计时",
  );
  clock.t += 31_000; // critical 距首次 61s
  governor.onSignal("critical");
  assert.equal(
    events.filter((event) => event.type === "governor_pressure").length,
    3,
    "61s 后 critical 再 sweep",
  );
});

// ── 场景 9：repeat 抑制（同因不刷屏，≥5min 再发，解除即清） ────────────

test("repeat suppression: same level+cap without evictables re-emits only after 5min", () => {
  const { governor, events, clock } = createHarness({ cap: 4 });
  const pressureEvents = () => events.filter((event) => event.type === "governor_pressure");
  governor.onSignal("critical");
  assert.equal(pressureEvents().length, 1);
  assert.equal(pressureEvents()[0].isRepeat, false);

  clock.t += 61_000; // 过限速窗，仍 <5min
  governor.onSignal("critical");
  assert.equal(pressureEvents().length, 1, "would_evict=0 同 level 同 cap → 压制");

  clock.t += 300_000; // 距上次发射 ≥5min
  governor.onSignal("critical");
  assert.equal(pressureEvents().length, 2);
  assert.equal(pressureEvents()[1].isRepeat, true);

  governor.onSignal(null); // 压力解除清 lastEmitted
  clock.t += 61_000;
  governor.onSignal("critical");
  assert.equal(pressureEvents().length, 3, "解除后同 level 必发");
  assert.equal(pressureEvents()[2].isRepeat, false);
});

// ── 场景 10：demand 上限 + 粘滞 peek 防死循环 ──────────────────────────

test("pressure sweep caps evictions at demand and breaks on sticky peek", () => {
  // demand = effective = 3：5 个够格受害者最多收 3 个。
  let pool = ["v1", "v2", "v3", "v4", "v5"].map((sessionId) => ({ sessionId, idleSeconds: 120 }));
  const evictedIds = [];
  const events = [];
  const governor = new CliGovernor({
    cap: () => 10,
    countActive: () => 3,
    peekLruIdleVictim: () => pool[0] ?? null,
    evictVictim: (sessionId) => {
      evictedIds.push(sessionId);
      pool = pool.filter((victim) => victim.sessionId !== sessionId);
    },
    onEvent: (event) => events.push(event),
    now: () => 1_000_000_000,
  });
  governor.onSignal("warning");
  assert.deepEqual(evictedIds, ["v1", "v2", "v3"]);
  const pressure = events.find((event) => event.type === "governor_pressure");
  assert.equal(pressure.demand, 3);
  assert.equal(pressure.evicted, 3);
  assert.equal(pressure.wouldEvict, 3);
  assert.equal(pressure.hadEvictable, true);

  // 粘滞 peek（异步收口未反映）：驱逐一次后守卫 break，不死循环。
  const stickyEvents = [];
  const stickyEvicted = [];
  const sticky = new CliGovernor({
    cap: () => 10,
    countActive: () => 3,
    peekLruIdleVictim: () => ({ sessionId: "v_sticky", idleSeconds: 90 }),
    evictVictim: (sessionId) => stickyEvicted.push(sessionId),
    onEvent: (event) => stickyEvents.push(event),
    now: () => 1_000_000_000,
  });
  sticky.onSignal("warning");
  assert.deepEqual(stickyEvicted, ["v_sticky"]);
  assert.equal(stickyEvents.find((event) => event.type === "governor_pressure").evicted, 1);
});

// ── 场景 12：轮询源阈值 + 读取失败视为解除且 warn 一次 ─────────────────

test("polling source: ratio thresholds, failure treated as clear with single warn", async () => {
  assert.equal(evaluateMemoryPressureLevel(0.04), "warning");
  assert.equal(evaluateMemoryPressureLevel(0.01), "critical");
  assert.equal(evaluateMemoryPressureLevel(0.5), null);
  assert.equal(evaluateMemoryPressureLevel(Number.NaN), null);
  assert.equal(evaluateMemoryPressureLevel(0.05), null, "边界：恰 5% 不算 warning");
  assert.equal(evaluateMemoryPressureLevel(0.0499), "warning", "边界：<5% 才 warning");
  assert.equal(evaluateMemoryPressureLevel(0.02), "warning", "边界：恰 2% 不算 critical");

  const levels = [];
  const source = createPollingMemoryPressureSource({
    getFreeMemoryRatio: () => 0.01,
    intervalMs: 10,
  });
  const unsubscribe = source.subscribe((level) => levels.push(level));
  await sleep(50);
  unsubscribe();
  assert.ok(levels.length >= 2, `应多次采样，实际 ${levels.length}`);
  assert.ok(levels.every((level) => level === "critical"));

  const warns = [];
  const received = [];
  const failing = createPollingMemoryPressureSource({
    getFreeMemoryRatio: () => {
      throw new Error("meminfo unavailable");
    },
    intervalMs: 10,
    logger: { warn: (message) => warns.push(message) },
  });
  const unsubscribe2 = failing.subscribe((level) => received.push(level));
  await sleep(50);
  unsubscribe2();
  assert.ok(received.length >= 2 && received.every((level) => level === null));
  assert.equal(warns.length, 1, "读取失败 warn 只记一次");
});

// ── 场景 13 + R4：舰队组合面（cap/LRU peek 排除在跑/可恢复驱逐） ───────

function makeFleetRecord(sessionId, agentId, lastActivityAt) {
  return {
    sessionId,
    agentId,
    title: sessionId,
    agentType: "general-purpose",
    launchedBySessionId: "sess_launcher",
    launchedByToolCallId: "tc_launch",
    startedAt: lastActivityAt,
    mode: "build",
    modeLineage: "ceiling",
    lastActivityAt,
    archived: false,
  };
}

test("fleet composition: cap from RAM, LRU peek skips running, evict is recoverable", async () => {
  resetCliGovernorForTest();
  const registry = resetFleetRegistryForTest();
  const taskRegistry = new InMemoryRuntimeTaskRegistry();
  const t0 = Date.now();
  registry.register(makeFleetRecord("sess_idle", "agent_idle", t0 - 120_000));
  registry.register(makeFleetRecord("sess_busy", "agent_busy", t0 - 300_000));
  taskRegistry.register({
    taskId: "agent_busy",
    agentId: "agent_busy",
    agentType: "general-purpose",
    description: "busy",
    status: "running",
    startedAt: new Date(),
    type: "local_agent",
    childSessionId: "sess_busy",
    isBackgrounded: true,
  });

  const stopped = [];
  let pressureListener = null;
  configureCliGovernor({
    runtimeTaskRegistry: taskRegistry,
    totalMemoryBytes: 24 * GIB,
    pressureSource: {
      subscribe: (listener) => {
        pressureListener = listener;
        return () => {};
      },
    },
    now: () => t0,
  });
  attachCliGovernorEvictionPort({
    stopTask: async (taskId) => {
      stopped.push(taskId);
    },
  });
  const governor = getCliGovernor();
  try {
    assert.equal(governor.currentCap(), 8, "24GiB → cap 8");
    assert.equal(governor.evictionOn(), true);

    // LRU：sess_busy 更旧但在跑 → 跳过；受害者 = sess_idle。
    const victim = peekFleetLruIdleVictim();
    assert.equal(victim.sessionId, "sess_idle");
    assert.equal(victim.idleSeconds, 120);

    pressureListener("critical");
    await sleep(20); // evict 是 best-effort 异步链
    assert.deepEqual(stopped, ["agent_idle"], "只收口空闲受害者");

    // R4 可恢复：记录仍在、未归档、条目未被 remove（恢复面完整）。
    const record = registry.get("sess_idle");
    assert.ok(record !== undefined, "驱逐不删舰队记录");
    assert.equal(record.archived, false, "驱逐不归档");
  } finally {
    resetCliGovernorForTest();
    resetFleetRegistryForTest();
  }
});
