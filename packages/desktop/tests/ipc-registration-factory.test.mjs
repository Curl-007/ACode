// 桌面平台 IPC 注册工厂回归（specs/ipc-registration-factory.md）。
//
// 覆盖：注册即声明（校验器/sender 门控）、失败语义闭集（invalid_payload /
// forbidden / invalid_response）、日志纪律（不回显载荷值与帧 URL）、幂等重注册
// （handle 替换 / on 不叠加 / legacy 注册被取代）、per-window dispatcher
// （WeakMap 隔离 + closed 拆除）、样板域迁移（desktopSitePermissionIpc 契约保留）。
// 模块含 electron 运行时导入，沿用 desktop-hardening.test.mjs 的 transpile+inject
// 手法：不真启动 Electron，ipcMain/BrowserWindow 全部走 stub。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { transpileModule, ModuleKind } from "typescript";

const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const sharedModule = await import("@acode/shared");
const zodModule = await import("zod");
const { PlatformChannels } = sharedModule;
const { z } = zodModule;

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
    // node: 内建走真实 require；第三方与仓库内模块必须显式注入，防止测试隐式拉起 Electron。
    if (name.startsWith("node:")) {
      return nodeRequire(name);
    }
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}

/** ipcMain/BrowserWindow stub：记录注册面与摘除调用；fromWebContents 走显式映射表。 */
function createElectronStub() {
  const handles = new Map();
  const onListeners = new Map();
  const calls = { removeHandler: [], removeListener: [] };
  const windowsByWebContents = new Map();
  const electronStub = {
    BrowserWindow: {
      fromWebContents: (webContents) =>
        windowsByWebContents.has(webContents) ? windowsByWebContents.get(webContents) : null,
    },
    ipcMain: {
      handle(channel, listener) {
        // 模拟 Electron：同通道重复 handle 直接抛错（工厂必须先摘旧再挂新）。
        if (handles.has(channel)) {
          throw new Error(`Attempted to register a second handler for '${channel}'`);
        }
        handles.set(channel, listener);
      },
      removeHandler(channel) {
        calls.removeHandler.push(channel);
        handles.delete(channel);
      },
      on(channel, listener) {
        if (!onListeners.has(channel)) onListeners.set(channel, []);
        onListeners.get(channel).push(listener);
      },
      removeListener(channel, listener) {
        calls.removeListener.push(channel);
        const listeners = onListeners.get(channel);
        if (!listeners) return;
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
  };
  return { electronStub, handles, onListeners, calls, windowsByWebContents };
}

function createFakeWindow(id) {
  const closedListeners = new Set();
  let destroyed = false;
  return {
    id,
    isDestroyed: () => destroyed,
    once(event, listener) {
      if (event === "closed") closedListeners.add(listener);
    },
    removeListener(event, listener) {
      if (event === "closed") closedListeners.delete(listener);
    },
    emitClosed() {
      destroyed = true;
      // Set 迭代中删除当前项安全：closer 内部会 removeListener 自己。
      for (const listener of closedListeners) listener();
    },
  };
}

/** 事件构造：frame 变体对应 rendererFrameTrust 的受信/子帧/远程 origin/缺帧四态。 */
function createEvent({ frame = "trusted", senderId = 1 } = {}) {
  const frames = {
    trusted: { parent: null, url: "file:///app/index.html" },
    nested: { parent: {}, url: "file:///app/index.html" },
    remote: { parent: null, url: "https://evil.example/page" },
    none: null,
  };
  const sender = { id: senderId, isDestroyed: () => false };
  return { event: { sender, senderFrame: frames[frame] }, sender };
}

async function createHarness() {
  const stub = createElectronStub();
  const warnings = [];
  const infos = [];
  const errors = [];
  const logger = {
    info: (...args) => infos.push(args),
    warn: (...args) => warnings.push(args),
    error: (...args) => errors.push(args),
  };
  // 帧受信判定与同步段计时都用真实实现（纯 Node，无 electron 依赖）。
  const rendererFrameTrust = await loadMain("rendererFrameTrust", {});
  const ipcSyncTiming = await loadMain("ipcSyncTiming", {});
  // per-window dispatcher 姊妹模块（type-only electron 依赖，纯 Node）。
  const perWindowDispatcher = await loadMain("platformIpcPerWindowDispatcher", {});
  const registryModule = await loadMain("platformIpcRegistry", {
    electron: stub.electronStub,
    "./rendererFrameTrust.js": rendererFrameTrust,
    "./ipcSyncTiming.js": ipcSyncTiming,
    "./platformIpcPerWindowDispatcher.js": perWindowDispatcher,
  });
  const registry = registryModule.createPlatformIpcRegistry({ logger });
  return {
    ...stub,
    warnings,
    infos,
    errors,
    logger,
    registryModule,
    registry,
    ipcSyncTiming,
    invoke: (channel, event, payload) => stub.handles.get(channel)(event, payload),
    fire: (channel, event, payload) => {
      for (const listener of stub.onListeners.get(channel) ?? []) {
        listener(event, payload);
      }
    },
  };
}

const resetSchema = z.object({ origin: z.string().min(1), permission: z.string().min(1) }).strict();
const resolveSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    action: z.enum(["allow-always", "allow-session", "block-always", "deny-once"]),
  })
  .strict();

test("handle 正常路径：类型化载荷触达、context 携带解析窗口、同步计时归因接线", async () => {
  const harness = await createHarness();
  const window = createFakeWindow(7);
  const { event, sender } = createEvent();
  harness.windowsByWebContents.set(sender, window);
  let seen = null;
  harness.registry.handle(PlatformChannels.ActivateOrSetWorkspace, {
    sender: "app-renderer",
    validate: z.string().min(1),
    handler: (context, payload) => {
      seen = { window: context.window, payload, event: context.event };
      return { activated: true };
    },
  });
  const result = await harness.invoke(PlatformChannels.ActivateOrSetWorkspace, event, "/repo");
  assert.deepEqual(result, { activated: true });
  assert.equal(seen.payload, "/repo");
  assert.equal(seen.window, window, "context.window 必须是 sender 解析出的窗口");
  assert.equal(seen.event, event);
  // 不变量 4：工厂注册的 handle 通道在同步计时归因面上（label = channel 派生）。
  const worst = harness.ipcSyncTiming.peekWorstIpcSyncOffender();
  assert.ok(worst, "同步计时必须有记账");
  assert.equal(worst.label, "activate_or_set_workspace");
});

test("handle 载荷校验失败：默认 reject invalid_payload，日志只记 issue 摘要不回显载荷值", async () => {
  const harness = await createHarness();
  const window = createFakeWindow(1);
  const { event, sender } = createEvent();
  harness.windowsByWebContents.set(sender, window);
  let handlerCalls = 0;
  harness.registry.handle(PlatformChannels.ResetEmbeddedBrowserSitePermission, {
    sender: "app-renderer",
    validate: resetSchema,
    handler: () => {
      handlerCalls += 1;
      return { success: true };
    },
  });
  await assert.rejects(
    () =>
      harness.invoke(PlatformChannels.ResetEmbeddedBrowserSitePermission, event, {
        origin: "https://x.example",
        permission: 12345,
      }),
    (error) => {
      assert.equal(error.name, "PlatformIpcError");
      assert.equal(error.code, "invalid_payload");
      assert.match(error.message, /invalid_payload/);
      assert.match(error.message, /reset-embedded-browser-site-permission/);
      return true;
    },
  );
  assert.equal(handlerCalls, 0, "校验失败不得触达 handler");
  const warnText = JSON.stringify(harness.warnings);
  assert.match(warnText, /invalid payload/);
  assert.match(warnText, /permission/, "日志应含 issue path");
  assert.ok(!warnText.includes("12345"), "日志不得回显原始载荷值");
});

test("handle 载荷校验失败：onInvalidPayload 保留存量信封契约", async () => {
  const harness = await createHarness();
  const window = createFakeWindow(1);
  const { event, sender } = createEvent();
  harness.windowsByWebContents.set(sender, window);
  harness.registry.handle(PlatformChannels.ResetEmbeddedBrowserSitePermission, {
    sender: "app-renderer",
    validate: resetSchema,
    onInvalidPayload: () => ({ success: false, error: "invalid_payload" }),
    handler: () => ({ success: true }),
  });
  const result = await harness.invoke(PlatformChannels.ResetEmbeddedBrowserSitePermission, event, {
    origin: "",
    permission: "camera",
  });
  assert.deepEqual(result, { success: false, error: "invalid_payload" });
});

test("sender 门控：子帧/远程 origin/无窗身份一律 forbidden，不触达 handler，日志不回显帧 URL", async () => {
  const harness = await createHarness();
  const window = createFakeWindow(2);
  let handlerCalls = 0;
  harness.registry.handle(PlatformChannels.NetworkCaptureGetState, {
    sender: "app-renderer",
    handler: () => {
      handlerCalls += 1;
      return { enabled: false, captureId: null };
    },
  });
  const channel = PlatformChannels.NetworkCaptureGetState;

  // 子帧（parent 非 null）：受信帧判定拒绝。
  const nested = createEvent({ frame: "nested", senderId: 11 });
  harness.windowsByWebContents.set(nested.sender, window);
  await assert.rejects(() => harness.invoke(channel, nested.event, undefined), /forbidden/);

  // 远程 origin 顶层帧：受信帧判定拒绝。
  const remote = createEvent({ frame: "remote", senderId: 12 });
  harness.windowsByWebContents.set(remote.sender, window);
  await assert.rejects(() => harness.invoke(channel, remote.event, undefined), /forbidden/);

  // 缺帧：fail-closed。
  const noFrame = createEvent({ frame: "none", senderId: 13 });
  harness.windowsByWebContents.set(noFrame.sender, window);
  await assert.rejects(() => harness.invoke(channel, noFrame.event, undefined), /forbidden/);

  // 受信帧但解析不出窗口（无窗 webContents 走 app-renderer 档）：身份解析拒绝。
  const windowless = createEvent({ frame: "trusted", senderId: 14 });
  await assert.rejects(() => harness.invoke(channel, windowless.event, undefined), /forbidden/);

  assert.equal(handlerCalls, 0, "任何 sender 拒绝都不得触达 handler");
  const warnText = JSON.stringify(harness.warnings);
  assert.match(warnText, /untrusted_frame/);
  assert.match(warnText, /no_sender_frame/);
  assert.match(warnText, /no_window/);
  assert.ok(!warnText.includes("evil.example"), "日志不得回显帧 URL");
});

test("sender 策略：trusted-frame 放行无窗顶层帧；predicate 原因词白名单收敛、抛错 fail-closed", async () => {
  const harness = await createHarness();
  const { event } = createEvent({ frame: "trusted" });

  // trusted-frame：不要求窗口身份（无窗辅助面）。
  let seenWindow = "unset";
  harness.registry.handle(PlatformChannels.NetworkCaptureGetState, {
    sender: "trusted-frame",
    handler: (context) => {
      seenWindow = context.window;
      return { enabled: false, captureId: null };
    },
  });
  await harness.invoke(PlatformChannels.NetworkCaptureGetState, event, undefined);
  assert.equal(seenWindow, null);

  // predicate：白名单原因词进日志。
  harness.registry.handle(PlatformChannels.IsDockerAvailable, {
    sender: { predicate: () => "rm_window_required" },
    handler: () => true,
  });
  await assert.rejects(() => harness.invoke(PlatformChannels.IsDockerAvailable, event, undefined), /forbidden/);
  assert.match(JSON.stringify(harness.warnings), /rm_window_required/);

  // predicate：非白名单原因收敛为 custom_denied，任意字符串不进日志。
  harness.registry.handle(PlatformChannels.ListWSLDistros, {
    sender: { predicate: () => "Has Spaces AND symbols!!" },
    handler: () => [],
  });
  await assert.rejects(() => harness.invoke(PlatformChannels.ListWSLDistros, event, undefined), /forbidden/);
  const deniedText = JSON.stringify(harness.warnings);
  assert.match(deniedText, /custom_denied/);
  assert.ok(!deniedText.includes("Has Spaces"));

  // predicate 抛错：fail-closed，错误消息不外泄。
  harness.registry.handle(PlatformChannels.SelectDirectory, {
    sender: {
      predicate: () => {
        throw new Error("boom-secret-detail");
      },
    },
    handler: () => null,
  });
  await assert.rejects(() => harness.invoke(PlatformChannels.SelectDirectory, event, undefined), /forbidden/);
  const errorText = JSON.stringify(harness.warnings);
  assert.match(errorText, /predicate_error/);
  assert.ok(!errorText.includes("boom-secret-detail"));

  // predicate 放行。
  harness.registry.handle(PlatformChannels.SelectFile, {
    sender: { predicate: () => true },
    handler: () => null,
  });
  assert.equal(await harness.invoke(PlatformChannels.SelectFile, event, undefined), null);
});

test("幂等重注册：handle 替换旧 handler 退役；on 替换监听器不叠加；legacy 注册被取代", async () => {
  const harness = await createHarness();
  const window = createFakeWindow(3);
  const { event, sender } = createEvent();
  harness.windowsByWebContents.set(sender, window);

  // handle 重复注册：替换语义（Electron 原生会抛错，工厂必须先摘旧）。
  let firstCalls = 0;
  let secondCalls = 0;
  harness.registry.handle(PlatformChannels.IsDockerAvailable, {
    sender: "app-renderer",
    handler: () => {
      firstCalls += 1;
      return true;
    },
  });
  harness.registry.handle(PlatformChannels.IsDockerAvailable, {
    sender: "app-renderer",
    handler: () => {
      secondCalls += 1;
      return false;
    },
  });
  assert.deepEqual(harness.calls.removeHandler, [PlatformChannels.IsDockerAvailable]);
  assert.match(JSON.stringify(harness.infos), /re-registered/);
  assert.equal(await harness.invoke(PlatformChannels.IsDockerAvailable, event, undefined), false);
  assert.equal(firstCalls, 0, "旧 handler 必须退役");
  assert.equal(secondCalls, 1);

  // on 重复注册：监听器不叠加（Electron 原生静默叠加，工厂收口为替换）。
  let onFirstCalls = 0;
  let onSecondCalls = 0;
  const onChannel = PlatformChannels.EmbeddedBrowserPermissionResolve;
  harness.registry.on(onChannel, {
    sender: "app-renderer",
    validate: resolveSchema,
    handler: () => {
      onFirstCalls += 1;
    },
  });
  harness.registry.on(onChannel, {
    sender: "app-renderer",
    validate: resolveSchema,
    handler: () => {
      onSecondCalls += 1;
    },
  });
  assert.equal(harness.onListeners.get(onChannel).length, 1);
  assert.deepEqual(harness.calls.removeListener, [onChannel]);
  harness.fire(onChannel, event, { requestId: "req-1", action: "deny-once" });
  assert.equal(onFirstCalls, 0);
  assert.equal(onSecondCalls, 1);

  // 工厂外的 legacy ipcMain.handle 占位：工厂注册经 removeHandler 重试路径取代它。
  const legacyChannel = PlatformChannels.ListDockerContainers;
  harness.handles.set(legacyChannel, () => {
    throw new Error("legacy handler must be replaced");
  });
  harness.registry.handle(legacyChannel, {
    sender: "app-renderer",
    handler: () => [],
  });
  assert.match(JSON.stringify(harness.warnings), /legacy handler/);
  assert.deepEqual(await harness.invoke(legacyChannel, event, undefined), []);
});

test("on 通道：无效载荷丢弃 + warn、sender 拒绝丢弃、handler 异常收敛不传播", async () => {
  const harness = await createHarness();
  const window = createFakeWindow(4);
  const trusted = createEvent({ senderId: 21 });
  harness.windowsByWebContents.set(trusted.sender, window);
  const channel = PlatformChannels.EmbeddedBrowserPermissionResolve;
  const received = [];
  harness.registry.on(channel, {
    sender: "app-renderer",
    validate: resolveSchema,
    handler: (_context, payload) => {
      received.push(payload);
      if (payload.requestId === "boom") throw new Error("handler failure");
    },
  });

  harness.fire(channel, trusted.event, { requestId: "req-1", action: "allow-always" });
  assert.deepEqual(received, [{ requestId: "req-1", action: "allow-always" }]);

  // 无效载荷：丢弃 + warn，不触达 handler。
  harness.fire(channel, trusted.event, { requestId: 42, action: "allow-always" });
  assert.equal(received.length, 1);
  assert.match(JSON.stringify(harness.warnings), /invalid payload/);

  // 伪造 sender：丢弃 + warn。
  const remote = createEvent({ frame: "remote", senderId: 22 });
  harness.windowsByWebContents.set(remote.sender, window);
  harness.fire(channel, remote.event, { requestId: "req-2", action: "deny-once" });
  assert.equal(received.length, 1);
  assert.match(JSON.stringify(harness.warnings), /sender rejected/);

  // handler 异常：收敛为 warn（send-only 无应答面，不得升级为 main uncaughtException）。
  harness.fire(channel, trusted.event, { requestId: "boom", action: "deny-once" });
  assert.match(JSON.stringify(harness.warnings), /on-handler failed/);
});

test("validateResponse：脏返回 fail-closed 为 invalid_response + error 日志", async () => {
  const harness = await createHarness();
  const window = createFakeWindow(5);
  const { event, sender } = createEvent();
  harness.windowsByWebContents.set(sender, window);
  harness.registry.handle(PlatformChannels.IsDockerAvailable, {
    sender: "app-renderer",
    validateResponse: z.boolean(),
    handler: () => "not-a-boolean",
  });
  await assert.rejects(
    () => harness.invoke(PlatformChannels.IsDockerAvailable, event, undefined),
    /invalid_response/,
  );
  assert.equal(harness.errors.length, 1, "invalid_response 必须走 error 级日志");
});

test("registry.dispose：摘除本实例名下全部活跃注册，重复 dispose 幂等", async () => {
  const harness = await createHarness();
  const window = createFakeWindow(6);
  const { sender } = createEvent();
  harness.windowsByWebContents.set(sender, window);
  harness.registry.handle(PlatformChannels.IsDockerAvailable, {
    sender: "app-renderer",
    handler: () => true,
  });
  harness.registry.on(PlatformChannels.EmbeddedBrowserPermissionResolve, {
    sender: "app-renderer",
    validate: resolveSchema,
    handler: () => {},
  });
  harness.registry.dispose();
  assert.equal(harness.handles.has(PlatformChannels.IsDockerAvailable), false);
  assert.equal(harness.onListeners.get(PlatformChannels.EmbeddedBrowserPermissionResolve).length, 0);
  harness.registry.dispose(); // 幂等：不抛错
});

test("per-window dispatcher：同窗同实例、异窗异实例、closed 后 dispose 并重建", async () => {
  const harness = await createHarness();
  const disposed = [];
  let created = 0;
  const dispatcher = harness.registryModule.createPerWindowDispatcher({
    create: (window) => {
      created += 1;
      return { id: created, window };
    },
    dispose: (value) => disposed.push(value.id),
  });
  const first = createFakeWindow(31);
  const second = createFakeWindow(32);
  const a = dispatcher.forWindow(first);
  assert.equal(dispatcher.forWindow(first), a, "同窗口必须复用实例（WeakMap 隔离）");
  const b = dispatcher.forWindow(second);
  assert.notEqual(a, b, "异窗口实例必须隔离");

  first.emitClosed();
  assert.deepEqual(disposed, [a.id], "关窗即 dispose");
  const c = dispatcher.forWindow(first);
  assert.notEqual(c, a, "关窗后重建新实例");

  dispatcher.disposeWindow(second);
  assert.deepEqual(disposed, [a.id, b.id]);
  assert.notEqual(dispatcher.forWindow(second), b);
});

test("台账复位后同通道注册走 legacy 替换路径（resetPlatformIpcRegistryForTest 语义）", async () => {
  const harness = await createHarness();
  const window = createFakeWindow(8);
  const { event, sender } = createEvent();
  harness.windowsByWebContents.set(sender, window);
  harness.registry.handle(PlatformChannels.IsDockerAvailable, {
    sender: "app-renderer",
    handler: () => true,
  });
  harness.registryModule.resetPlatformIpcRegistryForTest();
  // 台账已清空但 stub 上仍挂着旧 handler：再次注册必须经 removeHandler 重试路径取代。
  harness.registry.handle(PlatformChannels.IsDockerAvailable, {
    sender: "app-renderer",
    handler: () => "replaced",
  });
  assert.match(JSON.stringify(harness.warnings), /legacy handler/);
  assert.equal(await harness.invoke(PlatformChannels.IsDockerAvailable, event, undefined), "replaced");
});

test("样板迁移：站点权限 registrar 全量过工厂，契约保留 + sender 加固 + 幂等重注册", async () => {
  const stub = createElectronStub();
  const warnings = [];
  const infos = [];
  const logger = {
    info: (...args) => infos.push(args),
    warn: (...args) => warnings.push(args),
  };
  const rendererFrameTrust = await loadMain("rendererFrameTrust", {});
  const ipcSyncTiming = await loadMain("ipcSyncTiming", {});
  const perWindowDispatcher = await loadMain("platformIpcPerWindowDispatcher", {});
  const registryModule = await loadMain("platformIpcRegistry", {
    electron: stub.electronStub,
    "./rendererFrameTrust.js": rendererFrameTrust,
    "./ipcSyncTiming.js": ipcSyncTiming,
    "./platformIpcPerWindowDispatcher.js": perWindowDispatcher,
  });
  // controller 侧只需要 registrar 用到的四个方法面；re-export 面给占位实现。
  const controllerCalls = { reset: [], resolve: [], clear: 0 };
  const controller = {
    getPermissionTable: async () => ({ "https://example.com": { camera: "allow" } }),
    resetPermission: async (origin, permission) => {
      controllerCalls.reset.push({ origin, permission });
    },
    clearPermissions: async () => {
      controllerCalls.clear += 1;
    },
    resolvePrompt: (requestId, action) => {
      controllerCalls.resolve.push({ requestId, action });
    },
  };
  const sitePermissionModule = await loadMain("desktopSitePermissionIpc", {
    "@acode/shared": sharedModule,
    zod: zodModule,
    "./browserView/embeddedBrowserSitePermissionController.js": {
      EMBEDDED_BROWSER_ASKABLE_PERMISSIONS: [],
      EmbeddedBrowserSitePermissionController: class {},
      embeddedBrowserPermissionActionWritesStore: () => false,
      isEmbeddedBrowserPermissionAction: () => true,
      resolveEmbeddedBrowserRequestOrigin: () => null,
      resolveEmbeddedBrowserSitePermissionRequestOutcome: () => null,
      splitEmbeddedBrowserPermissionRequest: () => null,
    },
    "./platformIpcRegistry.js": registryModule,
  });

  sitePermissionModule.registerDesktopSitePermissionIpcHandlers({ controller, logger });
  assert.ok(stub.handles.has(PlatformChannels.GetEmbeddedBrowserSitePermissions));
  assert.ok(stub.handles.has(PlatformChannels.ResetEmbeddedBrowserSitePermission));
  assert.ok(stub.handles.has(PlatformChannels.ClearEmbeddedBrowserSitePermissions));
  assert.equal(stub.onListeners.get(PlatformChannels.EmbeddedBrowserPermissionResolve).length, 1);

  const window = createFakeWindow(51);
  const { event, sender } = createEvent();
  stub.windowsByWebContents.set(sender, window);

  // Get：读表原样返回（含读表失败回空表的既有语义，由 controller stub 覆盖正常路径）。
  const table = await stub.handles.get(PlatformChannels.GetEmbeddedBrowserSitePermissions)(
    event,
    undefined,
  );
  assert.deepEqual(table, { permissions: { "https://example.com": { camera: "allow" } } });

  // Reset 无效载荷：保留存量信封契约（不 reject）。
  const invalid = await stub.handles.get(PlatformChannels.ResetEmbeddedBrowserSitePermission)(
    event,
    { origin: "", permission: "camera" },
  );
  assert.deepEqual(invalid, { success: false, error: "invalid_payload" });
  assert.equal(controllerCalls.reset.length, 0);

  // Reset 合法载荷：解析后的类型化载荷直达 controller。
  const reset = await stub.handles.get(PlatformChannels.ResetEmbeddedBrowserSitePermission)(event, {
    origin: "https://example.com",
    permission: "camera",
  });
  assert.deepEqual(reset, { success: true });
  assert.deepEqual(controllerCalls.reset, [
    { origin: "https://example.com", permission: "camera" },
  ]);

  // 伪造 sender（远程 origin 顶层帧）：forbidden reject，controller 不被触达。
  const remote = createEvent({ frame: "remote", senderId: 52 });
  stub.windowsByWebContents.set(remote.sender, window);
  await assert.rejects(
    () => stub.handles.get(PlatformChannels.ClearEmbeddedBrowserSitePermissions)(remote.event, undefined),
    /forbidden/,
  );
  assert.equal(controllerCalls.clear, 0);

  // Resolve（on）：无效载荷丢弃、合法载荷触达。
  const fire = (ev, payload) => {
    for (const listener of stub.onListeners.get(PlatformChannels.EmbeddedBrowserPermissionResolve)) {
      listener(ev, payload);
    }
  };
  fire(event, { requestId: "", action: "nope" });
  assert.equal(controllerCalls.resolve.length, 0);
  fire(event, { requestId: "req-1", action: "allow-session" });
  assert.deepEqual(controllerCalls.resolve, [{ requestId: "req-1", action: "allow-session" }]);

  // registrar 重入（窗口重建等场景）：幂等替换，不抛错、监听器不叠加。
  sitePermissionModule.registerDesktopSitePermissionIpcHandlers({ controller, logger });
  assert.equal(stub.onListeners.get(PlatformChannels.EmbeddedBrowserPermissionResolve).length, 1);
  assert.match(JSON.stringify(infos), /re-registered/);
  fire(event, { requestId: "req-2", action: "deny-once" });
  assert.equal(controllerCalls.resolve.length, 2, "重注册后一次 send 只触达一次");
});
