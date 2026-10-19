// 更新交接账本/启动验证/残留清扫测试（specs/updater-journal-recovery.md 验收场景）。
// 覆盖：journal 原子写与崩溃一致性、代数截断、幂等边界、前向兼容兜底（未知字段/
// 未知枚举/畸形 JSON）、启动恢复事故指纹（交接了但版本没变——2026-10-18 R19 事故
// 形态）、启动验证双路径、清扫决策表（完整保留/部分清除/占用跳过/过期收敛）。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const logger = { info() {}, warn() {}, error() {}, debug() {} };
// updaterJournal.ts 的 schema/解析面拆分件（400 行 ratchet）；替身加载器白名单
// 需要显式登记该运行时 import。纯模块，无自身依赖。
const journalFormatModule = await load("updaterJournalFormat", {});
const nodeFsPromises = require("node:fs/promises");
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeCrypto = require("node:crypto");

function sha512Of(text) {
  return createHash("sha512").update(text).digest("hex");
}

/** 内存 fs 替身：记录 temp+rename 时序，可注入 rename 失败。 */
function memoryFs() {
  const files = new Map();
  const calls = { writeFile: [], rename: [], rm: [], mkdir: [] };
  let failRename = false;
  return {
    files,
    calls,
    setFailRename(value) {
      failRename = value;
    },
    impl: {
      readFile: async (path) => {
        if (!files.has(path)) {
          const error = new Error("ENOENT");
          error.code = "ENOENT";
          throw error;
        }
        return files.get(path);
      },
      writeFile: async (path, data) => {
        calls.writeFile.push(path);
        files.set(path, data);
      },
      rename: async (from, to) => {
        calls.rename.push([from, to]);
        if (failRename) {
          throw new Error("EPERM: rename blocked");
        }
        files.set(to, files.get(from));
        files.delete(from);
      },
      rm: async (path) => {
        calls.rm.push(path);
        files.delete(path);
      },
      mkdir: async (path) => {
        calls.mkdir.push(path);
      },
    },
  };
}

// ———————————————————— journal 模块 ————————————————————

test("journal append persists via temp+rename atomically and reads back", async () => {
  const { createUpdateJournalStore } = await load("updaterJournal", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
  });
  const mem = memoryFs();
  const store = createUpdateJournalStore({
    filePath: join(tmpdir(), "journal-test", "update-journal.json"),
    logger,
    fs: mem.impl,
  });
  const generation = await store.appendHandoff({
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    installerPath: "/pending/ACode-2.0.0.exe",
    installerFileName: "ACode-2.0.0.exe",
    sha512: sha512Of("installer"),
    size: 9,
    pendingReleaseName: "Release v2.0.0",
    channel: "stable",
    platform: "win32",
  });
  assert.equal(generation, 1);
  // 崩溃一致性时序：temp 写入 → rename 到终路径（spec R1）。
  assert.equal(mem.calls.writeFile.length, 1);
  assert.match(mem.calls.writeFile[0], /\.tmp$/);
  assert.deepEqual(mem.calls.rename[0], [mem.calls.writeFile[0], join(tmpdir(), "journal-test", "update-journal.json")]);
  const raw = JSON.parse(mem.files.get(join(tmpdir(), "journal-test", "update-journal.json")));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0].outcome, "handed-off");
  assert.equal(raw.entries[0].exitSweepHandoff, "pending");
  assert.equal(raw.entries[0].sha512, sha512Of("installer"));
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
});

test("journal rename failure degrades to direct write (best-effort persistence)", async () => {
  const { createUpdateJournalStore } = await load("updaterJournal", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
  });
  const mem = memoryFs();
  mem.setFailRename(true);
  const filePath = "/x/update-journal.json";
  const store = createUpdateJournalStore({ filePath, logger, fs: mem.impl });
  await store.appendHandoff({
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    installerPath: null,
    installerFileName: null,
    sha512: null,
    size: null,
    pendingReleaseName: null,
    channel: null,
    platform: null,
  });
  const raw = JSON.parse(mem.files.get(filePath));
  assert.equal(raw.entries.length, 1);
  // 降级直写后清理 temp。
  assert.equal(mem.calls.rm.length, 1);
});

test("journal truncates to generation cap and keeps original generations", async () => {
  const { createUpdateJournalStore, UPDATE_JOURNAL_MAX_ENTRIES } = await load("updaterJournal", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
  });
  const mem = memoryFs();
  const store = createUpdateJournalStore({ filePath: "/x/update-journal.json", logger, fs: mem.impl });
  for (let index = 0; index < 10; index += 1) {
    await store.markOutcome(
      await store.appendHandoff({
        fromVersion: `1.${index}.0`,
        toVersion: `1.${index + 1}.0`,
        installerPath: null,
        installerFileName: null,
        sha512: null,
        size: null,
        pendingReleaseName: null,
        channel: null,
        platform: null,
      }),
      "verified",
    );
  }
  const loaded = await store.load();
  assert.equal(loaded.length, UPDATE_JOURNAL_MAX_ENTRIES);
  assert.equal(loaded[0].generation, 10 - UPDATE_JOURNAL_MAX_ENTRIES + 1);
  assert.equal(loaded[loaded.length - 1].generation, 10);
});

test("journal markOutcome is idempotent (only handed-off entries transition)", async () => {
  const { createUpdateJournalStore } = await load("updaterJournal", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
  });
  const mem = memoryFs();
  const store = createUpdateJournalStore({ filePath: "/x/update-journal.json", logger, fs: mem.impl });
  const generation = await store.appendHandoff({
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    installerPath: null,
    installerFileName: null,
    sha512: null,
    size: null,
    pendingReleaseName: null,
    channel: null,
    platform: null,
  });
  await store.markOutcome(generation, "verified");
  const writesAfterFirst = mem.calls.writeFile.length;
  await store.markOutcome(generation, "install-not-effective");
  await store.setExitSweepHandoff(generation, "completed");
  assert.equal(mem.calls.writeFile.length, writesAfterFirst, "second transition must be a no-op");
  const loaded = await store.load();
  assert.equal(loaded[0].outcome, "verified");
});

test("journal append supersedes a lingering handed-off entry (no double open cases)", async () => {
  const { createUpdateJournalStore } = await load("updaterJournal", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
  });
  const mem = memoryFs();
  const store = createUpdateJournalStore({ filePath: "/x/update-journal.json", logger, fs: mem.impl });
  await store.appendHandoff({
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    installerPath: null,
    installerFileName: null,
    sha512: null,
    size: null,
    pendingReleaseName: null,
    channel: null,
    platform: null,
  });
  await store.appendHandoff({
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    installerPath: null,
    installerFileName: null,
    sha512: null,
    size: null,
    pendingReleaseName: null,
    channel: null,
    platform: null,
  });
  const loaded = await store.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].outcome, "install-not-effective", "open case must be closed on append");
  assert.equal(loaded[1].outcome, "handed-off");
});

test("journal forward compatibility: unknown fields/enums tolerated, malformed entries dropped", async () => {
  const { createUpdateJournalStore, deriveStartupRecoveryPlan } = await load("updaterJournal", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
  });
  const filePath = "/x/update-journal.json";
  const mem = memoryFs();
  mem.files.set(
    filePath,
    JSON.stringify({
      version: 99,
      entries: [
        {
          generation: 1,
          fromVersion: "1.0.0",
          toVersion: "2.0.0",
          outcome: "verified",
          handedOffAt: 1,
          exitSweepHandoff: "completed",
          futureField: { nested: true },
        },
        {
          generation: 2,
          fromVersion: "2.0.0",
          toVersion: "3.0.0",
          outcome: "some-future-outcome",
          handedOffAt: 2,
          exitSweepHandoff: "something-new",
        },
        { generation: 3, fromVersion: "not a version", toVersion: "3.0.0", handedOffAt: 3 },
      ],
    }),
  );
  const store = createUpdateJournalStore({ filePath, logger, fs: mem.impl });
  const loaded = await store.load();
  assert.equal(loaded.length, 2, "malformed entry dropped, future-schema version tolerated");
  assert.equal(loaded[0].outcome, "verified");
  assert.equal(loaded[1].outcome, "unknown", "unknown outcome normalized, not rejected");
  assert.equal(loaded[1].exitSweepHandoff, "unknown");
  // 未知 outcome：保守不行动（不触发清理，也不误判事故）。
  const plan = deriveStartupRecoveryPlan(loaded[1], "2.0.0");
  assert.deepEqual(plan, { kind: "none" });
});

test("journal malformed json degrades to null (no-journal path)", async () => {
  const { createUpdateJournalStore } = await load("updaterJournal", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
  });
  const mem = memoryFs();
  const filePath = "/x/update-journal.json";
  mem.files.set(filePath, "{not json");
  const store = createUpdateJournalStore({ filePath, logger, fs: mem.impl });
  assert.equal(await store.load(), null);
});

test("recovery plan matrix: verify / incident-unchanged / diverged / closed", async () => {
  const { deriveStartupRecoveryPlan } = await load("updaterJournal", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
  });
  const entry = (outcome) => ({
    generation: 1,
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    outcome,
    handedOffAt: 1,
    exitSweepHandoff: "completed",
    installerPath: null,
    installerFileName: "setup.exe",
    sha512: null,
    size: null,
    pendingReleaseName: null,
    channel: null,
    platform: null,
    outcomeAt: null,
  });
  assert.equal(deriveStartupRecoveryPlan(entry("handed-off"), "2.0.0").kind, "first-launch-after-update");
  const incident = deriveStartupRecoveryPlan(entry("handed-off"), "1.0.0");
  assert.equal(incident.kind, "install-not-effective");
  assert.equal(incident.fingerprint, "version-unchanged", "this month's incident fingerprint");
  const diverged = deriveStartupRecoveryPlan(entry("handed-off"), "9.9.9");
  assert.equal(diverged.fingerprint, "version-diverged");
  assert.deepEqual(deriveStartupRecoveryPlan(entry("verified"), "1.0.0"), { kind: "none" });
  assert.deepEqual(deriveStartupRecoveryPlan(null, "1.0.0"), { kind: "none" });
});

// ———————————————————— sweep 模块 ————————————————————

let sweepDir;

beforeEach(async () => {
  sweepDir = await mkdtemp(join(tmpdir(), "acode-updater-sweep-"));
});

afterEach(async () => {
  await rm(sweepDir, { recursive: true, force: true });
});

async function seedFile(name, content, mtimeMs) {
  const full = join(sweepDir, name);
  await writeFile(full, content);
  if (mtimeMs !== undefined) {
    await utimes(full, new Date(mtimeMs), new Date(mtimeMs));
  }
  return full;
}

const DAY = 24 * 60 * 60 * 1000;

test("sweep resolves pending dir per platform with yml name and appName fallback", async () => {
  const { resolveUpdaterPendingDir, resolveUpdaterCacheBasePath, parseUpdaterCacheDirName } =
    await load("updaterSweep", {
      "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
      "node:fs": nodeFs,
      "node:path": nodePath,
      "node:crypto": nodeCrypto,
    });
  assert.equal(
    resolveUpdaterCacheBasePath({ platform: "win32", env: { LOCALAPPDATA: "C:\\cache" }, homeDir: "/h" }),
    "C:\\cache",
  );
  assert.equal(
    resolveUpdaterCacheBasePath({ platform: "win32", env: {}, homeDir: "/h" }),
    nodePath.join("/h", "AppData", "Local"),
  );
  assert.equal(
    resolveUpdaterCacheBasePath({ platform: "darwin", env: {}, homeDir: "/h" }),
    nodePath.join("/h", "Library", "Caches"),
  );
  assert.equal(parseUpdaterCacheDirName("updaterCacheDirName: '@acodedesktop-updater'\n"), "@acodedesktop-updater");
  assert.equal(parseUpdaterCacheDirName("other: 1\n"), null);
  const resolved = await resolveUpdaterPendingDir({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\cache" },
    homeDir: "/h",
    isPackaged: true,
    resourcesPath: "/res",
    devAppUpdateConfigPath: null,
    appName: "app",
    readTextFile: async () => "provider: github\nupdaterCacheDirName: my-updater\n",
  });
  assert.equal(resolved, nodePath.join("C:\\cache", "my-updater", "pending"));
  const fallback = await resolveUpdaterPendingDir({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\cache" },
    homeDir: "/h",
    isPackaged: false,
    resourcesPath: null,
    devAppUpdateConfigPath: "/app/dev-app-update.yml",
    appName: "app",
    readTextFile: async () => null,
  });
  assert.equal(fallback, nodePath.join("C:\\cache", "app-updater", "pending"));
});

function sweepLoader() {
  return load("updaterSweep", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
    "node:fs": nodeFs,
    "node:path": nodePath,
    "node:crypto": nodeCrypto,
  });
}

test("sweep keeps valid current-generation installer + update-info, clears corrupt current installer (preserve=true)", async () => {
  const { sweepStaleUpdatePendingArtifacts } = await sweepLoader();
  const good = sha512Of("installer-bytes");
  const setupPath = await seedFile("setup.exe", "installer-bytes");
  await seedFile("update-info.json", "{}");
  const first = await sweepStaleUpdatePendingArtifacts({
    pendingDir: sweepDir,
    now: () => Date.now(),
    currentGeneration: { installerFileName: "setup.exe", sha512: good, size: "installer-bytes".length, preserve: true },
  });
  assert.ok(existsSync(setupPath), "complete pending must be kept for retry");
  assert.ok(existsSync(join(sweepDir, "update-info.json")), "update-info kept for cache-hit retry");
  assert.deepEqual(first.removed, []);
  // 当前代同名安装器 sha512 失配 = 部分/损坏必清（spec R5「部分下载必清」）。
  await writeFile(setupPath, "truncated-partial");
  const second = await sweepStaleUpdatePendingArtifacts({
    pendingDir: sweepDir,
    now: () => Date.now(),
    currentGeneration: { installerFileName: "setup.exe", sha512: good, size: "installer-bytes".length, preserve: true },
  });
  assert.ok(!existsSync(setupPath), "corrupt current-generation installer must be cleared");
  assert.deepEqual(second.removed, ["setup.exe"]);
  // 非当前代的新鲜文件受 1h 新鲜保护窗保护（无账本/误判时的保守下限）。
  await seedFile("other-0.9.0.exe", "whatever");
  const third = await sweepStaleUpdatePendingArtifacts({
    pendingDir: sweepDir,
    now: () => Date.now(),
    currentGeneration: { installerFileName: "setup.exe", sha512: good, size: "installer-bytes".length, preserve: true },
  });
  assert.ok(existsSync(join(sweepDir, "other-0.9.0.exe")), "fresh non-lineage file kept by min keep age");
  assert.deepEqual(third.removed, []);
});

test("sweep clears consumed generation installer regardless of freshness; stale update-info follows age rules", async () => {
  const { sweepStaleUpdatePendingArtifacts } = await sweepLoader();
  await seedFile("setup.exe", "installer-bytes");
  const now = Date.now();
  await seedFile("update-info.json", "{}", now - 2 * 60 * 60 * 1000);
  const summary = await sweepStaleUpdatePendingArtifacts({
    pendingDir: sweepDir,
    now: () => now,
    currentGeneration: { installerFileName: "setup.exe", sha512: null, size: null, preserve: false },
  });
  assert.ok(!existsSync(join(sweepDir, "setup.exe")));
  assert.ok(!existsSync(join(sweepDir, "update-info.json")));
  assert.equal(summary.removed.length, 2);
});

test("sweep removes non-lineage old files, keeps fresh ones (min keep age)", async () => {
  const { sweepStaleUpdatePendingArtifacts } = await sweepLoader();
  const now = Date.now();
  await seedFile("old-setup-0.9.0.exe", "old", now - 2 * 60 * 60 * 1000);
  await seedFile("fresh-setup-0.9.0.exe", "fresh", now - 60 * 1000);
  const summary = await sweepStaleUpdatePendingArtifacts({
    pendingDir: sweepDir,
    now: () => now,
    minKeepAgeMs: 60 * 60 * 1000,
    currentGeneration: { installerFileName: "setup.exe", sha512: null, size: null, preserve: true },
  });
  assert.ok(!existsSync(join(sweepDir, "old-setup-0.9.0.exe")));
  assert.ok(existsSync(join(sweepDir, "fresh-setup-0.9.0.exe")));
  assert.deepEqual(summary.removed, ["old-setup-0.9.0.exe"]);
});

test("sweep skips occupied files (Windows EPERM semantics) for next run", async () => {
  const { sweepStaleUpdatePendingArtifacts } = await sweepLoader();
  const now = Date.now();
  await seedFile("locked-old.exe", "locked", now - 2 * 60 * 60 * 1000);
  const summary = await sweepStaleUpdatePendingArtifacts({
    pendingDir: sweepDir,
    now: () => now,
    currentGeneration: null,
    fs: {
      unlink: async () => {
        const error = new Error("EPERM: file in use");
        error.code = "EPERM";
        throw error;
      },
    },
  });
  assert.ok(existsSync(join(sweepDir, "locked-old.exe")), "occupied file must be skipped, not lost");
  assert.equal(summary.removed.length, 0);
  assert.equal(summary.skipped.length, 1);
  assert.match(summary.skipped[0].reason, /EPERM/);
});

test("sweep unconditional stale retention clears even preserved generations", async () => {
  const { sweepStaleUpdatePendingArtifacts } = await sweepLoader();
  const now = Date.now();
  const content = "ancient";
  await seedFile("setup.exe", content, now - 8 * DAY);
  const summary = await sweepStaleUpdatePendingArtifacts({
    pendingDir: sweepDir,
    now: () => now,
    staleRetentionMs: 7 * DAY,
    currentGeneration: { installerFileName: "setup.exe", sha512: sha512Of(content), size: content.length, preserve: true },
  });
  assert.ok(!existsSync(join(sweepDir, "setup.exe")));
  assert.deepEqual(summary.removed, ["setup.exe"]);
});

test("sweep on missing dir is an empty no-op and never throws", async () => {
  const { sweepStaleUpdatePendingArtifacts } = await sweepLoader();
  const summary = await sweepStaleUpdatePendingArtifacts({
    pendingDir: join(sweepDir, "does-not-exist"),
    now: () => Date.now(),
    currentGeneration: null,
  });
  assert.deepEqual(summary, { removed: [], kept: [], skipped: [] });
});

test("sha512 validation distinguishes complete from partial downloads", async () => {
  const { computeFileSha512, validatePendingInstallerFile } = await sweepLoader();
  const full = await seedFile("setup.exe", "stable-bytes");
  assert.equal(await computeFileSha512(full), sha512Of("stable-bytes"));
  assert.deepEqual(
    await validatePendingInstallerFile({ filePath: full, expectedSha512: sha512Of("stable-bytes"), expectedSize: 12 }),
    { ok: true },
  );
  const sizeFail = await validatePendingInstallerFile({ filePath: full, expectedSha512: null, expectedSize: 999 });
  assert.equal(sizeFail.ok, false);
  assert.match(sizeFail.reason, /size mismatch/);
  const hashFail = await validatePendingInstallerFile({
    filePath: full,
    expectedSha512: sha512Of("different"),
    expectedSize: null,
  });
  assert.equal(hashFail.ok, false);
  const missing = await validatePendingInstallerFile({
    filePath: join(sweepDir, "nope.exe"),
    expectedSha512: null,
    expectedSize: null,
  });
  assert.equal(missing.ok, false);
});

// ———————————————————— autoUpdater 集成（交接/恢复/验证） ————————————————————

async function loadAutoUpdaterWithStubs({ userDataDir, homeDir, updaterStubs }) {
  const gatesModule = await load("updateGates", {
    semver: { __esModule: true, default: require("semver") },
  });
  const updaterJournalModule = await load("updaterJournal", {
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
  });
  const updaterSweepModule = await sweepLoader();
  const handlers = new Map();
  const ipcOn = [];
  const win = {
    isDestroyed: () => false,
    webContents: { id: 1, send: () => {} },
  };
  // isPackaged 必须为 true：canUseAutoUpdaterInCurrentRuntime 才放行 journal 初始化
  // 与恢复路径（dev 判定走 env/argv，默认关闭不受影响）。
  const electron = {
    app: {
      isPackaged: true,
      getVersion: () => updaterStubs.appVersion,
      getPath: (name) => (name === "userData" ? userDataDir : name === "home" ? homeDir : userDataDir),
      getAppPath: () => homeDir,
      getName: () => "acode-journal-test",
      relaunch: () => {},
      exit: () => {},
    },
    BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win },
    Menu: { getApplicationMenu: () => null },
    ipcMain: {
      handle: (key, fn) => handlers.set(key, fn),
      on: (key, fn) => ipcOn.push([key, fn]),
    },
    powerMonitor: { getSystemIdleTime: () => 0 },
  };
  const module = await load("autoUpdater", {
    electron,
    "@acode/shared": {
      DEFAULT_LOCALE: "en-US",
      ACODE_VERSION: updaterStubs.appVersion,
      PlatformChannels: new Proxy({}, { get: (_, key) => key }),
      desktopMenuMessageIds: {},
      getDesktopMenuMessage: () => "",
      formatDesktopMenuMessage: () => "",
    },
    "electron-updater": {
      __esModule: true,
      default: { autoUpdater: updaterStubs.updater },
      CancellationToken: class {
        dispose() {}
        cancel() {}
      },
    },
    semver: { __esModule: true, default: require("semver") },
    "./logger.js": { logger },
    "./updateGates.js": gatesModule,
    "./ipcSyncTiming.js": await load("ipcSyncTiming", {}),
    "./updaterJournal.js": updaterJournalModule,
    "./updaterSweep.js": updaterSweepModule,
    "node:fs/promises": nodeFsPromises,
    "./updaterJournalFormat.js": journalFormatModule,
    "node:path": nodePath,
  });
  return { module, handlers };
}

/** 打包态运行面替身：process.resourcesPath + app-update.yml + 缓存基目录重定向到临时区。 */
async function fakePackagedEnvironment() {
  const resourcesDir = await mkdtemp(join(tmpdir(), "acode-updater-res-"));
  const cacheBase = await mkdtemp(join(tmpdir(), "acode-updater-cache-"));
  await writeFile(
    join(resourcesDir, "app-update.yml"),
    "provider: github\nupdaterCacheDirName: acode-journal-test-updater\n",
    "utf8",
  );
  const previous = {
    resourcesPath: process.resourcesPath,
    localAppData: process.env.LOCALAPPDATA,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
  };
  process.resourcesPath = resourcesDir;
  process.env.LOCALAPPDATA = cacheBase;
  process.env.XDG_CACHE_HOME = cacheBase;
  return {
    resourcesDir,
    cacheBase,
    pendingDir: join(cacheBase, "acode-journal-test-updater", "pending"),
    restore: async () => {
      if (previous.resourcesPath === undefined) {
        delete process.resourcesPath;
      } else {
        process.resourcesPath = previous.resourcesPath;
      }
      if (previous.localAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = previous.localAppData;
      }
      if (previous.xdgCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = previous.xdgCacheHome;
      }
      await rm(resourcesDir, { recursive: true, force: true });
      await rm(cacheBase, { recursive: true, force: true });
    },
  };
}

function makeUpdaterStub(appVersion) {
  const updater = new EventEmitter();
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
    updater.emit("update-not-available", { version: appVersion });
  };
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = () => {};
  return updater;
}

async function readJournalEntries(userDataDir) {
  const raw = await readFile(join(userDataDir, "update-journal.json"), "utf8");
  return JSON.parse(raw).entries;
}

async function seedJournal(userDataDir, entry) {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, "update-journal.json"),
    JSON.stringify({ version: 1, entries: [entry] }),
    "utf8",
  );
}

function baseEntry(overrides = {}) {
  return {
    generation: 1,
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    outcome: "handed-off",
    handedOffAt: 1700000000000,
    exitSweepHandoff: "completed",
    installerPath: null,
    installerFileName: null,
    sha512: null,
    size: null,
    pendingReleaseName: null,
    channel: "stable",
    platform: "win32",
    outcomeAt: null,
    ...overrides,
  };
}

test("handoff write: update-downloaded → quitAndInstall journals from/to/sha512 and completed exit-sweep marker", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "acode-updater-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "acode-updater-ud-"));
  const installerDir = await mkdtemp(join(tmpdir(), "acode-updater-pending-"));
  const installerPath = join(installerDir, "ACode-2.0.0.exe");
  const installerBytes = "nsis-installer-bytes";
  await writeFile(installerPath, installerBytes);
  try {
    const updater = makeUpdaterStub("1.0.0");
    let installs = 0;
    updater.quitAndInstall = () => {
      installs += 1;
    };
    let preparation = 0;
    const { module, handlers } = await loadAutoUpdaterWithStubs({
      userDataDir,
      homeDir,
      updaterStubs: { appVersion: "1.0.0", updater },
    });
    await module.initAutoUpdater({
      onBeforeQuitAndInstall: async () => {
        preparation += 1;
      },
    });
    updater.emit("update-downloaded", {
      version: "2.0.0",
      downloadedFile: installerPath,
      sha512: sha512Of(installerBytes),
    });
    await new Promise(setImmediate);
    await handlers.get("QuitAndInstallUpdate")();
    assert.equal(preparation, 1);
    assert.equal(installs, 1);
    const entries = await readJournalEntries(userDataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fromVersion, "1.0.0");
    assert.equal(entries[0].toVersion, "2.0.0");
    assert.equal(entries[0].outcome, "handed-off");
    assert.equal(entries[0].exitSweepHandoff, "completed", "R19 exemption chain completion recorded");
    assert.equal(entries[0].installerFileName, "ACode-2.0.0.exe");
    assert.equal(entries[0].sha512, sha512Of(installerBytes));
    assert.equal(entries[0].size, installerBytes.length);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
    await rm(installerDir, { recursive: true, force: true });
  }
});

test("handoff abort: failing onBeforeQuitAndInstall marks entry handoff-aborted (no false incident)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "acode-updater-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "acode-updater-ud-"));
  const installerDir = await mkdtemp(join(tmpdir(), "acode-updater-pending-"));
  const installerPath = join(installerDir, "ACode-2.0.0.exe");
  await writeFile(installerPath, "bytes");
  try {
    const updater = makeUpdaterStub("1.0.0");
    let installs = 0;
    updater.quitAndInstall = () => {
      installs += 1;
    };
    const { module, handlers } = await loadAutoUpdaterWithStubs({
      userDataDir,
      homeDir,
      updaterStubs: { appVersion: "1.0.0", updater },
    });
    await module.initAutoUpdater({
      onBeforeQuitAndInstall: async () => {
        throw new Error("prepare failed");
      },
    });
    updater.emit("update-downloaded", {
      version: "2.0.0",
      downloadedFile: installerPath,
      sha512: sha512Of("bytes"),
    });
    await new Promise(setImmediate);
    await assert.rejects(handlers.get("QuitAndInstallUpdate")(), /prepare failed/);
    assert.equal(installs, 0);
    const entries = await readJournalEntries(userDataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "handoff-aborted");
    assert.equal(entries[0].exitSweepHandoff, "failed");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
    await rm(installerDir, { recursive: true, force: true });
  }
});

test("incident fingerprint (handed-off but version unchanged) with intact pending restores retry-ready", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "acode-updater-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "acode-updater-ud-"));
  const packaged = await fakePackagedEnvironment();
  const pendingDir = packaged.pendingDir;
  await mkdir(pendingDir, { recursive: true });
  const installerBytes = "complete-installer";
  await writeFile(join(pendingDir, "ACode-2.0.0.exe"), installerBytes);
  await writeFile(join(pendingDir, "update-info.json"), "{}");
  try {
    await seedJournal(userDataDir, baseEntry({
      installerFileName: "ACode-2.0.0.exe",
      sha512: sha512Of(installerBytes),
      size: installerBytes.length,
    }));
    const updater = makeUpdaterStub("1.0.0");
    const { module } = await loadAutoUpdaterWithStubs({
      userDataDir,
      homeDir,
      updaterStubs: { appVersion: "1.0.0", updater },
    });
    await module.initAutoUpdater({});
    // 完整 pending：恢复 restage-ready（诚实重试入口），不静默。
    assert.equal(module.getAutoUpdaterState().kind, "update-downloaded");
    assert.equal(module.getAutoUpdaterState().version, "2.0.0");
    const entries = await readJournalEntries(userDataDir);
    assert.equal(entries[0].outcome, "install-not-effective");
    assert.ok(existsSync(join(pendingDir, "ACode-2.0.0.exe")), "intact pending kept");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
    await packaged.restore();
  }
});

test("incident fingerprint with corrupt pending clears stale ready state and returns to idle", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "acode-updater-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "acode-updater-ud-"));
  const packaged = await fakePackagedEnvironment();
  const pendingDir = packaged.pendingDir;
  await mkdir(pendingDir, { recursive: true });
  await writeFile(join(pendingDir, "ACode-2.0.0.exe"), "truncated-partial");
  try {
    await seedJournal(userDataDir, baseEntry({
      installerFileName: "ACode-2.0.0.exe",
      sha512: sha512Of("complete-installer"),
      size: 19,
    }));
    const updater = makeUpdaterStub("1.0.0");
    const { module } = await loadAutoUpdaterWithStubs({
      userDataDir,
      homeDir,
      updaterStubs: { appVersion: "1.0.0", updater },
    });
    await module.initAutoUpdater({});
    // 失效 pending：清掉伪 ready 回到 idle 诚实状态（不展示指向损坏包的「重启以更新」）。
    assert.equal(module.getAutoUpdaterState().kind, "idle");
    const entries = await readJournalEntries(userDataDir);
    assert.equal(entries[0].outcome, "install-not-effective");
    assert.ok(existsSync(join(pendingDir, "ACode-2.0.0.exe")), "recovery does not delete; sweep owns deletion");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
    await packaged.restore();
  }
});

test("post-update verification success marks journal verified", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "acode-updater-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "acode-updater-ud-"));
  const packaged = await fakePackagedEnvironment();
  try {
    await seedJournal(userDataDir, baseEntry());
    const updater = makeUpdaterStub("2.0.0");
    const { module } = await loadAutoUpdaterWithStubs({
      userDataDir,
      homeDir,
      updaterStubs: { appVersion: "2.0.0", updater },
    });
    await module.initAutoUpdater({});
    const entries = await readJournalEntries(userDataDir);
    assert.equal(entries[0].outcome, "verified", "version advanced and probes passed");
  } finally {
    await packaged.restore();
    await rm(homeDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("post-update verification failure marks journal failed and reports honestly", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "acode-updater-home-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "acode-updater-ud-"));
  const packaged = await fakePackagedEnvironment();
  try {
    await seedJournal(userDataDir, baseEntry());
    const updater = makeUpdaterStub("2.0.0");
    const { module } = await loadAutoUpdaterWithStubs({
      userDataDir,
      homeDir,
      updaterStubs: { appVersion: "2.0.0", updater },
    });
    module.setPostUpdateResourceProbeForTest(async () => ({ ok: false, detail: "probe failed" }));
    await module.initAutoUpdater({});
    const entries = await readJournalEntries(userDataDir);
    assert.equal(entries[0].outcome, "failed");
    // 诚实状态：版本推进但验证失败时不得伪造成 ready。
    assert.equal(module.getAutoUpdaterState().kind, "idle");
  } finally {
    await packaged.restore();
    await rm(homeDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});
