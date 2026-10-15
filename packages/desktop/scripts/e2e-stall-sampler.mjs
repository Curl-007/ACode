#!/usr/bin/env node
/**
 * 主进程卡顿自诊断（stall-sampler）的真机验收（specs/main-stall-diagnostics.md）。
 *
 * 为什么需要它：单测（tests/main-stall-diagnostics.test.mjs）用假时钟 + 模拟 profile
 * 驱动状态机，但「Electron main 里 worker_threads + node:inspector/promises
 * connectToMainThread 能否在主线程被同步阻塞期间抓取 CPU profile」只有真实 Electron
 * 能回答（spec「可行性判决」的档位①证据即来自本 harness 的前身实验）。本脚本把
 * **真实模块**（src/main/stallSampler.ts + stallSamplerWorker.ts，esbuild 原样打包）
 * 挂进真实 Electron main，人为阻塞主线程 2.2s，断言：
 *
 *   R1 worker 以 profiling 模式就绪（connectToMainThread 在本 Electron 构建可用）；
 *   R2 收到 main_thread_stalled 的 warn 级结构化上报（status 闭集）；
 *   R3 captureStatus=ok 且 frames/sampleCount 非空（真的抓到了主线程 profile）；
 *   R4 startLagMs < stallMs（Profiler.start 在阻塞期间落定，而非恢复后补课）；
 *   R5 观测停跳时长与人为阻塞时长同数量级（心跳停跳检测成立）。
 *
 * 用法：node scripts/e2e-stall-sampler.mjs [--timeout-ms N] [--json]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import {
  createReporter,
  finishReporter,
  parseHarnessArgs,
  randomUUID,
  spawnElectronMain,
  teardownElectron,
} from "./e2e-electron-harness.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");

const { jsonOut, timeoutMs: overallTimeoutMs } = parseHarnessArgs();
const { record, logLine, checks, allOk } = createReporter({ tag: "stall-e2e", jsonOut });

/** 人为阻塞时长；停跳阈值/心跳/轮询在 main glue 里按比例调快，控制单轮耗时。 */
const BLOCK_MS = 2_200;

async function buildBundles(workDir) {
  // 真实 worker entry 原样打包（inline core+protocol；node:* 内建保持 external）。
  const workerResult = await esbuild.build({
    entryPoints: [join(desktopRoot, "src/main/stallSamplerWorker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["electron"],
    logLevel: "silent",
  });
  writeFileSync(join(workDir, "stallSamplerWorker.mjs"), workerResult.outputFiles[0].contents);

  // main glue：只负责 Electron 生命周期 + 阻塞脚本 + 观测回写；被验收对象
  // startMainStallSampler 是仓库真实源码（stdin + resolveDir 指向 desktop 根）。
  const glue = `
import { app } from "electron";
import { writeFileSync } from "node:fs";
import { startMainStallSampler } from "./src/main/stallSampler.ts";

const REPORT = ${JSON.stringify(join(workDir, "report.json"))};
const BLOCK_MS = ${BLOCK_MS};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (payload) => {
  try { process.stderr.write("[E2E] " + JSON.stringify(payload) + "\\n"); } catch {}
};
const writeReport = (payload) => {
  try { writeFileSync(REPORT, JSON.stringify(payload, null, 2), "utf8"); } catch {}
};
const jsonSafe = (value) => JSON.parse(JSON.stringify(value ?? null));

function hotLoop(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.sqrt(i) * Math.sin(i);
  return s;
}

async function waitForEntry(entries, predicate, timeoutMsValue) {
  const deadline = Date.now() + timeoutMsValue;
  while (Date.now() < deadline) {
    const entry = entries.find(predicate);
    if (entry) return entry;
    await sleep(50);
  }
  return null;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const entries = [];
  const collect = (level) => (...args) => {
    entries.push({ level, args });
    emit({ type: "log", level, args: jsonSafe(args) });
  };
  const handle = startMainStallSampler({
    logger: { info: collect("info"), warn: collect("warn") },
    env: {},
    workerUrl: new URL("./stallSamplerWorker.mjs", import.meta.url),
    config: {
      heartbeatIntervalMs: 100,
      pollIntervalMs: 50,
      stallThresholdMs: 800,
      minCaptureIntervalMs: 1_000,
      maxCaptureMs: 10_000,
    },
  });
  if (!handle) {
    writeReport({ ok: false, stage: "start", reason: "handle null" });
    app.exit(1);
    return;
  }
  const payloadOf = (entry) => (entry && typeof entry.args[1] === "object" ? entry.args[1] : null);
  const readyEntry = await waitForEntry(
    entries,
    (e) => payloadOf(e)?.status === "sampler_started",
    15_000,
  );
  if (!readyEntry) {
    writeReport({ ok: false, stage: "ready", entries: jsonSafe(entries) });
    handle.stop();
    app.exit(1);
    return;
  }
  // 让心跳稳定几拍再阻塞主线程。
  await sleep(400);
  emit({ type: "block_begin", blockMs: BLOCK_MS });
  const blockStartedAt = Date.now();
  let x = 0;
  while (Date.now() - blockStartedAt < BLOCK_MS) x += hotLoop(2_000);
  if (x < 0) emit({ type: "unreachable" });
  emit({ type: "block_end", elapsedMs: Date.now() - blockStartedAt });

  const reportEntry = await waitForEntry(
    entries,
    (e) =>
      payloadOf(e)?.status === "main_thread_stalled" ||
      payloadOf(e)?.status === "main_thread_stalled_sleep_suspected",
    20_000,
  );
  handle.stop();
  if (!reportEntry) {
    writeReport({ ok: false, stage: "report", entries: jsonSafe(entries) });
    app.exit(1);
    return;
  }
  writeReport({
    ok: true,
    ready: jsonSafe(readyEntry.args),
    reportLevel: reportEntry.level,
    report: jsonSafe(reportEntry.args),
  });
  app.exit(0);
});

process.on("uncaughtException", (error) => {
  emit({ type: "uncaught", error: String((error && error.stack) || error) });
  writeReport({ ok: false, stage: "uncaughtException", error: String((error && error.stack) || error) });
  app.exit(1);
});
`;
  const mainResult = await esbuild.build({
    stdin: { contents: glue, resolveDir: desktopRoot, sourcefile: "e2e-stall-main.mjs" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["electron"],
    logLevel: "silent",
  });
  writeFileSync(join(workDir, "main-bundle.mjs"), mainResult.outputFiles[0].contents);
  // Electron 靠 app 目录 package.json 定位 main；ESM 入口需要 type: module。
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify(
      { name: "stall-sampler-e2e", version: "1.0.0", type: "module", main: "main-bundle.mjs" },
      null,
      2,
    ),
    "utf8",
  );
}

async function main() {
  const runId = randomUUID();
  const workDir = mkdtempSync(join(tmpdir(), "acode-stall-e2e-"));
  const electronUserData = join(workDir, "userData");
  mkdirSync(electronUserData, { recursive: true });
  const reportPath = join(workDir, "report.json");

  let child = null;
  try {
    await buildBundles(workDir);
    const spawned = await spawnElectronMain({
      mainPath: workDir,
      workDir,
      userDataDir: electronUserData,
      runId,
      timeoutMs: overallTimeoutMs,
    });
    child = spawned.child;
    const { outcome, stdioText } = spawned;

    if (outcome.signal === "timeout") {
      record("electron-run", false, `timeout after ${overallTimeoutMs}ms`);
      logLine(
        stdioText
          .split(/\r?\n/)
          .filter((l) => l.startsWith("[E2E]"))
          .join("\n"),
      );
      return;
    }
    record("electron-run", outcome.code === 0, `exit code ${outcome.code}`);

    let report = null;
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch (error) {
        record("report-readable", false, String(error));
      }
    }
    if (!report) {
      record("report-readable", false, "report.json missing or unparsable");
      logLine(
        stdioText
          .split(/\r?\n/)
          .filter((l) => l.startsWith("[E2E]"))
          .join("\n"),
      );
      return;
    }
    record("report-readable", report.ok === true, report.ok ? "ok" : `stage=${report.stage}`);
    if (!report.ok) {
      logLine(JSON.stringify(report, null, 2));
      return;
    }

    const readyPayload = report.ready?.[1] ?? null;
    record(
      "R1-sampler-profiling-mode",
      readyPayload?.mode === "profiling",
      `mode=${readyPayload?.mode ?? "n/a"}${readyPayload?.reason ? ` reason=${readyPayload.reason}` : ""}`,
    );
    record(
      "R2-stall-reported-warn",
      report.reportLevel === "warn" && report.report?.[1]?.status === "main_thread_stalled",
      `level=${report.reportLevel} status=${report.report?.[1]?.status ?? "n/a"}`,
    );
    const payload = report.report?.[1] ?? {};
    record(
      "R3-capture-ok-with-frames",
      payload.captureStatus === "ok" && Array.isArray(payload.frames) && payload.frames.length > 0,
      `captureStatus=${payload.captureStatus} frames=${payload.frames?.length ?? 0} sampleCount=${payload.sampleCount}`,
    );
    record(
      "R4-profile-started-during-block",
      typeof payload.startLagMs === "number" &&
        typeof payload.stallMs === "number" &&
        payload.startLagMs < payload.stallMs,
      `startLagMs=${payload.startLagMs} stallMs=${payload.stallMs}`,
    );
    record(
      "R5-stall-duration-sane",
      typeof payload.stallMs === "number" &&
        payload.stallMs >= BLOCK_MS - 300 &&
        payload.stallMs <= BLOCK_MS + 1_500,
      `stallMs=${payload.stallMs} (block ${BLOCK_MS}ms, threshold 800ms + 观测粒度)`,
    );
    logLine(`[stall-e2e] frames: ${JSON.stringify(payload.frames ?? [])}`);
  } catch (error) {
    record("harness", false, String((error && error.stack) || error));
  } finally {
    await teardownElectron({ child, workDir, record });
  }
  finishReporter({ runId, mode: "fixed", checks, allOk, jsonOut });
}

await main();
