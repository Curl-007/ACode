// Overnight（K3）完成通知桌面出口测试（specs/overnight-completion-notify.md §8）。
// 覆盖：焦点抑制、非焦点弹出、runId 幂等（强于 3s 窗）、点击直达 parentTaskId、
// 平台不支持降级（不消费幂等槽）、缺文案守卫、双 locale 文案、角标单写者不回归、
// dispatchTaskNotification 重构后行为不变。house style：transpile + stub electron，
// 加载真实 desktopNotifications / overnightCompletionNotify / unreadBadge，无 Electron 运行时。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind } from "typescript";

const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

async function readSource(relative) {
  return readFile(new URL(relative, root), "utf8");
}

async function loadMain(relative, imports = {}) {
  const source = await readSource(`src/main/${relative}.ts`);
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => {
    if (name.startsWith("node:")) return nodeRequire(name);
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}

// ── 可控 electron 替身 ──────────────────────────────────────────────
const electronState = {
  supported: true,
  focusedWindows: [],
  notifications: [],
};

class NotificationStub {
  constructor(options) {
    this.options = options;
    this.listeners = {};
    this.shown = false;
    electronState.notifications.push(this);
  }
  once(event, cb) {
    this.listeners[event] = cb;
  }
  show() {
    this.shown = true;
  }
  // 测试驱动点击/关闭
  emitClick() {
    this.listeners.click?.();
  }
  static isSupported() {
    return electronState.supported;
  }
}

function makeFakeWindow({ id = 1, focused = false } = {}) {
  const calls = [];
  const sent = [];
  return {
    id,
    calls,
    sent,
    isDestroyed: () => false,
    isFocused: () => focused,
    isMinimized: () => false,
    restore: () => calls.push("restore"),
    isVisible: () => true,
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    webContents: {
      send: (channel, ...args) => sent.push([channel, ...args]),
    },
  };
}

const electronStub = {
  app: {
    dock: { show() {} },
    show() {},
    focus() {},
  },
  BrowserWindow: {
    getAllWindows: () => electronState.focusedWindows,
    fromWebContents: () => null,
  },
  Notification: NotificationStub,
};

const sharedStub = {
  PlatformChannels: new Proxy({}, { get: (_, key) => String(key) }),
  formatZodError: (e) => String(e),
  taskNotificationPayloadSchema: {
    safeParse: (data) => ({ success: true, data }),
  },
};

function resetElectron() {
  electronState.supported = true;
  electronState.focusedWindows = [];
  electronState.notifications = [];
}

const desktopNotifications = await loadMain("desktopNotifications", {
  electron: electronStub,
  "@acode/shared": sharedStub,
});
const overnightMod = await loadMain("overnightCompletionNotify", {
  "./desktopNotifications.js": desktopNotifications,
});
// unreadBadge 是纯模块（零 import），直接加载真实实现验证角标单写者语义。
const unreadBadge = await loadMain("unreadBadge", {});

const { createOvernightCompletionNotifier } = overnightMod;
const { presentTaskNotification, dispatchTaskNotification } = desktopNotifications;

const silentLogger = { info() {}, warn() {} };

// desktopNotifications 的 3s status:taskId 去重表是模块级、跨 test 常驻的（生产正确行为）。
// 测试必须给每条「期望弹出」的信号一个唯一 taskId，否则会被前一个 test 的同 taskId 条目抑制。
let taskIdSeq = 0;
function uniqueTaskId(prefix = "parent-task") {
  taskIdSeq += 1;
  return `${prefix}-${taskIdSeq}`;
}

function makeNotifier({ window, locale = "zh-CN" } = {}) {
  return createOvernightCompletionNotifier({
    resolveTargetWindow: () => window ?? null,
    getLocale: () => locale,
    logger: silentLogger,
  });
}

function completionSignal(overrides = {}) {
  return {
    runId: "overnight-run-1",
    parentTaskId: uniqueTaskId(),
    outcome: "completed",
    morningReportReady: true,
    ...overrides,
  };
}

// ── 场景 1：焦点抑制 ────────────────────────────────────────────────
test("场景1: 任一窗口聚焦时完成信号不弹通知", () => {
  resetElectron();
  electronState.focusedWindows = [makeFakeWindow({ focused: true })];
  const notifier = makeNotifier({ window: makeFakeWindow() });

  const presented = notifier.notify(completionSignal());

  assert.equal(presented, false, "焦点时不弹");
  assert.equal(electronState.notifications.length, 0, "Notification 未构造");
});

// ── 场景 2：非焦点弹出 + 本地化文案 ─────────────────────────────────
test("场景2: 无窗口聚焦时弹一条通知，文案为 zh-CN completedReport", () => {
  resetElectron();
  electronState.focusedWindows = [makeFakeWindow({ focused: false })];
  const notifier = makeNotifier({ window: makeFakeWindow(), locale: "zh-CN" });

  const presented = notifier.notify(completionSignal());

  assert.equal(presented, true, "非焦点弹出");
  assert.equal(electronState.notifications.length, 1, "恰一条");
  const n = electronState.notifications[0];
  assert.equal(n.shown, true);
  assert.equal(n.options.title, "挂机任务已完成");
  assert.equal(n.options.body, "晨报已就绪，点击查看今日成果。");
});

// ── 场景 3：runId 幂等（强于 3s 通用去重窗）─────────────────────────
test("场景3: 同一 runId 跨 >3s 窗连投仅弹一次；不同 runId 各弹一次", () => {
  resetElectron();
  electronState.focusedWindows = [];
  const notifier = makeNotifier({ window: makeFakeWindow() });

  // 固定同一 parentTaskId：3s 通用去重按 status:taskId 键，若只看它，跨过 3s 窗后
  // 同 taskId 会**允许**重发；runId 幂等必须更强——同 runId 跨窗仍不重发。
  const fixedTaskId = uniqueTaskId("run3-parent");
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    assert.equal(
      notifier.notify(completionSignal({ runId: "run-A", parentTaskId: fixedTaskId })),
      true,
    );
    clock += 10_000; // > TASK_NOTIFICATION_DEDUPE_WINDOW_MS(3000)：通用去重已放行
    assert.equal(
      notifier.notify(completionSignal({ runId: "run-A", parentTaskId: fixedTaskId })),
      false,
      "同 runId 跨 3s 窗仍不重发（runId 幂等强于通用去重）",
    );
    clock += 10_000;
    assert.equal(
      notifier.notify(completionSignal({ runId: "run-B", parentTaskId: fixedTaskId })),
      true,
      "不同 runId 弹（即使 taskId 相同）",
    );
  } finally {
    Date.now = realNow;
  }

  assert.equal(electronState.notifications.length, 2, "run-A 一次 + run-B 一次");
  assert.equal(notifier.notifiedRunCount(), 2);
});

// ── 场景 4：点击直达 parentTaskId ───────────────────────────────────
test("场景4: 点击通知聚焦窗口并向 parentTaskId 路由 TaskNotificationClick", () => {
  resetElectron();
  electronState.focusedWindows = [];
  const targetWindow = makeFakeWindow({ id: 7 });
  const notifier = makeNotifier({ window: targetWindow });

  notifier.notify(completionSignal({ parentTaskId: "parent-XYZ", outcome: "completed" }));
  assert.equal(electronState.notifications.length, 1);

  const n = electronState.notifications[0];
  n.emitClick();

  assert.ok(targetWindow.calls.includes("focus"), "目标窗口被聚焦");
  const clickMsg = targetWindow.sent.find((m) => m[0] === "TaskNotificationClick");
  assert.ok(clickMsg, "发出 TaskNotificationClick");
  assert.equal(clickMsg[1], "parent-XYZ", "路由到 parentTaskId（非 coordinator）");
});

// ── 场景 5：平台不支持降级（不消费幂等槽）──────────────────────────
test("场景5: Notification 不支持时 return false 且不消费 runId 幂等槽", () => {
  resetElectron();
  electronState.supported = false;
  electronState.focusedWindows = [];
  const notifier = makeNotifier({ window: makeFakeWindow() });

  const presented = notifier.notify(completionSignal({ runId: "run-unsupported" }));

  assert.equal(presented, false, "降级 no-op");
  assert.equal(electronState.notifications.length, 0, "未构造 Notification");
  assert.equal(notifier.notifiedRunCount(), 0, "未记 runId（平台恢复后可重试）");

  // 平台恢复后同一 runId 仍可弹
  electronState.supported = true;
  assert.equal(notifier.notify(completionSignal({ runId: "run-unsupported" })), true);
  assert.equal(electronState.notifications.length, 1);
});

// ── 场景 6：缺文案守卫（共享呈现核纪律）────────────────────────────
test("场景6: 空 title/body 被 presentTaskNotification 拒绝（missing_copy）", () => {
  resetElectron();
  electronState.focusedWindows = [];

  const outcome = presentTaskNotification({
    senderWindow: makeFakeWindow(),
    payload: { taskId: "t1", status: "completed", title: "  ", body: "" },
    logger: silentLogger,
  });

  assert.equal(outcome, "missing_copy");
  assert.equal(electronState.notifications.length, 0, "不弹空通知");
});

// ── 场景 7：双 locale 文案解析 ──────────────────────────────────────
test("场景7: en-US / zh-CN 各取对应语言文案", () => {
  resetElectron();
  electronState.focusedWindows = [];
  makeNotifier({ window: makeFakeWindow(), locale: "en-US" }).notify(
    completionSignal({ runId: "run-en", outcome: "failed" }),
  );
  assert.equal(electronState.notifications[0].options.title, "Overnight run failed");

  resetElectron();
  electronState.focusedWindows = [];
  makeNotifier({ window: makeFakeWindow(), locale: "zh-CN" }).notify(
    completionSignal({ runId: "run-zh", outcome: "cancelled" }),
  );
  assert.equal(electronState.notifications[0].options.title, "挂机任务已取消");
});

test("场景7b: completed 无晨报 → completedNoReport 文案", () => {
  resetElectron();
  electronState.focusedWindows = [];
  makeNotifier({ window: makeFakeWindow(), locale: "zh-CN" }).notify(
    completionSignal({ runId: "run-noreport", morningReportReady: false }),
  );
  assert.equal(electronState.notifications[0].options.title, "挂机任务已结束");
});

// ── 场景 8：角标单写者不回归（unreadBadge 纯函数）──────────────────
test("场景8: unreadBadge 计数单写者——0→1→0 归零回收，多窗口求和不重复计", () => {
  // parseWindowUnreadCount 只接受非负整数
  assert.equal(unreadBadge.parseWindowUnreadCount(0), 0);
  assert.equal(unreadBadge.parseWindowUnreadCount(3), 3);
  assert.equal(unreadBadge.parseWindowUnreadCount(-1), null);
  assert.equal(unreadBadge.parseWindowUnreadCount(1.5), null);
  assert.equal(unreadBadge.parseWindowUnreadCount("2"), null);

  // 单窗口 0→1→0：Map 语义由 handleWindowUnreadCountSync 承载，这里验求和与徽标下发。
  const badgeCalls = [];
  const setBadgeCount = (n) => badgeCalls.push(n);
  const map = new Map();

  map.set(1, 1); // 一个未读
  unreadBadge.syncAppUnreadBadge({
    platform: "darwin",
    totalUnreadCount: unreadBadge.sumWindowUnreadCounts(map),
    setBadgeCount,
  });
  assert.equal(badgeCalls.at(-1), 1);

  map.delete(1); // 归零回收
  unreadBadge.syncAppUnreadBadge({
    platform: "darwin",
    totalUnreadCount: unreadBadge.sumWindowUnreadCounts(map),
    setBadgeCount,
  });
  assert.equal(badgeCalls.at(-1), 0);

  // 多窗口求和：两个窗口各 1 个未读 → 2，不重复计同一窗口
  const multi = new Map([
    [1, 1],
    [2, 1],
  ]);
  assert.equal(unreadBadge.sumWindowUnreadCounts(multi), 2);

  // Windows 不支持 app badge：setBadgeCount 不被调用（跨平台降级）
  const winCalls = [];
  unreadBadge.syncAppUnreadBadge({
    platform: "win32",
    totalUnreadCount: 5,
    setBadgeCount: (n) => winCalls.push(n),
  });
  assert.equal(winCalls.length, 0, "win32 无 dock badge");
});

// ── 场景 9：dispatchTaskNotification 重构后行为不变 ─────────────────
test("场景9a: dispatchTaskNotification 焦点时返回 false 不弹", () => {
  resetElectron();
  electronState.focusedWindows = [makeFakeWindow({ focused: true })];
  const ok = dispatchTaskNotification({
    event: { sender: {} },
    payload: { taskId: "t", status: "completed", title: "标题", body: "正文" },
    logger: silentLogger,
  });
  assert.equal(ok, false);
  assert.equal(electronState.notifications.length, 0);
});

test("场景9b: dispatchTaskNotification 非焦点弹出并返回 true", () => {
  resetElectron();
  electronState.focusedWindows = [];
  const ok = dispatchTaskNotification({
    event: { sender: {} },
    payload: { taskId: "t-ipc", status: "completed", title: "标题", body: "正文" },
    logger: silentLogger,
  });
  assert.equal(ok, true);
  assert.equal(electronState.notifications.length, 1);
  assert.equal(electronState.notifications[0].options.title, "标题");
});

test("场景9c: dispatchTaskNotification 缺文案返回 false", () => {
  resetElectron();
  electronState.focusedWindows = [];
  const ok = dispatchTaskNotification({
    event: { sender: {} },
    payload: { taskId: "t", status: "completed", title: "", body: "" },
    logger: silentLogger,
  });
  assert.equal(ok, false);
  assert.equal(electronState.notifications.length, 0);
});
