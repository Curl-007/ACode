import assert from "node:assert/strict";
import test from "node:test";
import {
  createPresenceSystemSource,
  createPresenceTracker,
  POWER_MONITOR_EVENT_MAP,
  PRESENCE_EVENT_NAMES,
} from "../src/main/presenceSnapshot.js";

/**
 * presence 快照（specs/main-stall-diagnostics.md R10）单测：
 * 假时钟 + 假系统源驱动六事件总线、锁屏自愈、可空快照与订阅面。
 */

function createFakeSystem(initial = {}) {
  const state = {
    idleSeconds: initial.idleSeconds ?? 0,
    systemLocked: initial.systemLocked ?? false,
    onBattery: initial.onBattery ?? false,
    throwOnIdle: false,
    throwOnLocked: false,
    throwOnBattery: false,
  };
  return {
    state,
    source: {
      getSystemIdleSeconds() {
        if (state.throwOnIdle) throw new Error("idle boom");
        return state.idleSeconds;
      },
      isScreenLockedBySystem() {
        if (state.throwOnLocked) throw new Error("locked boom");
        return state.systemLocked;
      },
      isOnBatteryPower() {
        if (state.throwOnBattery) throw new Error("battery boom");
        return state.onBattery;
      },
    },
  };
}

function createHarness({ system = null, startMs = 1_000_000 } = {}) {
  const state = { t: startMs };
  const tracker = createPresenceTracker({
    now: () => state.t,
    system,
  });
  return {
    tracker,
    advance(ms) {
      state.t += ms;
    },
    at: () => state.t,
  };
}

test("六事件闭集与 powerMonitor 事件映射面完整", () => {
  assert.deepEqual(
    [...PRESENCE_EVENT_NAMES],
    ["suspend", "lock", "unlock", "resume", "session", "focus"],
  );
  assert.deepEqual(Object.values(POWER_MONITOR_EVENT_MAP).sort(), [
    "lock",
    "resume",
    "session",
    "suspend",
    "unlock",
  ]);
});

test("快照：事件从未发生 ⇒ 对应字段 null；发生后按墙钟折算秒数", () => {
  const fake = createFakeSystem({ idleSeconds: 42, onBattery: true });
  const h = createHarness({ system: fake.source, startMs: 10_000_000 });
  const empty = h.tracker.getSnapshot();
  assert.deepEqual(empty, {
    seconds_since_resume: null,
    seconds_since_unlock: null,
    idle_seconds: 42,
    locked: false,
    on_battery: true,
  });

  h.tracker.handleEvent("resume");
  h.advance(90_000);
  h.tracker.handleEvent("unlock");
  h.advance(30_000);
  const snapshot = h.tracker.getSnapshot();
  assert.equal(snapshot.seconds_since_resume, 120);
  assert.equal(snapshot.seconds_since_unlock, 30);
  assert.equal(snapshot.idle_seconds, 42);
  assert.equal(snapshot.on_battery, true);
});

test("未知事件名 fail-closed 抛错（总线不退化成死数据）", () => {
  const h = createHarness();
  assert.throws(() => h.tracker.handleEvent("bogus"), TypeError);
  assert.throws(() => h.tracker.handleEvent(""), TypeError);
});

test("锁屏：lock 置标志、unlock 清除；系统源 locked 同样计入", () => {
  const fake = createFakeSystem();
  const h = createHarness({ system: fake.source });
  assert.equal(h.tracker.isScreenLocked(), false);
  h.tracker.handleEvent("lock");
  assert.equal(h.tracker.isScreenLocked(), true);
  assert.equal(h.tracker.getSnapshot().locked, true);
  h.tracker.handleEvent("unlock");
  assert.equal(h.tracker.isScreenLocked(), false);

  fake.state.systemLocked = true; // powerMonitor.getSystemIdleState(1) === "locked"
  assert.equal(h.tracker.isScreenLocked(), true);
});

test("锁屏自愈：unlock 丢失但空闲时长证明锁后有过活动 ⇒ stale lock 被清除", () => {
  const fake = createFakeSystem();
  const h = createHarness({ system: fake.source, startMs: 1_000_000 });
  h.tracker.handleEvent("lock"); // lockedAt = 1_000_000
  h.advance(60_000);
  // 空闲 10s ⇒ 最近一次用户活动在 t-10s = 锁之后（容差 2s 之外）⇒ 自愈清标志
  fake.state.idleSeconds = 10;
  assert.equal(h.tracker.isScreenLocked(), false, "stale lock 必须被自愈清除");
  assert.equal(h.tracker.getSnapshot().locked, false);
});

test("锁屏自愈边界：活动落在容差内不自愈；锁后无活动保持 locked", () => {
  const fake = createFakeSystem();
  const h = createHarness({ system: fake.source, startMs: 1_000_000 });
  h.tracker.handleEvent("lock");
  h.advance(1_000);
  // 空闲 0s ⇒ 最近活动 = now；now - 0 > lockedAt + 2000 ? 1_001_000 > 1_002_000 = false
  fake.state.idleSeconds = 0;
  assert.equal(h.tracker.isScreenLocked(), true, "容差内不得自愈（防抖）");

  const h2 = createHarness({ system: fake.source, startMs: 5_000_000 });
  h2.tracker.handleEvent("lock");
  h2.advance(600_000);
  // 空闲 600s ⇒ 最近活动 = 加锁时刻本身，没有锁后活动的证据 ⇒ 保持 locked
  fake.state.idleSeconds = 600;
  assert.equal(h2.tracker.isScreenLocked(), true, "锁后无活动证据不得清除标志");
});

test("系统源缺席：idle/locked/on_battery 为 null/false，事件面照常", () => {
  const h = createHarness({ system: null });
  h.tracker.handleEvent("resume");
  h.advance(5_000);
  const snapshot = h.tracker.getSnapshot();
  assert.equal(snapshot.seconds_since_resume, 5);
  assert.equal(snapshot.idle_seconds, null);
  assert.equal(snapshot.on_battery, null);
  assert.equal(snapshot.locked, false, "无系统源时只能依赖事件标志");
  h.tracker.handleEvent("lock");
  assert.equal(h.tracker.getSnapshot().locked, true);
});

test("getter 抛错：快照整体全 null，不反杀调用方", () => {
  const fake = createFakeSystem();
  const h = createHarness({ system: fake.source });
  h.tracker.handleEvent("resume");
  fake.state.throwOnIdle = true;
  assert.deepEqual(h.tracker.getSnapshot(), {
    seconds_since_resume: null,
    seconds_since_unlock: null,
    idle_seconds: null,
    locked: null,
    on_battery: null,
  });
});

test("subscribe：六事件总线广播事件名与时刻；退订生效", () => {
  const h = createHarness({ startMs: 7_000 });
  const seen = [];
  const unsubscribe = h.tracker.subscribe((name, atMs) => seen.push([name, atMs]));
  h.tracker.handleEvent("suspend");
  h.tracker.handleEvent("focus", 8_500);
  unsubscribe();
  h.tracker.handleEvent("resume");
  assert.deepEqual(seen, [
    ["suspend", 7_000],
    ["focus", 8_500],
  ]);
});

test("attach：powerMonitor 五事件 + app focus 一次性接线，触发即入账", () => {
  const registered = { power: new Map(), app: new Map() };
  const emitters = {
    powerMonitor: {
      on(event, listener) {
        registered.power.set(event, listener);
        return this;
      },
    },
    app: {
      on(event, listener) {
        registered.app.set(event, listener);
        return this;
      },
    },
  };
  const h = createHarness({ startMs: 2_000_000 });
  const seen = [];
  h.tracker.subscribe((name) => seen.push(name));
  h.tracker.attach(emitters);
  assert.deepEqual([...registered.power.keys()].sort(), [
    "lock-screen",
    "resume",
    "suspend",
    "unlock-screen",
    "user-did-become-active",
  ]);
  assert.deepEqual([...registered.app.keys()], ["browser-window-focus"]);

  registered.power.get("suspend")();
  registered.power.get("lock-screen")();
  registered.power.get("unlock-screen")();
  registered.power.get("resume")();
  registered.power.get("user-did-become-active")();
  registered.app.get("browser-window-focus")();
  assert.deepEqual(seen, ["suspend", "lock", "unlock", "resume", "session", "focus"]);
  assert.equal(h.tracker.getSnapshot().locked, false);
});

test("createPresenceSystemSource：真实 powerMonitor 结构面适配", () => {
  const calls = [];
  const source = createPresenceSystemSource({
    getSystemIdleTime() {
      calls.push("idle");
      return 17;
    },
    getSystemIdleState(threshold) {
      calls.push(`state:${threshold}`);
      return threshold === 1 ? "locked" : "active";
    },
    isOnBatteryPower() {
      calls.push("battery");
      return true;
    },
  });
  assert.equal(source.getSystemIdleSeconds(), 17);
  assert.equal(source.isScreenLockedBySystem(), true);
  assert.equal(source.isOnBatteryPower(), true);
  assert.deepEqual(calls, ["idle", "state:1", "battery"]);
});
