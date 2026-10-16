import assert from "node:assert/strict";
import test from "node:test";
import {
  assertValidIpcSyncLabel,
  consumeWorstIpcSyncOffender,
  createIpcSyncTimingTracker,
  deriveIpcSyncLabel,
  IPC_SYNC_LABEL_PATTERN,
  wrapIpcHandle,
} from "../src/main/ipcSyncTiming.js";

/**
 * 同步 IPC worst-offender（specs/main-stall-diagnostics.md R9）单测：
 * 假时钟驱动，逐条断言「只测同步段」「严格大于替换」「消费即清零」
 * 「非法 label 抛错注册」与 Symbol.dispose 计时器语义。
 */

function createFakeClock(start = 0) {
  const state = { t: start };
  return {
    now: () => state.t,
    advance(ms) {
      state.t += ms;
    },
  };
}

test("wrapIpcHandle：async handler 只计同步前缀，await 后的耗时不进账", async () => {
  const clock = createFakeClock();
  const tracker = createIpcSyncTimingTracker({ now: clock.now });
  let resolveInner;
  const handler = tracker.wrapIpcHandle("select_directory", () => {
    clock.advance(30); // 同步段 30ms
    return new Promise((resolve) => {
      resolveInner = resolve;
    });
  });
  const promise = handler({ fake: "event" }, "arg");
  clock.advance(5_000); // 异步等待期：main 没有被阻塞，不得计入
  resolveInner("done");
  await promise;
  assert.deepEqual(tracker.consumeWorst(), { label: "select_directory", syncMs: 30 });
});

test("wrapIpcHandle：sync handler 计整个函数体；handler 同步抛错也记账", () => {
  const clock = createFakeClock();
  const tracker = createIpcSyncTimingTracker({ now: clock.now });
  const sync = tracker.wrapIpcHandle("sync_path", () => {
    clock.advance(12);
    return "ok";
  });
  assert.equal(sync(), "ok");
  assert.deepEqual(tracker.peekWorst(), { label: "sync_path", syncMs: 12 });

  const throwing = tracker.wrapIpcHandle("throws_path", () => {
    clock.advance(40);
    throw new Error("handler boom");
  });
  assert.throws(() => throwing(), /handler boom/u);
  // worst-offender 是窗口内最大值（40 > 12），不是累计和
  assert.deepEqual(tracker.consumeWorst(), { label: "throws_path", syncMs: 40 });
});

test("worst-offender：严格大于才替换（并列先到者保留），NaN/负值忽略", () => {
  const tracker = createIpcSyncTimingTracker({ now: () => 0 });
  tracker.record("first_label", 10);
  tracker.record("second_label", 10); // 并列：不替换
  tracker.record("third_label", 9.6); // 更小：不替换
  tracker.record("bad_nan", Number.NaN);
  tracker.record("bad_negative", -5);
  assert.deepEqual(tracker.peekWorst(), { label: "first_label", syncMs: 10 });
  tracker.record("bigger_label", 10.4);
  // 读出时四舍五入（记账保留原值用于严格比较）
  assert.deepEqual(tracker.peekWorst(), { label: "bigger_label", syncMs: 10 });
  tracker.record("rounds_up", 10.6);
  assert.deepEqual(tracker.consumeWorst(), { label: "rounds_up", syncMs: 11 });
});

test("消费即清零：consumeWorst 读出后归零，窗口重新累积；syncMs 四舍五入", () => {
  const tracker = createIpcSyncTimingTracker({ now: () => 0 });
  assert.equal(tracker.consumeWorst(), null, "空窗口读出 null");
  tracker.record("parse_config", 12.6);
  assert.deepEqual(tracker.consumeWorst(), { label: "parse_config", syncMs: 13 });
  assert.equal(tracker.peekWorst(), null, "消费后必须清零（stall 报告不重复顶包）");
  tracker.record("next_window", 3);
  assert.deepEqual(tracker.consumeWorst(), { label: "next_window", syncMs: 3 });
});

test("label 白名单：非法 label 注册即抛错，绝不静默降级", () => {
  const tracker = createIpcSyncTimingTracker({ now: () => 0 });
  const invalid = [
    "",
    "a".repeat(41),
    "has-dash",
    "has space",
    "HasUpper",
    "has1digit",
    "acode:channel",
    "拖拽面板",
    null,
    undefined,
    42,
  ];
  for (const label of invalid) {
    assert.throws(
      () => tracker.wrapIpcHandle(label, () => {}),
      TypeError,
      `wrapIpcHandle 应拒绝 ${String(label)}`,
    );
    assert.throws(
      () => tracker.createSyncSegmentTimer(label),
      TypeError,
      `createSyncSegmentTimer 应拒绝 ${String(label)}`,
    );
    assert.throws(() => tracker.record(label, 1), TypeError);
  }
  assert.doesNotThrow(() => assertValidIpcSyncLabel("a"));
  assert.doesNotThrow(() => assertValidIpcSyncLabel("_".repeat(40)));
  assert.equal(IPC_SYNC_LABEL_PATTERN.test("select_directory"), true);
});

test("deriveIpcSyncLabel：剥 scheme、折叠非法段、去首尾下划线、截断 40；派生失败抛错", () => {
  assert.equal(deriveIpcSyncLabel("acode:select-directory"), "select_directory");
  assert.equal(
    deriveIpcSyncLabel("acode:get-desktop-window-chrome-state"),
    "get_desktop_window_chrome_state",
  );
  assert.equal(deriveIpcSyncLabel("no-scheme-channel"), "no_scheme_channel");
  assert.equal(deriveIpcSyncLabel("acode:--weird__CASE--"), "weird_case");
  const long = deriveIpcSyncLabel(`acode:${"segment-".repeat(12)}`);
  assert.ok(long.length <= 40, `截断到 40：${long}`);
  assert.equal(IPC_SYNC_LABEL_PATTERN.test(long), true);
  assert.ok(!long.endsWith("_"), "截断后不得留尾部下划线");
  assert.throws(() => deriveIpcSyncLabel("acode:12345"), TypeError, "纯数字派生为空应抛错");
  assert.throws(() => deriveIpcSyncLabel(""), TypeError);
});

test("Symbol.dispose 计时器：using 块退出时记账到同一 worst-offender", () => {
  const clock = createFakeClock();
  const tracker = createIpcSyncTimingTracker({ now: clock.now });
  {
    using timer = tracker.createSyncSegmentTimer("deep_link_sync");
    assert.ok(timer, "计时器对象存在");
    clock.advance(77);
  } // using 块退出 → Symbol.dispose → 记账
  assert.deepEqual(tracker.consumeWorst(), { label: "deep_link_sync", syncMs: 77 });

  // 手动 dispose 形状（接线方不用 using 语法时的等价路径）
  const manual = tracker.createSyncSegmentTimer("menu_callback");
  clock.advance(5);
  manual[Symbol.dispose]();
  assert.deepEqual(tracker.consumeWorst(), { label: "menu_callback", syncMs: 5 });
});

test("模块级默认单例：wrapIpcHandle/consumeWorstIpcSyncOffender 共享同一存储", () => {
  const before = consumeWorstIpcSyncOffender();
  assert.equal(before, null, "默认单例初始为空（或已被前一消费清空）");
  let tick = 0;
  const wrapped = wrapIpcHandle("default_tracker_probe", () => {
    // 真实 performance.now 下同步段接近 0ms，但 0 >= 0 仍应记账。
    tick += 1;
    return tick;
  });
  wrapped({}, "x");
  const worst = consumeWorstIpcSyncOffender();
  assert.ok(worst, "默认单例必须记到 worst-offender");
  assert.equal(worst.label, "default_tracker_probe");
  assert.ok(worst.syncMs >= 0);
  assert.equal(consumeWorstIpcSyncOffender(), null, "消费即清零");
});
