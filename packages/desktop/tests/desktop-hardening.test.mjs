// 安全加固 P2 批次（specs/electron-hardening.md）的配置层与纯函数测试。
// Electron main 代码难以直接单测的部分，把可判定逻辑抽成纯函数后在这里覆盖；
// electron-builder.config.js 有重量级顶层副作用，改用源码文本断言接线是否完整。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { transpileModule, ModuleKind } from "typescript";

const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const logger = { info() {}, warn() {}, error() {}, debug() {} };
// Windows 专属行为的用例在 POSIX 上 skip 而不是改期望：app-bound cookies 嗅探链在生产
// 代码里按 process.platform === "win32" 门控（desktopBrowserDataIpc.ts:63），
// resolveLocalFileUrlTarget 直接返回 fileURLToPath 的平台形态（desktopMainIpcHelpers.ts:37）。
// CI 跑 ubuntu，这两条在 Windows 开发机与 desktop 打包冒烟里仍然执行。
const WIN32_ONLY =
  process.platform === "win32" ? false : "Windows-only 行为，POSIX 上生产代码不走这条链";

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

test("main window navigation guard allows app-owned pages and routes external urls out", async () => {
  const guard = await loadMain("desktopWebContentsGuard", {
    electron: { shell: { openExternal: async () => {} } },
  });
  const { resolveMainWindowNavigationAction, resolveMainWindowWindowOpenAction } = guard;

  // dev 态 vite 同 origin（含 login 页与带 query 自导航）放行
  assert.equal(
    resolveMainWindowNavigationAction("http://localhost:5173/", "http://localhost:5173/login.html"),
    "allow",
  );
  assert.equal(
    resolveMainWindowNavigationAction(
      "http://127.0.0.1:5173/index.html",
      "http://127.0.0.1:5173/?restoreSession=1",
    ),
    "allow",
  );
  // 打包态 file:→file:（index.html 与带 query 的自导航）放行
  assert.equal(
    resolveMainWindowNavigationAction(
      "file:///C:/app/out/renderer/index.html",
      "file:///C:/app/out/renderer/index.html?windowKind=update-status",
    ),
    "allow",
  );
  // 外部 http(s)：主帧阻止并转交系统浏览器（dev 与打包态一致）
  assert.equal(
    resolveMainWindowNavigationAction(
      "http://localhost:5173/",
      "https://evil.example.com/phish",
    ),
    "open-external",
  );
  assert.equal(
    resolveMainWindowNavigationAction(
      "file:///C:/app/out/renderer/index.html",
      "https://example.com/",
    ),
    "open-external",
  );
  // dev 态下的 file: 目标不是应用页面：block
  assert.equal(
    resolveMainWindowNavigationAction("http://localhost:5173/", "file:///C:/Windows/System32/x"),
    "block",
  );
  // 解析失败与自定义协议（含 acode: 深链，深链由协议处理链路接收）一律 block
  assert.equal(resolveMainWindowNavigationAction("http://localhost:5173/", "not a url"), "block");
  assert.equal(
    resolveMainWindowNavigationAction("http://localhost:5173/", "acode://oauth/callback"),
    "block",
  );
  assert.equal(resolveMainWindowNavigationAction(undefined, "https://example.com/"), "open-external");

  // window.open：一律不创建子窗口；http(s) 附带转交系统浏览器
  assert.equal(resolveMainWindowWindowOpenAction("https://example.com/"), "open-external");
  assert.equal(resolveMainWindowWindowOpenAction("http://localhost:5173/x"), "open-external");
  assert.equal(resolveMainWindowWindowOpenAction("file:///C:/x.html"), "block");
  assert.equal(resolveMainWindowWindowOpenAction("javascript:alert(1)"), "block");
});

test("main window guard wiring blocks navigation and denies window creation", async () => {
  const guard = await loadMain("desktopWebContentsGuard", {
    electron: { shell: { openExternal: async () => {} } },
  });
  const openedExternally = [];
  const navigationGuards = {};
  const webContentsStub = {
    getURL: () => "file:///C:/app/out/renderer/index.html",
    setWindowOpenHandler: (handler) => {
      navigationGuards.windowOpen = handler;
    },
    on: (event, handler) => {
      navigationGuards[event] = handler;
    },
  };
  guard.attachMainWindowNavigationGuards({
    webContents: webContentsStub,
    logger: {
      warn: (...args) => {
        openedExternally.push(args);
      },
    },
    // shell 未注入（模块顶层已绑定 electron.shell）——外部打开失败只会走 catch，不影响断言
  });

  const willNavigate = navigationGuards["will-navigate"];
  assert.equal(typeof willNavigate, "function");
  const prevented = [];
  willNavigate({ preventDefault: () => prevented.push(true) }, "https://evil.example.com/");
  assert.equal(prevented.length, 1, "external navigation must be prevented");
  willNavigate({ preventDefault: () => prevented.push(true) }, "file:///C:/app/out/renderer/index.html?a=b");
  assert.equal(prevented.length, 1, "same-app file navigation must not be prevented");

  const windowOpenResult = navigationGuards.windowOpen({ url: "https://example.com/" });
  assert.deepEqual(windowOpenResult, { action: "deny" }, "window.open must never create windows");
});

test("permission policy matrix denies sensitive permissions on every session", async () => {
  const policy = await loadMain("desktopSessionPermissionPolicy", {
    electron: { session: { fromPartition: () => ({}) } },
  });
  const decide = policy.resolveDesktopPermissionRequestDecision;

  for (const servesArbitraryWebPages of [true, false]) {
    assert.equal(decide({ permission: "fullscreen", servesArbitraryWebPages }), "granted");
    assert.equal(
      decide({ permission: "clipboard-sanitized-write", servesArbitraryWebPages }),
      "granted",
    );
    // 敏感权限在任何 session 都拒绝（specs/electron-hardening.md §2 决策矩阵）
    for (const permission of [
      "media",
      "display-capture",
      "geolocation",
      "notifications",
      "midi",
      "midiSysex",
      "window-management",
      "clipboard-read",
      "openExternal",
      "speaker-selection",
      "storage-access",
      "unknown",
    ]) {
      assert.equal(
        decide({ permission, servesArbitraryWebPages }),
        "denied",
        `${permission} must be denied (webPages=${servesArbitraryWebPages})`,
      );
    }
  }
  // pointerLock 只对承载任意网页的 session 放行
  assert.equal(decide({ permission: "pointerLock", servesArbitraryWebPages: true }), "granted");
  assert.equal(decide({ permission: "pointerLock", servesArbitraryWebPages: false }), "denied");
  // fail-closed：未识别权限一律拒绝
  assert.equal(decide({ permission: "not-yet-known-future-permission", servesArbitraryWebPages: true }), "denied");
});

test("permission policies install exactly one handler per web-content session", async () => {
  const sessions = {};
  const makeSession = (key) => {
    sessions[key] = { handlers: [] };
    return {
      setPermissionRequestHandler: (handler) => {
        sessions[key].handlers.push(handler);
      },
    };
  };
  const electronStub = {
    session: {
      defaultSession: makeSession("default"),
      fromPartition: (partition) => makeSession(partition),
    },
  };
  const policy = await loadMain("desktopSessionPermissionPolicy", { electron: electronStub });
  policy.resetDesktopPermissionPolicyForTest();

  policy.installDesktopSessionPermissionPolicies(electronStub.session, logger);
  assert.equal(sessions["default"].handlers.length, 1, "defaultSession must get one handler");
  assert.equal(sessions["persist:acode-embedded-browser"].handlers.length, 1);
  assert.equal(sessions["persist:acode-coding-plan"].handlers.length, 1);

  // 幂等：重复安装不得覆盖首次策略
  policy.installDesktopSessionPermissionPolicies(electronStub.session, logger);
  assert.equal(sessions["default"].handlers.length, 1, "install must be idempotent");

  // denied 请求回调 false
  let granted;
  sessions["persist:acode-embedded-browser"].handlers[0](
    {},
    "media",
    (permissionGranted) => {
      granted = permissionGranted;
    },
    { requestingUrl: "https://evil.example.com/", isMainFrame: true },
  );
  assert.equal(granted, false, "media request on embedded browser must be denied");
});

test("main renderer index.html carries a CSP that blocks remote script while serving dev and packaged", async () => {
  const html = await readSource("src/renderer/index.html");
  const metaMatch = html.match(/Content-Security-Policy"[^>]*content="([^"]+)"/);
  assert.ok(metaMatch, "index.html must declare a Content-Security-Policy meta tag");
  const csp = metaMatch[1];
  const directives = new Map(
    csp.split(";").map((directive) => {
      const parts = directive.trim().split(/\s+/);
      return [parts[0], parts.slice(1)];
    }),
  );
  assert.deepEqual(directives.get("default-src"), ["'none'"]);
  assert.deepEqual(
    directives.get("script-src"),
    ["'self'", "file:", "'unsafe-inline'", "'wasm-unsafe-eval'"],
    "script-src must allow self + file: (packaged loadFile) + inline (startup script / vite dev) + wasm (Shiki)",
  );
  // 回归守护：主窗 Shiki 代码高亮经 WebAssembly.instantiate 编译，缺 'wasm-unsafe-eval' 会被 CSP
  // 拦下（代码高亮/diff/office 预览全坏）。dev desktop 启动冒烟实测到过该违规，故钉死。
  assert.ok(
    directives.get("script-src").includes("'wasm-unsafe-eval'"),
    "script-src must keep 'wasm-unsafe-eval' for Shiki/Oniguruma WASM (code highlighting)",
  );
  // 'wasm-unsafe-eval' 只放行 WASM 编译，不放行任意 eval()——绝不能退化成 'unsafe-eval'。
  assert.ok(
    !directives.get("script-src").includes("'unsafe-eval'"),
    "script-src must not widen to 'unsafe-eval' (wasm-unsafe-eval is the narrow form)",
  );
  assert.ok(directives.get("object-src")[0] === "'none'", "object-src must be none");
  assert.ok(directives.get("base-uri")[0] === "'none'", "base-uri must be none");
  assert.ok(
    directives.get("frame-src").includes("https:") && directives.get("frame-src").includes("http:"),
    "frame-src must keep allowing webview guests (http/https)",
  );
  assert.ok(
    directives.get("img-src").includes("blob:") && directives.get("img-src").includes("data:"),
    "img-src must keep blob:/data: for previews",
  );
  assert.ok(
    directives.get("worker-src").includes("'self'"),
    "worker-src must keep bundled workers (diffs / workspace search) working",
  );
});

test("aux windows (resource-manager / cua-permission-panel) carry a tightened CSP", async () => {
  // specs/electron-hardening.md §3b：两个 vite 构建的独立辅助窗补 CSP，是 index.html 的已验证子集。
  for (const page of ["resource-manager.html", "cua-permission-panel.html"]) {
    const html = await readSource(`src/renderer/${page}`);
    const metaMatch = html.match(/Content-Security-Policy"[^>]*content="([^"]+)"/);
    assert.ok(metaMatch, `${page} must declare a Content-Security-Policy meta tag`);
    const directives = new Map(
      metaMatch[1]
        .split(";")
        .map((directive) => directive.trim())
        .filter(Boolean)
        .map((directive) => {
          const parts = directive.split(/\s+/);
          return [parts[0], parts.slice(1)];
        }),
    );
    assert.deepEqual(directives.get("default-src"), ["'none'"], `${page} default-src`);
    assert.deepEqual(
      directives.get("script-src"),
      ["'self'", "file:", "'unsafe-inline'"],
      `${page} script-src must allow self + file: (packaged) + inline (vite dev)`,
    );
    assert.equal(directives.get("object-src")?.[0], "'none'", `${page} object-src`);
    assert.equal(directives.get("base-uri")?.[0], "'none'", `${page} base-uri`);
    assert.equal(directives.get("form-action")?.[0], "'none'", `${page} form-action`);
    // 收紧回归守护：辅助窗无远端取数面，connect-src 不得含 http/https；无 <webview> 故无 frame-src。
    const connectSrc = directives.get("connect-src") ?? [];
    assert.ok(!connectSrc.includes("http:"), `${page} connect-src must not widen to http:`);
    assert.ok(!connectSrc.includes("https:"), `${page} connect-src must not widen to https:`);
    assert.ok(connectSrc.includes("ws:"), `${page} connect-src must keep ws: for dev HMR`);
    assert.equal(directives.get("frame-src"), undefined, `${page} must not declare frame-src`);
    assert.equal(directives.get("media-src"), undefined, `${page} must not declare media-src`);
    // cua 浮窗图标经 data: URL 推送；resource-manager 渲染 @acode/ui 可能用 data:/blob:。
    assert.ok(
      (directives.get("img-src") ?? []).includes("data:"),
      `${page} img-src must allow data: (icon / ui assets)`,
    );
  }
});

test(
  "openExternal file urls resolve to hardened local paths, never to shell.openExternal",
  { skip: WIN32_ONLY },
  async () => {
  const helpers = await loadMain("desktopMainIpcHelpers", {
    electron: { shell: {} },
  });
  const { resolveLocalFileUrlTarget } = helpers;

  // 裸 Windows 路径经 WHATWG 解析是 opaque `c:` 协议、不是 file:——现状 allowlist 本就拒绝
  // （OpenSplitButton 的本地文件「外部打开」因此在现状下不可达，属既有缺口，移交报告记录）。
  // 转换器保持只接受真正的 file: URL，不放宽新能力。
  assert.equal(resolveLocalFileUrlTarget(String.raw`C:\Users\x\report.html`), null);
  assert.equal(resolveLocalFileUrlTarget("file:///C:/x/y.html"), "C:\\x\\y.html");
  assert.equal(resolveLocalFileUrlTarget("file://localhost/C:/x.txt"), "C:\\x.txt");
  // UNC / 非 file: / 解析失败一律拒绝
  assert.equal(resolveLocalFileUrlTarget("file://server/share/evil.hta"), null);
  assert.equal(resolveLocalFileUrlTarget("https://example.com/a.html"), null);
  assert.equal(resolveLocalFileUrlTarget("not a url"), null);
  assert.equal(resolveLocalFileUrlTarget(""), null);

  // IPC 层接线：file: 分支不再出现对 shell.openExternal 的调用
  const remoteSource = await readSource("src/main/desktopMainIpcRemote.ts");
  assert.ok(
    remoteSource.includes("resolveLocalFileUrlTarget"),
    "OpenExternal handler must route file: urls through the hardened resolver",
  );
});

test("electron fuses keep agent-runtime fuses on and enable asar protections per platform", async () => {
  const { resolveDesktopElectronFuses, shouldRefreshAsarIntegrity, DESKTOP_ELECTRON_FUSES_DOC } =
    await import(new URL("scripts/desktop-electron-fuses.mjs", root).href);

  const winFuses = resolveDesktopElectronFuses({ platformOs: "win32", macSigningEnabled: false });
  assert.deepEqual(winFuses, {
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
  });

  const macSignedFuses = resolveDesktopElectronFuses({ platformOs: "darwin", macSigningEnabled: true });
  assert.deepEqual(macSignedFuses, {
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
  });

  // macOS 未签名包不能开 asar 完整性（依赖代码签名），否则启动即失败
  const macUnsignedFuses = resolveDesktopElectronFuses({ platformOs: "darwin", macSigningEnabled: false });
  assert.deepEqual(macUnsignedFuses, { onlyLoadAppFromAsar: true });

  // linux 不支持 asar 完整性校验
  const linuxFuses = resolveDesktopElectronFuses({ platformOs: "linux", macSigningEnabled: false });
  assert.deepEqual(linuxFuses, { onlyLoadAppFromAsar: true });

  // 与计划的偏离（specs/electron-hardening.md §5）：这两个 fuse 必须保持默认开启，
  // 否则打包版 agent（ELECTRON_RUN_AS_NODE=1 + NODE_EXTRA_CA_CERTS）会直接失效。
  for (const fuses of [winFuses, macSignedFuses, macUnsignedFuses, linuxFuses]) {
    assert.equal("runAsNode" in fuses, false, "runAsNode must stay at default (true)");
    assert.equal(
      "enableNodeOptionsEnvironmentVariable" in fuses,
      false,
      "enableNodeOptionsEnvironmentVariable must stay at default (true)",
    );
  }
  assert.deepEqual(DESKTOP_ELECTRON_FUSES_DOC.blockedByAgentRuntime, [
    "runAsNode",
    "enableNodeOptionsEnvironmentVariable",
  ]);

  assert.equal(shouldRefreshAsarIntegrity(winFuses), true);
  assert.equal(shouldRefreshAsarIntegrity(linuxFuses), false);
});

test("electron-builder config wires electronFuses and refreshes asar integrity after rewrites", async () => {
  const configSource = await readSource("electron-builder.config.js");
  assert.ok(
    /electronFuses:\s*desktopElectronFuses/.test(configSource),
    "electronFuses must be wired from the pure resolver",
  );
  assert.ok(
    configSource.includes("resolveDesktopElectronFuses"),
    "config must import the fuse resolver",
  );
  assert.ok(
    configSource.includes("afterPack:refreshPackagedAsarIntegrity"),
    "afterPack must refresh asar integrity after app.asar rewrites",
  );
  // 完整性刷新必须发生在 app.asar 重写（sourcemap 清理）之后
  const stripIndex = configSource.indexOf("afterPack:stripPackagedSourcemapReferences");
  const refreshIndex = configSource.indexOf("afterPack:refreshPackagedAsarIntegrity");
  assert.ok(stripIndex >= 0 && refreshIndex > stripIndex, "integrity refresh must run after asar rewrites");

  const { buildWindowsIntegrityResourceList, buildMacIntegrityPlistObject } = await import(
    new URL("scripts/desktop-asar-integrity-refresh.mjs", root).href
  );
  const integrity = { "resources/app.asar": { algorithm: "SHA256", hash: "abc123" } };
  assert.deepEqual(buildWindowsIntegrityResourceList(integrity), [
    { file: "resources\\app.asar", alg: "SHA256", value: "abc123" },
  ]);
  assert.deepEqual(buildMacIntegrityPlistObject({ "Resources/app.asar": { algorithm: "SHA256", hash: "def456" } }), {
    "Resources/app.asar": { algorithm: "SHA256", hash: "def456" },
  });
});

test("chrome elevated decryption is decided by main, ignoring renderer payload", async () => {
  const { resolveElevatedChromeDecryptionAuthorization, registerBrowserDataIpcHandlers } =
    await loadMain("desktopBrowserDataIpc", {
      electron: { BrowserWindow: {}, dialog: {}, ipcMain: { handle() {} } },
      "@acode/shared": {
        PlatformChannels: new Proxy({}, { get: (_, key) => String(key) }),
      },
      "./browserDataManager.js": {
        importChromeBrowserData: async () => ({}),
        clearEmbeddedBrowserData: async () => ({}),
      },
      "./chromeProfileDiscovery.js": {
        discoverChromeProfile: async () => ({ success: false, error: "chrome_profile_not_found" }),
      },
      "./chromeCookieManager.js": {
        hasAppBoundEncryptedCookies: async () => null,
      },
    });

  // 判定真值表：win32 + 嗅探确认 v20 + 用户确认 才放行
  assert.equal(
    resolveElevatedChromeDecryptionAuthorization({
      platform: "win32",
      appBoundCookieRowsPresent: true,
      userConfirmed: true,
    }),
    true,
  );
  assert.equal(
    resolveElevatedChromeDecryptionAuthorization({
      platform: "win32",
      appBoundCookieRowsPresent: null,
      userConfirmed: true,
    }),
    false,
    "unknown sniff result must fail closed",
  );
  assert.equal(
    resolveElevatedChromeDecryptionAuthorization({
      platform: "win32",
      appBoundCookieRowsPresent: true,
      userConfirmed: false,
    }),
    false,
  );
  assert.equal(
    resolveElevatedChromeDecryptionAuthorization({
      platform: "darwin",
      appBoundCookieRowsPresent: true,
      userConfirmed: true,
    }),
    false,
  );

  // IPC 层：renderer 载荷里的 allowElevatedChromeDecryption 必须被忽略
  const remoteIpcSource = await readSource("src/main/desktopBrowserDataIpc.ts");
  assert.ok(
    !remoteIpcSource.includes("requested?.allowElevatedChromeDecryption"),
    "IPC payload field must no longer be read as authorization",
  );
  assert.equal(typeof registerBrowserDataIpcHandlers, "function");
});

test("chrome import flow asks the user only after an app-bound sniff hit", { skip: WIN32_ONLY }, async () => {
  const handlers = new Map();
  let dialogOptions = null;
  let sniffCalls = 0;
  const importCalls = [];
  const electronStub = {
    BrowserWindow: { fromWebContents: () => null },
    dialog: {
      showMessageBox: async (parentOrOptions, maybeOptions) => {
        dialogOptions = maybeOptions ?? parentOrOptions;
        return { response: 0 };
      },
    },
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
  };
  const sharedStub = {
    PlatformChannels: new Proxy(
      {},
      { get: (_, key) => (key === "ImportChromeBrowserData" ? "ImportChromeBrowserData" : String(key)) },
    ),
  };
  const browserDataStub = {
    importChromeBrowserData: async (options) => {
      importCalls.push(options);
      return { success: true };
    },
    clearEmbeddedBrowserData: async () => ({ success: true }),
  };
  const discoveryStub = {
    discoverChromeProfile: async () => ({
      success: true,
      source: { profilePath: "C:\\Users\\x\\AppData\\Chrome\\Default" },
    }),
  };
  const cookieStub = {
    hasAppBoundEncryptedCookies: async () => {
      sniffCalls += 1;
      return true;
    },
  };
  const module = await loadMain("desktopBrowserDataIpc", {
    electron: electronStub,
    "@acode/shared": sharedStub,
    "./browserDataManager.js": browserDataStub,
    "./chromeProfileDiscovery.js": discoveryStub,
    "./chromeCookieManager.js": cookieStub,
  });
  module.registerBrowserDataIpcHandlers(logger);

  // renderer 即使伪造 allowElevatedChromeDecryption: true，也不被采信；
  // 走完整链路：嗅探命中 → 弹确认框 → 用户确认 → 才允许提权。
  await handlers.get("ImportChromeBrowserData")(
    { sender: {} },
    { allowElevatedChromeDecryption: true },
  );
  assert.equal(sniffCalls, 1, "sniff must run before any dialog");
  assert.ok(dialogOptions && dialogOptions.defaultId === 1, "dialog must default to cancel");
  assert.equal(importCalls.length, 1);
  assert.equal(
    importCalls[0].allowElevatedChromeDecryption,
    true,
    "user-confirmed elevation must be allowed",
  );

  // 用户取消：不带提权执行
  electronStub.dialog.showMessageBox = async () => ({ response: 1 });
  await handlers.get("ImportChromeBrowserData")({ sender: {} }, undefined);
  assert.equal(importCalls.length, 2);
  assert.equal(
    importCalls[1].allowElevatedChromeDecryption,
    false,
    "cancelled dialog must not authorize elevation",
  );

  // 嗅探未知（null）：fail-closed，不弹窗、不提权
  cookieStub.hasAppBoundEncryptedCookies = async () => null;
  await handlers.get("ImportChromeBrowserData")({ sender: {} }, undefined);
  assert.equal(importCalls.length, 3);
  assert.equal(
    importCalls[2].allowElevatedChromeDecryption,
    false,
    "unknown sniff must not authorize elevation",
  );
});
