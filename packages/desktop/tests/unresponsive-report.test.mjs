import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrintCallGuard,
  PRINT_CALL_IPC_CHANNEL,
  PRINT_CALL_MAX_TRUSTED_AGE_MS,
  registerPrintCallIpc,
} from "../src/main/printCallGuard.js";
import {
  classifyUnresponsiveSurface,
  createUnresponsiveReporter,
  RECENT_STALL_WINDOW_MS,
  UNRESPONSIVE_LOG_STATUS,
} from "../src/main/unresponsiveReport.js";
import { createContentBreadcrumbRegistry } from "../src/main/contentBreadcrumb.js";

/**
 * print() 假死守卫与 unresponsive 聚合报告（specs/main-stall-diagnostics.md R12）
 * 单测：假时钟驱动守卫状态机与归因闭集全分支；聚合 payload 逐键断言；
 * sender 校验拒绝面；诊断-only 边界（只记日志、不 kill）。
 */

const TRUSTED_FRAME = { url: "file:///app/out/renderer/index.html", parent: null };

function createCollectorLogger() {
  const calls = [];
  return {
    calls,
    logger: {
      info: (...args) => calls.push(["info", ...args]),
      warn: (...args) => calls.push(["warn", ...args]),
    },
  };
}

// ---------------------------------------------------------------------------
// print() 假死守卫
// ---------------------------------------------------------------------------

test("守卫：开始/结束上报记账；sender 校验拒绝不改状态", () => {
  let t = 0;
  const guard = createPrintCallGuard({ now: () => t });
  assert.equal(guard.reportPrintCall({ webContentsId: 1, frame: TRUSTED_FRAME }, true), true);
  assert.equal(guard.isInProgress(1), true);
  assert.equal(
    guard.reportPrintCall(
      { webContentsId: 2, frame: { url: "https://example.com/", parent: null } },
      true,
    ),
    false,
    "远程 origin 拒绝",
  );
  assert.equal(guard.isInProgress(2), false, "被拒上报不得入账");
  assert.equal(guard.reportPrintCall({ webContentsId: 1, frame: TRUSTED_FRAME }, false), true);
  assert.equal(guard.isInProgress(1), false, "结束上报清账");
});

test("守卫：多窗口按 wc 独立记账；导航/销毁清理", () => {
  const guard = createPrintCallGuard({ now: () => 0 });
  guard.reportPrintCall({ webContentsId: 1, frame: TRUSTED_FRAME }, true);
  guard.reportPrintCall({ webContentsId: 2, frame: TRUSTED_FRAME }, true);
  guard.clearForWebContents(1);
  assert.equal(guard.isInProgress(1), false);
  assert.equal(guard.isInProgress(2), true);
});

test("守卫归因闭集：none / in_progress / window_focused / switch_off / too_old", () => {
  let t = 1_000;
  let enabled = true;
  const guard = createPrintCallGuard({ now: () => t, guardEnabled: () => enabled });

  // none：无 print 状态
  assert.deepEqual(guard.evaluate(9, { windowFocused: false }), {
    skipStallVerdict: false,
    printCall: "none",
    printCallAgeMs: null,
  });

  guard.reportPrintCall({ webContentsId: 9, frame: TRUSTED_FRAME }, true);
  t = 31_000; // age 30s

  // in_progress：print 中 + 窗口未聚焦 + 守卫开 ⇒ 不判卡顿
  assert.deepEqual(guard.evaluate(9, { windowFocused: false }), {
    skipStallVerdict: true,
    printCall: "in_progress",
    printCallAgeMs: 30_000,
  });

  // window_focused：打印对话框必然夺焦，仍聚焦 ⇒ 照常判卡顿
  assert.deepEqual(guard.evaluate(9, { windowFocused: true }), {
    skipStallVerdict: false,
    printCall: "window_focused",
    printCallAgeMs: 30_000,
  });

  // switch_off：守卫关闭 ⇒ 照常判卡顿
  enabled = false;
  assert.deepEqual(guard.evaluate(9, { windowFocused: false }), {
    skipStallVerdict: false,
    printCall: "switch_off",
    printCallAgeMs: 30_000,
  });
  enabled = true;

  // too_old：超过 10min 信任上限 ⇒ 清账并照常判卡顿（结束上报丢失的自愈）
  t = 1_000 + PRINT_CALL_MAX_TRUSTED_AGE_MS + 1;
  const tooOld = guard.evaluate(9, { windowFocused: false });
  assert.equal(tooOld.printCall, "too_old");
  assert.equal(tooOld.skipStallVerdict, false);
  assert.equal(guard.isInProgress(9), false, "too_old 必须顺手清账");
});

test("registerPrintCallIpc：boolean 校验先行、sender 拒绝 warn、注销移除监听", () => {
  const guard = createPrintCallGuard({ now: () => 0 });
  const listeners = new Map();
  const ipcMain = {
    on(channel, listener) {
      (listeners.get(channel) ?? listeners.set(channel, []).get(channel)).push(listener);
      return this;
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      return this;
    },
    emit(channel, event, payload) {
      for (const listener of listeners.get(channel) ?? []) listener(event, payload);
    },
  };
  const { calls, logger } = createCollectorLogger();
  const dispose = registerPrintCallIpc({ ipcMain, guard, logger });
  assert.equal(PRINT_CALL_IPC_CHANNEL, "acode:print-call");

  // 畸形 payload：不得触碰守卫状态
  ipcMain.emit(PRINT_CALL_IPC_CHANNEL, { sender: { id: 1 }, senderFrame: TRUSTED_FRAME }, "yes");
  assert.equal(guard.isInProgress(1), false);
  assert.equal(calls.at(-1)[2].event, "print_call_payload_invalid");

  // 合法上报
  ipcMain.emit(PRINT_CALL_IPC_CHANNEL, { sender: { id: 1 }, senderFrame: TRUSTED_FRAME }, true);
  assert.equal(guard.isInProgress(1), true);

  // 非受信 sender：拒绝并 warn（不回显 URL）
  ipcMain.emit(
    PRINT_CALL_IPC_CHANNEL,
    { sender: { id: 5 }, senderFrame: { url: "https://evil.example/", parent: null } },
    true,
  );
  assert.equal(guard.isInProgress(5), false);
  const warning = calls.at(-1)[2];
  assert.equal(warning.event, "print_call_sender_rejected");
  assert.equal(JSON.stringify(warning).includes("evil.example"), false);

  dispose();
  assert.equal(listeners.get(PRINT_CALL_IPC_CHANNEL).length, 0);
});

// ---------------------------------------------------------------------------
// surface 分类
// ---------------------------------------------------------------------------

test("surface 分类：hint 闭集映射 + login 细分 + unknown 兜底", () => {
  assert.equal(classifyUnresponsiveSurface({ windowKind: "main" }), "app_main");
  assert.equal(
    classifyUnresponsiveSurface({
      windowKind: "main",
      url: "file:///app/out/renderer/login.html?x=1",
    }),
    "app_login",
  );
  assert.equal(
    classifyUnresponsiveSurface({ windowKind: "main", url: "http://localhost:5173/login.html" }),
    "app_login",
  );
  assert.equal(classifyUnresponsiveSurface({ windowKind: "update-status" }), "update_status");
  assert.equal(classifyUnresponsiveSurface({ windowKind: "about" }), "about");
  assert.equal(classifyUnresponsiveSurface({ windowKind: "cua-indicator" }), "cua_indicator");
  assert.equal(classifyUnresponsiveSurface({ windowKind: "embedded-browser" }), "embedded_browser");
  assert.equal(classifyUnresponsiveSurface({ windowKind: "bogus" }), "unknown");
  assert.equal(classifyUnresponsiveSurface(null), "unknown");
  assert.equal(classifyUnresponsiveSurface(undefined), "unknown");
});

// ---------------------------------------------------------------------------
// unresponsive 聚合报告
// ---------------------------------------------------------------------------

function createReporterHarness(overrides = {}) {
  let t = overrides.startMs ?? 1_000_000;
  const { calls, logger } = createCollectorLogger();
  const breadcrumbs = createContentBreadcrumbRegistry({ now: () => t });
  const guard = createPrintCallGuard({ now: () => t });
  const reporter = createUnresponsiveReporter({
    logger,
    now: () => t,
    getProcessRssBytes: () => 321_000_000,
    getPresenceSnapshot: () => ({
      seconds_since_resume: 40,
      seconds_since_unlock: 30,
      idle_seconds: 2,
      locked: false,
      on_battery: false,
    }),
    contentBreadcrumbs: breadcrumbs,
    getLastStallAttribution: () => overrides.lastStall ?? null,
    printCallGuard: guard,
    ...overrides.reporterOverrides,
  });
  return {
    calls,
    reporter,
    breadcrumbs,
    guard,
    advance(ms) {
      t += ms;
    },
    at: () => t,
  };
}

test("聚合：一次 unresponsive ⇒ 恰一条 warn，payload 全字段形状正确", () => {
  const h = createReporterHarness({
    lastStall: {
      stallMs: 2_400,
      sleepSuspected: false,
      captureStatus: "ok",
      ipcSyncWorst: { label: "sync_window_tabs", syncMs: 900 },
      receivedAtMs: 990_000,
    },
  });
  h.breadcrumbs.record(11, {
    route_kind: "chat",
    transcript_msgs_bucket: "huge",
    composer_blocks_bucket: "many",
    rows_held_bucket: "large",
  });
  const payload = h.reporter.handleUnresponsive({
    webContentsId: 11,
    surfaceHint: { windowKind: "main", url: "file:///app/index.html" },
    window: { visible: true, minimized: false, focused: true },
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "warn");
  assert.deepEqual(payload, {
    status: "renderer_unresponsive",
    surface: "app_main",
    main_rss_bytes: 321_000_000,
    window_visible: true,
    window_minimized: false,
    window_focused: true,
    presence: {
      seconds_since_resume: 40,
      seconds_since_unlock: 30,
      idle_seconds: 2,
      locked: false,
      on_battery: false,
    },
    recent_main_stall: {
      stall_ms: 2_400,
      sleep_suspected: false,
      capture_status: "ok",
      ago_ms: 10_000,
      ipc_sync_worst_label: "sync_window_tabs",
      ipc_sync_worst_ms: 900,
    },
    content: {
      route_kind: "chat",
      transcript_msgs_bucket: "huge",
      composer_blocks_bucket: "many",
      rows_held_bucket: "large",
      stamp_age_ms: 0,
    },
    print_call: "none",
  });
  assert.equal(payload.status, UNRESPONSIVE_LOG_STATUS.stalled);
});

test("聚合：print 守卫命中 ⇒ info 级 + print_call 专属 status + age", () => {
  const h = createReporterHarness();
  h.guard.reportPrintCall({ webContentsId: 12, frame: TRUSTED_FRAME }, true);
  h.advance(20_000);
  const payload = h.reporter.handleUnresponsive({
    webContentsId: 12,
    surfaceHint: { windowKind: "main" },
    window: { visible: true, minimized: false, focused: false },
  });
  assert.equal(payload.status, UNRESPONSIVE_LOG_STATUS.printCall);
  assert.equal(payload.print_call, "in_progress");
  assert.equal(payload.print_call_age_ms, 20_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "info", "print 假死不配 warn 噪音");
});

test("聚合：焦点事实缺失按聚焦处理（fail-safe，不误开守卫）", () => {
  const h = createReporterHarness();
  h.guard.reportPrintCall({ webContentsId: 13, frame: TRUSTED_FRAME }, true);
  const payload = h.reporter.handleUnresponsive({
    webContentsId: 13,
    window: { visible: true, minimized: false, focused: null },
  });
  assert.equal(payload.print_call, "window_focused");
  assert.equal(payload.status, UNRESPONSIVE_LOG_STATUS.stalled);
});

test("聚合：最近 stall 归因窗口 60s——窗口外/未来时刻/无保留均 null", () => {
  assert.equal(RECENT_STALL_WINDOW_MS, 60_000);
  const stale = {
    stallMs: 9_000,
    sleepSuspected: true,
    captureStatus: "unavailable",
    ipcSyncWorst: null,
    receivedAtMs: 1_000_000 - 61_000,
  };
  const h1 = createReporterHarness({ lastStall: stale });
  assert.equal(
    h1.reporter.handleUnresponsive({ webContentsId: 1 }).recent_main_stall,
    null,
    "60s 窗口外不带出",
  );
  const h2 = createReporterHarness({
    lastStall: { ...stale, receivedAtMs: 1_000_000 + 5_000 },
  });
  assert.equal(
    h2.reporter.handleUnresponsive({ webContentsId: 1 }).recent_main_stall,
    null,
    "未来时刻（时钟回拨）不带出",
  );
  const h3 = createReporterHarness({
    lastStall: { ...stale, receivedAtMs: 1_000_000 - 59_000 },
  });
  const recent = h3.reporter.handleUnresponsive({ webContentsId: 1 }).recent_main_stall;
  assert.equal(recent.ago_ms, 59_000);
  assert.equal(recent.sleep_suspected, true, "睡眠分类随归因带出（对齐不重复）");
  assert.equal(recent.ipc_sync_worst_label, null);
  assert.equal(recent.ipc_sync_worst_ms, null);
});

test("聚合：可选依赖缺席时全 null 兜底，不炸日志路径", () => {
  const { calls, logger } = createCollectorLogger();
  const reporter = createUnresponsiveReporter({ logger });
  const payload = reporter.handleUnresponsive({ webContentsId: 99 });
  assert.equal(payload.status, UNRESPONSIVE_LOG_STATUS.stalled);
  assert.equal(payload.surface, "unknown");
  assert.equal(payload.presence, null);
  assert.equal(payload.recent_main_stall, null);
  assert.equal(payload.content, null);
  assert.equal(payload.print_call, "none");
  assert.equal(payload.window_visible, null);
  assert.equal(typeof payload.main_rss_bytes, "number", "RSS 默认取 process.memoryUsage");
  assert.equal(calls.length, 1);
});
