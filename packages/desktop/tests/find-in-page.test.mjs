import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { transpileModule, ModuleKind } from "typescript";
import { readFile } from "node:fs/promises";

// specs/find-in-page.md 验收 6/7/8/9 + 阈值：
// requestId 匹配三路竞速 fail-soft、失效链、WeakSet 防重复 stop、首查 findNext 强制、
// CJK 感知起搜阈值（main 侧镜像）。
const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const sharedModule = await import("@acode/shared");

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
    if (name.startsWith("node:")) {
      return nodeRequire(name);
    }
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}

// ipcMain.handle 同步段计时包装（W1-6 接线）：注入真实 ipcSyncTiming（纯 Node，无 electron 依赖）。
const ipcSyncTimingModule = await loadMain("ipcSyncTiming", {});
// 二期 provider 双路协调器（findInPageMain 的姊妹模块）：注入真实实现，原生路测试不申报即不激活。
const providerModule = await loadMain("findInPageProviderMain", {
  "@acode/shared": sharedModule,
});

/** 测试替身：只实现 findInPageMain 消费的 WebContents 表面。 */
class FakeWebContents extends EventEmitter {
  constructor(id = 1) {
    super();
    this.id = id;
    this.destroyedFlag = false;
    this.findCalls = [];
    this.stopCalls = [];
    this.sentMessages = [];
    this.nextRequestId = 100;
  }
  isDestroyed() {
    return this.destroyedFlag;
  }
  findInPage(text, options) {
    const requestId = this.nextRequestId++;
    this.findCalls.push({ text, options, requestId });
    return requestId;
  }
  stopFindInPage(action) {
    if (this.throwOnStop) {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    }
    this.stopCalls.push(action);
  }
  send(channel, ...args) {
    this.sentMessages.push({ channel, args });
  }
  emitFound(requestId, activeMatchOrdinal, matches) {
    this.emit("found-in-page", {}, { requestId, activeMatchOrdinal, matches, selectionArea: {} });
  }
  markDestroyed() {
    this.destroyedFlag = true;
    this.emit("destroyed");
  }
}

function createHarness(options = {}) {
  const handlers = new Map();
  return loadMain("findInPageMain", {
    electron: {
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
    },
    "@acode/shared": sharedModule,
    "./ipcSyncTiming.js": ipcSyncTimingModule,
    "./findInPageProviderMain.js": providerModule,
  }).then((mod) => {
    mod.registerFindInPageIpc({
      logger: { info() {}, warn() {} },
      timeoutMs: options.timeoutMs ?? 40,
    });
    const invoke = (channel, sender, payload) => handlers.get(channel)({ sender }, payload);
    return { mod, handlers, invoke };
  });
}

const FIND_CHANNEL = "acode:find-in-page";
const STOP_CHANNEL = "acode:stop-find-in-page";
const END_CHANNEL = "acode:end-find-in-page-session";
const OPEN_CHANNEL = "acode:open-find-in-page";

test("CJK 感知起搜阈值：拉丁 3 字符起搜，Han/假名/谚文单字即搜", async () => {
  const { mod } = await createHarness();
  assert.equal(mod.meetsFindInPageThreshold("ab"), false);
  assert.equal(mod.meetsFindInPageThreshold("abc"), true);
  assert.equal(mod.meetsFindInPageThreshold(""), false);
  assert.equal(mod.meetsFindInPageThreshold("中"), true);
  assert.equal(mod.meetsFindInPageThreshold("の"), true);
  assert.equal(mod.meetsFindInPageThreshold("カ"), true);
  assert.equal(mod.meetsFindInPageThreshold("한"), true);
  // 混合：长度 2 但含 CJK → 可搜。
  assert.equal(mod.meetsFindInPageThreshold("a中"), true);
});

test("未过阈值/载荷非法返回 null，且不触碰 Chromium findInPage", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  assert.equal(await invoke(FIND_CHANNEL, target, { text: "ab", findNext: true }), null);
  assert.equal(target.findCalls.length, 0);
  assert.equal(await invoke(FIND_CHANNEL, target, { text: 42, findNext: true }), null);
  assert.equal(await invoke(FIND_CHANNEL, target, { text: "abc" }), null); // findNext 缺失
  assert.equal(await invoke(FIND_CHANNEL, target, { text: "abc", findNext: "yes" }), null);
  assert.equal(await invoke(FIND_CHANNEL, target, null), null);
  assert.equal(target.findCalls.length, 0);
});

test("requestId 匹配：命中轮次结算 {activeIndex,total}，错轮事件被忽略", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  const pending = invoke(FIND_CHANNEL, target, { text: "hello", findNext: true });
  assert.equal(target.findCalls.length, 1);
  // 错误 requestId 的事件不结算。
  target.emitFound(target.findCalls[0].requestId + 1, 9, 99);
  target.emitFound(target.findCalls[0].requestId, 2, 7);
  assert.deepEqual(await pending, { activeIndex: 2, total: 7 });
});

test("首查强制 findNext:true；已有高亮后透传调用方语义", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  const first = invoke(FIND_CHANNEL, target, { text: "hello", findNext: false, forward: false });
  target.emitFound(target.findCalls[0].requestId, 1, 3);
  await first;
  assert.deepEqual(target.findCalls[0].options, { forward: false, findNext: true });
  // 第二轮（WeakSet 已有高亮）：findNext 透传 false，forward 缺省 true。
  const second = invoke(FIND_CHANNEL, target, { text: "hello", findNext: false });
  target.emitFound(target.findCalls[1].requestId, 2, 3);
  await second;
  assert.deepEqual(target.findCalls[1].options, { forward: true, findNext: false });
});

test("三路竞速 fail-soft：超时 / destroyed / render-process-gone 都收口 {0,0}", async () => {
  const { invoke } = await createHarness();
  // 超时路径。
  const timeoutTarget = new FakeWebContents();
  const timedOut = invoke(FIND_CHANNEL, timeoutTarget, { text: "slow", findNext: true });
  assert.deepEqual(await timedOut, { activeIndex: 0, total: 0 });
  assert.equal(timeoutTarget.listenerCount("found-in-page"), 0); // 结算后监听器摘除
  // destroyed 路径。
  const destroyedTarget = new FakeWebContents();
  const destroyed = invoke(FIND_CHANNEL, destroyedTarget, { text: "gone", findNext: true });
  destroyedTarget.markDestroyed();
  assert.deepEqual(await destroyed, { activeIndex: 0, total: 0 });
  // render-process-gone 路径。
  const crashedTarget = new FakeWebContents();
  const crashed = invoke(FIND_CHANNEL, crashedTarget, { text: "crash", findNext: true });
  crashedTarget.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });
  assert.deepEqual(await crashed, { activeIndex: 0, total: 0 });
  assert.equal(crashedTarget.listenerCount("found-in-page"), 0);
});

test("findInPage 同步抛错（目标已崩溃等）按 {0,0} 收口", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  target.findInPage = () => {
    throw new Error("Render frame was disposed before WebFrameMain could be accessed");
  };
  assert.deepEqual(await invoke(FIND_CHANNEL, target, { text: "boom", findNext: true }), {
    activeIndex: 0,
    total: 0,
  });
});

test("stop 清高亮：WeakSet 防重复，崩溃后 stopFindInPage 抛错也 fail-soft", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  const pending = invoke(FIND_CHANNEL, target, { text: "hello", findNext: true });
  target.emitFound(target.findCalls[0].requestId, 1, 1);
  await pending;
  await invoke(STOP_CHANNEL, target);
  assert.deepEqual(target.stopCalls, ["clearSelection"]);
  // 重复 stop / 无高亮 stop = no-op。
  await invoke(STOP_CHANNEL, target);
  assert.deepEqual(target.stopCalls, ["clearSelection"]);
  // 崩溃后 stopFindInPage 抛错：吞掉不冒泡。
  const crashed = new FakeWebContents(2);
  const crashedFind = invoke(FIND_CHANNEL, crashed, { text: "hello", findNext: true });
  crashed.emitFound(crashed.findCalls[0].requestId, 1, 1);
  await crashedFind;
  crashed.throwOnStop = true;
  await invoke(STOP_CHANNEL, crashed); // 不抛即通过
});

test("失效链：跨文档导航/渲染进程崩溃 → clearSelection 恰一次 + 会话监听拆除", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  const pending = invoke(FIND_CHANNEL, target, { text: "hello", findNext: true });
  target.emitFound(target.findCalls[0].requestId, 1, 4);
  await pending;
  // same-document 导航不失效。
  target.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  assert.deepEqual(target.stopCalls, []);
  // 非同文档主框架导航 → 失效。
  target.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(target.stopCalls, ["clearSelection"]);
  // 失效后监听已拆：再导航/end-session 都不重复 stop。
  target.emit("did-navigate", {}, "https://example.com/", 200, "OK");
  await invoke(END_CHANNEL, target);
  assert.deepEqual(target.stopCalls, ["clearSelection"]);
  // 子框架导航不失效。
  const subframe = new FakeWebContents(3);
  const subPending = invoke(FIND_CHANNEL, subframe, { text: "hello", findNext: true });
  subframe.emitFound(subframe.findCalls[0].requestId, 1, 2);
  await subPending;
  subframe.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  assert.deepEqual(subframe.stopCalls, []);
  subframe.emit("did-redirect-navigation", { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(subframe.stopCalls, ["clearSelection"]);
  // render-process-gone 失效路径：崩溃后 stopFindInPage 抛错也收口。
  const crashed = new FakeWebContents(4);
  const crashedPending = invoke(FIND_CHANNEL, crashed, { text: "hello", findNext: true });
  crashed.emitFound(crashed.findCalls[0].requestId, 1, 2);
  await crashedPending;
  crashed.throwOnStop = true;
  crashed.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });
  // 会话监听已拆：destroyed 再触发不产生额外 stop。
  const before = crashed.stopCalls.length;
  crashed.markDestroyed();
  assert.equal(crashed.stopCalls.length, before);
});

test("end-session 幂等：无查找会话时 stop/end 都是 no-op", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  await invoke(STOP_CHANNEL, target);
  await invoke(END_CHANNEL, target);
  assert.deepEqual(target.stopCalls, []);
});

test("目标已销毁的 find 请求返回 null", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  target.destroyedFlag = true;
  assert.equal(await invoke(FIND_CHANNEL, target, { text: "hello", findNext: true }), null);
});

test("requestFindInPageOpen 向 renderer 单向推送打开；销毁目标不发送", async () => {
  const { mod } = await createHarness();
  const target = new FakeWebContents();
  mod.requestFindInPageOpen(target);
  assert.deepEqual(target.sentMessages, [{ channel: OPEN_CHANNEL, args: [] }]);
  const destroyed = new FakeWebContents(5);
  destroyed.destroyedFlag = true;
  mod.requestFindInPageOpen(destroyed);
  assert.deepEqual(destroyed.sentMessages, []);
});
