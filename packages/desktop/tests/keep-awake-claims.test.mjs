import assert from "node:assert/strict";
import test from "node:test";

import {
  installKeepAwakeClaims,
  KEEP_AWAKE_SESSION_TERMINAL_STATES,
} from "../src/main/keepAwakeClaims.ts";

/**
 * keep-awake 认领台账单测（specs/shutdown-keepawake-containment.md 验收 2）：
 * 单 blocker 引用计数、总开关/电池策略门实时重估、recorded but not applied 显式日志、
 * loop/background 2h 上限过期（假时钟）、终结态闭集释放与 away-ms clamp 计量。
 */

function createRecordingLogger() {
  const entries = [];
  const push =
    (level) =>
    (...args) =>
      entries.push({ level, args });
  return { entries, info: push("info"), warn: push("warn"), error: push("error") };
}

function findStructured(entries, event, level) {
  return entries
    .filter((entry) => level === undefined || entry.level === level)
    .map((entry) => entry.args.find((arg) => arg && typeof arg === "object" && arg.event === event))
    .filter(Boolean);
}

function findMessage(entries, substring, level) {
  return entries.filter(
    (entry) =>
      (level === undefined || entry.level === level) &&
      entry.args.some((arg) => typeof arg === "string" && arg.includes(substring)),
  );
}

function createHarness(options = {}) {
  const logger = createRecordingLogger();
  const starts = [];
  const stops = [];
  let nextBlockerId = 1;
  const powerListeners = new Map();
  const state = {
    masterSwitch: options.masterSwitch ?? true,
    onBattery: options.onBattery ?? false,
    idleSeconds: options.idleSeconds ?? 0,
    batteryPolicy: options.batteryPolicy,
    monotonic: 0,
  };
  const timers = { timeouts: [], intervals: [] };
  const deps = {
    logger,
    powerSaveBlocker: {
      start: (type) => {
        assert.equal(type, "prevent-app-suspension");
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
      getSystemIdleTime: () => state.idleSeconds,
      isOnBatteryPower: () => state.onBattery,
    },
    getMasterSwitch: () => state.masterSwitch,
    ...(options.batteryPolicy === undefined ? {} : { getBatteryPolicy: () => state.batteryPolicy }),
    now: () => state.monotonic,
    claimCapMs: options.claimCapMs,
    awaySampleIntervalMs: options.awaySampleIntervalMs ?? 60_000,
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
  };
  const controller = installKeepAwakeClaims(deps);
  return {
    logger,
    starts,
    stops,
    state,
    timers,
    controller,
    powerListeners,
    advance(ms) {
      state.monotonic += ms;
    },
    emitPower(event) {
      for (const listener of powerListeners.get(event) ?? []) listener();
    },
    fireSampler() {
      for (const handle of [...timers.intervals]) handle.fn();
    },
    fireTimeouts(delayMs) {
      for (const handle of [...timers.timeouts]) {
        if (delayMs === undefined || handle.ms === delayMs) handle.fn();
      }
    },
  };
}

test("single blocker with reference counting across claims", () => {
  const harness = createHarness();
  const releaseTurn = harness.controller.acquire("turn", "s1");
  harness.controller.acquire("background_task", "s2");
  assert.deepEqual(harness.starts, [1], "blocker started exactly once for multiple claims");
  assert.equal(harness.controller.getSnapshot().applied, true);

  releaseTurn();
  assert.equal(harness.controller.getSnapshot().applied, true);
  assert.deepEqual(harness.stops, []);

  harness.controller.release("background_task", "s2");
  assert.deepEqual(harness.stops, [1], "blocker stopped when the last claim is released");
  assert.equal(harness.controller.getSnapshot().claims.length, 0);
  const stopped = findStructured(harness.logger.entries, "keep_awake_blocker_stopped")[0];
  assert.equal(stopped.outcome, "last_claim_released");
  // 重复释放幂等。
  releaseTurn();
  assert.deepEqual(harness.stops, [1]);
  // 采样 interval 随 claims 清空而停止。
  assert.equal(harness.timers.intervals.length, 0);
});

test("master switch off records claims but does not apply, and re-applies on reopen", () => {
  const harness = createHarness({ masterSwitch: false });
  harness.controller.acquire("turn", "s1");
  assert.deepEqual(harness.starts, []);
  const messages = findMessage(harness.logger.entries, "recorded but not applied", "info");
  assert.equal(messages.length, 1);
  const acquired = findStructured(harness.logger.entries, "keep_awake_claim_acquired")[0];
  assert.equal(acquired.outcome, "recorded_but_not_applied");
  assert.equal(acquired.suppressed_reason, "setting_off");
  assert.equal(harness.controller.getSnapshot().claims.length, 1, "claim 照记（台账完整）");

  // 设置重开 → 实时重估 → 自动 applied。
  harness.state.masterSwitch = true;
  harness.controller.reconcile("settings-sync");
  assert.deepEqual(harness.starts, [1]);
  assert.equal(harness.controller.getSnapshot().applied, true);

  // 再关：blocker 停但 claims 保留，outcome=suppressed。
  harness.state.masterSwitch = false;
  harness.controller.reconcile("settings-sync");
  assert.deepEqual(harness.stops, [1]);
  assert.equal(harness.controller.getSnapshot().claims.length, 1);
  const stopped = findStructured(harness.logger.entries, "keep_awake_blocker_stopped")[0];
  assert.equal(stopped.outcome, "suppressed");
  assert.equal(stopped.suppressed_reason, "setting_off");
});

test("battery policy gate re-estimates on on-ac/on-battery events", () => {
  const harness = createHarness({ batteryPolicy: false });
  harness.state.onBattery = true;
  harness.controller.acquire("loop", "s1");
  assert.deepEqual(harness.starts, [], "电池 + 禁用电池保持唤醒 → 不 applied");
  assert.equal(harness.controller.getSnapshot().suppressed_reason, "on_battery");

  harness.state.onBattery = false;
  harness.emitPower("on-ac");
  assert.deepEqual(harness.starts, [1], "on-ac 事件实时重估后 applied");

  harness.state.onBattery = true;
  harness.emitPower("on-battery");
  assert.deepEqual(harness.stops, [1], "on-battery 事件实时重估后停用");
  assert.ok(findStructured(harness.logger.entries, "keep_awake_power_changed").length >= 2);

  // 默认电池策略（缺省）不压制：与现有全局布尔行为一致，无回退。
  const defaultHarness = createHarness();
  defaultHarness.state.onBattery = true;
  defaultHarness.controller.acquire("turn", "s1");
  assert.deepEqual(defaultHarness.starts, [1]);
});

test("loop/background claims expire at the cap; turn claims do not", () => {
  const harness = createHarness({ claimCapMs: 1_000 });
  harness.controller.acquire("loop", "s1");
  harness.controller.acquire("background_task", "s2");
  harness.controller.acquire("turn", "s3");
  // 两个非 turn claim 各有一个 cap timer，turn 没有。
  assert.deepEqual(
    harness.timers.timeouts.map((handle) => handle.ms),
    [1_000, 1_000],
  );

  harness.advance(1_000);
  harness.fireTimeouts(1_000);
  const keys = harness.controller.getSnapshot().claims.map((entry) => entry.key);
  assert.deepEqual(keys, ["turn:s3"]);
  const expired = findStructured(harness.logger.entries, "keep_awake_claim_expired", "warn");
  assert.deepEqual(
    expired.map((entry) => entry.outcome),
    ["capped", "capped"],
  );
  assert.deepEqual(expired.map((entry) => entry.claim_kind).sort(), ["background_task", "loop"]);
  // turn claim 仍持有 blocker。
  assert.equal(harness.controller.getSnapshot().applied, true);
});

test("session terminal states release all session claims; unknown state is rejected", () => {
  const harness = createHarness();
  harness.controller.acquire("turn", "s1");
  harness.controller.acquire("loop", "s1");
  harness.controller.acquire("turn", "s2");

  harness.controller.releaseSession("s1", "running");
  assert.equal(harness.controller.getSnapshot().claims.length, 3, "未知状态不释放");
  const rejected = findStructured(
    harness.logger.entries,
    "keep_awake_session_release_rejected",
    "warn",
  )[0];
  assert.equal(rejected.outcome, "unknown_state");

  harness.controller.releaseSession("s1", "paused");
  const keys = harness.controller.getSnapshot().claims.map((entry) => entry.key);
  assert.deepEqual(keys, ["turn:s2"]);
  const released = findStructured(harness.logger.entries, "keep_awake_claim_released");
  assert.equal(released.length, 2);
  assert.ok(
    released.every(
      (entry) => entry.outcome === "session_terminal" && entry.terminal_state === "paused",
    ),
  );

  // 闭集全量：每个终结态都能释放。
  for (const state of KEEP_AWAKE_SESSION_TERMINAL_STATES) {
    const loop = createHarness();
    loop.controller.acquire("turn", "sx");
    loop.controller.releaseSession("sx", state);
    assert.equal(loop.controller.getSnapshot().claims.length, 0, `state ${state} must release`);
  }
});

test("away-ms sampling clamps idle time to the claim holding window", () => {
  const harness = createHarness({ awaySampleIntervalMs: 60_000 });
  // 系统已空闲 1 小时后才认领：clamp 到持有窗口，不把认领前的空闲记到 claim 头上。
  harness.state.idleSeconds = 3_600;
  harness.advance(100_000);
  harness.controller.acquire("turn", "s1");
  harness.advance(10_000);
  harness.fireSampler();
  assert.equal(harness.controller.getSnapshot().claims[0].max_away_ms, 10_000);

  // 更长的真实空闲 → 取更大值；短空闲不回退 max。
  harness.state.idleSeconds = 30;
  harness.advance(20_000);
  harness.fireSampler();
  assert.equal(harness.controller.getSnapshot().claims[0].max_away_ms, 30_000);
  harness.state.idleSeconds = 5;
  harness.advance(1_000);
  harness.fireSampler();
  assert.equal(harness.controller.getSnapshot().claims[0].max_away_ms, 30_000);

  const release = harness.controller.acquire("turn", "s1");
  release();
  // 释放日志带 held_ms / max_away_ms 计量。
  const released = findStructured(harness.logger.entries, "keep_awake_claim_released").at(-1);
  assert.equal(released.held_ms, 31_000);
  assert.equal(released.max_away_ms, 30_000);
});

test("acquire validates closed sets and dispose releases everything", () => {
  const harness = createHarness();
  assert.throws(() => harness.controller.acquire("bogus", "s1"), TypeError);
  assert.throws(() => harness.controller.acquire("turn", ""), TypeError);
  assert.throws(() => harness.controller.acquire("turn", 42), TypeError);

  harness.controller.acquire("loop", "s1");
  assert.deepEqual(harness.starts, [1]);
  harness.controller.dispose();
  assert.deepEqual(harness.stops, [1], "dispose 停掉 blocker");
  assert.equal(harness.controller.getSnapshot().claims.length, 0);
  assert.equal(harness.timers.intervals.length, 0);
  assert.equal(harness.timers.timeouts.length, 0);
  assert.equal(harness.powerListeners.get("on-ac").size, 0);
  assert.equal(harness.powerListeners.get("on-battery").size, 0);
  // dispose 后 reconcile 不再起 blocker。
  harness.controller.reconcile("after-dispose");
  assert.deepEqual(harness.starts, [1]);
});

test("session ids are sanitized in log payloads", () => {
  const harness = createHarness();
  harness.controller.acquire("turn", "sess ion/id\u0000secret");
  const acquired = findStructured(harness.logger.entries, "keep_awake_claim_acquired")[0];
  assert.equal(acquired.session_id, "sess_ion_id_secret");
  assert.ok(!JSON.stringify(harness.logger.entries).includes("\u0000"));
});
