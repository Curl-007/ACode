import assert from "node:assert/strict";
import test from "node:test";

import { installKeepAwakeClaims } from "../src/main/keepAwakeClaims.ts";
import { installKeepAwakeClaimSources } from "../src/main/keepAwakeClaimSources.ts";

/**
 * keep-awake 认领数据源单测（specs/shutdown-keepawake-containment.md B2 节验收 4）：
 * fake 事件源驱动全生命周期——turn 槽位合成（可观察 Map）、offpeak 计数槽位合成、
 * cron runId 合成与 close/error 终结态映射、无效输入拒绝、clamp、dispose 后 no-op，
 * 以及与真台账的端到端（blocker 单点起停）。
 */

function createRecordingLogger() {
  const entries = [];
  const push =
    (level) =>
    (...args) =>
      entries.push({ level, args });
  return { entries, info: push("info"), warn: push("warn"), error: push("error") };
}

function findStructured(entries, event) {
  return entries
    .map((entry) => entry.args.find((arg) => arg && typeof arg === "object" && arg.event === event))
    .filter(Boolean);
}

/** fake 台账：只记录调用，验证数据源 → acquire/releaseSession 的映射语义。 */
function createFakeClaims() {
  const calls = [];
  return {
    calls,
    acquires: () => calls.filter((call) => call.op === "acquire"),
    releases: () => calls.filter((call) => call.op === "releaseSession"),
    acquire(kind, sessionId) {
      calls.push({ op: "acquire", kind, sessionId });
      return () => calls.push({ op: "releaseFn", kind, sessionId });
    },
    release(kind, sessionId) {
      calls.push({ op: "release", kind, sessionId });
    },
    releaseSession(sessionId, state) {
      calls.push({ op: "releaseSession", sessionId, state });
    },
    reconcile(reason) {
      calls.push({ op: "reconcile", reason });
    },
    getSnapshot() {
      return {
        claims: [],
        blocker_id: null,
        applied: false,
        suppressed_reason: null,
        on_battery: false,
      };
    },
    dispose() {
      calls.push({ op: "dispose" });
    },
  };
}

function createHarness() {
  const logger = createRecordingLogger();
  const claims = createFakeClaims();
  const sources = installKeepAwakeClaimSources({ claims, logger });
  return { logger, claims, sources };
}

test("turn claims follow host running count via observed map (synthetic slot sessions)", () => {
  const { claims, sources } = createHarness();
  const map = sources.createHostRunningTaskCountMap();
  const hostA = { pid: 11 };
  const hostB = { pid: 22 };

  map.set(hostA, 2);
  assert.deepEqual(
    claims.acquires().map((c) => [c.kind, c.sessionId]),
    [
      ["turn", "host:1:1"],
      ["turn", "host:1:2"],
    ],
  );

  // 同值重复 set：数据源不重复记账（host 上报是幂等口径）。
  map.set(hostA, 2);
  assert.equal(claims.acquires().length, 2);

  // 第二个 host 分配独立序号段。
  map.set(hostB, 1);
  assert.deepEqual(claims.acquires()[2], { op: "acquire", kind: "turn", sessionId: "host:2:1" });

  // 上升只补新槽。
  map.set(hostA, 3);
  assert.deepEqual(claims.acquires()[3], { op: "acquire", kind: "turn", sessionId: "host:1:3" });

  // 下降逐槽 releaseSession(close)，高槽先释放。
  map.set(hostA, 1);
  assert.deepEqual(
    claims.releases().map((c) => [c.sessionId, c.state]),
    [
      ["host:1:3", "close"],
      ["host:1:2", "close"],
    ],
  );

  // delete（host exit / count<=0）释放该 host 全部剩余槽位；重复 delete 幂等。
  map.delete(hostA);
  assert.deepEqual(claims.releases()[2], {
    op: "releaseSession",
    sessionId: "host:1:1",
    state: "close",
  });
  const releaseCountBefore = claims.releases().length;
  assert.equal(map.delete(hostA), false);
  assert.equal(claims.releases().length, releaseCountBefore);

  // 同一 host 对象计数回来：沿用原序号段（身份不换）。
  map.set(hostA, 1);
  assert.deepEqual(claims.acquires()[4], { op: "acquire", kind: "turn", sessionId: "host:1:1" });

  // Map 原生语义保留（退出屏障 getRunningAgentSessionCount 的口径不受影响）。
  assert.equal(map.get(hostA), 1);
  assert.equal(map.get(hostB), 1);
  assert.equal(map.size, 2);
});

test("invalid host counts are rejected for claims but map writes pass through", () => {
  const { claims, logger, sources } = createHarness();
  const map = sources.createHostRunningTaskCountMap();
  const host = {};

  map.set(host, Number.NaN);
  map.set(host, -1);
  map.set(host, 1.5);
  assert.equal(claims.acquires().length, 0, "invalid counts must not create claims");
  const rejected = findStructured(logger.entries, "keep_awake_claim_source_rejected");
  assert.equal(rejected.length, 3);
  assert.equal(rejected[0].outcome, "invalid_count");
  assert.equal(rejected[0].source, "host_running_task_count");
  // 写入透传：数据源不得拦截 map 本身（最后一次写入生效）。
  assert.equal(map.get(host), 1.5);

  // 无效计数不污染槽位状态：随后的合法计数从 0 基线记账。
  map.set(host, 2);
  assert.deepEqual(
    claims.acquires().map((c) => c.sessionId),
    ["host:1:1", "host:1:2"],
  );
});

test("runaway counts are clamped to the slot cap", () => {
  const { claims, logger, sources } = createHarness();
  const map = sources.createHostRunningTaskCountMap();
  map.set({}, 300);
  assert.equal(claims.acquires().length, 256);
  const clamped = findStructured(logger.entries, "keep_awake_claim_source_clamped");
  assert.equal(clamped.length, 1);
  assert.equal(clamped[0].outcome, "count_clamped");
  assert.equal(clamped[0].count, 300);

  sources.handleOffPeakActiveCountChanged(1000);
  const offPeakAcquires = claims.acquires().filter((c) => c.kind === "background_task");
  assert.equal(offPeakAcquires.length, 256);
  assert.equal(findStructured(logger.entries, "keep_awake_claim_source_clamped").length, 2);
});

test("map clear releases every held host turn slot", () => {
  const { claims, sources } = createHarness();
  const map = sources.createHostRunningTaskCountMap();
  map.set({ pid: 1 }, 2);
  map.set({ pid: 2 }, 1);
  map.clear();
  assert.deepEqual(
    claims
      .releases()
      .map((c) => c.sessionId)
      .sort(),
    ["host:1:1", "host:1:2", "host:2:1"],
  );
  assert.equal(map.size, 0);
});

test("off-peak active count drives background_task slot claims", () => {
  const { claims, logger, sources } = createHarness();

  sources.handleOffPeakActiveCountChanged(2);
  assert.deepEqual(
    claims.acquires().map((c) => [c.kind, c.sessionId]),
    [
      ["background_task", "offpeak:1"],
      ["background_task", "offpeak:2"],
    ],
  );

  // 同值幂等（scheduler 侧本就只在变化时上报，这里再防一层）。
  sources.handleOffPeakActiveCountChanged(2);
  assert.equal(claims.acquires().length, 2);

  sources.handleOffPeakActiveCountChanged(1);
  assert.deepEqual(claims.releases()[0], {
    op: "releaseSession",
    sessionId: "offpeak:2",
    state: "close",
  });

  sources.handleOffPeakActiveCountChanged(0);
  assert.deepEqual(claims.releases()[1], {
    op: "releaseSession",
    sessionId: "offpeak:1",
    state: "close",
  });

  // 无效计数拒绝 + 状态不动。
  sources.handleOffPeakActiveCountChanged(-1);
  sources.handleOffPeakActiveCountChanged(1.5);
  sources.handleOffPeakActiveCountChanged("2");
  assert.equal(claims.acquires().length, 2);
  assert.equal(claims.releases().length, 2);
  const rejected = findStructured(logger.entries, "keep_awake_claim_source_rejected");
  assert.equal(rejected.length, 3);
  assert.equal(rejected[0].source, "offpeak_active_count");
});

test("cron runs map to loop claims with close/error terminal states", () => {
  const { claims, logger, sources } = createHarness();
  const runId = "auto-1:1700000000000";

  sources.handleCronRunDispatched({ runId, automationId: "auto-1" });
  assert.deepEqual(claims.acquires()[0], {
    op: "acquire",
    kind: "loop",
    sessionId: `cron:${runId}`,
  });

  // 重复派发上报幂等。
  sources.handleCronRunDispatched({ runId, automationId: "auto-1" });
  assert.equal(claims.acquires().length, 1);

  // 结算 ok=true → close。
  sources.handleCronRunSettled({ runId, ok: true });
  assert.deepEqual(claims.releases()[0], {
    op: "releaseSession",
    sessionId: `cron:${runId}`,
    state: "close",
  });

  // 结算 ok=false → error。
  sources.handleCronRunDispatched({ runId });
  sources.handleCronRunSettled({ runId, ok: false });
  assert.deepEqual(claims.releases()[1], {
    op: "releaseSession",
    sessionId: `cron:${runId}`,
    state: "error",
  });

  // 迟到/重复结算幂等：不 warn（scheduler 协议允许仅凭 runId 迟到结算）。
  const warnCountBefore = logger.entries.filter((e) => e.level === "warn").length;
  sources.handleCronRunSettled({ runId, ok: true });
  assert.equal(claims.releases().length, 3);
  assert.equal(
    logger.entries.filter((e) => e.level === "warn").length,
    warnCountBefore,
    "duplicate settle must not warn",
  );

  // 空/缺失 runId 拒绝。
  sources.handleCronRunDispatched({ runId: "" });
  sources.handleCronRunDispatched({});
  sources.handleCronRunSettled({ runId: "   " });
  const rejected = findStructured(logger.entries, "keep_awake_claim_source_rejected");
  assert.equal(rejected.length, 3);
  assert.equal(rejected[0].outcome, "invalid_run_id");
  assert.equal(claims.acquires().length, 2);
});

test("sources are inert after dispose", () => {
  const { claims, sources } = createHarness();
  const map = sources.createHostRunningTaskCountMap();
  const host = {};
  map.set(host, 1);
  sources.handleOffPeakActiveCountChanged(1);
  const callCountBefore = claims.calls.length;

  sources.dispose();

  // dispose 后事件迟到静默 no-op；map 写入仍透传（退出屏障口径不受影响）。
  map.set(host, 3);
  map.delete(host);
  map.clear();
  sources.handleOffPeakActiveCountChanged(5);
  sources.handleCronRunDispatched({ runId: "auto-2:1" });
  sources.handleCronRunSettled({ runId: "auto-2:1", ok: true });
  assert.equal(claims.calls.length, callCountBefore);
  assert.equal(map.get(host), undefined);
  // dispose 幂等。
  sources.dispose();
  assert.equal(claims.calls.length, callCountBefore);
});

test("end-to-end with the real ledger: blocker follows synthetic claims", () => {
  // 与 keep-awake-claims.test.mjs 同款 fake Electron 端口 + 假时钟，驱动真台账。
  const logger = createRecordingLogger();
  const starts = [];
  const stops = [];
  let nextBlockerId = 1;
  const powerListeners = new Map();
  const timers = { timeouts: [], intervals: [] };
  const claims = installKeepAwakeClaims({
    logger,
    powerSaveBlocker: {
      start: () => {
        const id = nextBlockerId++;
        starts.push(id);
        return id;
      },
      stop: (id) => stops.push(id),
    },
    powerMonitor: {
      on: (event, listener) => {
        if (!powerListeners.has(event)) powerListeners.set(event, new Set());
        powerListeners.get(event).add(listener);
      },
      off: (event, listener) => powerListeners.get(event)?.delete(listener),
      getSystemIdleTime: () => 0,
      isOnBatteryPower: () => false,
    },
    getMasterSwitch: () => true,
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms, unref: () => {} };
      timers.timeouts.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      const index = timers.timeouts.indexOf(handle);
      if (index >= 0) timers.timeouts.splice(index, 1);
    },
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms, unref: () => {} };
      timers.intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => {
      const index = timers.intervals.indexOf(handle);
      if (index >= 0) timers.intervals.splice(index, 1);
    },
  });
  const sources = installKeepAwakeClaimSources({ claims, logger });
  const map = sources.createHostRunningTaskCountMap();
  const host = {};

  map.set(host, 1);
  assert.deepEqual(starts, [1], "first synthetic turn claim starts the single blocker");
  assert.equal(claims.getSnapshot().applied, true);

  sources.handleCronRunDispatched({ runId: "auto-9:42", automationId: "auto-9" });
  sources.handleOffPeakActiveCountChanged(2);
  let snapshot = claims.getSnapshot();
  assert.deepEqual(snapshot.claims.map((c) => c.key).sort(), [
    "background_task:offpeak:1",
    "background_task:offpeak:2",
    "loop:cron:auto-9:42",
    "turn:host:1:1",
  ]);
  assert.deepEqual(starts, [1], "additional claims do not start a second blocker");

  sources.handleCronRunSettled({ runId: "auto-9:42", ok: true });
  sources.handleOffPeakActiveCountChanged(0);
  map.delete(host);
  snapshot = claims.getSnapshot();
  assert.deepEqual(snapshot.claims, []);
  assert.deepEqual(stops, [1], "blocker stops only after the last synthetic claim releases");
  assert.equal(snapshot.applied, false);
  assert.equal(timers.intervals.length, 0, "away sampler stops with empty ledger");
  assert.equal(timers.timeouts.length, 0, "cap timers cleaned up on release");

  sources.dispose();
  claims.dispose();
});
