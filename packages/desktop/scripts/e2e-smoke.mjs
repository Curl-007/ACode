#!/usr/bin/env node
/**
 * Windows/本机 isolated-profile Electron smoke（docs/reviews/2026-10-08/external-e2e-2026-10-09.md 建议门禁 2）。
 *
 * 目标：在完全隔离的运行时身份（独立 app name / home / userData / 数据目录 / 日志目录）下启动
 * 开发态 Electron，等待并证明四个启动检查点，然后强杀整棵进程树并验证清理：
 *   CP1 进程存活        —— electron 主进程 spawn 成功且未提前退出；
 *   CP2 CDP 端口        —— <userData>/DevToolsActivePort 出现且 /json/version 可答（app-ready 前 Chromium 不会写该文件）；
 *   CP3 首窗 ready      —— /json/list 出现 index.html page target，并解析 acodeLaunchMarks（T0-T3 启动计时证据）；
 *   CP4 Host 启动       —— E2E 日志目录出现 "[spawnHostProcess]"（窗口创建链路真的把 Host utility process 拉起来了）。
 * 退出：taskkill /T /F 杀整棵树 → 验证没有 electron 进程的命令行仍引用临时目录 → 删除临时目录。
 *
 * 任何检查点超时都会转储 electron stdio 与主进程日志尾部，用于定位 app-ready/首窗前卡点。
 * 用法：node scripts/e2e-smoke.mjs [--timeout-ms N] [--keep] [--json]
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const desktopRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const overallTimeoutMs = Number(argValue("timeout-ms") ?? 240_000);
const keepTemp = argv.includes("--keep");
const jsonOut = argv.includes("--json");

function resolveElectronBinary() {
  // 与 scripts/dev.mjs 相同的解析路径：不依赖 PATH，直接用本仓安装的 Electron。
  const electronPackageRoot = resolve(require.resolve("electron/package.json"), "..");
  if (process.platform === "win32") return resolve(electronPackageRoot, "dist", "electron.exe");
  if (process.platform === "darwin")
    return resolve(electronPackageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  return resolve(electronPackageRoot, "dist", "electron");
}

function httpJson(url, timeoutMs = 2_000) {
  return new Promise((resolvePromise) => {
    const req = httpGet(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolvePromise({ ok: true, json: JSON.parse(body) });
        } catch {
          resolvePromise({ ok: false, reason: `bad json: ${body.slice(0, 120)}` });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolvePromise({ ok: false, reason: error.message }));
  });
}

function logLine(...args) {
  if (!jsonOut) console.log(...args);
}

function tailFile(path, lines = 40) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return `<unreadable: ${path}>`;
  }
}

function findElectronProcessesReferencing(marker) {
  if (process.platform !== "win32") {
    // 非 Windows 平台用 pgrep -f 兜底；smoke 首先服务 Windows 验收。
    const out = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
    return out.stdout.trim().split(/\r?\n/).filter(Boolean);
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

function listListeningPortsOfPid(pid) {
  if (process.platform === "win32") {
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    const ports = [];
    for (const line of (out.stdout ?? "").split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[2]) === pid) ports.push(Number(m[1]));
    }
    return ports;
  }
  const out = spawnSync("lsof", ["-aPan", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  const ports = [];
  for (const line of (out.stdout ?? "").split(/\r?\n/)) {
    const m = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (m) ports.push(Number(m[1]));
  }
  return ports;
}

async function probeListeningPortsOfPid(pid) {
  for (const port of listListeningPortsOfPid(pid)) {
    const res = await httpJson(`http://127.0.0.1:${port}/json/version`, 1_000);
    if (res.ok && res.json?.webSocketDebuggerUrl) return port;
  }
  return null;
}

async function collectCdpDiagnostics(pid, userDataDir) {
  const ports = listListeningPortsOfPid(pid);
  let dirEntries = [];
  try {
    dirEntries = readdirSync(userDataDir);
  } catch {}
  return `pid=${pid} listeningPorts=[${ports.join(",")}] userDataDirEntries=[${dirEntries
    .slice(0, 25)
    .join(",")}]`;
}

async function main() {
  const startedAt = Date.now();
  const runId = randomUUID();
  const tempRoot = mkdtempSync(join(tmpdir(), "acode-e2e-smoke-"));
  const homeDir = join(tempRoot, "home");
  const userDataDir = join(tempRoot, "userData");
  const dataBaseDir = join(tempRoot, "data");
  const logDir = join(tempRoot, "logs");
  for (const dir of [homeDir, userDataDir, dataBaseDir, logDir])
    mkdirSync(dir, { recursive: true });
  const stdioLogPath = join(tempRoot, "electron-stdio.log");

  const env = {
    ...process.env,
    ACODE_ENV: "test",
    ACODE_E2E_RUN_ID: runId,
    ACODE_E2E_RUNTIME_LOG_DIR: logDir,
    ACODE_DATA_BASE_DIR: dataBaseDir,
    ACODE_DESKTOP_HOME_DIR: homeDir,
    ACODE_DESKTOP_USER_DATA_DIR: userDataDir,
    // 独立应用身份：单实例锁按 userData/app name 归组，避免与本机正在运行的 ACode 抢锁。
    ACODE_DESKTOP_APPLICATION_NAME: `ACode E2E Smoke ${runId.slice(0, 8)}`,
    // 固定 9229 会与开发实例抢端口（见 src/main/index.ts 注释）；这里交给 --remote-debugging-port=0。
    ACODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  };

  const electronBinary = resolveElectronBinary();
  const stdioFd = openSync(stdioLogPath, "a");
  logLine(`[smoke] runId=${runId}`);
  logLine(`[smoke] tempRoot=${tempRoot}`);
  logLine(`[smoke] electron=${electronBinary}`);
  // Chromium switch 必须放在 app path 之前；放在 "." 之后时部分 Electron 版本不会把它
  // 并入 browser 进程的 command line，DevToolsActivePort 永远不落盘（上一轮探针无 CDP 的疑似根因）。
  const child = spawn(electronBinary, ["--remote-debugging-port=0", "."], {
    cwd: desktopRoot,
    env,
    stdio: ["ignore", stdioFd, stdioFd],
    windowsHide: false,
  });

  const checkpoints = [];
  const record = (name, ok, detail) => {
    checkpoints.push({ name, ok, detail, elapsedMs: Date.now() - startedAt });
    logLine(
      `[smoke] ${ok ? "PASS" : "FAIL"} ${name} (+${Date.now() - startedAt}ms) ${detail ?? ""}`,
    );
  };

  let exitedEarly = null;
  child.on("exit", (code, signal) => {
    exitedEarly = { code, signal };
  });

  const deadline = Date.now() + overallTimeoutMs;
  const mainLogPath = () => {
    const now = new Date();
    const name = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}.log`;
    return join(logDir, name);
  };

  const fail = async (stage, reason) => {
    record(stage, false, reason);
    console.error(`[smoke] blocked at ${stage}: ${reason}`);
    console.error(
      `[smoke] --- electron stdio tail (${stdioLogPath}) ---\n${tailFile(stdioLogPath)}`,
    );
    console.error(`[smoke] --- main log tail (${mainLogPath()}) ---\n${tailFile(mainLogPath())}`);
    await teardown();
    finish(1);
  };

  let cdpPort = null;
  let teardownDone = false;
  async function teardown() {
    if (teardownDone) return;
    teardownDone = true;
    if (child.exitCode == null && !exitedEarly) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }
    }
    // 等待进程树退出（最多 15s），随后验证没有残留 electron 引用临时目录。
    const killDeadline = Date.now() + 15_000;
    while (Date.now() < killDeadline) {
      if (findElectronProcessesReferencing(tempRoot).length === 0) break;
      await sleep(500);
    }
    const leftovers = findElectronProcessesReferencing(tempRoot);
    record(
      "process-tree-cleanup",
      leftovers.length === 0,
      leftovers.length
        ? `leftover pids: ${leftovers.join(",")}`
        : "no electron process references temp root",
    );
    if (!keepTemp) {
      try {
        rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      } catch {}
      record(
        "temp-dir-cleanup",
        !existsSync(tempRoot),
        existsSync(tempRoot) ? `still exists: ${tempRoot}` : "removed",
      );
    } else {
      logLine(`[smoke] --keep: temp root preserved at ${tempRoot}`);
    }
  }

  function finish(code) {
    const summary = { runId, tempRoot, checkpoints, exitCode: code };
    if (jsonOut) console.log(JSON.stringify(summary, null, 2));
    process.exit(code);
  }

  try {
    // CP1：进程存活 5s（早期 crash 会立刻暴露，例如 runtime data path 校验抛错）。
    await sleep(5_000);
    if (exitedEarly) {
      await fail(
        "CP1-process-alive",
        `electron exited early code=${exitedEarly.code} signal=${exitedEarly.signal}`,
      );
      return;
    }
    record("CP1-process-alive", true, `pid=${child.pid}`);

    // CP2：DevToolsActivePort → CDP /json/version。
    // 兜底：文件缺失时扫描 electron 主进程 PID 的监听端口并逐个探测 /json/version，
    // 用于区分「Chromium 没开调试端口」与「端口文件写到了别的 user-data-dir」。
    const devtoolsActivePortPath = join(userDataDir, "DevToolsActivePort");
    let lastCdpProgressLog = 0;
    while (Date.now() < deadline) {
      if (exitedEarly) {
        await fail(
          "CP2-cdp",
          `electron exited code=${exitedEarly.code} signal=${exitedEarly.signal}`,
        );
        return;
      }
      if (existsSync(devtoolsActivePortPath)) {
        const firstLine = readFileSync(devtoolsActivePortPath, "utf8").split(/\r?\n/)[0]?.trim();
        if (firstLine && Number(firstLine) > 0) {
          cdpPort = Number(firstLine);
          break;
        }
      }
      const fallbackPort = await probeListeningPortsOfPid(child.pid);
      if (fallbackPort) {
        cdpPort = fallbackPort;
        logLine(
          `[smoke] DevToolsActivePort missing; discovered CDP via listening-port probe: ${cdpPort}`,
        );
        break;
      }
      const now = Date.now();
      if (now - lastCdpProgressLog >= 15_000) {
        logLine(
          `[smoke] waiting for CDP... devtoolsActivePort=${existsSync(devtoolsActivePortPath)} (+${now - startedAt}ms)`,
        );
        lastCdpProgressLog = now;
      }
      await sleep(500);
    }
    if (!cdpPort) {
      const diagnostics = await collectCdpDiagnostics(child.pid, userDataDir);
      await fail("CP2-cdp", `no CDP endpoint within timeout. ${diagnostics}`);
      return;
    }
    const version = await httpJson(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!version.ok) {
      await fail("CP2-cdp", `port ${cdpPort} found but /json/version failed: ${version.reason}`);
      return;
    }
    record("CP2-cdp", true, `port=${cdpPort} browser=${version.json.Browser}`);

    // CP3：首窗 page target + launch marks。
    let firstWindow = null;
    while (Date.now() < deadline) {
      if (exitedEarly) {
        await fail("CP3-first-window", `electron exited code=${exitedEarly.code}`);
        return;
      }
      const list = await httpJson(`http://127.0.0.1:${cdpPort}/json/list`);
      if (list.ok && Array.isArray(list.json)) {
        firstWindow =
          list.json.find((t) => t.type === "page" && /index\.html/.test(t.url ?? "")) ?? null;
        if (firstWindow) break;
      }
      await sleep(1_000);
    }
    if (!firstWindow) {
      await fail("CP3-first-window", "no index.html page target within timeout");
      return;
    }
    let launchMarks = null;
    try {
      const marks = new URL(firstWindow.url).searchParams.get("acodeLaunchMarks");
      if (marks) launchMarks = JSON.parse(decodeURIComponent(marks));
    } catch {}
    record(
      "CP3-first-window",
      true,
      `title="${firstWindow.title}" launchMarks=${launchMarks ? JSON.stringify(launchMarks) : "<none>"}`,
    );

    // CP4：Host 启动证据（窗口创建链路应拉起 Host utility process）。
    let hostEvidence = null;
    while (Date.now() < deadline) {
      if (exitedEarly) break;
      try {
        const content = readFileSync(mainLogPath(), "utf8");
        const line = content
          .split(/\r?\n/)
          .find((l) => l.includes("[spawnHostProcess] forked host process"));
        if (line) {
          hostEvidence = line.trim().slice(0, 200);
          break;
        }
      } catch {}
      await sleep(1_000);
    }
    if (!hostEvidence) {
      await fail(
        "CP4-host-spawn",
        `no "[spawnHostProcess] forked host process" line in ${mainLogPath()}`,
      );
      return;
    }
    record("CP4-host-spawn", true, hostEvidence);

    await teardown();
    const allOk = checkpoints.every((c) => c.ok);
    finish(allOk ? 0 : 1);
  } catch (error) {
    await fail("unexpected", String(error?.stack ?? error));
  }
}

await main();
