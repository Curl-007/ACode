import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { transpileModule, ModuleKind } from "typescript";
import { readFile } from "node:fs/promises";

// specs/find-in-page.md 二期验收 13-17：
// 双路仲裁、epoch 守卫（latest-wins/失配丢弃）、provider 路 fail-soft 三路收口、
// report 载荷校验、失效链复位 providerActive、stop/end-session 清 provider 路。
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

const ipcSyncTimingModule = await loadMain("ipcSyncTiming", {});
const providerModule = await loadMain("findInPageProviderMain", {
  "@acode/shared": sharedModule,
});

/** 测试替身：只实现 findInPageMain/findInPageProviderMain 消费的 WebContents 表面。 */
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
    this.stopCalls.push(action);
  }
  send(channel, ...args) {
    if (this.throwOnSend) {
      throw new Error("IPC channel disposed");
    }
    this.sentMessages.push({ channel, args });
  }
  emitFound(requestId, activeMatchOrdinal, matches) {
    this.emit("found-in-page", {}, { requestId, activeMatchOrdinal, matches, selectionArea: {} });
  }
  markDestroyed() {
    this.destroyedFlag = true;
    this.emit("destroyed");
  }
  lastSent(channel) {
    return [...this.sentMessages].reverse().find((message) => message.channel === channel);
  }
  countSent(channel) {
    return this.sentMessages.filter((message) => message.channel === channel).length;
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
const PROVIDER_ACTIVE_CHANNEL = "acode:find-in-page-provider-active";
const DISPATCH_CHANNEL = "acode:find-in-page-dispatch";
const REPORT_CHANNEL = "acode:find-in-page-report";
const CLEAR_CHANNEL = "acode:find-in-page-clear";

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── 验收 13：双路仲裁 ──

test("provider active 后不调用 Chromium findInPage，dispatch 携带 epoch/text/findNext/forward", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  const findPromise = invoke(FIND_CHANNEL, target, { text: "hello", findNext: true });
  await tick();
  assert.equal(target.findCalls.length, 0, "provider 路激活期间不得调用原生 findInPage");
  const dispatch = target.lastSent(DISPATCH_CHANNEL);
  assert.ok(dispatch, "应下发 FindInPageDispatch");
  const payload = dispatch.args[0];
  assert.equal(payload.text, "hello");
  assert.equal(payload.findNext, true);
  assert.equal(payload.forward, true, "forward 缺省归一为 true");
  assert.equal(typeof payload.epoch, "number");
  await invoke(REPORT_CHANNEL, target, {
    epoch: payload.epoch,
    result: { activeIndex: 2, total: 5 },
  });
  assert.deepEqual(await findPromise, { activeIndex: 2, total: 5 });
});

test("provider 维度可选字段透传（activeInRenderedWindow/hasUnsearchableRegions）", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  const findPromise = invoke(FIND_CHANNEL, target, {
    text: "xyz",
    findNext: false,
    forward: false,
  });
  await tick();
  const payload = target.lastSent(DISPATCH_CHANNEL).args[0];
  assert.equal(payload.forward, false);
  await invoke(REPORT_CHANNEL, target, {
    epoch: payload.epoch,
    result: {
      activeIndex: 1,
      total: 3,
      activeInRenderedWindow: false,
      hasUnsearchableRegions: true,
    },
  });
  assert.deepEqual(await findPromise, {
    activeIndex: 1,
    total: 3,
    activeInRenderedWindow: false,
    hasUnsearchableRegions: true,
  });
});

test("SetProviderActive(false) 后回到原生路；非法载荷不改变状态", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: "yes" }); // 非法：非布尔
  let findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  assert.equal(target.findCalls.length, 1, "非法申报不得激活 provider 路");
  target.emitFound(target.findCalls[0].requestId, 1, 2);
  assert.deepEqual(await findPromise, { activeIndex: 1, total: 2 });

  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  assert.equal(target.findCalls.length, 1, "provider 路不走原生");
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: false });
  assert.deepEqual(await findPromise, { activeIndex: 0, total: 0 }, "能力撤回结算在途 pending");
  assert.ok(target.lastSent(CLEAR_CHANNEL), "撤回时下发 FindInPageClear 防高亮残留");

  findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  assert.equal(target.findCalls.length, 2, "撤回后回到原生路");
  target.emitFound(target.findCalls[1].requestId, 1, 1);
  assert.deepEqual(await findPromise, { activeIndex: 1, total: 1 });
});

// ── 验收 14：epoch 守卫 ──

test("新一轮 dispatch 立即结算旧 pending {0,0}；失配 epoch 的 report 丢弃", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  const first = invoke(FIND_CHANNEL, target, { text: "aaa", findNext: true });
  await tick();
  const epoch1 = target.lastSent(DISPATCH_CHANNEL).args[0].epoch;
  const second = invoke(FIND_CHANNEL, target, { text: "aab", findNext: true });
  await tick();
  const epoch2 = target.lastSent(DISPATCH_CHANNEL).args[0].epoch;
  assert.notEqual(epoch2, epoch1, "epoch 单调递增");
  assert.deepEqual(await first, { activeIndex: 0, total: 0 }, "latest-wins：旧轮结算 {0,0}");
  // 旧 epoch 的晚到 report：不得影响任何在途轮次。
  await invoke(REPORT_CHANNEL, target, { epoch: epoch1, result: { activeIndex: 9, total: 9 } });
  await invoke(REPORT_CHANNEL, target, { epoch: epoch2, result: { activeIndex: 1, total: 4 } });
  assert.deepEqual(await second, { activeIndex: 1, total: 4 });
});

test("report 载荷非法（缺 result/epoch 非数值/可选字段非布尔）丢弃，留待超时收口", async () => {
  const { invoke } = await createHarness({ timeoutMs: 30 });
  const target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  const findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  const epoch = target.lastSent(DISPATCH_CHANNEL).args[0].epoch;
  await invoke(REPORT_CHANNEL, target, { epoch, result: { activeIndex: 1 } }); // 缺 total
  await invoke(REPORT_CHANNEL, target, { epoch: "x", result: { activeIndex: 1, total: 1 } });
  await invoke(REPORT_CHANNEL, target, {
    epoch,
    result: { activeIndex: 1, total: 1, activeInRenderedWindow: "yes" },
  });
  await invoke(REPORT_CHANNEL, target, null);
  assert.deepEqual(
    await findPromise,
    { activeIndex: 0, total: 0 },
    "非法 report 全部丢弃 → 超时 fail-soft",
  );
});

// ── 验收 15：provider 路 fail-soft 三路收口 ──

test("provider 路超时/destroyed/render-process-gone 都收口 {0,0}；send 抛错 fail-soft", async () => {
  const { invoke } = await createHarness({ timeoutMs: 25 });
  // 超时：无 report。
  let target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  let findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  assert.deepEqual(await findPromise, { activeIndex: 0, total: 0 });

  // destroyed：dispatch 后目标销毁。
  target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  assert.equal(target.listenerCount("destroyed") >= 1, true);
  target.markDestroyed();
  assert.deepEqual(await findPromise, { activeIndex: 0, total: 0 });

  // render-process-gone。
  target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  target.emit("render-process-gone", {}, {});
  assert.deepEqual(await findPromise, { activeIndex: 0, total: 0 });

  // send 抛错（IPC 通道失效）：立即 {0,0}，不悬挂。
  target = new FakeWebContents();
  target.throwOnSend = true;
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  assert.deepEqual(await findPromise, { activeIndex: 0, total: 0 });
});

// ── 验收 16：失效链对 provider 路 ──

test("跨文档导航失效链：pending {0,0} + FindInPageClear 下发 + providerActive 复位", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  const findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  target.emit("did-navigate", {}, "https://example.com", 200, "OK");
  assert.deepEqual(await findPromise, { activeIndex: 0, total: 0 });
  assert.ok(target.lastSent(CLEAR_CHANNEL), "失效链下发 FindInPageClear");

  // providerActive 已复位：下一轮走原生路。
  const next = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  assert.equal(target.findCalls.length, 1, "失效后回原生路，等待 renderer 重新申报");
  target.emitFound(target.findCalls[0].requestId, 1, 1);
  assert.deepEqual(await next, { activeIndex: 1, total: 1 });
});

test("崩溃失效链：render-process-gone 复位 providerActive，clear 的 send 抛错被吞", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  const findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  target.throwOnSend = true; // 崩溃后 IPC 失效：clear 下发抛错必须 fail-soft 吞掉。
  target.emit("render-process-gone", {}, { reason: "crashed" });
  assert.deepEqual(await findPromise, { activeIndex: 0, total: 0 });
  const next = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  assert.equal(target.findCalls.length, 1, "崩溃后 providerActive 复位");
  target.emitFound(target.findCalls[0].requestId, 0, 0);
  assert.deepEqual(await next, { activeIndex: 0, total: 0 });
});

// ── 验收 17：stop / end-session 对 provider 路 ──

test("stop：结算 pending + 下发 clear，providerActive 保留（能力申报与会话解耦）", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  const findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  await invoke(STOP_CHANNEL, target);
  assert.deepEqual(await findPromise, { activeIndex: 0, total: 0 });
  assert.ok(target.lastSent(CLEAR_CHANNEL));
  assert.equal(target.stopCalls.length, 0, "provider 路无原生高亮，不触发 stopFindInPage");

  const next = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  assert.equal(target.findCalls.length, 0, "stop 后 provider 路仍激活");
  assert.ok(target.lastSent(DISPATCH_CHANNEL));
  const epoch = target.lastSent(DISPATCH_CHANNEL).args[0].epoch;
  await invoke(REPORT_CHANNEL, target, { epoch, result: { activeIndex: 1, total: 1 } });
  assert.deepEqual(await next, { activeIndex: 1, total: 1 });
});

test("end-session：结算 pending + 下发 clear + 拆失效链，providerActive 保留", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  await invoke(PROVIDER_ACTIVE_CHANNEL, target, { active: true });
  const findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  await invoke(END_CHANNEL, target);
  assert.deepEqual(await findPromise, { activeIndex: 0, total: 0 });
  assert.ok(target.lastSent(CLEAR_CHANNEL));

  const next = invoke(FIND_CHANNEL, target, { text: "abc", findNext: true });
  await tick();
  assert.equal(target.findCalls.length, 0, "end-session 后 provider 路仍激活");
  const epoch = target.lastSent(DISPATCH_CHANNEL).args[0].epoch;
  await invoke(REPORT_CHANNEL, target, { epoch, result: { activeIndex: 2, total: 2 } });
  assert.deepEqual(await next, { activeIndex: 2, total: 2 });
});

// ── 一期回归：原生路语义不受二期分支影响 ──

test("未申报 provider 时原生路语义不变（requestId 匹配 + 首查 findNext 强制）", async () => {
  const { invoke } = await createHarness();
  const target = new FakeWebContents();
  const findPromise = invoke(FIND_CHANNEL, target, { text: "abc", findNext: false });
  await tick();
  assert.equal(target.findCalls.length, 1);
  assert.equal(target.findCalls[0].options.findNext, true, "首查强制 findNext:true");
  target.emitFound(target.findCalls[0].requestId, 3, 7);
  assert.deepEqual(await findPromise, { activeIndex: 3, total: 7 });
  assert.equal(target.countSent(DISPATCH_CHANNEL), 0, "原生路不下发 dispatch");
});
