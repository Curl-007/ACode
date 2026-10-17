// 更新门控三件增量 + 网络端点注册表骨架测试
// （spec: packages/desktop/specs/update-gates-endpoint-registry.md 验收节）。
// 模块加载沿用 github-updates.test.mjs 的边界替身惯例：transpile + 注入 import，无真网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { transpileModule, ModuleKind } from "typescript";

const require = createRequire(import.meta.url);

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

const semverImport = { __esModule: true, default: require("semver") };

function createCapturingLogger() {
  const entries = [];
  return {
    entries,
    info: (...args) => entries.push({ level: "info", args }),
    warn: (...args) => entries.push({ level: "warn", args }),
    error: (...args) => entries.push({ level: "error", args }),
    debug: () => {},
  };
}

function gateLogs(logger) {
  return logger.entries
    .filter((entry) => entry.args[0] === "[auto-update] gate")
    .map((entry) => entry.args[1]);
}

const gates = await load("updateGates", { semver: semverImport });

test("gate reason closed set and structured log keys", () => {
  assert.deepEqual(
    [...gates.UPDATE_GATE_REASONS],
    [
      "stale",
      "invalid_feed",
      "invalid_pointer",
      "capped",
      "busy_deferred",
      "install_failed",
      "fetch_failed",
      "disabled_by_policy",
      "not_packaged",
      "already_in_flight",
      "state_conflict",
      "user_skipped_version",
    ],
  );
  const logger = createCapturingLogger();
  // status 是日志上下文保留键：即使调用方误传也必须被剥离，gateReason 是唯一分类键。
  gates.logUpdateGate(logger, "capped", { status: "leaked", cap: "1.2.3" });
  const context = logger.entries[0].args[1];
  assert.equal(context.gateReason, "capped");
  assert.equal(context.cap, "1.2.3");
  assert.ok(!("status" in context));
  assert.equal(
    gates.classifyUpdateFailureGateReason("prepare quit and install failed"),
    "install_failed",
  );
  assert.equal(gates.classifyUpdateFailureGateReason("download update failed"), "fetch_failed");
  assert.equal(gates.classifyUpdateFailureGateReason("startup check failed"), "fetch_failed");
});

test("version cap resolution and evaluation", () => {
  // 显式注入打包态生效；env/argv 仅非打包构建生效（P1-7 同哲学）。
  assert.deepEqual(
    gates.resolveUpdateVersionCap({ explicit: "2.5.0", env: {}, argv: [], isPackaged: true }),
    { cap: "2.5.0", invalidValue: null },
  );
  assert.deepEqual(
    gates.resolveUpdateVersionCap({
      env: { ACODE_UPDATE_MAX_VERSION: "3.0.0" },
      argv: [],
      isPackaged: true,
    }),
    { cap: null, invalidValue: null },
  );
  assert.deepEqual(
    gates.resolveUpdateVersionCap({
      env: { ACODE_UPDATE_MAX_VERSION: "3.0.0" },
      argv: [],
      isPackaged: false,
    }),
    { cap: "3.0.0", invalidValue: null },
  );
  assert.deepEqual(
    gates.resolveUpdateVersionCap({ env: {}, argv: ["--acode-update-max-version", "4.1.0"] }),
    { cap: "4.1.0", invalidValue: null },
  );
  // 非法 cap 不丢弃：invalidValue 交由判定层 fail-closed。
  assert.deepEqual(
    gates.resolveUpdateVersionCap({ explicit: "not-a-version", env: {}, argv: [] }),
    { cap: null, invalidValue: "not-a-version" },
  );

  const none = { cap: null, invalidValue: null };
  assert.equal(
    gates.evaluateCurrentVersionCap({ cap: none, currentVersion: "9.9.9" }).gated,
    false,
  );
  const cap = { cap: "2.0.0", invalidValue: null };
  assert.deepEqual(gates.evaluateCurrentVersionCap({ cap, currentVersion: "2.0.0" }), {
    gated: true,
    detail: "current_at_or_above_cap",
  });
  assert.equal(
    gates.evaluateCurrentVersionCap({ cap, currentVersion: "2.1.0" }).detail,
    "current_at_or_above_cap",
  );
  assert.equal(gates.evaluateCurrentVersionCap({ cap, currentVersion: "1.9.9" }).gated, false);
  assert.deepEqual(gates.evaluateCurrentVersionCap({ cap, currentVersion: "bogus" }), {
    gated: true,
    detail: "version_unparseable",
  });
  assert.deepEqual(
    gates.evaluateCurrentVersionCap({
      cap: { cap: null, invalidValue: "x" },
      currentVersion: "1.0.0",
    }),
    { gated: true, detail: "cap_invalid" },
  );
  assert.deepEqual(gates.evaluateCandidateVersionCap({ cap, candidateVersion: "2.0.1" }), {
    gated: true,
    detail: "candidate_above_cap",
  });
  assert.equal(gates.evaluateCandidateVersionCap({ cap, candidateVersion: "2.0.0" }).gated, false);
  assert.equal(gates.evaluateCandidateVersionCap({ cap, candidateVersion: "1.0.0" }).gated, false);

  assert.equal(gates.validateCustomUpdateFeedPointer("https://example.invalid/feed/"), true);
  assert.equal(gates.validateCustomUpdateFeedPointer("not a url"), false);
  assert.equal(gates.validateCustomUpdateFeedPointer("ftp://example.invalid/"), false);
});

test("busy deferral tracker joint signals and thresholds", () => {
  let nowMs = 1_000_000;
  const signals = { focused: true, idleSeconds: 0, agentSessions: 0 };
  const tracker = gates.createUpdateBusyDeferralTracker({
    signals: {
      hasFocusedWindow: () => signals.focused,
      getSystemIdleSeconds: () => signals.idleSeconds,
      getRunningAgentSessionCount: () => signals.agentSessions,
    },
    now: () => nowMs,
  });

  // 聚焦且无空闲 → 延迟；首次采样带 firstSighting（结构化日志只记这一条）。
  let decision = tracker.sample();
  assert.deepEqual(
    { defer: decision.defer, firstSighting: decision.firstSighting },
    { defer: true, firstSighting: true },
  );
  nowMs += 60_000;
  decision = tracker.sample();
  assert.equal(decision.defer, true);
  assert.equal(decision.firstSighting, false);
  assert.equal(decision.busyMinutes, 1);

  // 系统空闲 ≥300s 且无 agent 会话 → 安静恢复放行。
  nowMs += 60_000;
  signals.focused = false;
  signals.idleSeconds = 300;
  decision = tracker.sample();
  assert.equal(decision.defer, false);
  assert.equal(decision.quietAfterBusy, true);

  // agent 会话活跃时即使空闲/失焦也视为忙（更新安装避开 agent 活跃期）。
  tracker.reset();
  nowMs += 60_000;
  signals.agentSessions = 2;
  decision = tracker.sample();
  assert.equal(decision.defer, true);
  assert.equal(decision.firstSighting, true);

  // 失焦（无 agent）持续 ≥30s 也算安静。
  nowMs += 30_000;
  signals.agentSessions = 0;
  signals.idleSeconds = 0;
  decision = tracker.sample();
  assert.equal(decision.defer, false);

  // 忙碌累计满 2h 强制检查；间隔 >45min 不累计。
  tracker.reset();
  signals.focused = true;
  signals.idleSeconds = 0;
  tracker.sample();
  nowMs += 46 * 60 * 1000; // 超过 45min 间隔窗：休眠/挂起不算忙碌累计
  decision = tracker.sample();
  assert.equal(decision.defer, true);
  assert.equal(decision.busyMinutes, 0);
  nowMs += 121 * 60 * 1000; // 连续忙碌跨过 2h（两次采样间隔均 >45min 会清零累计——
  // 这里按 20min 步进模拟连续在场）
  tracker.reset();
  nowMs = 1_000_000;
  tracker.sample();
  for (let step = 0; step < 7; step += 1) {
    nowMs += 20 * 60 * 1000;
    decision = tracker.sample();
  }
  assert.equal(decision.defer, false);
  assert.equal(decision.forcedAfterBusy, true);
  assert.ok(decision.busyMinutes >= 120);
});

const registry = await load("networkEndpointRegistry", {});

test("endpoint registry lookup by host and path shapes", () => {
  // 调用方传 pathname（query 在 desktopNetworkPolicy 解析层剥离）；注册表层做前缀匹配。
  assert.deepEqual(
    registry.lookupNetworkEndpointRegistration("api.github.com", "/repos/Curl-007/ACode/releases"),
    {
      usageId: "update-feed",
      labelKey: "networkEndpoint.usage.updateFeed.label",
      purposeKey: "networkEndpoint.purpose.updateFeedCheck",
      origin: "main",
    },
  );
  const download = registry.lookupNetworkEndpointRegistration(
    "github.com",
    "/Curl-007/ACode/releases/download/v1.0.0/app.exe",
  );
  assert.equal(download?.usageId, "update-feed");
  assert.equal(download?.followRedirects, true);
  assert.equal(
    registry.lookupNetworkEndpointRegistration("github.com", "/Curl-007/ACode/issues"),
    null,
  );
  const cdnPlugin = registry.lookupNetworkEndpointRegistration(
    "cdn-zcode.z.ai",
    "/zcode/official-plugin/marketplace.json",
  );
  assert.equal(cdnPlugin?.usageId, "official-plugin-cdn");
  assert.equal(cdnPlugin?.origin, "subprocess");
  assert.equal(cdnPlugin?.toggleKey, "officialServices.marketplace");
  const cdnAssets = registry.lookupNetworkEndpointRegistration(
    "CDN-Zcode.Z.AI.",
    "/zcode/electron/releases/1.2.3/manifest.json",
  );
  assert.equal(cdnAssets?.origin, "main", "host 大小写/尾点归一");
  assert.equal(
    registry.lookupNetworkEndpointRegistration("zcode.z.ai", "/api/v1/plugin/list")?.usageId,
    "official-plugin-cdn",
  );
  assert.equal(
    registry.lookupNetworkEndpointRegistration("api.z.ai", "/api/oauth/authorize")?.origin,
    "renderer",
  );
  assert.equal(registry.lookupNetworkEndpointRegistration("evil.example", "/"), null);
  assert.ok(
    registry.getNetworkEndpointRegistry().some((usage) => usage.id === "provider-api"),
    "provider API 动态基址类别条目在表（endpoints 空，仅盘点）",
  );
});

test("endpoint registry fail-closed on build failure", () => {
  const logger = createCapturingLogger();
  registry.resetNetworkEndpointRegistryForTest(() => {
    throw new Error("boom");
  });
  assert.equal(
    registry.lookupNetworkEndpointRegistration("api.github.com", "/repos", logger),
    null,
  );
  assert.equal(registry.isNetworkEndpointRegistryLoadFailed(), true);
  assert.ok(
    logger.entries.some(
      (entry) => entry.level === "warn" && /registry build failed/.test(String(entry.args[0])),
    ),
    "构建失败必须 warn 一次",
  );
  registry.resetNetworkEndpointRegistryForTest(null);
  assert.equal(registry.isNetworkEndpointRegistryLoadFailed(), false);
  assert.ok(
    registry.lookupNetworkEndpointRegistration("api.github.com", "/repos/Curl-007/ACode/releases"),
  );
});

const networkPolicy = await load("desktopNetworkPolicy", {
  "node:crypto": require("node:crypto"),
  "node:fs": require("node:fs"),
  "./browserDataManager.js": { EMBEDDED_BROWSER_PARTITION: "persist:embedded-browser" },
  "./networkEndpointRegistry.js": registry,
});

test("network policy lookup and unregistered egress diagnostics (warn-only)", () => {
  const logger = createCapturingLogger();
  const registered = networkPolicy.lookupRegisteredNetworkEndpoint(
    "https://api.github.com/repos/Curl-007/ACode/releases/latest?x=1",
  );
  assert.equal(registered?.usageId, "update-feed");
  assert.equal(networkPolicy.lookupRegisteredNetworkEndpoint("not a url"), null);
  // 日志描述不落 query（可能带 token）。
  assert.equal(
    networkPolicy.describeEgressUrlForLog("https://api.example/path?token=secret"),
    "api.example/path",
  );

  networkPolicy.resetNetworkEgressDiagnosticsForTest();
  networkPolicy.diagnoseUnregisteredEgress("https://unregistered.example/a?token=1", {
    origin: "renderer",
    logger,
  });
  networkPolicy.diagnoseUnregisteredEgress("https://unregistered.example/b", {
    origin: "renderer",
    logger,
  });
  const warns = logger.entries.filter((entry) => entry.level === "warn");
  assert.equal(warns.length, 1, "同 host+origin 去重只 warn 一次");
  assert.match(warns[0].args[0], /unregistered egress \(warn-only, not blocked\)/);
  assert.ok(!/token=1/.test(warns[0].args[0]), "诊断日志不得携带 query");
  networkPolicy.diagnoseUnregisteredEgress("https://unregistered.example/a", {
    origin: "main",
    logger,
  });
  assert.equal(
    logger.entries.filter((entry) => entry.level === "warn").length,
    2,
    "不同 origin 分别 warn",
  );
  const before = logger.entries.length;
  networkPolicy.diagnoseUnregisteredEgress("https://api.z.ai/api/oauth", {
    origin: "renderer",
    logger,
  });
  assert.equal(logger.entries.length, before, "已登记端点不产生诊断日志");

  const observer = networkPolicy.createEgressDiagnosticsObserver(logger, "renderer");
  observer({ url: "https://another-unregistered.example/x" });
  assert.ok(
    logger.entries.some((entry) => /another-unregistered\.example/.test(String(entry.args[0]))),
  );
  observer({ url: "%%invalid%%" }); // 观察者自身不得抛出
});

async function loadAutoUpdaterModule({ appVersion = "1.0.0", logger } = {}) {
  const updater = new EventEmitter();
  const state = { checks: 0, downloads: 0, installs: 0, configured: undefined };
  updater.setFeedURL = (value) => {
    state.configured = value;
  };
  updater.checkForUpdates = async () => {
    state.checks++;
    updater.emit("checking-for-update");
  };
  updater.downloadUpdate = async () => {
    state.downloads++;
  };
  updater.quitAndInstall = () => {
    state.installs++;
  };
  const handlers = new Map();
  const sent = [];
  const win = {
    isDestroyed: () => false,
    webContents: { id: 1, send: (...args) => sent.push(args) },
  };
  // ipcMain.handle 同步段计时包装（W1-6 接线）：注入真实 ipcSyncTiming（纯 Node，无 electron 依赖）。
  const ipcSyncTimingModule = await load("ipcSyncTiming", {});
  const module = await load("autoUpdater", {
    electron: {
      app: { isPackaged: true, getVersion: () => appVersion },
      BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win },
      Menu: { getApplicationMenu: () => null },
      powerMonitor: { getSystemIdleTime: () => 0 },
      ipcMain: { handle: (key, fn) => handlers.set(key, fn), on() {} },
    },
    "@acode/shared": {
      DEFAULT_LOCALE: "en-US",
      ACODE_VERSION: appVersion,
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
    semver: semverImport,
    "./ipcSyncTiming.js": ipcSyncTimingModule,
    "./logger.js": { logger },
    "./updateGates.js": gates,
  });
  return { module, updater, state, handlers, sent, win };
}

const tick = () => new Promise(setImmediate);

test("autoUpdater: current version at cap blocks startup and manual checks", async () => {
  const logger = createCapturingLogger();
  const { module, state, sent, win } = await loadAutoUpdaterModule({ appVersion: "2.0.0", logger });
  await module.initAutoUpdater({ updateGates: { maxVersion: "2.0.0" } });
  await tick();
  assert.equal(state.checks, 0, "当前版≥cap 不得发起检查");
  assert.ok(
    gateLogs(logger).some(
      (context) => context.gateReason === "capped" && context.detail === "current_at_or_above_cap",
    ),
  );
  module.checkForUpdateMenuClick(win);
  await tick();
  assert.equal(state.checks, 0, "手动检查同受 cap 约束");
  const result = sent.find((args) => args[0] === "UpdateCheckResult");
  assert.deepEqual(result[1], { kind: "up-to-date", currentVersion: "2.0.0" });
});

test("autoUpdater: candidate above cap is ignored and gated", async () => {
  const logger = createCapturingLogger();
  const { module, updater, state } = await loadAutoUpdaterModule({ appVersion: "1.0.0", logger });
  await module.initAutoUpdater({ updateGates: { maxVersion: "1.5.0" } });
  await tick();
  assert.equal(state.checks, 1, "当前版低于 cap，检查放行");
  updater.emit("update-available", { version: "2.0.0" });
  await tick();
  await tick();
  assert.equal(module.getAutoUpdaterState().kind, "idle", "超 cap 候选不得进入可更新状态");
  assert.ok(
    gateLogs(logger).some(
      (context) => context.gateReason === "capped" && context.detail === "candidate_above_cap",
    ),
  );
});

test("autoUpdater: host busy defers background check, manual check still runs", async () => {
  const logger = createCapturingLogger();
  const { module, state, win } = await loadAutoUpdaterModule({ logger });
  await module.initAutoUpdater({
    hostBusySignals: {
      hasFocusedWindow: () => true,
      getSystemIdleSeconds: () => 0,
      getRunningAgentSessionCount: () => 1,
    },
  });
  await tick();
  assert.equal(state.checks, 0, "宿主忙碌时后台启动检查被推迟");
  const busyLogs = gateLogs(logger).filter((context) => context.gateReason === "busy_deferred");
  assert.equal(busyLogs.length, 1, "延迟 episode 只记一条结构化 busy_deferred");
  assert.match(busyLogs[0].detail, /host busy/i);
  module.checkForUpdateMenuClick(win);
  await tick();
  assert.equal(state.checks, 1, "手动检查是用户显式意图，不进忙碌门");
});

test("autoUpdater: update-install shutdown segment runs before prepare and install", async () => {
  const logger = createCapturingLogger();
  const { module, updater, handlers, state } = await loadAutoUpdaterModule({ logger });
  const calls = [];
  await module.initAutoUpdater({
    onBeforeQuitAndInstall: async () => {
      calls.push("prepare");
    },
    shutdownRunner: {
      runShutdown: async (kind, options) => {
        calls.push(kind);
        assert.equal(options?.reason, "auto-update quitAndInstall");
      },
    },
  });
  await tick();
  updater.emit("update-downloaded", { version: "2.0.0" });
  await tick();
  await handlers.get("QuitAndInstallUpdate")();
  // 顺序契约：update-install 段（best-effort flush）→ 退出准备（文件锁硬前置）→ 安装器。
  assert.deepEqual(calls, ["update-install", "prepare"]);
  assert.equal(state.installs, 1);
});

test("autoUpdater: update-install shutdown failure warns but does not block install", async () => {
  const logger = createCapturingLogger();
  const { module, updater, handlers, state } = await loadAutoUpdaterModule({ logger });
  let prepared = 0;
  await module.initAutoUpdater({
    onBeforeQuitAndInstall: async () => {
      prepared++;
    },
    shutdownRunner: {
      runShutdown: async () => {
        throw new Error("flush failed");
      },
    },
  });
  await tick();
  updater.emit("update-downloaded", { version: "2.0.0" });
  await tick();
  await handlers.get("QuitAndInstallUpdate")();
  assert.equal(prepared, 1);
  assert.equal(state.installs, 1);
  assert.ok(
    logger.entries.some(
      (entry) =>
        entry.level === "warn" &&
        /update-install shutdown segment failed/.test(String(entry.args[0])),
    ),
  );
});

test("autoUpdater: invalid dev feed pointer gates checks with invalid_pointer", async () => {
  const logger = createCapturingLogger();
  const { module, state, sent, win } = await loadAutoUpdaterModule({ logger });
  await module.initAutoUpdater({ updateFeedSource: { url: "not a url" } });
  await tick();
  assert.equal(state.checks, 0);
  assert.ok(gateLogs(logger).some((context) => context.gateReason === "invalid_pointer"));
  module.checkForUpdateMenuClick(win);
  await tick();
  assert.equal(state.checks, 0);
  const result = sent.find((args) => args[0] === "UpdateCheckResult");
  assert.equal(result[1].kind, "error");
});
