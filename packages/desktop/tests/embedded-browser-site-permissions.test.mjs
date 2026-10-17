import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { transpileModule, ModuleKind } from "typescript";
import { readFile } from "node:fs/promises";

// specs/embedded-browser-site-permissions.md：可询问闭集判定、四档动作落点、
// 同 (origin,permission) 去重、未知 requestId 按 deny-once、check-handler 镜像。
// 模块含 electron 运行时导入，按 desktop-hardening.test.mjs 的 transpile+inject 模式加载。
const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const sharedModule = await import("@acode/shared");
const zodModule = await import("zod");
const storeModule = await import("../src/main/browserView/embeddedBrowserSitePermissionStore.ts");

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

const electronStub = {
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: { handle() {}, on() {} },
  session: { fromPartition: () => ({}) },
};

const policyModule = await loadMain("desktopSessionPermissionPolicy", {
  electron: electronStub,
});
const controllerModule = await loadMain("browserView/embeddedBrowserSitePermissionController", {
  electron: electronStub,
  "@acode/shared": sharedModule,
  "./embeddedBrowserSitePermissionStore.js": storeModule,
  "../desktopSessionPermissionPolicy.js": policyModule,
});
// ipcMain.handle 同步段计时包装（W1-6 接线）：注入真实 ipcSyncTiming（纯 Node，无 electron 依赖）。
const ipcSyncTimingModule = await loadMain("ipcSyncTiming", {});
const sitePermissionModule = await loadMain("desktopSitePermissionIpc", {
  electron: electronStub,
  "@acode/shared": sharedModule,
  zod: zodModule,
  "./browserView/embeddedBrowserSitePermissionController.js": controllerModule,
  "./ipcSyncTiming.js": ipcSyncTimingModule,
});

class MemoryFs {
  constructor(initial = {}) {
    this.files = new Map(Object.entries(initial));
  }
  async mkdir() {}
  async readFile(path) {
    if (!this.files.has(path)) {
      const error = new Error(`ENOENT: ${path}`);
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(this.files.get(path), "utf8");
  }
  async writeFile(path, data) {
    this.files.set(path, Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  }
  async rename(from, to) {
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }
  async unlink() {}
  async rm(path) {
    this.files.delete(path);
  }
}

const STORE_PATH = "/userdata/embedded-browser-site-permissions.json";

function createFakeWindow() {
  const sent = [];
  const closedHandlers = new Set();
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    once: (event, handler) => {
      if (event === "closed") closedHandlers.add(handler);
    },
    removeListener: (_event, handler) => {
      closedHandlers.delete(handler);
    },
    emitClosed: () => {
      closedHandlers.forEach((handler) => handler());
    },
  };
}

function createHarness(options = {}) {
  const fs =
    options.fs ?? new MemoryFs(options.initialFile ? { [STORE_PATH]: options.initialFile } : {});
  const warnings = [];
  const infos = [];
  const logger = {
    info: (...args) => infos.push(args),
    warn: (...args) => warnings.push(args),
  };
  const fakeWindow = options.window === null ? null : createFakeWindow();
  let requestCounter = 0;
  const controller = new sitePermissionModule.EmbeddedBrowserSitePermissionController({
    store: new storeModule.EmbeddedBrowserSitePermissionStore(STORE_PATH, { fs }),
    logger,
    resolveTargetWindow: () => fakeWindow,
    generateRequestId: () => `req-${(requestCounter += 1)}`,
  });
  const flush = async (rounds = 6) => {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  return {
    fs,
    controller,
    fakeWindow,
    warnings,
    infos,
    flush,
    request: async (permission, details = {}) => {
      const results = [];
      controller.handlePermissionRequest(
        { id: 1 },
        permission,
        (granted) => results.push(granted),
        {
          requestingUrl: details.requestingUrl ?? "https://example.com/page",
          ...(details.mediaTypes ? { mediaTypes: details.mediaTypes } : {}),
        },
      );
      await flush();
      return results;
    },
    persisted: () => (fs.files.has(STORE_PATH) ? JSON.parse(fs.files.get(STORE_PATH)) : {}),
  };
}

test("判定矩阵：闭集外与静态放行项不进入弹窗路径", async () => {
  const harness = createHarness();
  // 不可询问权限：同步 denied + info 日志（与既有静态矩阵同档），无弹窗。
  for (const permission of [
    "clipboard-read",
    "usb",
    "hid",
    "serial",
    "display-capture",
    "future-permission",
  ]) {
    const results = await harness.request(permission);
    assert.deepEqual(results, [false], `${permission} 必须拒绝且不弹窗`);
  }
  assert.equal(harness.fakeWindow.sent.length, 0);

  // 静态矩阵放行项（fullscreen）在站点权限链里同样直接放行，不弹窗。
  const fullscreen = await harness.request("fullscreen");
  assert.deepEqual(fullscreen, [true]);
  assert.equal(harness.fakeWindow.sent.length, 0);
});

test("media 按 mediaTypes 细分：video 只弹/只写 camera", async () => {
  const harness = createHarness();
  await harness.request("media", { mediaTypes: ["video"] });
  assert.equal(harness.fakeWindow.sent.length, 1);
  assert.deepEqual(harness.fakeWindow.sent[0].payload, {
    requestId: "req-1",
    origin: "https://example.com",
    permission: "media",
    mediaTypes: ["video"],
  });

  harness.controller.resolvePrompt("req-1", "allow-always");
  await harness.flush();
  await harness.controller.whenIdle();
  assert.deepEqual(harness.persisted(), { "https://example.com": { camera: "allow" } });
});

test("allow-always：写 store allow；后续同权限直接放行且无弹窗；notifications 仍弹", async () => {
  const harness = createHarness();
  assert.deepEqual(await harness.request("camera"), [], "弹窗未决时 callback 不结算");

  harness.controller.resolvePrompt("req-1", "allow-always");
  await harness.flush();
  await harness.controller.whenIdle();
  assert.deepEqual(await harness.request("camera"), [true], "第二次请求命中 store allow");
  assert.equal(harness.fakeWindow.sent.length, 1, "allow 后不再弹窗");

  // spec 验收 1：同 origin 的 notifications 仍要弹。
  assert.deepEqual(await harness.request("notifications"), []);
  assert.equal(harness.fakeWindow.sent.length, 2);
});

test("allow-session：只写内存；重启（新 controller 同 store 文件）后重新弹窗", async () => {
  const harness = createHarness();
  await harness.request("geolocation");
  harness.controller.resolvePrompt("req-1", "allow-session");
  await harness.flush();
  assert.deepEqual(await harness.request("geolocation"), [true], "会话内命中 session-allow");
  assert.equal(harness.fakeWindow.sent.length, 1);
  assert.deepEqual(harness.persisted(), {}, "session 档不得写盘");

  // 模拟 app 重启：同一落盘文件、全新 controller（内存 session 集清零）。
  const restarted = createHarness({ fs: harness.fs });
  await restarted.request("geolocation");
  assert.equal(restarted.fakeWindow.sent.length, 1, "重启后必须重新弹窗（spec 验收 2）");
});

test("block-always：写 store deny；后续请求拒绝且无弹窗", async () => {
  const harness = createHarness();
  await harness.request("notifications");
  harness.controller.resolvePrompt("req-1", "block-always");
  await harness.flush();
  await harness.controller.whenIdle();
  assert.deepEqual(await harness.request("notifications"), [false]);
  assert.equal(harness.fakeWindow.sent.length, 1);
  assert.deepEqual(harness.persisted(), { "https://example.com": { notifications: "deny" } });
});

test("deny-once：什么都不写；下次请求重新弹窗", async () => {
  const harness = createHarness();
  await harness.request("camera");
  harness.controller.resolvePrompt("req-1", "deny-once");
  await harness.flush();
  await harness.controller.whenIdle();
  assert.equal(harness.persisted()["https://example.com"], undefined);
  await harness.request("camera");
  assert.equal(harness.fakeWindow.sent.length, 2, "deny-once 后同权限再次弹窗");
});

test("去重：并发同 (origin,permission) 共享一个未决弹窗与同一决策", async () => {
  const harness = createHarness();
  const first = [];
  const second = [];
  harness.controller.handlePermissionRequest(
    { id: 1 },
    "camera",
    (granted) => first.push(granted),
    { requestingUrl: "https://example.com/a" },
  );
  await harness.flush(2);
  harness.controller.handlePermissionRequest(
    { id: 2 },
    "camera",
    (granted) => second.push(granted),
    { requestingUrl: "https://example.com/b" },
  );
  await harness.flush();
  assert.equal(harness.fakeWindow.sent.length, 1, "同 key 只允许一个未决弹窗");

  harness.controller.resolvePrompt("req-1", "allow-always");
  await harness.flush();
  assert.deepEqual(first, [true]);
  assert.deepEqual(second, [true], "并发请求共享同一决策");
});

test("去重键用细分集合：并发 media(video) 与 media(audio) 各自弹窗，摄像头决策不静默放行麦克风", async () => {
  // 回归：pending 去重键曾按原始 permission（`origin\0media`）计算，导致并发的
  // media(video) 与 media(audio) 命中同一个键——音频请求没有自己的弹窗，直接 await
  // 摄像头弹窗的 Promise 并被其决策静默放行（fail-open 隐私泄露）。
  const harness = createHarness();
  const videoResults = [];
  const audioResults = [];
  harness.controller.handlePermissionRequest(
    { id: 1 },
    "media",
    (granted) => videoResults.push(granted),
    { requestingUrl: "https://example.com/page", mediaTypes: ["video"] },
  );
  await harness.flush(2);
  harness.controller.handlePermissionRequest(
    { id: 2 },
    "media",
    (granted) => audioResults.push(granted),
    { requestingUrl: "https://example.com/page", mediaTypes: ["audio"] },
  );
  await harness.flush();

  // 两个 disjoint 的子权限集合必须各弹一个窗，绝不折叠成同一个。
  assert.equal(harness.fakeWindow.sent.length, 2, "disjoint 子权限集合必须各自弹窗");
  assert.deepEqual(
    harness.fakeWindow.sent.map((entry) => entry.payload.requestId),
    ["req-1", "req-2"],
  );

  // 只对摄像头弹窗 allow-always：音频请求必须仍挂在它自己的弹窗上未决。
  harness.controller.resolvePrompt("req-1", "allow-always");
  await harness.flush();
  await harness.controller.whenIdle();
  assert.deepEqual(videoResults, [true], "摄像头请求放行");
  assert.deepEqual(audioResults, [], "麦克风不得继承摄像头决策被静默放行");
  assert.deepEqual(
    harness.persisted(),
    { "https://example.com": { camera: "allow" } },
    "allow-always 只写摄像头，不写麦克风",
  );

  // 音频请求仍可由它自己的弹窗独立结算（这里选择拒绝，验证不被摄像头决策污染）。
  harness.controller.resolvePrompt("req-2", "deny-once");
  await harness.flush();
  assert.deepEqual(audioResults, [false], "麦克风由自己的弹窗按 deny-once 结算");
});

test("去重键用细分集合：并发 media(video) 与 media(video) 仍共享一个弹窗", async () => {
  // 反向保护：相同子权限集合的并发 media 请求仍必须去重，修复不得退化成每请求都弹窗。
  const harness = createHarness();
  const first = [];
  const second = [];
  harness.controller.handlePermissionRequest(
    { id: 1 },
    "media",
    (granted) => first.push(granted),
    { requestingUrl: "https://example.com/a", mediaTypes: ["video"] },
  );
  await harness.flush(2);
  harness.controller.handlePermissionRequest(
    { id: 2 },
    "media",
    (granted) => second.push(granted),
    { requestingUrl: "https://example.com/b", mediaTypes: ["video"] },
  );
  await harness.flush();
  assert.equal(harness.fakeWindow.sent.length, 1, "相同子权限集合仍去重共享弹窗");

  harness.controller.resolvePrompt("req-1", "allow-always");
  await harness.flush();
  assert.deepEqual(first, [true]);
  assert.deepEqual(second, [true], "并发同集合请求共享同一决策");
});

test("未知/过期 requestId：warn + 按 deny-once 结算（不抛错、不影响未决弹窗）", async () => {
  const harness = createHarness();
  await harness.request("camera");
  harness.controller.resolvePrompt("totally-unknown", "allow-always");
  await harness.flush();
  assert.ok(
    harness.warnings.some((args) => String(args[0]).includes("unknown or settled requestId")),
    "未知 requestId 必须 warn",
  );

  // 伪造的 resolve 不得写入 store。
  await harness.controller.whenIdle();
  assert.deepEqual(harness.persisted(), {});

  // 真实 requestId 仍可正常结算。
  harness.controller.resolvePrompt("req-1", "deny-once");
  await harness.flush();
  // 重复 resolve（过期）也只 warn 不抛错。
  harness.controller.resolvePrompt("req-1", "allow-always");
  await harness.flush();
  assert.ok(
    harness.warnings.filter((args) => String(args[0]).includes("unknown or settled requestId"))
      .length >= 2,
  );
});

test("弹窗目标窗口不可用：同步 denied + warn，不排队", async () => {
  const harness = createHarness({ window: null });
  assert.deepEqual(await harness.request("camera"), [false]);
  assert.equal(harness.fakeWindow, null);
  assert.ok(
    harness.warnings.some((args) => String(args[0]).includes("prompt target window unavailable")),
  );
});

test("弹窗窗口在应答前关闭：按 deny-once 结算，不写 store", async () => {
  const harness = createHarness();
  const results = [];
  harness.controller.handlePermissionRequest(
    { id: 1 },
    "camera",
    (granted) => results.push(granted),
    { requestingUrl: "https://example.com/page" },
  );
  await harness.flush(2);
  harness.fakeWindow.emitClosed();
  await harness.flush();
  assert.deepEqual(results, [false]);
  await harness.controller.whenIdle();
  assert.deepEqual(harness.persisted(), {});
});

test("check-handler 镜像：只认 store allow 与 session-allow，从不弹窗", async () => {
  const harness = createHarness();
  // 静态矩阵放行项镜像放行，避免探测/请求结论矛盾。
  assert.equal(harness.controller.checkPermission("https://example.com", "fullscreen"), true);
  assert.equal(harness.controller.checkPermission(undefined, "fullscreen"), true);
  // 闭集外一律 false。
  assert.equal(harness.controller.checkPermission("https://example.com", "clipboard-read"), false);
  // 无记录 false。
  assert.equal(harness.controller.checkPermission("https://example.com", "camera"), false);

  await harness.request("media", { mediaTypes: ["video"] });
  harness.controller.resolvePrompt("req-1", "allow-always");
  await harness.flush();
  await harness.controller.whenIdle();
  assert.equal(harness.controller.checkPermission("https://example.com", "media", "video"), true);
  assert.equal(
    harness.controller.checkPermission("https://example.com", "media", "audio"),
    false,
    "只允许 video 时 audio 探测必须拒绝",
  );
  assert.equal(
    harness.controller.checkPermission("https://other.example", "media", "video"),
    false,
    "其他 origin 不得命中",
  );
  assert.equal(harness.fakeWindow.sent.length, 1, "check 路径绝不触发弹窗");
});

test("stored deny 优先：命中即拒绝且不弹窗；重置后重新弹窗", async () => {
  const initialFile = JSON.stringify({ "https://example.com": { camera: "deny" } });
  const harness = createHarness({ initialFile });
  assert.deepEqual(await harness.request("camera"), [false]);
  assert.equal(harness.fakeWindow.sent.length, 0, "stored deny 不弹窗");

  await harness.controller.resetPermission("https://example.com", "camera");
  await harness.controller.whenIdle();
  await harness.request("camera");
  assert.equal(harness.fakeWindow.sent.length, 1, "重置后请求重新弹窗（spec 验收 3）");
});

test("纯函数：splitEmbeddedBrowserPermissionRequest 的细分与闭集", () => {
  const { splitEmbeddedBrowserPermissionRequest } = sitePermissionModule;
  assert.deepEqual(splitEmbeddedBrowserPermissionRequest("camera"), ["camera"]);
  assert.deepEqual(splitEmbeddedBrowserPermissionRequest("media", ["video"]), ["camera"]);
  assert.deepEqual(splitEmbeddedBrowserPermissionRequest("media", ["audio"]), ["microphone"]);
  assert.deepEqual(splitEmbeddedBrowserPermissionRequest("media", ["video", "audio"]).sort(), [
    "camera",
    "microphone",
  ]);
  assert.deepEqual(splitEmbeddedBrowserPermissionRequest("media"), ["camera", "microphone"]);
  assert.deepEqual(splitEmbeddedBrowserPermissionRequest("clipboard-read"), []);
});

test("纯函数：resolveEmbeddedBrowserRequestOrigin 只接受 http(s) 可信 origin", () => {
  const { resolveEmbeddedBrowserRequestOrigin } = sitePermissionModule;
  assert.equal(resolveEmbeddedBrowserRequestOrigin("https://a.example/x?y=1"), "https://a.example");
  assert.equal(resolveEmbeddedBrowserRequestOrigin("http://b.example"), "http://b.example");
  assert.equal(resolveEmbeddedBrowserRequestOrigin("file:///C:/x.html"), null);
  assert.equal(resolveEmbeddedBrowserRequestOrigin("about:blank"), null);
  assert.equal(resolveEmbeddedBrowserRequestOrigin("not a url"), null);
  assert.equal(resolveEmbeddedBrowserRequestOrigin(undefined), null);
});

test("policy 接线：embedded-browser 分支进控制器，default/coding-plan 保持静态矩阵", async () => {
  const sessions = {};
  const makeSession = (key) => {
    sessions[key] = { handlers: [], checkHandlers: [] };
    return {
      setPermissionRequestHandler: (handler) => sessions[key].handlers.push(handler),
      setPermissionCheckHandler: (handler) => sessions[key].checkHandlers.push(handler),
    };
  };
  const electronPolicyStub = {
    session: {
      defaultSession: makeSession("default"),
      fromPartition: (partition) => makeSession(partition),
    },
  };
  const policy = await loadMain("desktopSessionPermissionPolicy", { electron: electronPolicyStub });
  policy.resetDesktopPermissionPolicyForTest();

  const calls = [];
  const controllerLike = {
    handlePermissionRequest: (_webContents, _permission, callback) => {
      calls.push("controller");
      callback(true);
    },
    checkPermission: () => {
      calls.push("check");
      return false;
    },
  };
  policy.installDesktopSessionPermissionPolicies(
    electronPolicyStub.session,
    {
      info() {},
      warn() {},
    },
    controllerLike,
  );

  // 只有 embedded-browser 挂了 check handler 与控制器分支。
  assert.equal(sessions["persist:acode-embedded-browser"].checkHandlers.length, 1);
  assert.equal(sessions["default"].checkHandlers.length, 0);
  assert.equal(sessions["persist:acode-coding-plan"].checkHandlers.length, 0);

  let granted;
  sessions["persist:acode-embedded-browser"].handlers[0](
    {},
    "camera",
    (value) => {
      granted = value;
    },
    { requestingUrl: "https://x.example/" },
  );
  assert.equal(granted, true);
  assert.deepEqual(calls, ["controller"]);

  // default session 未接控制器时维持静态矩阵（camera 拒绝）。
  let defaultGranted = "unset";
  sessions["default"].handlers[0](
    {},
    "camera",
    (value) => {
      defaultGranted = value;
    },
    { requestingUrl: "https://x.example/" },
  );
  assert.equal(defaultGranted, false);
});
