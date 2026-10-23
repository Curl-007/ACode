#!/usr/bin/env node
/**
 * jcode 引擎的桌面端到端验证（agent-engine-jcode-slot.md 验收场景 8）。
 *
 * 目标：证明「Settings 选 jcode」→ Host 自动 spawn **jcode-bridge**（而非 app-server）。
 * 这条链路是本轮注册表改造的核心，且 L1/L2 测试走的是 env 覆盖通道、绕过了它。
 *
 * 做法（不伪造 provider registry，复用本机已有登录态）：
 *   1. 建隔离 profile（独立 app name / home / userData / 数据目录，照 e2e-smoke.mjs）；
 *   2. 把真实 ~/.acode/v2 的 provider_config.json + credentials.json + credential-key.dpapi.json
 *      seed 进隔离 profile —— 让 provider 就绪门禁放行（agent warmup 只在就绪后 spawn agent）。
 *      凭据是本机 DPAPI 加密、绑定当前用户，复制到同用户 temp 目录仍可解密；
 *      **不读取、不打印其内容**，跑完随 temp 目录一起删除。
 *   3. 写 setting.json：agentEngine=jcode + jcodeBinaryPath=<本机 jcode>；
 *   4. 拉起 Electron，扫 Host 日志断言出现 jcode-bridge spawn 证据。
 *
 * 用法：node scripts/e2e-jcode-engine.mjs [--keep] [--timeout-ms N]
 * 需先构建：pnpm --filter @acode/desktop build（tsup + vite）+ prepare:agent-bundle。
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
const overallTimeoutMs = Number(argValue("timeout-ms") ?? 300_000);
const keepTemp = argv.includes("--keep");
const JCODE_BINARY =
  argValue("jcode-binary") ?? join(process.env.LOCALAPPDATA ?? "", "jcode", "bin", "jcode.exe");

function resolveElectronBinary() {
  // 与 e2e-smoke.mjs / dev.mjs 相同的解析：不依赖 PATH，直接用本仓安装的 Electron。
  const electronPackageRoot = resolve(require.resolve("electron/package.json"), "..");
  if (process.platform === "win32") return resolve(electronPackageRoot, "dist", "electron.exe");
  if (process.platform === "darwin")
    return resolve(electronPackageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  return resolve(electronPackageRoot, "dist", "electron");
}

const logLine = (message) => process.stderr.write(`[e2e-jcode] ${message}\n`);

// ---------- 前置检查 ----------
if (!existsSync(JCODE_BINARY)) {
  logLine(`SKIP: jcode 二进制不存在（${JCODE_BINARY}）；传 --jcode-binary <path> 指定`);
  process.exit(0);
}
const realConfigDir = join(homedir(), ".acode", "v2");
const PROVIDER_SEED_FILES = [
  "provider_config.json",
  "credentials.json",
  "credential-key.dpapi.json",
];
const availableSeedFiles = PROVIDER_SEED_FILES.filter((name) =>
  existsSync(join(realConfigDir, name)),
);
if (!availableSeedFiles.includes("provider_config.json")) {
  logLine(
    `SKIP: 本机无 provider 登录态（${realConfigDir}/provider_config.json 缺失），无法让 agent warmup 放行`,
  );
  process.exit(0);
}

const electronBinary = resolveElectronBinary();
const runId = randomUUID();
const tempRoot = mkdtempSync(join(tmpdir(), "acode-e2e-jcode-"));
const homeDir = join(tempRoot, "home");
const userDataDir = join(tempRoot, "userData");
const dataBaseDir = join(tempRoot, "data");
const logDir = join(tempRoot, "logs");
for (const dir of [homeDir, userDataDir, dataBaseDir, logDir]) mkdirSync(dir, { recursive: true });

// ---------- seed provider 登录态 + 写引擎设置 ----------
// 两类文件的根目录**不同**（首轮实测教训）：
//   - provider/凭据：ACODE_DATA_BASE_DIR → <data>/.acode/v2/（providerConfigRuntime 从这里读）
//   - setting.json：ACODE_DESKTOP_HOME_DIR → <home>/.acode/v2/（settingService 读写这里；
//     首轮把 setting.json 只写进 data 目录，app 启动后用空设置覆盖，engineId 回退 native，
//     日志实证 spawn args 仍是 ["acode.cjs","app-server","--stdio"]）
// 为稳妥两处都写。
const isolatedDataConfigDir = join(dataBaseDir, ".acode", "v2");
const isolatedHomeConfigDir = join(homeDir, ".acode", "v2");
for (const dir of [isolatedDataConfigDir, isolatedHomeConfigDir])
  mkdirSync(dir, { recursive: true });
for (const name of availableSeedFiles) {
  // 只复制文件，不读取/打印内容（凭据是敏感材料）。
  const source = join(realConfigDir, name);
  copyFileSync(source, join(isolatedDataConfigDir, name));
  copyFileSync(source, join(isolatedHomeConfigDir, name));
}
// 引擎选择：本轮注册表改造要验证的输入。jcodeBinaryPath 是 R5 的必填项
// （桌面 GUI 的 PATH 不含 login shell 条目，必须显式给路径）。
const settings = {
  schemaVersion: 1,
  agentEngine: "jcode",
  jcodeBinaryPath: JCODE_BINARY,
};
const settingsJson = JSON.stringify(settings, null, 2);
writeFileSync(join(isolatedDataConfigDir, "setting.json"), settingsJson, "utf8");
writeFileSync(join(isolatedHomeConfigDir, "setting.json"), settingsJson, "utf8");
logLine(`seeded provider files: ${availableSeedFiles.join(", ")} → data+home 两处`);
logLine(`setting.json (data+home): agentEngine=jcode, jcodeBinaryPath=<set>`);

const stdioLogPath = join(tempRoot, "electron-stdio.log");
const env = {
  ...process.env,
  ACODE_ENV: "test",
  ACODE_E2E_RUN_ID: runId,
  ACODE_E2E_RUNTIME_LOG_DIR: logDir,
  ACODE_DATA_BASE_DIR: dataBaseDir,
  ACODE_DESKTOP_HOME_DIR: homeDir,
  ACODE_DESKTOP_USER_DATA_DIR: userDataDir,
  ACODE_DESKTOP_APPLICATION_NAME: `ACode E2E jcode ${runId.slice(0, 8)}`,
  ACODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  // jcode 侧遥测硬关（spec R4-2）；shim 自己也会注入，这里双保险。
  JCODE_NO_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
};
// 刻意**不设** ACODE_AGENT_SERVER_COMMAND：本轮验证的是注册表路径
// （Settings.agentEngine → resolveAgentEngineFromSettings → startClient → resolver），
// env 覆盖会在 resolver 最前面短路掉注册表 dispatch，测不到目标链路。

const stdioFd = openSync(stdioLogPath, "a");
logLine(`tempRoot=${tempRoot}`);
const child = spawn(electronBinary, ["--remote-debugging-port=0", "."], {
  cwd: desktopRoot,
  env,
  stdio: ["ignore", stdioFd, stdioFd],
  windowsHide: false,
});

let exitedEarly = null;
child.on("exit", (code, signal) => {
  exitedEarly = { code, signal };
});

const mainLogPath = () => {
  // Host/main 日志落在 ACODE_E2E_RUNTIME_LOG_DIR。
  const files = existsSync(logDir) ? require("node:fs").readdirSync(logDir) : [];
  const log = files.find((name) => name.endsWith(".log"));
  return log ? join(logDir, log) : null;
};

/** 扫日志找证据；返回命中的行或 null。 */
function findInLogs(pattern) {
  const candidates = [mainLogPath(), stdioLogPath].filter((p) => p && existsSync(p));
  for (const file of candidates) {
    try {
      const content = readFileSync(file, "utf8");
      for (const line of content.split(/\r?\n/)) {
        if (pattern.test(line)) return { file, line: line.trim().slice(0, 400) };
      }
    } catch {
      // 日志文件可能正被写；下一轮重试。
    }
  }
  return null;
}

const results = [];
const record = (name, ok, detail, opts) => {
  // soft：结构性不可见的辅助证据（见 shim-* 断言处说明）。不可见时记 SKIP，
  // 不计入 pass 也不计入 fail——避免把「生产 e2e 看不到 shim stderr debug」误报成失败。
  const skip = opts?.soft === true && !ok;
  results.push({ name, ok, detail, skip });
  logLine(`${skip ? "SKIP" : ok ? "PASS" : "FAIL"} ${name} ${detail ?? ""}`);
};

const deadline = Date.now() + overallTimeoutMs;

try {
  // 1. 进程存活。
  await sleep(6_000);
  record("CP1-process-alive", exitedEarly === null, exitedEarly ? JSON.stringify(exitedEarly) : "");

  // 2. storage 准备不再 unsupported_runtime（R6 修复的回归证据）。
  const storageFailure = findInLogs(/unsupported_runtime|Storage preparation failed/);
  record(
    "storage-preparation-not-blocked",
    storageFailure === null,
    storageFailure ? storageFailure.line : "(无 unsupported_runtime)",
  );

  // 3. **决定性断言**：Host 按 Settings.agentEngine=jcode spawn 了 jcode-bridge。
  //    最可靠的证据是 Host 自己记录的 spawn preflight / process started 里的 args
  //    （首轮实测：走 glm 时是 ["...acode.cjs","app-server","--stdio"]）——
  //    这比找 shim 的 stderr 更直接，因为它是 Host 侧的决定，且一定进日志。
  let spawnEvidence = null;
  let wrongEngineEvidence = null;
  while (Date.now() < deadline) {
    if (exitedEarly) break;
    spawnEvidence = findInLogs(/"args":\[[^\]]*"jcode-bridge"/) ?? spawnEvidence;
    if (spawnEvidence) break;
    // 同时抓反证：若 spawn 的是 app-server，说明引擎设置没生效（回退 native）。
    wrongEngineEvidence =
      findInLogs(/ACode agent spawn preflight[\s\S]*?"app-server"/) ?? wrongEngineEvidence;
    await sleep(2_000);
  }
  record(
    "host-spawned-jcode-bridge",
    spawnEvidence !== null,
    spawnEvidence
      ? spawnEvidence.line.slice(0, 300)
      : wrongEngineEvidence
        ? `spawn 的是 app-server（引擎设置未生效）：${wrongEngineEvidence.line.slice(0, 220)}`
        : "超时未见 agent spawn 证据",
  );

  // 4. 若 spawn 成功，验证 agent init 走通（本轮修复的 -32601 降级链）。
  //    决定性正向证据是 Host 自己的 info 日志「ACode agent warmup ready」
  //    （desktop host/index.ts:879）——Host 日志必落盘；shim 的 stderr 走
  //    debugLog（生产不落盘，dev 态才可见），只能作辅助证据。
  if (spawnEvidence) {
    // warmup ready 需要 shim spawn + ACP initialize（jcode 首启要拉 daemon），
    // 给足轮询而不是单次检查（首轮实测：init 被 -32601 杀死时这里 3 秒即报失败）。
    let warmupReady = null;
    let warmupFailed = null;
    const warmupDeadline = Date.now() + Math.min(120_000, deadline - Date.now());
    while (Date.now() < warmupDeadline) {
      if (exitedEarly) break;
      warmupReady = findInLogs(/ACode agent warmup ready/) ?? warmupReady;
      if (warmupReady) break;
      warmupFailed =
        findInLogs(
          /ACode agent warmup unavailable|ACode agent warmup failed|ACode agent 初始化失败/,
        ) ?? warmupFailed;
      if (warmupFailed) break;
      await sleep(2_000);
    }
    record(
      "agent-init-warmup-ready",
      warmupReady !== null,
      warmupReady
        ? warmupReady.line.slice(0, 220)
        : warmupFailed
          ? `init 失败：${warmupFailed.line.slice(0, 260)}`
          : "超时未见 warmup ready/failed",
    );

    // shim 侧证据（stderr，dev 态可见）：遥测硬关 + southbound ready。
    // 生产 e2e（ACODE_ENV=test）里 Host 对子进程 stderr 一律走 debugLog，debug 不落盘，
    // 故这两条结构性不可见 → 记 soft（SKIP 不计失败）。真实 southbound/遥测验证由
    // Level 2（jcode-bridge-service-layer.test.mjs，真 jcode 跑通 completedSuccess）承担，
    // 那里南向握手是 createSession 的前置，通过即证明 southbound ready + telemetry off。
    const telemetryOff = findInLogs(/telemetryOff"?:?\s*true/);
    record(
      "shim-telemetry-hard-off",
      telemetryOff !== null,
      telemetryOff ? telemetryOff.line : "(生产 e2e 不可见 shim stderr debug；见 Level 2)",
      { soft: true },
    );
    const southbound = findInLogs(/jcode bridge southbound ready/);
    record(
      "shim-southbound-ready",
      southbound !== null,
      southbound ? southbound.line : "(生产 e2e 不可见 shim stderr debug；南向 lazy，见 Level 2)",
      { soft: true },
    );
    // agent warmup 是否越过 provider 门禁（证明 seeding 生效）。
    const waiting = findInLogs(/等待 provider\/model 就绪|provider\/model 尚未就绪/);
    record(
      "provider-readiness-gate-passed",
      waiting === null,
      waiting ? `仍在等 provider：${waiting.line.slice(0, 160)}` : "(已越过 provider 就绪门禁)",
    );
  }
} finally {
  // 进程树清理（Windows taskkill /T /F；POSIX 负 pid 组杀）。
  if (child.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  await sleep(1_500);
  if (!keepTemp) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      logLine(`temp root 未删除（占用中）：${tempRoot}`);
    }
  } else {
    logLine(`--keep: temp root 保留于 ${tempRoot}`);
  }
}

const failed = results.filter((r) => !r.ok && !r.skip);
const skipped = results.filter((r) => r.skip);
const passed = results.filter((r) => r.ok);
logLine(
  `结果：${passed.length}/${results.length - skipped.length} 通过${skipped.length ? `（另 ${skipped.length} SKIP）` : ""}`,
);
if (failed.length > 0) {
  for (const f of failed) logLine(`  失败：${f.name} — ${f.detail ?? ""}`);
  // 两条核心断言：注册表路径 spawn jcode-bridge + agent init 越过 -32601 降级链就绪。
  // 任一失败即整体验证失败（本轮改造的验收目标就是这两条）。
  const CORE = ["host-spawned-jcode-bridge", "agent-init-warmup-ready"];
  const coreFailed = failed.some((f) => CORE.includes(f.name));
  process.exit(coreFailed ? 1 : 0);
}
process.exit(0);
