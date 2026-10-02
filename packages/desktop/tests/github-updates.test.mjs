import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { transpileModule, ModuleKind } from "typescript";

const require = createRequire(import.meta.url);
const feed = "https://github.com/Curl-007/ACode/releases/latest/download/";
async function load(relative, imports = {}) {
  const source = await readFile(new URL(`../src/main/${relative}.ts`, import.meta.url), "utf8");
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => {
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}
const logger = { info() {}, warn() {}, error() {}, debug() {} };

test("update modules have no official endpoint or custom manifest dependency", async () => {
  for (const name of ["autoUpdater", "forceUpdateGuard"]) {
    const source = await readFile(new URL(`../src/main/${name}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /DEFAULT_ACODE_ENDPOINT_ORIGIN|resolveRuntimeACodeEndpointOrigin|manifestUpdateProvider|zcode\.z\.ai|\/api\/v1\/client\/configs/,
    );
  }
});

test("force guard never fetches, blocks or invokes callbacks", async () => {
  const guard = await load("forceUpdateGuard");
  const unexpected = () => assert.fail("force update must have no side effects");
  assert.deepEqual(
    await guard.maybeBlockStartupForForceUpdate({
      locale: "en-US",
      logger,
      fetchRemoteConfig: unexpected,
      requestAutoUpdate: unexpected,
      onBlocked: unexpected,
    }),
    { blocked: false },
  );
});

test("github feed, overrides, manual check and native download/install remain wired", async () => {
  const updater = new EventEmitter();
  let checks = 0,
    downloads = 0,
    installs = 0,
    preparation = 0,
    configured;
  updater.setFeedURL = (value) => {
    configured = value;
  };
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit("checking-for-update");
    updater.emit("update-not-available", { version: "1.0.0" });
  };
  updater.downloadUpdate = async () => {
    downloads++;
  };
  updater.quitAndInstall = () => {
    installs++;
  };
  const handlers = new Map();
  const sent = [];
  const win = {
    isDestroyed: () => false,
    webContents: { id: 1, send: (...args) => sent.push(args) },
  };
  const module = await load("autoUpdater", {
    electron: {
      app: { isPackaged: true, getVersion: () => "1.0.0" },
      BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win },
      Menu: { getApplicationMenu: () => null },
      ipcMain: { handle: (key, fn) => handlers.set(key, fn), on() {} },
    },
    "@acode/shared": {
      DEFAULT_LOCALE: "en-US",
      ACODE_VERSION: "1.0.0",
      PlatformChannels: new Proxy({}, { get: (_, key) => key }),
      desktopMenuMessageIds: {},
      getDesktopMenuMessage: () => "",
      formatDesktopMenuMessage: () => "",
    },
    "electron-updater": {
      __esModule: true,
      default: { autoUpdater: updater },
      CancellationToken: class {
        dispose() {}
      },
    },
    semver: { __esModule: true, default: require("semver") },
    "./logger.js": { logger },
  });
  assert.deepEqual(
    module.resolveUpdateFeedSourceFromStartupConfig({
      argv: [],
      env: { ACODE_UPDATE_FEED_URL: "https://example.invalid/feed/" },
    }),
    { url: "https://example.invalid/feed/" },
  );
  for (const argv of [
    ["--acode-update-feed-url=https://example.invalid/cli/"],
    ["--acode-update-feed-url", "https://example.invalid/cli/"],
  ]) {
    assert.deepEqual(
      module.resolveUpdateFeedSourceFromStartupConfig({
        argv,
        env: { ACODE_UPDATE_FEED_URL: feed },
      }),
      { url: "https://example.invalid/cli/" },
    );
  }
  // P1-7：打包发行版（isPackaged:true）必须忽略 env 与 argv 两个更新源覆盖入口，
  // 与 NOTICE.md / NOTICE.zh-CN.md「打包版会忽略 ACODE_UPDATE_FEED_URL 及 --acode-update-feed-url」
  // 的承诺一致。此前代码无条件读取 env/argv，文档与代码矛盾。
  for (const isPackaged of [true, undefined, false]) {
    const expectOverride = isPackaged !== true;
    for (const argv of [
      [],
      ["--acode-update-feed-url=https://example.invalid/cli/"],
    ]) {
      const resolved = module.resolveUpdateFeedSourceFromStartupConfig({
        argv,
        env: { ACODE_UPDATE_FEED_URL: "https://example.invalid/feed/" },
        isPackaged,
      });
      if (expectOverride) {
        assert.ok(
          resolved && typeof resolved.url === "string" && resolved.url.startsWith("https://example.invalid/"),
          `dev build (isPackaged=${isPackaged}) must still honor the override, got ${JSON.stringify(resolved)}`,
        );
      } else {
        assert.equal(
          resolved,
          undefined,
          "packaged build must ignore env/argv update-feed override (P1-7)",
        );
      }
    }
  }
  await module.initAutoUpdater({
    onBeforeQuitAndInstall: async () => {
      preparation++;
    },
  });
  await new Promise(setImmediate);
  assert.equal(configured.provider, "github");
  assert.equal(configured.owner, "Curl-007");
  assert.equal(configured.repo, "ACode");
  assert.equal(updater.allowPrerelease, true);
  assert.equal(checks, 1);
  module.refreshAutoUpdaterReleaseChannel(true);
  assert.equal(checks, 1);
  module.requestForceAutoUpdate(() => assert.fail("no callback"))();
  assert.equal(checks, 1);
  module.checkForUpdateMenuClick(win);
  await new Promise(setImmediate);
  assert.equal(checks, 2);
  updater.emit("update-available", { version: "2.0.0" });
  await new Promise(setImmediate);
  assert.equal(module.getAutoUpdaterState().kind, "update-available");
  await handlers.get("DownloadUpdate")();
  assert.equal(downloads, 1);
  updater.emit("update-downloaded", { version: "2.0.0" });
  await new Promise(setImmediate);
  assert.equal(module.getAutoUpdaterState().kind, "update-downloaded");
  await handlers.get("QuitAndInstallUpdate")();
  assert.equal(preparation, 1);
  assert.equal(installs, 1);
  assert.ok(sent.length > 0);
  await module.initAutoUpdater({ updateFeedSource: { url: "https://example.invalid/custom/" } });
  assert.equal(configured.url, "https://example.invalid/custom/");
  await module.initAutoUpdater({ enabled: false });
});

test("built-in provider reads platform YAML and resolves release assets", async () => {
  const { GenericProvider } = require("electron-updater/out/providers/GenericProvider.js");
  for (const [platform, suffix] of [
    ["darwin", "-mac"],
    ["win32", ""],
    ["linux", `-linux${process.arch === "x64" ? "" : `-${process.arch}`}`],
  ]) {
    let requested;
    const provider = new GenericProvider(
      { provider: "generic", url: feed, channel: "latest" },
      { isAddNoCacheQuery: false },
      {
        platform,
        executor: {
          request: async (options) => {
            requested = `https://${options.hostname}${options.path}`;
            return "version: 2.0.0\nfiles:\n  - url: app.zip\n    sha512: test-checksum\n";
          },
        },
      },
    );
    const info = await provider.getLatestVersion();
    assert.equal(requested, `${feed}latest${suffix}.yml`);
    assert.equal(provider.resolveFiles(info)[0].url.href, `${feed}app.zip`);
  }
});
