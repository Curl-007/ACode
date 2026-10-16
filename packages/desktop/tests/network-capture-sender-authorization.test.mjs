// 运行时网络观测开关的发送方鉴权回归（specs/runtime-network-capture.md 桌面链路 + 验收 7）。
//
// 根因：desktopNetworkCaptureIpc.isResourceManagerSender 曾把 event.sender.id
// （WebContents id）直接比 getResourceManagerWindowId()（BrowserWindow.id）——两套彼此
// 独立的整数计数器（desktopWindowIds.ts）。本 App 会创建大量无窗口 webContents
// （<webview> guest、WebContentsView/CUA、辅助 renderer、DevTools），RM 窗口的
// webContents.id 必然 > 其 BrowserWindow.id，于是合法 RM 发送方被误判 forbidden，
// 开关静默失效；反向地，webContents.id 恰等于 RM BrowserWindow.id 的无关 renderer 会越权。
//
// Electron main 模块无法在单测里直接 import（顶层拉起 electron），沿用
// desktop-hardening.test.mjs 的 loadMain 手法：transpile 到 CJS + 显式注入依赖，
// 断言鉴权判定与 ID 空间纪律，而不真启动 Electron。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { transpileModule, ModuleKind } from "typescript";

const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const logger = { info() {}, warn() {}, error() {}, debug() {} };

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

/**
 * 构造资源管理器窗口的真实 ID 布局：BrowserWindow.id 与 webContents.id 不相等
 * （webContents 计数器因无窗口 renderer 超前）。返回注入用的 resourceManagerWindow
 * stub + 各发送方 webContents.id。
 */
function makeResourceManagerStub({ open = true } = {}) {
  // RM 窗口：BrowserWindow.id = 2，其 webContents.id = 3（常态：webContents 计数器超前）。
  const RM_WINDOW_ID = 2;
  const RM_WEBCONTENTS_ID = 3;
  const stub = {
    // WindowId 空间：仅供 BrowserWindow.fromId 推送记录。
    getResourceManagerWindowId: () => (open ? RM_WINDOW_ID : null),
    // WebContentsId 空间：供发送方鉴权（修复后模块从这里取）。
    getResourceManagerWebContentsId: () => (open ? RM_WEBCONTENTS_ID : null),
  };
  return { stub, RM_WINDOW_ID, RM_WEBCONTENTS_ID };
}

async function loadNetworkCaptureIpc(rmStub) {
  const handlers = new Map();
  const electronStub = {
    // BrowserWindow.fromId 只在推送记录路径用到；本测试聚焦发送方鉴权，给最小实现。
    BrowserWindow: { fromId: () => null },
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
  };
  // desktopWindowIds.ts 无依赖，直接 transpile 真实实现注入（品牌函数在 JS 层等价恒等）。
  const windowIds = await loadMain("desktopWindowIds", {});
  // ipcMain.handle 同步段计时包装（W1-6 接线）：注入真实 ipcSyncTiming（纯 Node，无 electron 依赖）。
  const ipcSyncTiming = await loadMain("ipcSyncTiming", {});
  const module = await loadMain("desktopNetworkCaptureIpc", {
    electron: electronStub,
    // PlatformChannels.* → 用键名当频道字符串（与 desktop-hardening.test.mjs 同法）。
    "@acode/shared": {
      PlatformChannels: new Proxy({}, { get: (_, key) => String(key) }),
    },
    zod: nodeRequire("zod"),
    "./resourceManagerWindow.js": rmStub,
    "./desktopWindowIds.js": windowIds,
    "./ipcSyncTiming.js": ipcSyncTiming,
  });
  return { module, handlers };
}

test("RM 发送方（webContents.id）开关被放行并转发 host，而非误判 forbidden", async () => {
  const { stub, RM_WEBCONTENTS_ID } = makeResourceManagerStub();
  const { module, handlers } = await loadNetworkCaptureIpc(stub);
  module.resetNetworkCaptureStateForTest();
  module.registerNetworkCaptureIpc(logger);

  const setEnabled = handlers.get("NetworkCaptureSetEnabled");
  assert.equal(typeof setEnabled, "function", "必须注册 NetworkCaptureSetEnabled 处理器");

  // 合法 RM renderer：其 sender.id 是 RM 窗口的 webContents.id。
  const result = await setEnabled(
    { sender: { id: RM_WEBCONTENTS_ID } },
    { enabled: true },
  );
  assert.deepEqual(
    result,
    { success: true },
    "资源管理器窗口自身的开关请求必须放行（无 host child 时按已记忆成功返回）；" +
      "若被 forbidden 说明鉴权又拿错了 ID 空间",
  );

  // 放行后状态确实被记忆为开启（GetState 是纯读取，不限制发送方）。
  const getState = handlers.get("NetworkCaptureGetState");
  const state = await getState({ sender: { id: 999 } });
  assert.equal(state.enabled, true, "开关放行后 main 必须记忆 enabled=true");
  assert.ok(typeof state.captureId === "string", "开启必须生成对账 captureId");

  module.resetNetworkCaptureStateForTest();
});

test("webContents.id 恰等于 RM BrowserWindow.id 的无关 renderer 必须被拒绝（防鉴权旁路）", async () => {
  const { stub, RM_WINDOW_ID, RM_WEBCONTENTS_ID } = makeResourceManagerStub();
  assert.notEqual(
    RM_WINDOW_ID,
    RM_WEBCONTENTS_ID,
    "测试前提：RM 的两套 id 必须不同（真实 App 常态）",
  );
  const { module, handlers } = await loadNetworkCaptureIpc(stub);
  module.resetNetworkCaptureStateForTest();
  module.registerNetworkCaptureIpc(logger);

  const setEnabled = handlers.get("NetworkCaptureSetEnabled");
  // 无关 renderer：其 webContents.id 恰好等于 RM 的 BrowserWindow.id（旧代码会误放行）。
  const result = await setEnabled({ sender: { id: RM_WINDOW_ID } }, { enabled: true });
  assert.deepEqual(
    result,
    { success: false, error: "forbidden" },
    "非资源管理器发送方即使 id 撞上 RM 的 BrowserWindow.id 也必须 forbidden",
  );

  const getState = handlers.get("NetworkCaptureGetState");
  const state = await getState({ sender: { id: RM_WINDOW_ID } });
  assert.equal(state.enabled, false, "被拒绝的开关不得改写 main 记忆状态");

  module.resetNetworkCaptureStateForTest();
});

test("RM 窗口未开时任何发送方一律 forbidden", async () => {
  const { stub } = makeResourceManagerStub({ open: false });
  const { module, handlers } = await loadNetworkCaptureIpc(stub);
  module.resetNetworkCaptureStateForTest();
  module.registerNetworkCaptureIpc(logger);

  const setEnabled = handlers.get("NetworkCaptureSetEnabled");
  const result = await setEnabled({ sender: { id: 1 } }, { enabled: true });
  assert.deepEqual(result, { success: false, error: "forbidden" });

  module.resetNetworkCaptureStateForTest();
});
