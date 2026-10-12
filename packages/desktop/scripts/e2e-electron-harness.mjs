/**
 * 真机 Electron 验收 harness 的共享骨架（被 e2e-network-capture-auth.mjs 与
 * e2e-visualization-card-render.mjs 复用）。
 *
 * 收敛在这里的都是与「验哪个 bug」无关的 Electron 运行时机制：解析本仓 Electron 二进制、
 * 命令行解析、带超时的 spawn、进程树清理、checkpoint 记账、进程退出码。两个 harness 只在
 * 「构建什么 bundle」「往真实运行时里断言什么」上不同，机制层共用一份实现，避免两份各自
 * 漂移（AGENTS.md「单一所有者」/ code-review 的 Reuse 角度）。
 *
 * 与 scripts/e2e-smoke.mjs 同源的两条实证纪律也固化在此：
 *   1. 解析 Electron 不依赖 PATH（pnpm + PowerShell 下子进程常只拿到 node）；
 *   2. 隔离身份走 Chromium 的 --user-data-dir，不覆盖 USERPROFILE/HOME——实证 Windows 上
 *      覆盖 USERPROFILE 会让 Electron 在 app.whenReady() 之前以 STATUS_BREAKPOINT 崩，
 *      连 JS 层异常钩子都接不到。
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);

/** 本仓安装的 Electron 二进制（与 scripts/dev.mjs、e2e-smoke.mjs 相同解析路径）。 */
export function resolveElectronBinary() {
  const electronPackageRoot = resolve(require.resolve("electron/package.json"), "..");
  if (process.platform === "win32") return resolve(electronPackageRoot, "dist", "electron.exe");
  if (process.platform === "darwin")
    return resolve(electronPackageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  return resolve(electronPackageRoot, "dist", "electron");
}

/** 引用了 marker（临时目录路径）的 electron 进程 PID 列表，用于验证进程树清理干净。 */
export function findElectronProcessesReferencing(marker) {
  if (process.platform !== "win32") {
    const out = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
    return (out.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  }
  const out = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: "utf8" },
  );
  return (out.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
}

/** 命令行解析：`--name value` 取参数、`--flag` 取布尔，外加 --json / --timeout-ms 约定。 */
export function parseHarnessArgs(argv = process.argv.slice(2)) {
  const argValue = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    argValue,
    has: (name) => argv.includes(`--${name}`),
    controlMode: argv.includes("--control"),
    jsonOut: argv.includes("--json"),
    timeoutMs: Number(argValue("timeout-ms") ?? 180_000),
  };
}

/** checkpoint 记账器：逐条 PASS/FAIL + 累计耗时，最终 allOk 决定进程退出码。 */
export function createReporter({ tag, jsonOut }) {
  const startedAt = Date.now();
  const checks = [];
  const logLine = (...args) => {
    if (!jsonOut) console.log(...args);
  };
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail, elapsedMs: Date.now() - startedAt });
    logLine(`[${tag}] ${ok ? "PASS" : "FAIL"} ${name} (+${Date.now() - startedAt}ms) ${detail ?? ""}`);
  };
  return { record, logLine, checks, allOk: () => checks.every((c) => c.ok) };
}

/**
 * 起一个真实 Electron main 并等待它自行退出或超时。返回 { outcome, stdioText, child }：
 * outcome.signal === "timeout" 表示超过 timeoutMs 仍未退出（child 仍活，交调用方 teardown）。
 */
export async function spawnElectronMain({ mainPath, workDir, userDataDir, runId, timeoutMs }) {
  const child = spawn(
    resolveElectronBinary(),
    [
      "--no-sandbox",
      "--disable-gpu",
      "--enable-logging",
      // 隔离走 Chromium 自己的 user-data-dir 开关（见文件头纪律 2）。
      `--user-data-dir=${userDataDir}`,
      mainPath,
    ],
    {
      cwd: workDir,
      env: { ...process.env, ACODE_E2E_RUN_ID: runId, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d));
  child.stderr.on("data", (d) => chunks.push(d));
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const timeout = sleep(timeoutMs).then(() => ({ code: null, signal: "timeout" }));
  const outcome = await Promise.race([exited, timeout]);
  return { outcome, stdioText: Buffer.concat(chunks).toString("utf8"), child };
}

/**
 * 杀掉整棵 Electron 进程树（最多等 killWaitMs），验证没有残留进程仍引用临时目录，
 * 再删临时目录；两步都记 checkpoint。SIGINT/超时杀 harness 时也应经这里收口。
 */
export async function teardownElectron({ child, workDir, record, killWaitMs = 10_000 }) {
  if (child && child.exitCode == null) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    const deadline = Date.now() + killWaitMs;
    while (Date.now() < deadline) {
      if (findElectronProcessesReferencing(workDir).length === 0) break;
      await sleep(400);
    }
  }
  const leftovers = findElectronProcessesReferencing(workDir);
  record(
    "process-tree-cleanup",
    leftovers.length === 0,
    leftovers.length
      ? `leftover pids: ${leftovers.join(",")}`
      : "no electron process references temp root",
  );
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  } catch {}
  record(
    "temp-dir-cleanup",
    !existsSync(workDir),
    existsSync(workDir) ? `still exists: ${workDir}` : "removed",
  );
}

/** 输出汇总（--json 时打 JSON）并以 allOk 决定退出码。 */
export function finishReporter({ runId, mode, checks, allOk, jsonOut }) {
  if (jsonOut)
    console.log(
      JSON.stringify({ runId, mode, checks, exitCode: allOk ? 0 : 1 }, null, 2),
    );
  process.exit(allOk ? 0 : 1);
}

export { randomUUID };
