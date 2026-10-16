import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { transpileModule, ModuleKind } from "typescript";
import { readFile } from "node:fs/promises";

// specs/embedded-browser-pane-governance.md 验收场景 1-8：
// 件1 one-shot admission ticket、件2 导航 epoch 分轨、件4 合成输入抑制窗口+激活戳、
// 件5 pointer-lock 强制退出链，以及 guest manager 最小挂点的集成回归。
// guest manager 含 electron 运行时导入，按 embedded-browser-site-permissions.test.mjs
// 的 transpile+inject 模式加载；四个治理模块零 electron 导入，直接 tsx import。
const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

const ticketModule = await import("../src/main/browserView/browserPaneAdmissionTicket.ts");
const epochsModule = await import("../src/main/browserView/browserTabNavigationEpochs.ts");
const syntheticModule = await import("../src/main/browserView/browserSyntheticInputWindow.ts");
const governorModule = await import("../src/main/browserView/browserPointerLockGovernor.ts");
const sharedModule = await import("@acode/shared");

const SIBLING_SPECIFIERS = {
  "./browserCommandExecutor.js": "../src/main/browserView/browserCommandExecutor.ts",
  "./browserPlaywrightLocatorExecutor.js":
    "../src/main/browserView/browserPlaywrightLocatorExecutor.ts",
  "./browserVideoRecorder.js": "../src/main/browserView/browserVideoRecorder.ts",
  "./browserPlaywrightTimeout.js": "../src/main/browserView/browserPlaywrightTimeout.ts",
  "./browserTransparentWindowBootstrap.js":
    "../src/main/browserView/browserTransparentWindowBootstrap.ts",
  "./browserTabResidencyCoordinator.js":
    "../src/main/browserView/browserTabResidencyCoordinator.ts",
  "./browserPaneAdmissionTicket.js": "../src/main/browserView/browserPaneAdmissionTicket.ts",
  "./browserTabNavigationEpochs.js": "../src/main/browserView/browserTabNavigationEpochs.ts",
  "./browserSyntheticInputWindow.js": "../src/main/browserView/browserSyntheticInputWindow.ts",
  "./browserPointerLockGovernor.js": "../src/main/browserView/browserPointerLockGovernor.ts",
};

async function loadGuestManager(electronStub) {
  const source = await readFile(
    new URL("src/main/browserView/browserGuestManager.ts", root),
    "utf8",
  );
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const siblings = {};
  for (const [specifier, relative] of Object.entries(SIBLING_SPECIFIERS)) {
    siblings[specifier] = await import(relative);
  }
  const exports = {};
  new Function("require", "exports", output)((name) => {
    if (name.startsWith("node:")) return nodeRequire(name);
    if (name === "electron") return electronStub;
    if (name === "@acode/shared") return sharedModule;
    assert.ok(name in siblings, `unexpected runtime import: ${name}`);
    return siblings[name];
  }, exports);
  return exports;
}

function makeClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
    get value() {
      return value;
    },
  };
}

// ---------------------------------------------------------------------------
// 件 1：one-shot admission ticket（验收场景 1）
// ---------------------------------------------------------------------------

test("admission ticket：单次消费/复用/缺失/过期/键隔离/dropScope", () => {
  const clock = makeClock();
  const logs = [];
  const ledger = new ticketModule.BrowserPaneAdmissionTicketLedger({
    now: clock.now,
    ttlMs: 1_000,
    log: (message) => logs.push(message),
  });
  const key = { scopeKey: "scope-a", targetKey: "tab-1", tier: "site" };

  const ticketId = ledger.mint(key);
  assert.ok(ticketId.length > 0);
  assert.equal(ledger.has(key), true);
  assert.deepEqual(ledger.consume(key), { ok: true, reason: "ok" });
  // 复用：tombstone 命中 → consumed（区别于从未 mint 的 missing）。
  assert.deepEqual(ledger.consume(key), { ok: false, reason: "consumed" });
  // 键三元组任一维不同 → missing（tier/scope/target 隔离）。
  assert.equal(ledger.consume({ ...key, tier: "high-risk" }).reason, "missing");
  assert.equal(ledger.consume({ ...key, scopeKey: "scope-b" }).reason, "missing");
  assert.equal(ledger.consume({ ...key, targetKey: "tab-2" }).reason, "missing");

  // 过期：mint 后超 TTL → expired；过期票不落 tombstone（后续是 missing）。
  ledger.mint({ ...key, targetKey: "tab-expire" });
  clock.advance(1_001);
  const expiredKey = { ...key, targetKey: "tab-expire" };
  assert.equal(ledger.consume(expiredKey).reason, "expired");
  assert.equal(ledger.consume(expiredKey).reason, "missing");

  // tombstone 自身也随 TTL 过期（惰性 GC 后 consumed → missing）。
  ledger.mint(key);
  ledger.consume(key);
  clock.advance(1_001);
  assert.equal(ledger.consume(key).reason, "missing");

  // 重新 mint 清除同键 tombstone：新同意不背旧复用记录。
  ledger.mint(key);
  ledger.consume(key);
  ledger.mint(key);
  assert.equal(ledger.consume(key).reason, "ok");

  // dropScope：scope 终结不留残余票。
  ledger.mint(key);
  ledger.dropScope("scope-a");
  assert.equal(ledger.consume(key).reason, "missing");
  assert.ok(logs.some((line) => line.includes("admission ticket consumed")));
});

// ---------------------------------------------------------------------------
// 件 2：导航 epoch 分轨（验收场景 3）
// ---------------------------------------------------------------------------

test("navigation epochs：主 frame/同源 subframe/外来 subframe 分轨计数", () => {
  const foreign = [];
  const tracker = new epochsModule.BrowserTabNavigationEpochTracker({
    onForeignSubframeNavigation: (tabId, snapshot) => foreign.push({ tabId, snapshot }),
  });
  const main = "https://example.com/page";
  const note = (tabId, isMainFrame, frameUrl, mainFrameUrl = main) =>
    tracker.noteFrameNavigation(tabId, { isMainFrame, frameUrl, mainFrameUrl });

  assert.equal(tracker.snapshot("tab-1"), null); // 未知 tab → null
  note("tab-1", true, "https://example.com/next");
  note("tab-1", false, "https://example.com/iframe");
  note("tab-1", false, "https://ads.other.com/x");
  note("tab-1", false, "blob:https://example.com/uuid");
  note("tab-1", false, "filesystem:https://example.com/temporary/f");
  note("tab-1", false, "about:blank");
  assert.deepEqual(tracker.snapshot("tab-1"), {
    frameTree: 6,
    mainFrame: 1,
    subframes: 5,
    foreignSubframes: 3, // 跨 origin + blob + filesystem；about:blank 不计
  });
  assert.equal(foreign.length, 3);
  assert.equal(foreign[0].tabId, "tab-1");

  // 主 frame URL 不可读 → 保守计外来；frame URL 不可解析 → 不计。
  note("tab-2", false, "https://example.com/a", null);
  note("tab-2", false, "not a url", main);
  assert.deepEqual(tracker.snapshot("tab-2"), {
    frameTree: 2,
    mainFrame: 0,
    subframes: 2,
    foreignSubframes: 1,
  });

  // 计数器按 tabId 存续（guest 替换不清零），dropTab 后归零重建。
  const before = tracker.snapshot("tab-1");
  assert.deepEqual(tracker.snapshot("tab-1"), before);
  tracker.dropTab("tab-1");
  assert.equal(tracker.snapshot("tab-1"), null);
});

test("isForeignSubframeNavigation：协议与 origin 判定矩阵", () => {
  const { isForeignSubframeNavigation: isForeign } = epochsModule;
  const main = "https://example.com/";
  assert.equal(isForeign("https://example.com/other", main), false);
  assert.equal(isForeign("https://other.com/x", main), true);
  assert.equal(isForeign("http://example.com/x", main), true); // 协议不同 → origin 不同
  assert.equal(isForeign("https://example.com/x", null), true); // 主 frame 不可读 → 保守外来
  assert.equal(isForeign("blob:https://evil.com/u", main), true);
  assert.equal(isForeign("data:text/html,x", main), false);
  assert.equal(isForeign("about:blank", main), false);
  assert.equal(isForeign("", main), false);
});

// ---------------------------------------------------------------------------
// 件 4：合成输入抑制窗口 + 真实输入激活戳（验收场景 4/5）
// ---------------------------------------------------------------------------

test("synthetic window：派发窗口开合、200ms 尾缘、并发 token、僵尸 GC", () => {
  const clock = makeClock(0);
  const w = new syntheticModule.BrowserSyntheticInputWindow({ now: clock.now });
  const token = w.beginInputDispatch("tab");
  assert.equal(w.isInputSuppressed("tab"), true);
  // 窗口内「看起来像用户手势」的事件一律按合成来源处理（stamp=false）。
  assert.equal(w.stampActivationFromInputEvent("tab", "mouseDown"), false);
  assert.equal(w.lastRealGestureAt("tab"), null);
  clock.advance(1_000);
  w.endInputDispatch("tab", token);
  assert.equal(w.isInputSuppressed("tab"), true); // 台账空 → now+200ms 尾缘
  clock.advance(199);
  assert.equal(w.isInputSuppressed("tab"), true);
  clock.advance(2);
  assert.equal(w.isInputSuppressed("tab"), false);
  // 窗口外闭集类型 → 真实手势落账；非闭集类型不落账。
  assert.equal(w.stampActivationFromInputEvent("tab", "mouseDown"), true);
  assert.equal(w.lastRealGestureAt("tab"), clock.value);
  assert.equal(w.stampActivationFromInputEvent("tab", "mouseUp"), false);
  assert.equal(w.stampActivationFromInputEvent("tab", "char"), false);
  assert.equal(w.stampActivationFromInputEvent("tab", "mouseWheel"), false);
  assert.equal(w.stampActivationFromInputEvent("tab", "keyDown"), true);
  assert.equal(w.stampActivationFromInputEvent("tab", "rawKeyDown"), true);

  // 并发 token：end 一个不收窗；僵尸 token（begin 超 cap）在 end 时被 GC，
  // 台账判空 → now+200ms（若无 GC 会把窗口钉在过期的 begin+cap 上）。
  const a = w.beginInputDispatch("tab2");
  clock.advance(36_000); // a 成为超 cap 僵尸
  const b = w.beginInputDispatch("tab2");
  w.endInputDispatch("tab2", a); // a 删除后 b 仍在途 → 窗口不收
  assert.equal(w.isInputSuppressed("tab2"), true);
  w.endInputDispatch("tab2", b); // 台账空（a 已被 GC/删除）→ now+200
  assert.equal(w.isInputSuppressed("tab2"), true);
  clock.advance(201);
  assert.equal(w.isInputSuppressed("tab2"), false);
});

test("synthetic window：激活窗口 6s 尾巴与派发近因", () => {
  const clock = makeClock(0);
  const w = new syntheticModule.BrowserSyntheticInputWindow({ now: clock.now });
  assert.equal(w.syntheticActivationLive("tab3"), false);
  const act = w.beginActivation("tab3");
  assert.equal(w.syntheticActivationLive("tab3"), true);
  w.endActivation("tab3", act);
  // end 后 until=now+200，live 尾巴 = until + 5s + 1s：覆盖 transient activation。
  clock.advance(6_100);
  assert.equal(w.syntheticActivationLive("tab3"), true);
  clock.advance(200);
  assert.equal(w.syntheticActivationLive("tab3"), false);

  w.noteDispatch("tab4");
  assert.equal(w.hasRecentSyntheticDispatch("tab4"), true);
  clock.advance(34_999);
  assert.equal(w.hasRecentSyntheticDispatch("tab4"), true);
  clock.advance(2);
  assert.equal(w.hasRecentSyntheticDispatch("tab4"), false);

  w.beginInputDispatch("tab5");
  assert.equal(w.hasRecentSyntheticDispatch("tab5"), true); // 在途 token 即近因
  w.dropTab("tab5");
  assert.equal(w.hasRecentSyntheticDispatch("tab5"), false); // dropTab 全清
  assert.equal(w.isInputSuppressed("tab5"), false);
});

// ---------------------------------------------------------------------------
// 件 5：pointer-lock 强制退出链（验收场景 6/7）
// ---------------------------------------------------------------------------

/** frame 脚本应答核心：probe(!==null) / confirm(===null) / exit(exitPointerLock) 三态。 */
function createFrameCore({ locked = false, confirmMode = "exit-immediately" } = {}) {
  const scripts = [];
  const core = {
    scripts,
    locked,
    unavailable: false,
    respond: async (script) => {
      scripts.push(script);
      if (script.includes("exitPointerLock")) {
        if (confirmMode !== "never") core.locked = false;
        return undefined;
      }
      if (script.includes("!==null")) return core.locked; // probe
      if (confirmMode === "never") return new Promise(() => {}); // confirm 永不落定
      if (confirmMode === "unavailable-after-exit") {
        // 退出广播后 frame 变为 destroyed/detached：确认按「已退出」收敛。
        core.unavailable = true;
        return false;
      }
      return !core.locked; // confirm
    },
  };
  return core;
}

/** governor 模块测试面（BrowserPointerLockFrameHandle 形状）。 */
function makeFrame(opts) {
  const core = createFrameCore(opts);
  return {
    scripts: core.scripts,
    get locked() {
      return core.locked;
    },
    set locked(value) {
      core.locked = value;
    },
    isUnavailable: () => core.unavailable,
    run: (script) => core.respond(script),
  };
}

/** manager 集成测试面（WebFrameMain 形状：isDestroyed/detached/executeJavaScript）。 */
function makeWebFrame(opts) {
  const core = createFrameCore(opts);
  return {
    scripts: core.scripts,
    get locked() {
      return core.locked;
    },
    set locked(value) {
      core.locked = value;
    },
    isDestroyed: () => core.unavailable,
    detached: false,
    executeJavaScript: (script) => core.respond(script),
  };
}

function makeGovernor(overrides = {}) {
  const clock = makeClock();
  const warns = [];
  const governor = new governorModule.BrowserPointerLockGovernor({
    now: clock.now,
    // 假 sleep 推进时钟并让出一个宏任务：立即落定的 frame 调用（纯微任务）必胜
    // 超时侧；永不落定的调用必败——消除 Promise.race 的微任务序歧义。
    sleep: async (ms) => {
      clock.advance(ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
    warn: (message) => warns.push(message),
    ...overrides,
  });
  return { governor, clock, warns };
}

test("pointer-lock：未准入节流探测、持锁隐式准入并退出、probe-skipped", async () => {
  const { governor, clock } = makeGovernor();
  const frame = makeFrame({ locked: false });
  const readFrames = () => [frame];

  assert.equal(
    await governor.ensureUnlockedBeforeSyntheticInput("tab", 1, readFrames),
    "not-admitted",
  );
  assert.equal(frame.scripts.filter((s) => s.includes("!==null")).length, 1); // 探测一次
  // 节流窗内再派发 → probe-skipped，不触碰 frame。
  assert.equal(
    await governor.ensureUnlockedBeforeSyntheticInput("tab", 1, readFrames),
    "probe-skipped",
  );
  assert.equal(frame.scripts.length, 1);
  clock.advance(2_001);

  // 节流窗过后再探测：页面已持锁 → 隐式准入 + 退出链 → exited，admitted 被清除。
  frame.locked = true;
  assert.equal(await governor.ensureUnlockedBeforeSyntheticInput("tab", 1, readFrames), "exited");
  assert.equal(frame.locked, false);
  assert.ok(frame.scripts.some((s) => s.includes("exitPointerLock")));
  assert.ok(frame.scripts.some((s) => s.includes("===null")));
  assert.equal(governor.isAdmitted("tab", 1), false);
});

test("pointer-lock：已准入直达退出链；did-navigate 清准入；guestId 换代失效", async () => {
  const { governor } = makeGovernor();
  const frame = makeFrame({ locked: true });
  governor.markAdmitted("tab", 7);
  assert.equal(governor.isAdmitted("tab", 7), true);
  assert.equal(governor.isAdmitted("tab", 8), false); // guest 换代 → 旧准入失效

  assert.equal(
    await governor.ensureUnlockedBeforeSyntheticInput("tab", 7, () => [frame]),
    "exited",
  );
  // 准入路径不做探测：第一条脚本就是退出广播（无 probe）。
  assert.ok(!frame.scripts.some((s) => s.includes("!==null")));
  assert.equal(governor.isAdmitted("tab", 7), false); // exited 后清准入

  // 重新准入后主 frame 导航 → 清准入（新文档不继承旧锁准入）。
  governor.markAdmitted("tab", 7);
  governor.noteMainFrameNavigation("tab");
  assert.equal(governor.isAdmitted("tab", 7), false);
});

test("pointer-lock：超时结构化 warn、frame 不可用收敛、异常输入不上抛", async () => {
  const { governor, warns } = makeGovernor({ maxPolls: 15, pollIntervalMs: 10 });
  const stuck = makeFrame({ locked: true, confirmMode: "never" });
  governor.markAdmitted("tab", 1);
  assert.equal(
    await governor.ensureUnlockedBeforeSyntheticInput("tab", 1, () => [stuck]),
    "timeout",
  );
  const timeoutWarn = warns.find((line) => line.includes("outcome=timeout"));
  assert.ok(timeoutWarn, "timeout 必须落结构化 warn");
  assert.ok(timeoutWarn.includes("tabId=tab"));
  assert.ok(timeoutWarn.includes("frameCount=1"));
  assert.ok(timeoutWarn.includes("pendingCount=1"));
  assert.ok(/elapsedMs=\d+/.test(timeoutWarn));
  assert.ok(!timeoutWarn.includes("http"), "warn 不落 URL/用户数据");
  // confirm 轮次 = maxPolls（15×10ms 轮询确认语义）。
  assert.equal(stuck.scripts.filter((s) => s.includes("===null")).length, 15);

  // frame 中途不可用（destroyed/detached）→ 按已退出收敛。
  const flaky = makeFrame({ locked: true, confirmMode: "unavailable-after-exit" });
  governor.markAdmitted("tab2", 1);
  assert.equal(
    await governor.ensureUnlockedBeforeSyntheticInput("tab2", 1, () => [flaky]),
    "exited",
  );

  // frame 树不可读 / 空 / run 抛错：闭集收敛且绝不上抛。
  assert.equal(
    await governor.ensureUnlockedBeforeSyntheticInput("tab3", 1, () => {
      throw new Error("destroyed");
    }),
    "guest-unavailable",
  );
  governor.markAdmitted("tab4", 1);
  assert.equal(await governor.ensureUnlockedBeforeSyntheticInput("tab4", 1, () => []), "no-frames");
  governor.markAdmitted("tab5", 1);
  const throwing = {
    isUnavailable: () => false,
    run: () => {
      throw new Error("frame gone");
    },
  };
  assert.equal(
    await governor.ensureUnlockedBeforeSyntheticInput("tab5", 1, () => [throwing]),
    "timeout", // 抛错按 fallback 收敛（confirm=false）→ 轮次耗尽 timeout，不 reject
  );

  // 并发派发共享单 flight：退出广播只发一轮。
  const shared = makeFrame({ locked: true, confirmMode: "never" });
  governor.markAdmitted("tab6", 1);
  const [r1, r2] = await Promise.all([
    governor.ensureUnlockedBeforeSyntheticInput("tab6", 1, () => [shared]),
    governor.ensureUnlockedBeforeSyntheticInput("tab6", 1, () => [shared]),
  ]);
  assert.equal(r1, "timeout");
  assert.equal(r2, "timeout");
  assert.equal(shared.scripts.filter((s) => s.includes("exitPointerLock")).length, 1);
});

test("pointer-lock：canAdmitPointerLock 判定表", () => {
  const { governor } = makeGovernor();
  const decide = governor.canAdmitPointerLock.bind(governor);
  assert.equal(
    decide({ paneVisible: true, syntheticActivationLive: false, recentSyntheticDispatch: false }),
    true,
  );
  assert.equal(
    decide({ paneVisible: false, syntheticActivationLive: false, recentSyntheticDispatch: false }),
    false,
  );
  assert.equal(
    decide({ paneVisible: true, syntheticActivationLive: true, recentSyntheticDispatch: false }),
    false,
  );
  assert.equal(
    decide({ paneVisible: true, syntheticActivationLive: false, recentSyntheticDispatch: true }),
    false,
  );
});

// ---------------------------------------------------------------------------
// guest manager 最小挂点集成（验收场景 2/8 + 挂点回归）
// ---------------------------------------------------------------------------

function createFakeGuest(id, { frames = [], mainFrameUrl = "https://example.com/" } = {}) {
  const listeners = new Map();
  const sentCommands = [];
  const guest = {
    id,
    mainFrame: {
      url: mainFrameUrl,
      framesInSubtree: frames,
      isDestroyed: () => false,
      detached: false,
      executeJavaScript: async () => null,
    },
    getType: () => "webview",
    getZoomFactor: () => 1,
    setZoomFactor: () => {},
    isDestroyed: () => false,
    loadURL: async () => {},
    getURL: () => mainFrameUrl,
    getTitle: () => "fake-guest",
    reload: () => {},
    stop: () => {},
    capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
    executeJavaScript: async () => null,
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
      getAllEntries: () => [],
      getActiveIndex: () => 0,
      restore: async () => {},
    },
    close: () => {},
    debugger: {
      isAttached: () => true,
      attach: () => {},
      detach: () => {},
      sendCommand: async (method, params, sessionId) => {
        sentCommands.push({ method, params, sessionId });
        return {};
      },
      on: () => {},
      removeListener: () => {},
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener: (event, listener) => listeners.get(event)?.delete(listener),
    once: () => {},
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return { guest, sentCommands };
}

const MANAGER_CONTEXT_BASE = {
  browserId: "unclaimed-iab",
  browserGeneration: 0,
  windowId: 7,
  workspaceKey: "ws",
  sessionId: "sess",
  clientMode: "desktop-continuous",
};

async function createManagerHarness(governanceOptions = {}) {
  const guests = new Map();
  const electronStub = {
    webContents: { fromId: (id) => guests.get(id) },
  };
  const mod = await loadGuestManager(electronStub);
  const logs = [];
  const clock = makeClock();
  const manager = new mod.BrowserGuestManager(
    (message) => logs.push(message),
    50,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: clock.now },
    undefined,
    60_000,
    { now: clock.now, ...governanceOptions },
  );
  const attach = (tabId, id, options = {}) => {
    const fake = createFakeGuest(id, options);
    guests.set(id, fake.guest);
    const result = manager.attachGuest(tabId, id, {
      active: true,
      windowId: 7,
      workspaceKey: "ws",
      sessionId: "sess",
    });
    return { ...fake, result };
  };
  return { manager, attach, logs, clock, guests };
}

test("manager 挂点：enforcement 关闭时 claimTab 行为不变（回归）", async () => {
  const { manager, attach } = await createManagerHarness();
  try {
    attach("tab-claim", 201);
    const result = await manager.execute(
      { ...MANAGER_CONTEXT_BASE, requestId: "req-claim-1" },
      { method: "claimTab", tabId: "tab-claim" },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    manager.disposeAll();
  }
});

test("manager 挂点：enforcement 开启后无票拒绝、mint 后放行", async () => {
  const { manager, attach, logs } = await createManagerHarness({
    enforceClaimAdmissionTicket: true,
  });
  try {
    attach("tab-claim", 202);
    const denied = await manager.execute(
      { ...MANAGER_CONTEXT_BASE, requestId: "req-claim-2" },
      { method: "claimTab", tabId: "tab-claim" },
    );
    assert.equal(denied.ok, false);
    assert.match(denied.error.message, /admission ticket missing/);
    assert.ok(
      logs.some((line) => line.includes("claimTab rejected") && line.includes("admission=missing")),
    );

    const context = { ...MANAGER_CONTEXT_BASE, requestId: "req-claim-3" };
    manager.mintTabClaimTicket(context, "tab-claim");
    const allowed = await manager.execute(context, {
      method: "claimTab",
      tabId: "tab-claim",
    });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
  } finally {
    manager.disposeAll();
  }
});

test("manager 挂点：Input 派发走治理漏斗（探测→抑制窗口→CDP），epoch 分轨落账", async () => {
  const { manager, attach, clock } = await createManagerHarness();
  try {
    const frame = makeWebFrame({ locked: false });
    const { guest, sentCommands, result } = attach("tab-input", 203, { frames: [frame] });
    assert.equal(result.ok, true);

    const press = await manager.execute(
      { ...MANAGER_CONTEXT_BASE, requestId: "req-press-1" },
      { method: "press", key: "Enter" },
    );
    assert.equal(press.ok, true, JSON.stringify(press));
    assert.ok(sentCommands.some((entry) => entry.method === "Input.dispatchKeyEvent"));
    // 未准入 guest：Input 派发前做了持锁探测（防御纵深不反噬主链路）。
    assert.ok(frame.scripts.some((script) => script.includes("!==null")));

    // 合成派发期间 canAdmitGuestPointerLock=false；36s 后派发近因过期。
    assert.equal(manager.canAdmitGuestPointerLock(203), false);
    clock.advance(36_000);
    assert.equal(manager.canAdmitGuestPointerLock(203), false); // pane 尚不可见
    const visibility = await manager.execute(
      { ...MANAGER_CONTEXT_BASE, requestId: "req-vis-1" },
      { method: "browserVisibilitySet", visible: true },
    );
    assert.equal(visibility.ok, true);
    assert.equal(manager.canAdmitGuestPointerLock(203), true);

    // did-frame-navigate → epoch 分轨；did-navigate → 清 pointer-lock 准入。
    guest.emit("did-frame-navigate", {}, "https://example.com/a", 200, "OK", true, 1, 1);
    guest.emit("did-frame-navigate", {}, "https://ads.other.com/x", 200, "OK", false, 2, 2);
    guest.emit("did-frame-navigate", {}, "https://example.com/b", 200, "OK", false, 3, 3);
    assert.deepEqual(manager.getTabNavigationEpochs("tab-input"), {
      frameTree: 3,
      mainFrame: 1,
      subframes: 2,
      foreignSubframes: 1,
    });

    // 真实输入事件（窗口外）不炸链；did-navigate 清 pointer-lock 准入：
    // 清准入后 Input 派发回到探测路径（未持锁 → 无退出广播）。
    guest.emit("input-event", {}, { type: "mouseDown" });
    manager.markGuestPointerLockAdmitted(203);
    guest.emit("did-navigate", {}, "https://example.com/a", false);
    const scriptsBeforeSecondPress = frame.scripts.length;
    const press2 = await manager.execute(
      { ...MANAGER_CONTEXT_BASE, requestId: "req-press-1b" },
      { method: "press", key: "Enter" },
    );
    assert.equal(press2.ok, true, JSON.stringify(press2));
    const newScripts = frame.scripts.slice(scriptsBeforeSecondPress);
    assert.ok(!newScripts.some((script) => script.includes("exitPointerLock")));
  } finally {
    manager.disposeAll();
  }
  // disposeAll → closeTab → dropPaneGovernanceState：epoch 台账不跨 tab 生命周期残留。
  assert.equal(manager.getTabNavigationEpochs("tab-input"), null);
});

test("manager 挂点：已准入 guest 的 Input 派发前广播退出并确认", async () => {
  const { manager, attach } = await createManagerHarness();
  try {
    const frame = makeWebFrame({ locked: true });
    attach("tab-lock", 204, { frames: [frame] });
    manager.markGuestPointerLockAdmitted(204);
    const press = await manager.execute(
      { ...MANAGER_CONTEXT_BASE, requestId: "req-press-2" },
      { method: "press", key: "Enter" },
    );
    assert.equal(press.ok, true, JSON.stringify(press));
    assert.ok(frame.scripts.some((script) => script.includes("exitPointerLock")));
    assert.ok(frame.scripts.some((script) => script.includes("===null")));
    assert.equal(frame.locked, false);
  } finally {
    manager.disposeAll();
  }
});

test("manager 挂点：frame 树不可读时输入主链路不受反噬", async () => {
  const { manager, guests } = await createManagerHarness();
  try {
    const { sentCommands, result } = attachWithBrokenFrames(manager, guests, "tab-broken", 205);
    assert.equal(result.ok, true);
    const press = await manager.execute(
      { ...MANAGER_CONTEXT_BASE, requestId: "req-press-3" },
      { method: "press", key: "Enter" },
    );
    assert.equal(press.ok, true, JSON.stringify(press));
    assert.ok(sentCommands.some((entry) => entry.method === "Input.dispatchKeyEvent"));
  } finally {
    manager.disposeAll();
  }
});

function attachWithBrokenFrames(manager, guests, tabId, id) {
  const fake = createFakeGuest(id);
  Object.defineProperty(fake.guest, "mainFrame", {
    get() {
      throw new Error("Object has been destroyed");
    },
  });
  guests.set(id, fake.guest);
  const result = manager.attachGuest(tabId, id, {
    active: true,
    windowId: 7,
    workspaceKey: "ws",
    sessionId: "sess",
  });
  return { ...fake, result };
}
