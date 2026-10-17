import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
} from "../src/main/appShutdownPolicy.ts";
import {
  createShutdownEvidenceStore,
  getPreviousShutdownEvidence,
  initializeShutdownEvidence,
  parseShutdownEvidenceRecord,
  previousQuitClean,
  resetShutdownEvidenceCacheForTest,
  summarizeShutdownCleanup,
} from "../src/main/shutdownEvidence.ts";
import { createShutdownTaskRegistry } from "../src/main/shutdownTasks.ts";

/** 退出看门狗+上次退出证据链单测（specs/shutdown-keepawake-containment.md 验收 1）。 */

function createRecordingLogger() {
  const entries = [];
  function push(level) {
    return (...args) => entries.push({ level, args });
  }
  return { entries, info: push("info"), warn: push("warn"), error: push("error") };
}

function findStructured(entries, event, level) {
  return entries
    .filter((entry) => level === undefined || entry.level === level)
    .map((entry) => entry.args.find((arg) => arg && typeof arg === "object" && arg.event === event))
    .filter(Boolean);
}

function createFakeSyncFs() {
  const files = new Map();
  return {
    files,
    writeFileSync: (path, data) => {
      files.set(path, String(data));
    },
    renameSync: (from, to) => {
      if (!files.has(from)) {
        throw Object.assign(new Error(`ENOENT ${from}`), { code: "ENOENT" });
      }
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms, unref: () => {} };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
    fireNext(delayMs) {
      const handle = timers.find((entry) => entry.ms === delayMs);
      assert.ok(handle, `expected a timer with delay ${delayMs}`);
      handle.fn();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createPolicy(overrides = {}) {
  return {
    forceKillDelayMs: 4_000,
    waitTimeoutMs: 4_500,
    cleanupBudgetMs: 1_000,
    watchdogDelayMs: 2_000,
    ...overrides,
  };
}

function createHarness(options = {}) {
  const logger = createRecordingLogger();
  const fs = createFakeSyncFs();
  const timers = createFakeTimers();
  const filePath = options.filePath ?? "/userData/last-shutdown-evidence.json";
  let monotonic = 0;
  let wall = 1_700_000_000_000;
  const policy = createPolicy(options.policy);
  const evidence = createShutdownEvidenceStore({ filePath, logger, fs, wallNow: () => wall });
  const exits = [];
  const registry = createShutdownTaskRegistry({
    evidence,
    logger,
    resolvePolicy: () => policy,
    appVersion: () => "1.2.3",
    forceExit: (reason) => exits.push(reason),
    now: () => monotonic,
    wallNow: () => wall,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return {
    logger,
    fs,
    timers,
    evidence,
    registry,
    exits,
    policy,
    advance(ms) {
      monotonic += ms;
      wall += ms;
    },
    evidenceRecord() {
      const raw = fs.files.get(filePath);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
  };
}

test("appShutdownPolicy keeps tier semantics and adds cleanup/watchdog budgets", () => {
  const windowsBase = { forceKillDelayMs: 4_000, waitTimeoutMs: 4_500 };
  const strictBase = { forceKillDelayMs: 7_500, waitTimeoutMs: 9_000 };
  const windowsBudget = { cleanupBudgetMs: 12_000, watchdogDelayMs: 10_000 };
  const windowsNormal = resolveAppShutdownPolicy("normal", "win32");
  assert.deepEqual(windowsNormal, { ...windowsBase, ...windowsBudget });
  const strict = resolveAppShutdownPolicy("update-install", "win32");
  assert.deepEqual(strict, { ...strictBase, cleanupBudgetMs: 20_000, watchdogDelayMs: 15_000 });
  assert.deepEqual(resolveAppShutdownPolicy("normal", "darwin"), strict);
  // 每档 cleanupBudgetMs 必须覆盖同档 waitTimeoutMs 的 Host 屏障（spec R6）。
  for (const kind of ["normal", "update-install"]) {
    for (const platform of ["win32", "darwin", "linux"]) {
      const policy = resolveAppShutdownPolicy(kind, platform);
      assert.ok(policy.cleanupBudgetMs > policy.waitTimeoutMs);
      assert.ok(policy.watchdogDelayMs > 0);
    }
  }
  // update-install 优先级只增不减的既有语义回归。
  const upgraded = selectAppShutdownPolicy("normal", "update-install", "win32");
  assert.equal(upgraded.kind, "update-install");
  assert.equal(upgraded.upgraded, true);
  const kept = selectAppShutdownPolicy("update-install", "normal", "win32");
  assert.equal(kept.kind, "update-install");
  assert.equal(kept.upgraded, false);
});

test("registry rejects invalid names, duplicates and non-callable tasks", () => {
  const harness = createHarness();
  assert.equal(harness.registry.register({ name: "ok_task-1.a", fn: () => {} }), true);
  assert.equal(harness.registry.register({ name: "ok_task-1.a", fn: () => {} }), false);
  assert.equal(harness.registry.register({ name: "bad name!", fn: () => {} }), false);
  assert.equal(harness.registry.register({ name: "x".repeat(65), fn: () => {} }), false);
  assert.equal(harness.registry.register({ name: "no_fn" }), false);
  assert.equal(harness.registry.listTasks().length, 1);
  const { entries } = harness.logger;
  const outcomes = findStructured(entries, "shutdown_task_rejected").map((e) => e.outcome);
  assert.deepEqual(outcomes, ["duplicate_name", "invalid_name", "invalid_name", "missing_fn"]);
});

test("runShutdown accounts per handler and selects segments by kind", async () => {
  const harness = createHarness();
  const order = [];
  function track(name, ms, extra = {}) {
    const fn = async () => {
      order.push(name);
      harness.advance(ms);
    };
    harness.registry.register({ name, ...extra, fn });
  }
  track("plain", 10);
  track("flush", 50, { beforeInstall: true });
  track("pty", 30, { stopsChildProcesses: true });

  const updateRun = await harness.registry.runShutdown("update-install", { reason: "test" });
  assert.deepEqual(updateRun.attempted, ["flush", "pty"]);
  assert.deepEqual(order, ["flush", "pty"]);
  assert.equal(updateRun.timedOut, false);
  // 并行 handler 共享单调时钟：flush 的时长覆盖到 pty 推进的 30ms（真实墙钟语义）。
  assert.equal(updateRun.durationsMs.flush, 80);
  assert.equal(updateRun.durationsMs.pty, 30);
  const updateEvidence = updateRun.evidence;
  assert.equal(updateEvidence.for_update, true);
  assert.equal(updateEvidence.completed, true);
  assert.equal(updateEvidence.stage, "final");
  assert.equal(updateEvidence.slowest_handler, "flush");
  assert.equal(updateEvidence.slowest_ms, 80);
  assert.equal(updateEvidence.quit_app_version, "1.2.3");
  assert.ok(updateEvidence.ts > 0);

  const normalRun = await harness.registry.runShutdown("normal");
  // normal 段执行剩余任务，update-install 已执行的按 name 跳过（R1）。
  assert.deepEqual(normalRun.attempted, ["plain"]);
  assert.deepEqual(normalRun.skipped, ["flush", "pty"]);
  assert.deepEqual(harness.registry.listExecuted().sort(), ["flush", "plain", "pty"]);
  assert.equal(normalRun.evidence.for_update, false);
});

test("failing handler is timed and recorded as executed", async () => {
  const harness = createHarness();
  harness.registry.register({
    name: "boom",
    fn: async () => {
      harness.advance(20);
      throw new Error("handler exploded");
    },
  });
  harness.registry.register({ name: "fine", fn: () => {} });
  const run = await harness.registry.runShutdown("normal");
  assert.equal(run.durationsMs.boom, 20);
  assert.equal(run.timedOut, false);
  assert.deepEqual(run.evidence.pending_handlers, []);
  const failure = findStructured(harness.logger.entries, "shutdown_task_failed", "error")[0];
  assert.equal(failure.handler, "boom");
  assert.equal(failure.outcome, "failed");
  assert.match(failure.error, /handler exploded/);
});

test("cleanup budget timeout aborts wait and records pending_handlers", async () => {
  const harness = createHarness();
  let releaseSlow;
  const slowPromise = new Promise((resolve) => (releaseSlow = resolve));
  harness.registry.register({ name: "fast", fn: async () => harness.advance(5) });
  harness.registry.register({ name: "slow-a", fn: () => slowPromise });
  harness.registry.register({ name: "slow-b", fn: () => slowPromise });

  const runPromise = harness.registry.runShutdown("normal");
  await flush();
  harness.advance(1_000);
  harness.timers.fireNext(1_000); // cleanupBudgetMs 到期
  const run = await runPromise;

  assert.equal(run.timedOut, true);
  assert.deepEqual(run.pendingHandlers.sort(), ["slow-a", "slow-b"]);
  assert.equal(run.evidence.timed_out, true);
  assert.equal(run.evidence.completed, true);
  assert.deepEqual([...run.evidence.pending_handlers].sort(), ["slow-a", "slow-b"]);
  // abort 快照里的名字即使后来补上时长也不算 slowest（summarize 语义）。
  assert.equal(run.evidence.slowest_handler, "fast");
  const timeoutLog = findStructured(harness.logger.entries, "shutdown_cleanup_timeout", "error")[0];
  assert.equal(timeoutLog.outcome, "aborted");
  assert.deepEqual([...timeoutLog.pending_handlers].sort(), ["slow-a", "slow-b"]);

  releaseSlow();
  await flush();
});

test("concurrent runShutdown joins the in-flight run", async () => {
  const harness = createHarness();
  harness.registry.register({ name: "only", fn: async () => flush() });
  const first = harness.registry.runShutdown("normal");
  const second = harness.registry.runShutdown("normal");
  assert.equal(first, second);
  await first;
});

test("watchdog marks evidence and forces exit when the loop stays alive", async () => {
  const harness = createHarness();
  harness.registry.register({ name: "quick", fn: () => {} });
  await harness.registry.runShutdown("normal");
  // final 记录已落盘，watchdog armed。
  assert.equal(harness.evidenceRecord().stage, "final");
  harness.timers.fireNext(2_000); // watchdogDelayMs 到期
  const record = harness.evidenceRecord();
  assert.equal(record.watchdog_fired, true);
  assert.equal(record.stage, "watchdog");
  assert.deepEqual(harness.exits, ["shutdown-watchdog"]);
  const watchdogLog = findStructured(harness.logger.entries, "shutdown_watchdog_fired", "error")[0];
  assert.equal(watchdogLog.outcome, "forced_exit");
  assert.equal(watchdogLog.timeout_ms, 2_000);
  // 结构化负载不得使用保留闭集键 status（spec R7）。
  assert.equal(watchdogLog.status, undefined);
});

test("summarizeShutdownCleanup derives slowest/timed_out/pending", () => {
  const durations = new Map();
  durations.set("a", 10.4).set("c", 90.6);
  const summary = summarizeShutdownCleanup({
    handlerNames: ["a", "b", "c"],
    durationsMs: durations,
    elapsedMs: 120.5,
    pendingAtAbort: ["b"],
  });
  assert.equal(summary.cleanup_ms, 121);
  assert.equal(summary.handler_count, 3);
  assert.equal(summary.slowest_handler, "c");
  assert.equal(summary.slowest_ms, 91);
  assert.equal(summary.timed_out, true);
  assert.deepEqual(summary.pending_handlers, ["b"]);
  const empty = { handlerNames: [], durationsMs: new Map(), elapsedMs: 0, pendingAtAbort: null };
  const clean = summarizeShutdownCleanup(empty);
  assert.equal(clean.timed_out, false);
  assert.equal(clean.slowest_handler, null);
});

test("parseShutdownEvidenceRecord is fail-closed on malformed records", () => {
  const valid = {
    completed: true,
    cleanup_ms: 12,
    handler_count: 2,
    slowest_handler: "a",
    slowest_ms: 12,
    timed_out: false,
    pending_handlers: ["b"],
    watchdog_fired: false,
    for_update: false,
    quit_app_version: "1.2.3",
    quit_epoch_ms: 1_700_000_000_000,
    ts: 1_700_000_000_012,
    stage: "final",
  };
  assert.deepEqual(parseShutdownEvidenceRecord(valid), valid);
  const rejects = (patch) =>
    assert.equal(parseShutdownEvidenceRecord({ ...valid, ...patch }), null);
  rejects({ cleanup_ms: null });
  rejects({ stage: "exploded" });
  rejects({ quit_app_version: "not a version" });
  rejects({ pending_handlers: ["bad name"] });
  rejects({ slowest_handler: null, slowest_ms: 5 });
  assert.equal(parseShutdownEvidenceRecord(null), null);
  assert.equal(parseShutdownEvidenceRecord([]), null);
  assert.equal(parseShutdownEvidenceRecord("x"), null);
  // pending_handlers 超过 100 项被截断。
  const many = { ...valid, pending_handlers: Array.from({ length: 150 }, (_, i) => `h${i}`) };
  assert.equal(parseShutdownEvidenceRecord(many).pending_handlers.length, 100);
});

test("previousQuitClean covers clean/unclean/absent", () => {
  const base = { completed: true, timed_out: false, watchdog_fired: false };
  assert.equal(previousQuitClean(base), true);
  assert.equal(previousQuitClean({ ...base, timed_out: true }), false);
  assert.equal(previousQuitClean({ ...base, watchdog_fired: true }), false);
  assert.equal(previousQuitClean({ ...base, completed: false }), false);
  assert.equal(previousQuitClean(null), null);
});

test("initializeShutdownEvidence consumes previous record and stamps boot", async (t) => {
  resetShutdownEvidenceCacheForTest();
  const dir = await mkdtemp(join(tmpdir(), "acode-shutdown-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "last-shutdown-evidence.json");
  const logger = createRecordingLogger();

  // 首启：无记录。boot 打点落盘。
  const first = await initializeShutdownEvidence({ filePath, logger, appVersion: "1.2.3" });
  assert.equal(first.previous, null);
  assert.equal(getPreviousShutdownEvidence(), null);
  const bootRecord = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(bootRecord.stage, "boot");
  assert.equal(bootRecord.completed, false);

  // 模拟一次干净退出：final 记录覆盖 boot 打点。
  const meta = { handlerNames: ["a"], forUpdate: false, appVersion: "1.2.3", startedEpochMs: 1 };
  first.store.recordCleanupStart(meta);
  first.store.recordCleanupFinished({
    ...meta,
    durationsMs: new Map([["a", 3]]),
    elapsedMs: 4,
    pendingAtAbort: null,
  });
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).stage, "final");

  // 第二次启动：读回 + 消费（读后即删）+ 重新 boot 打点。
  resetShutdownEvidenceCacheForTest();
  const second = await initializeShutdownEvidence({ filePath, logger, appVersion: "1.2.4" });
  assert.equal(second.previous.previousQuitClean, true);
  assert.equal(second.previous.record.quit_app_version, "1.2.3");
  assert.equal(getPreviousShutdownEvidence(), second.previous);
  const restamped = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(restamped.stage, "boot");
  assert.equal(restamped.quit_app_version, "1.2.4");

  // 强杀场景：boot 打点留存 → 下次启动归因非干净退出。
  resetShutdownEvidenceCacheForTest();
  const third = await initializeShutdownEvidence({ filePath, logger, appVersion: "1.2.4" });
  assert.equal(third.previous.previousQuitClean, false);
  assert.equal(third.previous.record.stage, "boot");

  // 畸形记录 fail-closed：不抛错、判 null。
  await writeFile(filePath, "{not json", "utf8");
  resetShutdownEvidenceCacheForTest();
  const fourth = await initializeShutdownEvidence({ filePath, logger, appVersion: "1.2.4" });
  assert.equal(fourth.previous, null);
  assert.ok(findStructured(logger.entries, "shutdown_evidence_malformed").length >= 1);
  resetShutdownEvidenceCacheForTest();
});
