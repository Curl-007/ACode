/**
 * 嵌入内容可编辑焦点台账（specs/embedded-content-focus-yield.md §2）单测。
 *
 * 锚定不变量：
 * - 台账写入唯一路径 setEditableFocus；布尔之外一律拒绝（IPC 面收窄）；
 * - 导航 / 渲染进程崩溃 / 销毁自动清集合（收口不依赖 renderer 合作）；
 * - 聚合翻转事件只在「空 ↔ 非空」翻转时触发（菜单重建接线的防抖前提）；
 * - 嵌套 frame 上报被拒（顶层 frame 守卫）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  createEditableFocusLedger,
  registerEmbeddedEditableFocusIpc,
  EMBEDDED_EDITABLE_FOCUS_CHANNEL,
} = await import("../src/main/editableFocusTracker.ts");

/** 结构化 WebContents 假件：记录 on/once 监听器，emit 触发（once 触发后自摘）。 */
function createFakeWebContents(id) {
  const listeners = new Map();
  const fake = {
    id,
    destroyed: false,
    listeners,
    isDestroyed() {
      return fake.destroyed;
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push({ listener, once: false });
      listeners.set(event, list);
      return fake;
    },
    once(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push({ listener, once: true });
      listeners.set(event, list);
      return fake;
    },
    emit(event) {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((entry) => !entry.once),
      );
      for (const entry of list) entry.listener();
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length;
    },
  };
  return fake;
}

function createFlips() {
  const flips = [];
  return { flips, listener: (hasAny) => flips.push(hasAny) };
}

test("置 true 进入台账并触发聚合翻转，重复置 true 不重复通知", () => {
  const ledger = createEditableFocusLedger();
  const { flips, listener } = createFlips();
  ledger.onAggregateChange(listener);
  const wc = createFakeWebContents(11);

  ledger.setEditableFocus(wc, true);
  assert.equal(ledger.hasEditableFocus(11), true);
  assert.equal(ledger.hasAnyEditableFocus(), true);
  assert.deepEqual(flips, [true], "空 → 非空翻转恰好一次");

  ledger.setEditableFocus(wc, true);
  assert.deepEqual(flips, [true], "幂等：无第二次翻转通知");
  assert.equal(wc.listenerCount("did-navigate"), 1, "收口监听只挂一次");
});

test("置 false 清出台账并翻回", () => {
  const ledger = createEditableFocusLedger();
  const { flips, listener } = createFlips();
  ledger.onAggregateChange(listener);
  const wc = createFakeWebContents(12);

  ledger.setEditableFocus(wc, true);
  ledger.setEditableFocus(wc, false);
  assert.equal(ledger.hasEditableFocus(12), false);
  assert.equal(ledger.hasAnyEditableFocus(), false);
  assert.deepEqual(flips, [true, false]);
});

test("did-navigate / render-process-gone 自动清集合（导航后旧文档焦点事实失效）", () => {
  for (const event of ["did-navigate", "render-process-gone"]) {
    const ledger = createEditableFocusLedger();
    const { flips, listener } = createFlips();
    ledger.onAggregateChange(listener);
    const wc = createFakeWebContents(13);

    ledger.setEditableFocus(wc, true);
    wc.emit(event);
    assert.equal(ledger.hasEditableFocus(13), false, `${event} 后应清出`);
    assert.deepEqual(flips, [true, false], `${event} 后应翻回`);
  }
});

test("destroyed 清集合并摘收口登记：再次置 true 会重新挂监听", () => {
  const ledger = createEditableFocusLedger();
  const wc = createFakeWebContents(14);

  ledger.setEditableFocus(wc, true);
  wc.emit("destroyed");
  assert.equal(ledger.hasEditableFocus(14), false);

  // destroyed 后 watched 登记已摘除：同一假件重新置 true 时重新挂一套收口监听。
  ledger.setEditableFocus(wc, true);
  assert.equal(ledger.hasEditableFocus(14), true);
  assert.equal(wc.listenerCount("did-navigate"), 2, "重新挂监听（旧 once destroyed 已自摘）");
});

test("多 webContents：聚合只在最后一个清出时翻回", () => {
  const ledger = createEditableFocusLedger();
  const { flips, listener } = createFlips();
  ledger.onAggregateChange(listener);
  const a = createFakeWebContents(21);
  const b = createFakeWebContents(22);

  ledger.setEditableFocus(a, true);
  ledger.setEditableFocus(b, true);
  ledger.setEditableFocus(a, false);
  assert.equal(ledger.hasAnyEditableFocus(), true, "b 仍在集合内");
  assert.deepEqual(flips, [true], "中间变化不触发聚合翻转");
  ledger.setEditableFocus(b, false);
  assert.deepEqual(flips, [true, false]);
});

test("clearEditableFocus 对未知 id 是静默 no-op", () => {
  const ledger = createEditableFocusLedger();
  const { flips, listener } = createFlips();
  ledger.onAggregateChange(listener);
  ledger.clearEditableFocus(999);
  assert.deepEqual(flips, []);
});

test("退订后不再收到聚合翻转", () => {
  const ledger = createEditableFocusLedger();
  const { flips, listener } = createFlips();
  const unsubscribe = ledger.onAggregateChange(listener);
  unsubscribe();
  ledger.setEditableFocus(createFakeWebContents(23), true);
  assert.deepEqual(flips, []);
});

// ===== IPC 注册面（收窄校验器） =====

function createFakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    on(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

function createFakeWarn() {
  const calls = [];
  return { calls, warn: (message, meta) => calls.push({ message, meta }) };
}

function createIpcEvent(sender, senderFrame) {
  return { sender, senderFrame };
}

test("IPC 注册在约定 channel 上", () => {
  const ledger = createEditableFocusLedger();
  const ipcMain = createFakeIpcMain();
  registerEmbeddedEditableFocusIpc({ ipcMain, ledger, logger: createFakeWarn() });
  assert.equal(
    ipcMain.handlers.get(EMBEDDED_EDITABLE_FOCUS_CHANNEL) !== undefined,
    true,
    `channel 常量 = ${EMBEDDED_EDITABLE_FOCUS_CHANNEL}`,
  );
});

test("布尔 payload 写台账：true 进入 / false 清出", () => {
  const ledger = createEditableFocusLedger();
  const ipcMain = createFakeIpcMain();
  registerEmbeddedEditableFocusIpc({ ipcMain, ledger, logger: createFakeWarn() });
  const handler = ipcMain.handlers.get(EMBEDDED_EDITABLE_FOCUS_CHANNEL);
  const wc = createFakeWebContents(31);

  handler(createIpcEvent(wc, { parent: null }), true);
  assert.equal(ledger.hasEditableFocus(31), true);
  handler(createIpcEvent(wc, { parent: null }), false);
  assert.equal(ledger.hasEditableFocus(31), false);
});

test("senderFrame 为 null 时按顶层放行（部分平台无 frame 信息）", () => {
  const ledger = createEditableFocusLedger();
  const ipcMain = createFakeIpcMain();
  registerEmbeddedEditableFocusIpc({ ipcMain, ledger, logger: createFakeWarn() });
  const handler = ipcMain.handlers.get(EMBEDDED_EDITABLE_FOCUS_CHANNEL);
  const wc = createFakeWebContents(32);

  handler(createIpcEvent(wc, null), true);
  assert.equal(ledger.hasEditableFocus(32), true);
});

test("非布尔 payload 一律拒绝 + warn（IPC 面收窄）", () => {
  const ledger = createEditableFocusLedger();
  const ipcMain = createFakeIpcMain();
  const logger = createFakeWarn();
  registerEmbeddedEditableFocusIpc({ ipcMain, ledger, logger });
  const handler = ipcMain.handlers.get(EMBEDDED_EDITABLE_FOCUS_CHANNEL);
  const wc = createFakeWebContents(33);

  for (const payload of ["true", 1, 0, null, undefined, { focused: true }, [true]]) {
    handler(createIpcEvent(wc, { parent: null }), payload);
  }
  assert.equal(ledger.hasEditableFocus(33), false, "非布尔不得写台账");
  assert.equal(logger.calls.length, 7, "每次拒绝都有 warn");
});

test("嵌套 frame 上报被拒（顶层 frame 守卫）", () => {
  const ledger = createEditableFocusLedger();
  const ipcMain = createFakeIpcMain();
  const logger = createFakeWarn();
  registerEmbeddedEditableFocusIpc({ ipcMain, ledger, logger });
  const handler = ipcMain.handlers.get(EMBEDDED_EDITABLE_FOCUS_CHANNEL);
  const wc = createFakeWebContents(34);

  handler(createIpcEvent(wc, { parent: { id: 1 } }), true);
  assert.equal(ledger.hasEditableFocus(34), false);
  assert.equal(logger.calls.length, 1);
});
