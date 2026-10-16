import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  aggregateStallProfileTopFrames,
  createStallCaptureTokenBucket,
  createStallSamplerCore,
} from "../src/main/stallSamplerCore.js";
import {
  isMainStallSamplerWorkerMessage,
  MAIN_STALL_SAMPLER_DEFAULT_CONFIG,
} from "../src/main/stallSamplerProtocol.js";
import {
  formatStallFrame,
  logMainStallReport,
  MAIN_STALL_LOG_STATUS,
  sanitizeStallFrameFunctionName,
  sanitizeStallFrameUrl,
  startMainStallSampler,
} from "../src/main/stallSampler.js";

/**
 * 主进程卡顿自诊断（specs/main-stall-diagnostics.md）单测：
 * 假时钟 + 模拟 profile 驱动 core 状态机；令牌桶/聚合/守卫/上报形状逐条断言；
 * main 侧用假 worker 工厂验证心跳写入、消息消费与 stop 语义。
 * 真机可行性（connectToMainThread 档位判决）由 scripts/e2e-stall-sampler.mjs 验收。
 */

const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 模拟 CPU profile：heavyParse 4 样本、tick 1 样本、(idle) 1 样本（必须被过滤）。 */
const FAKE_PROFILE = {
  nodes: [
    { id: 1, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 } },
    {
      id: 2,
      callFrame: {
        functionName: "heavyParse",
        url: "file:///home/someone/app/out/main/index.js",
        lineNumber: 41,
      },
    },
    {
      id: 3,
      callFrame: { functionName: "listOnTimeout", url: "node:internal/timers", lineNumber: 545 },
    },
  ],
  samples: [2, 2, 2, 1, 3, 2],
};

function createFakeProfiler(options = {}) {
  const calls = { start: 0, stop: 0 };
  let startDeferred = options.startDeferred ?? false;
  let stopDeferred = options.stopDeferred ?? false;
  let resolveStart = null;
  let rejectStart = null;
  let resolveStop = null;
  return {
    calls,
    profile: options.profile ?? FAKE_PROFILE,
    start() {
      calls.start += 1;
      if (options.startFails) return Promise.reject(new Error("start failed"));
      if (startDeferred) {
        return new Promise((resolve, reject) => {
          resolveStart = resolve;
          rejectStart = reject;
        });
      }
      return Promise.resolve();
    },
    stop() {
      calls.stop += 1;
      if (options.stopFails) return Promise.reject(new Error("stop failed"));
      if (stopDeferred) {
        return new Promise((resolve) => {
          resolveStop = resolve;
        });
      }
      return Promise.resolve(this.profile);
    },
    settleStart() {
      startDeferred = false;
      resolveStart?.();
    },
    failStart() {
      startDeferred = false;
      rejectStart?.(new Error("start failed"));
    },
    settleStop() {
      stopDeferred = false;
      resolveStop?.(this.profile);
    },
  };
}

function createCoreHarness({ config = {}, profiler = null } = {}) {
  const sab = new SharedArrayBuffer(8);
  const heartbeat = new BigInt64Array(sab);
  const posted = [];
  const state = { t: 0, wall: 1_700_000_000_000 };
  const merged = { ...MAIN_STALL_SAMPLER_DEFAULT_CONFIG, ...config };
  const core = createStallSamplerCore({
    heartbeat,
    profiler,
    post: (message) => posted.push(message),
    now: () => state.t,
    wallNow: () => state.wall,
    config: merged,
  });
  const harness = {
    heartbeat,
    posted,
    core,
    config: merged,
    /** 模拟 main 侧心跳写入。 */
    beat() {
      Atomics.add(heartbeat, 0, 1n);
    },
    /** 单调钟 + 墙钟同步前进并 poll 一次。 */
    advanceAndPoll(ms) {
      state.t += ms;
      state.wall += ms;
      core.poll();
    },
    /** 只跳墙钟（OS 睡眠/挂起模拟），随下一次 poll 生效。 */
    jumpWall(ms) {
      state.wall += ms;
    },
    /** 带心跳地长距离前进（避免误开停跳 episode）。 */
    advanceWithBeats(ms, beatEvery = 250) {
      for (let done = 0; done < ms; done += beatEvery) {
        harness.beat();
        harness.advanceAndPoll(beatEvery);
      }
    },
  };
  return harness;
}

/** 一次完整停跳 episode：停跳 stallMs → 判定 → 恢复；内部 flush 让 start/stop 落定。 */
async function runStallEpisode(h, { stallMs = 1_200, resumeAfter = 100 } = {}) {
  h.advanceAndPoll(stallMs);
  await flush();
  h.beat();
  h.advanceAndPoll(resumeAfter);
  await flush();
  await flush();
}

function onlyReport(posted) {
  const reports = posted.filter((m) => m.type === "stall_report");
  assert.equal(reports.length, 1, `应恰有一条 stall_report，实际 ${reports.length}`);
  return reports[0].report;
}

// ---------------------------------------------------------------------------
// 停跳判定与上报形状
// ---------------------------------------------------------------------------

test("心跳持续推进：不产生任何报告", () => {
  const h = createCoreHarness({ profiler: createFakeProfiler() });
  h.advanceWithBeats(3_000);
  assert.equal(h.posted.length, 0);
});

test("停跳超阈值后恢复：恰一条 stall_report，形状完整（captureStatus ok + frames + startLagMs）", async () => {
  const profiler = createFakeProfiler();
  const h = createCoreHarness({ profiler });
  await runStallEpisode(h, { stallMs: 1_100, resumeAfter: 500 });
  const report = onlyReport(h.posted);
  // 观测停跳 = 最后一次心跳推进（t=0）到恢复 poll（t=1600）
  assert.equal(report.stallMs, 1_600);
  assert.equal(report.sleepSuspected, false);
  assert.equal(report.captureStatus, "ok");
  assert.equal(report.startLagMs, 0); // 假时钟下 start 即时落定
  assert.equal(report.sampleCount, FAKE_PROFILE.samples.length);
  assert.deepEqual(report.frames[0], {
    fn: "heavyParse",
    url: "file:///home/someone/app/out/main/index.js",
    line: 42,
    selfMs: 4,
  });
  assert.equal(profiler.calls.start, 1);
  assert.equal(profiler.calls.stop, 1);
});

test("停跳未达阈值：不开 episode、不抓 profile", async () => {
  const profiler = createFakeProfiler();
  const h = createCoreHarness({ profiler, config: { stallThresholdMs: 1_000 } });
  h.advanceAndPoll(900);
  h.beat();
  h.advanceAndPoll(50);
  await flush();
  assert.equal(h.posted.length, 0);
  assert.equal(profiler.calls.start, 0);
});

test("profiler 缺席（heartbeat_only 档位④）：停跳事实照常上报，captureStatus unavailable", async () => {
  const h = createCoreHarness({ profiler: null });
  await runStallEpisode(h);
  const report = onlyReport(h.posted);
  assert.equal(report.captureStatus, "unavailable");
  assert.deepEqual(report.frames, []);
  assert.equal(report.startLagMs, null);
  assert.equal(report.sampleCount, null);
});

test("Profiler.start 失败：captureStatus error，停跳事实仍上报", async () => {
  const profiler = createFakeProfiler({ startFails: true });
  const h = createCoreHarness({ profiler });
  await runStallEpisode(h);
  const report = onlyReport(h.posted);
  assert.equal(report.captureStatus, "error");
  assert.equal(report.startLagMs, null);
});

test("Profiler.stop 失败：captureStatus error", async () => {
  const profiler = createFakeProfiler({ stopFails: true });
  const h = createCoreHarness({ profiler });
  await runStallEpisode(h);
  assert.equal(onlyReport(h.posted).captureStatus, "error");
});

// ---------------------------------------------------------------------------
// worker 生命周期实证坑回归：start/stop 未决时报告不得丢失
// ---------------------------------------------------------------------------

test("start 未决期间恢复：报告等 start 落定后才发出（pending promise 不丢报告）", async () => {
  const profiler = createFakeProfiler({ startDeferred: true });
  const h = createCoreHarness({ profiler });
  h.advanceAndPoll(1_200); // 判定停跳，start 挂起
  await flush();
  h.beat();
  h.advanceAndPoll(100); // 恢复：closeEpisode 挂在 startPromise 上
  await flush();
  assert.equal(h.posted.length, 0, "start 未落定不得提前报告");
  assert.equal(profiler.calls.stop, 0);
  profiler.settleStart();
  await flush();
  await flush();
  const report = onlyReport(h.posted);
  assert.equal(report.captureStatus, "ok");
  assert.equal(report.startLagMs, 100); // 恢复时刻(1300) - 判定时刻(1200)
  assert.equal(profiler.calls.stop, 1);
});

test("start 未决超过 maxCaptureMs：captureStatus timeout；迟到 start 落定后补 stop 防泄漏且不追发报告", async () => {
  const profiler = createFakeProfiler({ startDeferred: true });
  const h = createCoreHarness({ profiler, config: { maxCaptureMs: 5_000 } });
  h.advanceAndPoll(1_200); // 判定，start 挂起
  h.advanceAndPoll(5_000); // 超过 maxCaptureMs → discarded
  await flush();
  h.beat();
  h.advanceAndPoll(100); // 恢复 → timeout 报告
  await flush();
  const report = onlyReport(h.posted);
  assert.equal(report.captureStatus, "timeout");
  assert.deepEqual(report.frames, []);
  assert.equal(profiler.calls.stop, 0);
  profiler.settleStart(); // start 迟到落定
  await flush();
  await flush();
  assert.equal(profiler.calls.stop, 1, "迟到 start 必须补 stop 防采样器泄漏");
  assert.equal(
    h.posted.filter((m) => m.type === "stall_report").length,
    1,
    "补 stop 的结果必须丢弃，不得追发第二条报告",
  );
});

test("running 超过 maxCaptureMs 截断：提前 stop 落定 frames，恢复时才报告完整 stallMs", async () => {
  const profiler = createFakeProfiler({ stopDeferred: true });
  const h = createCoreHarness({ profiler, config: { maxCaptureMs: 3_000 } });
  h.advanceAndPoll(1_200); // 判定，start 即时落定
  await flush();
  h.advanceAndPoll(3_100); // running 超过 maxCaptureMs → 截断 stop（挂起）
  await flush();
  assert.equal(h.posted.length, 0, "截断 stop 未决不得报告");
  profiler.settleStop();
  await flush();
  assert.equal(h.posted.length, 0, "停跳仍在进行：截断只落定 settle，不提前报告");
  h.beat();
  h.advanceAndPoll(100); // 恢复
  await flush();
  const report = onlyReport(h.posted);
  assert.equal(report.captureStatus, "ok");
  assert.equal(report.stallMs, 4_400, "报告使用恢复时刻的完整观测停跳时长");
  assert.equal(profiler.calls.stop, 1);
});

// ---------------------------------------------------------------------------
// 睡眠/挂起分类（R5）
// ---------------------------------------------------------------------------

test("墙钟跳变的停跳 episode：sleepSuspected=true（main 侧降级 info）", async () => {
  const profiler = createFakeProfiler();
  const h = createCoreHarness({ profiler });
  h.advanceAndPoll(300);
  h.jumpWall(20_000); // OS 睡眠：墙钟大幅跳变
  h.advanceAndPoll(20_000); // 冻结恢复后的第一次 poll：单调钟同样大跳
  await flush();
  h.beat();
  h.advanceAndPoll(100);
  await flush();
  await flush();
  assert.equal(onlyReport(h.posted).sleepSuspected, true);
});

test("停跳整体发生在两次 poll 之间（合成路径）：按事实上报，unavailable + 睡眠分类", async () => {
  const h = createCoreHarness({ profiler: createFakeProfiler() });
  h.advanceAndPoll(100);
  h.jumpWall(30_000);
  h.beat();
  h.advanceAndPoll(30_000); // 恢复 poll：seq 已推进且停滞超阈值，但从未开 episode
  await flush();
  const report = onlyReport(h.posted);
  assert.equal(report.sleepSuspected, true);
  assert.equal(report.captureStatus, "unavailable");
  assert.ok(report.stallMs >= 30_000);
});

// ---------------------------------------------------------------------------
// 令牌桶（R4）
// ---------------------------------------------------------------------------

test("令牌桶：突发封顶、按最小间隔补桶、桶空降级 rate_limited 但停跳事实照报", async () => {
  const profiler = createFakeProfiler();
  const h = createCoreHarness({
    profiler,
    config: { maxBurstCaptures: 2, minCaptureIntervalMs: 600_000 },
  });
  await runStallEpisode(h);
  await runStallEpisode(h);
  await runStallEpisode(h);
  const reports = h.posted.filter((m) => m.type === "stall_report").map((m) => m.report);
  assert.equal(reports.length, 3);
  assert.deepEqual(
    reports.map((r) => r.captureStatus),
    ["ok", "ok", "rate_limited"],
  );
  assert.equal(profiler.calls.start, 2, "桶空不得再 start profiler");
  assert.equal(reports[2].stallMs, 1_300, "限流只降 profile，不降停跳事实");

  // 前进超过一个补桶间隔（期间保持心跳），第 4 个 episode 恢复可抓
  h.advanceWithBeats(600_001);
  await runStallEpisode(h);
  const fourth = h.posted.filter((m) => m.type === "stall_report").at(-1).report;
  assert.equal(fourth.captureStatus, "ok");
  assert.equal(profiler.calls.start, 3);
});

test("令牌桶纯逻辑：满桶锚点跟随、整数步长补桶、封顶", () => {
  const bucket = createStallCaptureTokenBucket(
    { maxBurstCaptures: 2, minCaptureIntervalMs: 1_000 },
    0,
  );
  assert.equal(bucket.tryConsume(0), true);
  assert.equal(bucket.tryConsume(100), true);
  assert.equal(bucket.tryConsume(200), false, "桶空拒绝");
  assert.equal(bucket.tryConsume(1_100), true, "补足一个间隔回 1 枚");
  assert.equal(bucket.tryConsume(1_200), false);
  assert.equal(bucket.tryConsume(5_000), true, "长时间累积按整数步长补");
  assert.equal(bucket.peek(), 1, "补桶封顶 maxBurst 后余 1（5000ms 只补到 2 再消耗 1）");
  assert.equal(bucket.tryConsume(5_100), true);
  assert.equal(bucket.tryConsume(5_200), false);
});

// ---------------------------------------------------------------------------
// profile 聚合（R3）
// ---------------------------------------------------------------------------

test("聚合：过滤 (idle)、按命中排序、selfMs 折算、maxFrames 截断、匿名与无 URL 帧", () => {
  const frames = aggregateStallProfileTopFrames(FAKE_PROFILE, {
    maxFrames: 8,
    samplingIntervalUs: 1_000,
  });
  assert.deepEqual(frames, [
    {
      fn: "heavyParse",
      url: "file:///home/someone/app/out/main/index.js",
      line: 42,
      selfMs: 4,
    },
    { fn: "listOnTimeout", url: "node:internal/timers", line: 546, selfMs: 1 },
  ]);

  const synthetic = aggregateStallProfileTopFrames(
    {
      nodes: [
        { id: 1, callFrame: { functionName: "", url: "", lineNumber: 7 } },
        { id: 2, callFrame: { functionName: "f", url: "node:x", lineNumber: 0 } },
        { id: 3, callFrame: { functionName: "g", url: "node:y", lineNumber: 0 } },
      ],
      samples: [1, 1, 2, 3, 3, 3],
    },
    { maxFrames: 2, samplingIntervalUs: 500 },
  );
  assert.equal(synthetic.length, 2, "maxFrames 截断");
  assert.deepEqual(synthetic[0], { fn: "g", url: "node:y", line: 1, selfMs: 2 });
  assert.deepEqual(synthetic[1], { fn: "(anonymous)", url: "", line: 0, selfMs: 1 });
});

// ---------------------------------------------------------------------------
// 消息守卫与上报（R6）
// ---------------------------------------------------------------------------

function validReport(overrides = {}) {
  return {
    stallMs: 1_500,
    sleepSuspected: false,
    captureStatus: "ok",
    startLagMs: 12,
    sampleCount: 10,
    frames: [{ fn: "heavyParse", url: "node:internal/x", line: 3, selfMs: 900 }],
    ...overrides,
  };
}

test("守卫：合法消息通过，畸形/越界载荷 fail-closed 拒绝", () => {
  assert.equal(isMainStallSamplerWorkerMessage({ type: "sampler_ready", mode: "profiling" }), true);
  assert.equal(
    isMainStallSamplerWorkerMessage({
      type: "sampler_ready",
      mode: "heartbeat_only",
      reason: "connect: x",
    }),
    true,
  );
  assert.equal(
    isMainStallSamplerWorkerMessage({ type: "stall_report", report: validReport() }),
    true,
  );
  assert.equal(
    isMainStallSamplerWorkerMessage({
      type: "stall_report",
      report: validReport({ startLagMs: null, sampleCount: null, frames: [] }),
    }),
    true,
  );
  const rejected = [
    null,
    "stall_report",
    { type: "sampler_ready" }, // 缺 mode
    { type: "sampler_ready", mode: "full" }, // mode 越出闭集
    { type: "stall_report" }, // 缺 report
    { type: "stall_report", report: validReport({ stallMs: -1 }) },
    { type: "stall_report", report: validReport({ stallMs: Number.NaN }) },
    { type: "stall_report", report: validReport({ captureStatus: "maybe" }) }, // 闭集外
    { type: "stall_report", report: validReport({ sleepSuspected: "yes" }) },
    { type: "stall_report", report: validReport({ frames: "none" }) },
    { type: "stall_report", report: validReport({ frames: [{ fn: 1 }] }) },
    {
      type: "stall_report",
      report: validReport({
        frames: Array.from({ length: 65 }, () => ({ fn: "f", url: "", line: 0, selfMs: 0 })),
      }),
    },
    { type: "unknown_event", report: validReport() },
  ];
  for (const message of rejected) {
    assert.equal(
      isMainStallSamplerWorkerMessage(message),
      false,
      `应拒绝 ${JSON.stringify(message) ?? String(message)}`,
    );
  }
});

test("帧钳制：函数名形状白名单、URL 归一（node: 原样 / file: 取 basename / 外部归一）", () => {
  assert.equal(sanitizeStallFrameFunctionName("heavyParse"), "heavyParse");
  assert.equal(sanitizeStallFrameFunctionName("(idle)"), "(idle)");
  assert.equal(sanitizeStallFrameFunctionName("bound get value"), "bound get value"); // 合法 V8 形状
  assert.equal(sanitizeStallFrameFunctionName("eval (anonymous)\nsecret"), "(clamped)");
  assert.equal(sanitizeStallFrameFunctionName("heavy parse (leak /etc/passwd)"), "(clamped)");
  assert.equal(sanitizeStallFrameFunctionName("Object.#private"), "Object.#private");
  assert.equal(sanitizeStallFrameUrl("node:internal/timers"), "node:internal/timers");
  assert.equal(
    sanitizeStallFrameUrl("file:///C:/Users/someone/app/out/main/index.js"),
    "index.js",
    "用户目录全路径不得进日志",
  );
  assert.equal(sanitizeStallFrameUrl("https://example.com/a/b.js"), "(external)");
  assert.equal(sanitizeStallFrameUrl(""), null);
  assert.equal(
    formatStallFrame({
      fn: "heavyParse",
      url: "file:///x/out/main/index.js",
      line: 42,
      selfMs: 900.4,
    }),
    "heavyParse (index.js:42) 900ms",
  );
  assert.equal(formatStallFrame({ fn: "anon", url: "", line: 0, selfMs: 12 }), "anon 12ms");
});

test("上报：真实停跳 warn + status=main_thread_stalled；睡眠疑似 info + 专属 status", () => {
  const calls = [];
  const logger = {
    info: (...args) => calls.push(["info", ...args]),
    warn: (...args) => calls.push(["warn", ...args]),
  };
  logMainStallReport(logger, validReport());
  logMainStallReport(logger, validReport({ sleepSuspected: true, captureStatus: "unavailable" }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "warn");
  assert.equal(calls[0][2].status, MAIN_STALL_LOG_STATUS.stalled);
  assert.equal(calls[0][2].stallMs, 1_500);
  assert.deepEqual(calls[0][2].frames, ["heavyParse (node:internal/x:3) 900ms"]);
  assert.equal(calls[1][0], "info");
  assert.equal(calls[1][2].status, MAIN_STALL_LOG_STATUS.stalledSleepSuspected);
});

// ---------------------------------------------------------------------------
// main 侧：kill switch、心跳写入、消息消费、stop 语义（假 worker 工厂）
// ---------------------------------------------------------------------------

class FakeWorker {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.listeners = {};
    this.terminated = 0;
    this.unrefed = false;
  }
  on(event, listener) {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  unref() {
    this.unrefed = true;
  }
  terminate() {
    this.terminated += 1;
    return Promise.resolve(0);
  }
  emit(event, ...args) {
    for (const listener of this.listeners[event] ?? []) listener(...args);
  }
}

function createCollectorLogger() {
  const calls = [];
  return {
    calls,
    logger: {
      info: (...args) => calls.push(["info", ...args]),
      warn: (...args) => calls.push(["warn", ...args]),
    },
  };
}

test("kill switch：ACODE_MAIN_STALL_SAMPLER=0 完全不启动", () => {
  const { logger } = createCollectorLogger();
  const spawned = [];
  const handle = startMainStallSampler({
    logger,
    env: { ACODE_MAIN_STALL_SAMPLER: "0" },
    workerFactory: (url, options) => {
      const worker = new FakeWorker(url, options);
      spawned.push(worker);
      return worker;
    },
  });
  assert.equal(handle, null);
  assert.equal(spawned.length, 0);
});

test("main 侧：心跳低频写入 SAB、worker 收到 data、unref；stop 幂等且停心跳", async () => {
  const { logger } = createCollectorLogger();
  const spawned = [];
  const handle = startMainStallSampler({
    logger,
    env: {},
    config: { heartbeatIntervalMs: 5 },
    workerFactory: (url, options) => {
      const worker = new FakeWorker(url, options);
      spawned.push(worker);
      return worker;
    },
  });
  assert.ok(handle);
  const [worker] = spawned;
  assert.equal(worker.unrefed, true);
  assert.deepEqual(worker.options.execArgv, []);
  assert.equal(worker.options.resourceLimits.maxOldGenerationSizeMb, 128);
  const heartbeat = new BigInt64Array(worker.options.workerData.heartbeat);
  assert.equal(Atomics.load(heartbeat, 0), 0n);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(Atomics.load(heartbeat, 0) > 0n, "心跳必须周期性写入 SAB");
  const beatsObserved = Atomics.load(heartbeat, 0);
  handle.stop();
  handle.stop(); // 幂等
  assert.equal(worker.terminated, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(Atomics.load(heartbeat, 0), beatsObserved, "stop 后心跳必须停止");
});

test("main 侧：ready/stall_report/畸形消息/意外退出的日志形状（status 闭集）", () => {
  const { calls, logger } = createCollectorLogger();
  const spawned = [];
  const handle = startMainStallSampler({
    logger,
    env: {},
    config: { heartbeatIntervalMs: 60_000 },
    workerFactory: (url, options) => {
      const worker = new FakeWorker(url, options);
      spawned.push(worker);
      return worker;
    },
  });
  const [worker] = spawned;

  worker.emit("message", { type: "sampler_ready", mode: "profiling" });
  worker.emit("message", { type: "stall_report", report: validReport() });
  worker.emit("message", { type: "stall_report", report: { bogus: true } });
  worker.emit("message", "nonsense");
  worker.emit("error", new Error("boom"));
  worker.emit("exit", 1);
  worker.emit("exit", 1); // 双 exit 只记一条

  const statuses = calls.map(([, , payload]) => payload?.status);
  assert.deepEqual(statuses, [
    MAIN_STALL_LOG_STATUS.started,
    MAIN_STALL_LOG_STATUS.stalled,
    MAIN_STALL_LOG_STATUS.protocolViolation,
    MAIN_STALL_LOG_STATUS.protocolViolation,
    MAIN_STALL_LOG_STATUS.workerExited,
  ]);
  const exitCall = calls.at(-1);
  assert.equal(exitCall[0], "warn");
  assert.equal(exitCall[2].code, 1);
  assert.equal(exitCall[2].error, "boom", "error 与 exit 合并为一条 warn");
  handle.stop();
  // 主动 stop 后 exit 不再告警
  calls.length = 0;
  worker.emit("exit", 0);
  assert.equal(calls.length, 0);
});

test("main 侧：worker 工厂抛错 → sampler_spawn_failed，返回 null 不炸 main", () => {
  const { calls, logger } = createCollectorLogger();
  const handle = startMainStallSampler({
    logger,
    env: {},
    workerFactory: () => {
      throw new Error("spawn refused");
    },
  });
  assert.equal(handle, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "warn");
  assert.equal(calls[0][2].status, MAIN_STALL_LOG_STATUS.spawnFailed);
  assert.equal(calls[0][2].error, "spawn refused");
});

// ---------------------------------------------------------------------------
// 归因深化层（R13）：enrichStallReport 附加键、向后兼容、归因保留
// ---------------------------------------------------------------------------

const PRESENCE_FIXTURE = {
  seconds_since_resume: 12,
  seconds_since_unlock: 8,
  idle_seconds: 1,
  locked: false,
  on_battery: true,
};

test("R13 向后兼容：未提供 extras 时日志 payload 与增强前逐键一致", () => {
  const { calls, logger } = createCollectorLogger();
  logMainStallReport(logger, validReport());
  assert.deepEqual(
    Object.keys(calls[0][2]).sort(),
    ["captureStatus", "frames", "sampleCount", "stallMs", "startLagMs", "status"].sort(),
  );
});

test("R13：extras 提供时以附加键带出 ipcSyncWorst/presence，缺项归 null", () => {
  const { calls, logger } = createCollectorLogger();
  logMainStallReport(logger, validReport(), {
    ipcSyncWorst: { label: "select_directory", syncMs: 480 },
    presence: PRESENCE_FIXTURE,
  });
  assert.deepEqual(calls[0][2].ipcSyncWorst, { label: "select_directory", syncMs: 480 });
  assert.deepEqual(calls[0][2].presence, PRESENCE_FIXTURE);
  logMainStallReport(logger, validReport(), {});
  assert.equal(calls[1][2].ipcSyncWorst, null);
  assert.equal(calls[1][2].presence, null);
  // 既有键不受影响
  assert.equal(calls[1][2].stallMs, 1_500);
});

test("R13：enrichStallReport 接线后随 stall_report 消费；归因保留在 handle 上", () => {
  const { calls, logger } = createCollectorLogger();
  const spawned = [];
  let consumed = 0;
  const handle = startMainStallSampler({
    logger,
    env: {},
    config: { heartbeatIntervalMs: 60_000 },
    workerFactory: (url, options) => {
      const worker = new FakeWorker(url, options);
      spawned.push(worker);
      return worker;
    },
    enrichStallReport: () => {
      consumed += 1;
      return {
        ipcSyncWorst: { label: "sync_window_tabs", syncMs: 700 },
        presence: PRESENCE_FIXTURE,
      };
    },
  });
  assert.equal(handle.getLastStallAttribution(), null, "无报告时归因为 null");

  const before = Date.now();
  spawned[0].emit("message", { type: "stall_report", report: validReport() });
  assert.equal(consumed, 1, "每次 stall_report 恰消费一次（采样即清零语义）");
  const payload = calls.at(-1)[2];
  assert.deepEqual(payload.ipcSyncWorst, { label: "sync_window_tabs", syncMs: 700 });
  assert.deepEqual(payload.presence, PRESENCE_FIXTURE);

  const attribution = handle.getLastStallAttribution();
  assert.equal(attribution.stallMs, 1_500);
  assert.equal(attribution.sleepSuspected, false);
  assert.equal(attribution.captureStatus, "ok");
  assert.deepEqual(attribution.ipcSyncWorst, { label: "sync_window_tabs", syncMs: 700 });
  assert.ok(attribution.receivedAtMs >= before && attribution.receivedAtMs <= Date.now());

  // 睡眠疑似报告同样保留（unresponsive 排除误报需要 sleepSuspected）
  spawned[0].emit("message", {
    type: "stall_report",
    report: validReport({ sleepSuspected: true, captureStatus: "unavailable" }),
  });
  assert.equal(handle.getLastStallAttribution().sleepSuspected, true);
  handle.stop();
});

test("R13 fail-open：enrichStallReport 抛错不得反杀 stall 上报本身", () => {
  const { calls, logger } = createCollectorLogger();
  const spawned = [];
  const handle = startMainStallSampler({
    logger,
    env: {},
    config: { heartbeatIntervalMs: 60_000 },
    workerFactory: (url, options) => {
      const worker = new FakeWorker(url, options);
      spawned.push(worker);
      return worker;
    },
    enrichStallReport: () => {
      throw new Error("enrichment boom");
    },
  });
  spawned[0].emit("message", { type: "stall_report", report: validReport() });
  assert.equal(calls.length, 1, "报告仍必须落日志");
  assert.equal(calls[0][2].status, MAIN_STALL_LOG_STATUS.stalled);
  assert.deepEqual(
    Object.keys(calls[0][2]).sort(),
    ["captureStatus", "frames", "sampleCount", "stallMs", "startLagMs", "status"].sort(),
    "增强失败时不出现附加键（与无回调形状一致）",
  );
  const attribution = handle.getLastStallAttribution();
  assert.equal(attribution.ipcSyncWorst, null);
  handle.stop();
});

// ---------------------------------------------------------------------------
// 接线守卫（仓库惯例：源码级钉死构建入口与生命周期接线）
// ---------------------------------------------------------------------------

test("接线守卫：tsup entry、index.ts 启动/停止、worker interval 保活纪律都在位", () => {
  const tsupSource = readFileSync(join(DESKTOP_ROOT, "tsup.config.ts"), "utf-8");
  assert.match(
    tsupSource,
    /"main\/stallSamplerWorker": "src\/main\/stallSamplerWorker\.ts"/u,
    "worker 必须是独立 tsup entry，否则打包态 new Worker(new URL()) 解析不到",
  );
  const indexSource = readFileSync(join(DESKTOP_ROOT, "src/main/index.ts"), "utf-8");
  assert.match(
    indexSource,
    // 允许后续接线追加选项（如 enrichStallReport，spec R13）：只钉死「以 logger 启动」。
    /startMainStallSampler\(\{\s*logger\b/u,
    "main 必须启动 stall-sampler",
  );
  assert.match(
    indexSource,
    /mainStallSampler\?\.stop\(\)/u,
    "prepareAppQuit 必须停止 stall-sampler",
  );
  const workerSource = readFileSync(join(DESKTOP_ROOT, "src/main/stallSamplerWorker.ts"), "utf-8");
  assert.match(
    workerSource,
    /setInterval\(\(\) => core\.poll\(\), config\.pollIntervalMs\)/u,
    "poll interval 必须常驻（worker 生命周期实证坑，见 spec 可行性判决）",
  );
  assert.match(workerSource, /connectToMainThread/u, "档位①路线必须保留");
});
