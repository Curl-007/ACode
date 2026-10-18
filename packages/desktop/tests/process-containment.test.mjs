import assert from "node:assert/strict";
import test from "node:test";

import { installProcessContainment } from "../src/main/processContainment.ts";
import { summarizeSpawnCommand } from "../src/main/processContainmentCore.ts";

/**
 * Windows 孤儿进程围堵（台账形态）单测（specs/shutdown-keepawake-containment.md 验收 3）：
 * 假频道/假子进程跨平台驱动 win32 分支；outcome 闭集、spawn 台账、首 spawn 效果验证
 * （covered / missed_first_spawn / 3 次异常退订）、sweep 与 exit 钩子、命令摘要净化。
 * 末尾附真实 diagnostics_channel + 真实 spawn 的集成验证（频道不可用时 skip）。
 */

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

function createFakeChannel() {
  const listeners = new Set();
  return {
    listeners,
    subscribe: (name, listener) => {
      assert.equal(name, "child_process");
      listeners.add(listener);
    },
    unsubscribe: (name, listener) => listeners.delete(listener),
    publish(message) {
      for (const listener of [...listeners]) listener(message);
    },
  };
}

function createFakeChild(options = {}) {
  const handlers = new Map();
  const child = {
    pid: undefined,
    spawnfile: options.spawnfile ?? "C:\\Program Files\\ACode\\agent.exe",
    spawnargs: options.spawnargs ?? ["--run", "task"],
    once(event, listener) {
      handlers.set(event, listener);
      return child;
    },
    emitSpawn(pid) {
      child.pid = pid;
      handlers.get("spawn")?.();
    },
    emitExit(code) {
      handlers.get("exit")?.(code, null);
    },
  };
  return child;
}

function createHarness(options = {}) {
  const logger = createRecordingLogger();
  const channel = options.channel ?? createFakeChannel();
  const treeKills = [];
  const kills = [];
  let wall = 1_700_000_000_000;
  const exitListeners = [];
  const controller = installProcessContainment({
    logger,
    platform: options.platform ?? "win32",
    enabled: options.enabled,
    requireJobObject: options.requireJobObject,
    jobObject: options.jobObject,
    channel,
    now: () => wall,
    kill: (pid, signal) => kills.push({ pid, signal }),
    runTreeKill: (pid) => treeKills.push(pid),
    registerExitListener: (listener) => exitListeners.push(listener),
    maxLedgerEntries: options.maxLedgerEntries,
  });
  return {
    logger,
    channel,
    controller,
    treeKills,
    kills,
    exitListeners,
    advance(ms) {
      wall += ms;
    },
    spawnChild(options2 = {}) {
      const child = createFakeChild(options2);
      channel.publish({ process: child });
      child.emitSpawn(options2.pid ?? 4242);
      return child;
    },
  };
}

test("non-windows platforms get an inert controller", () => {
  const harness = createHarness({ platform: "darwin" });
  assert.equal(harness.controller.outcome, "not_windows");
  assert.equal(harness.channel.listeners.size, 0, "非 win32 不订阅频道");
  const installed = findStructured(harness.logger.entries, "process_containment_installed")[0];
  assert.equal(installed.outcome, "not_windows");
  // inert 控制器接口仍可用。
  assert.deepEqual(harness.controller.getLedger(), []);
  assert.deepEqual(harness.controller.sweepOrphanedChildProcesses("quit").pids, []);
});

test("disabled flag short-circuits installation", () => {
  const harness = createHarness({ enabled: false });
  assert.equal(harness.controller.outcome, "disabled");
  assert.equal(harness.channel.listeners.size, 0);
});

test("ledger records spawns, exit backfill and verification coverage", () => {
  const harness = createHarness();
  assert.equal(harness.controller.outcome, "tracked");
  const child = harness.spawnChild({ pid: 4242 });
  const ledger = harness.controller.getLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].pid, 4242);
  assert.equal(ledger[0].parentPid, process.pid);
  assert.equal(ledger[0].command, "agent.exe --run task");
  assert.equal(ledger[0].exitedAt, null);
  assert.deepEqual(harness.controller.listLivePids(), [4242]);

  const verification = findStructured(
    harness.logger.entries,
    "process_containment_verification",
  )[0];
  assert.equal(verification.outcome, "covered");
  assert.equal(verification.form, "ledger");
  assert.equal(verification.pid, 4242);

  harness.advance(1_500);
  child.emitExit(0);
  assert.equal(harness.controller.getLedger()[0].exitCode, 0);
  assert.equal(harness.controller.getLedger()[0].exitedAt, 1_700_000_001_500);
  assert.deepEqual(harness.controller.listLivePids(), []);
  // 验证器是一次性的：第二个 spawn 不再产生验证日志。
  harness.spawnChild({ pid: 5150 });
  assert.equal(
    findStructured(harness.logger.entries, "process_containment_verification").length,
    1,
  );
});

test("publish before spawn event carries no pid and is recorded on spawn", () => {
  const harness = createHarness();
  const child = createFakeChild();
  harness.channel.publish({ process: child });
  // Electron Node 24 实测：publish 时 pid 尚未就绪，台账必须等 spawn 事件。
  assert.deepEqual(harness.controller.getLedger(), []);
  child.emitSpawn(777);
  assert.equal(harness.controller.getLedger()[0].pid, 777);
  // 畸形载荷被忽略。
  harness.channel.publish({});
  harness.channel.publish(null);
  harness.channel.publish({ process: { once: "not-a-function" } });
  assert.equal(harness.controller.getLedger().length, 1);
});

test("missed first spawn is reported at error level", () => {
  // maxLedgerEntries=0 让台账立刻淘汰刚记录的项，模拟「围堵未覆盖首 spawn」。
  const harness = createHarness({ maxLedgerEntries: 0 });
  harness.spawnChild({ pid: 999 });
  const verification = findStructured(
    harness.logger.entries,
    "process_containment_verification",
    "error",
  )[0];
  assert.equal(verification.outcome, "missed_first_spawn");
  const message = harness.logger.entries
    .filter((entry) => entry.level === "error")
    .flatMap((entry) => entry.args.filter((arg) => typeof arg === "string"))
    .find((text) => text.includes("after the first spawn"));
  assert.ok(message, "error 日志必须点名「围堵生效晚于首 spawn」语义");
});

test("job form uses isProcessInJob and gives up after 3 check failures", () => {
  const calls = [];
  const harness = createHarness({
    jobObject: {
      join: () => {},
      isProcessInJob: (pid) => {
        calls.push(pid);
        throw new Error("native query unavailable");
      },
    },
  });
  assert.equal(harness.controller.outcome, "joined");
  harness.spawnChild({ pid: 11 });
  harness.spawnChild({ pid: 22 });
  let failures = findStructured(harness.logger.entries, "process_containment_verification", "warn");
  assert.deepEqual(
    failures.map((entry) => entry.outcome),
    ["check_failed", "check_failed"],
  );
  harness.spawnChild({ pid: 33 });
  failures = findStructured(harness.logger.entries, "process_containment_verification", "warn");
  assert.equal(failures.at(-1).outcome, "gave_up");
  // 放弃后不再检查（退订验证），台账仍继续记账。
  harness.spawnChild({ pid: 44 });
  assert.deepEqual(calls, [11, 22, 33]);
  assert.equal(harness.controller.getLedger().length, 4);
});

test("job form reports joined coverage and failed join", () => {
  const covered = createHarness({
    jobObject: { join: () => {}, isProcessInJob: () => true },
  });
  covered.spawnChild({ pid: 5 });
  const verification = findStructured(
    covered.logger.entries,
    "process_containment_verification",
  )[0];
  assert.equal(verification.outcome, "covered");
  assert.equal(verification.form, "job");

  const failed = createHarness({
    jobObject: {
      join: () => {
        throw new Error("CreateJobObjectW failed");
      },
      isProcessInJob: () => true,
    },
  });
  assert.equal(failed.controller.outcome, "failed");
  // join 失败台账仍订阅（辅助 sweep）。
  failed.spawnChild({ pid: 6 });
  assert.equal(failed.controller.getLedger().length, 1);
});

test("requireJobObject without capability yields no_capability and ledger fallback", () => {
  const harness = createHarness({ requireJobObject: true });
  assert.equal(harness.controller.outcome, "no_capability");
  harness.spawnChild({ pid: 8 });
  assert.equal(harness.controller.getLedger().length, 1, "降级台账仍记账");
  assert.ok(
    findStructured(harness.logger.entries, "process_containment_installed", "warn").length >= 1,
  );
});

test("channel subscribe failure yields failed outcome", () => {
  const harness = createHarness({
    channel: {
      subscribe: () => {
        throw new Error("channel unavailable");
      },
      unsubscribe: () => {},
    },
  });
  assert.equal(harness.controller.outcome, "failed");
  assert.equal(
    findStructured(harness.logger.entries, "process_containment_installed", "error").length,
    1,
  );
});

test("summarizeSpawnCommand sanitizes and truncates", () => {
  assert.equal(
    summarizeSpawnCommand("C:\\System32\\taskkill.exe", ["/PID", "123", "/T", "/F", "extra"]),
    "taskkill.exe /PID 123 /T",
  );
  assert.equal(
    summarizeSpawnCommand("/usr/bin/node", ["-e", "console.log(1)"]),
    "node -e console.log(1)",
  );
  // 凭据样式字符被白名单收敛，不进日志面。
  const secret = summarizeSpawnCommand("agent.exe", [`--token=abc$ecret\u0000"quoted"`]);
  assert.ok(!secret.includes("$"));
  assert.ok(!secret.includes("\u0000"));
  assert.ok(!secret.includes('"'));
  const long = summarizeSpawnCommand("agent.exe", ["x".repeat(500)]);
  assert.ok(long.length <= 200);
  assert.equal(summarizeSpawnCommand(undefined, undefined), "");
});

test("sweep kills live entries, skips containment tools and exited pids", () => {
  const harness = createHarness();
  harness.spawnChild({ pid: 10, spawnfile: "C:\\app\\agent.exe", spawnargs: ["agent.exe"] });
  harness.spawnChild({ pid: 11, spawnfile: "taskkill.exe", spawnargs: ["/PID", "999"] });
  const exited = harness.spawnChild({ pid: 12, spawnfile: "C:\\app\\helper.exe", spawnargs: [] });
  exited.emitExit(0);

  const result = harness.controller.sweepOrphanedChildProcesses("app-quit");
  assert.deepEqual(result.pids, [10]);
  assert.deepEqual(result.skippedToolPids, [11]);
  assert.deepEqual(harness.treeKills, [10]);
  const sweepLog = findStructured(harness.logger.entries, "process_containment_sweep")[0];
  assert.equal(sweepLog.outcome, "killed");
});

test("exit hook SIGKILLs live children synchronously without tree semantics", () => {
  const harness = createHarness();
  harness.spawnChild({ pid: 20, spawnfile: "C:\\app\\agent.exe", spawnargs: [] });
  harness.spawnChild({ pid: 21, spawnfile: "taskkill.exe", spawnargs: [] });
  const gone = harness.spawnChild({ pid: 22, spawnfile: "C:\\app\\gone.exe", spawnargs: [] });
  gone.emitExit(0);
  harness.controller.installExitHook();
  assert.equal(harness.exitListeners.length, 1);
  harness.exitListeners[0]();
  // 只杀存活项，跳过 taskkill 自身；已退出项不动。
  assert.deepEqual(harness.kills, [{ pid: 20, signal: "SIGKILL" }]);
  assert.deepEqual(harness.treeKills, [], "exit 钩子不 spawn taskkill（同步 SIGKILL 直杀）");
});

test("R19: disableExitSweep makes exit hook yield to the update installer", () => {
  const harness = createHarness();
  harness.spawnChild({ pid: 40, spawnfile: "C:\\app\\agent.exe", spawnargs: [] });
  harness.controller.installExitHook();
  // 交接豁免后：模拟 quitAndInstall 拉起的安装器进入台账，exit 钩子不得杀它
  // （2026-10-18 v1.0.0 实机缺陷：安装器被 exit 钩子 SIGKILL，更新静默失败）。
  harness.controller.disableExitSweep("update-install-handoff");
  harness.spawnChild({
    pid: 41,
    spawnfile:
      "C:\\Users\\u\\AppData\\Local\\@acodedesktop-updater\\pending\\ACode-1.0.0-win-x64.exe",
    spawnargs: ["--updated", "--force-run"],
  });
  harness.exitListeners[0]();
  assert.deepEqual(harness.kills, [], "豁免后 exit 钩子不杀任何子进程（含安装器）");
  const skip = findStructured(
    harness.logger.entries,
    "process_containment_exit_sweep_skipped",
    "info",
  );
  assert.equal(skip.length, 1);
  assert.equal(skip[0].reason, "update-install-handoff");
  // sweep 不受豁免影响：交接前的显式收敛仍按台账树杀（豁免只作用于 exit 钩子）。
  const swept = harness.controller.sweepOrphanedChildProcesses("update-install");
  assert.deepEqual(
    swept.pids.sort((a, b) => a - b),
    [40, 41],
  );
});

test("ledger evicts exited entries first and warns on live eviction", () => {
  const harness = createHarness({ maxLedgerEntries: 2 });
  const a = harness.spawnChild({ pid: 31 });
  a.emitExit(0);
  const b = harness.spawnChild({ pid: 32 });
  b.emitExit(0);
  harness.spawnChild({ pid: 33 });
  const pids = harness.controller.getLedger().map((entry) => entry.pid);
  assert.deepEqual(pids, [32, 33], "最旧的已退出项先被淘汰");

  harness.spawnChild({ pid: 34 });
  const pids2 = harness.controller.getLedger().map((entry) => entry.pid);
  assert.deepEqual(pids2, [33, 34]);
  assert.deepEqual(
    findStructured(harness.logger.entries, "process_containment_ledger_overflow", "warn"),
    [],
    "淘汰已退出项不告警",
  );

  // 台账里只剩活项时溢出：淘汰最旧活项并 warn（围堵面异常需要人工看日志）。
  harness.spawnChild({ pid: 35 });
  const pids3 = harness.controller.getLedger().map((entry) => entry.pid);
  assert.deepEqual(pids3, [34, 35]);
  assert.ok(
    findStructured(harness.logger.entries, "process_containment_ledger_overflow", "warn").length >=
      1,
  );
  assert.deepEqual(harness.controller.listLivePids(), [34, 35]);
});

test("pid reuse retires the stale live entry", () => {
  const harness = createHarness();
  harness.spawnChild({ pid: 40 });
  harness.spawnChild({ pid: 40 });
  const entries = harness.controller.getLedger();
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].exitedAt, null, "旧活项按丢失退出处理，防止 sweep 误杀新进程");
  assert.equal(entries[1].exitedAt, null);
  assert.deepEqual(harness.controller.listLivePids(), [40]);
  assert.ok(
    findStructured(harness.logger.entries, "process_containment_pid_reuse", "warn").length >= 1,
  );
});

test("dispose unsubscribes the channel listener", () => {
  const harness = createHarness();
  assert.equal(harness.channel.listeners.size, 1);
  harness.controller.dispose();
  assert.equal(harness.channel.listeners.size, 0);
});

test("real diagnostics_channel child_process integration", async (t) => {
  const diagnosticsChannel = await import("node:diagnostics_channel");
  const { spawn } = await import("node:child_process");
  const harness = createHarness({ channel: diagnosticsChannel });
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const recorded = await new Promise((resolve) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (harness.controller.getLedger().some((entry) => entry.pid === child.pid)) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - startedAt > 5_000) {
        clearInterval(interval);
        resolve(false);
      }
    }, 10);
  });
  await new Promise((resolve) => child.once("exit", resolve));
  harness.controller.dispose();
  if (!recorded) {
    // Node 运行时未发布 child_process 频道（旧版本）时按平台分支 skip。
    t.skip("child_process diagnostics channel not published by this Node runtime");
    return;
  }
  const entry = harness.controller.getLedger().find((item) => item.pid === child.pid);
  assert.match(entry.command, /^node(\.exe)? -e/);
  const verification = findStructured(
    harness.logger.entries,
    "process_containment_verification",
  )[0];
  assert.equal(verification.outcome, "covered");
});
