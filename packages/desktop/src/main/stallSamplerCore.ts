// stall-sampler 的纯逻辑核心（specs/main-stall-diagnostics.md R2-R5）：
// 停跳检测状态机 + capture 生命周期 + 令牌桶 + profile 聚合。
//
// 全部外部依赖（时钟、profiler、消息出口、心跳视图）经构造参数注入，
// 单测用假时钟与模拟 profile 直接驱动（tests/main-stall-diagnostics.test.mjs）。
// 本文件无 IO、不 import electron / node:inspector。
import {
  STALL_HEARTBEAT_SLOT,
  type MainStallCaptureStatus,
  type MainStallFrame,
  type MainStallSamplerConfig,
  type MainStallSamplerWorkerMessage,
} from "./stallSamplerProtocol.js";

/** V8 CPU profile 的最小结构面（node:inspector 的 Profiler.Profile 与之结构兼容）。 */
export interface StallSamplerCpuProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}

export interface StallSamplerCpuProfile {
  nodes: StallSamplerCpuProfileNode[];
  samples?: number[];
}

/** 档位①的 profiler 端口；null 表示 inspector 路线不可用，降级 heartbeat_only（R8）。 */
export interface StallSamplerProfilerPort {
  start(): Promise<void>;
  stop(): Promise<StallSamplerCpuProfile>;
}

export interface StallSamplerCoreDeps {
  heartbeat: BigInt64Array;
  profiler: StallSamplerProfilerPort | null;
  post: (message: MainStallSamplerWorkerMessage) => void;
  /** 单调时钟（performance.now）。 */
  now: () => number;
  /** 墙钟（Date.now），仅用于睡眠/挂起跳变分类（R5）。 */
  wallNow: () => number;
  config: MainStallSamplerConfig;
}

export interface StallSamplerCore {
  poll(): void;
  dispose(): void;
}

const IDLE_FRAME_NAME = "(idle)";
/** 墙钟单步跳变超过 max(4×pollInterval, 该值) 判为睡眠/挂起（R5）。 */
const SLEEP_WALL_JUMP_MIN_MS = 2_000;

type CaptureSettle = {
  status: MainStallCaptureStatus;
  startLagMs: number | null;
  sampleCount: number | null;
  frames: MainStallFrame[];
};

interface ProfilingCapture {
  kind: "profiling";
  detectAt: number;
  startLagMs: number | null;
  startedAt: number | null;
  /** start 未决超时（R3）：放弃等待，start 事后落定时补 stop 防采样器泄漏。 */
  discarded: boolean;
  stopRequested: boolean;
  /** Profiler.stop 只允许发起一次（截断路径与恢复路径可能都触发 beginStop）。 */
  stopStarted: boolean;
  settle: CaptureSettle | null;
  startPromise: Promise<void>;
}

interface PlainCapture {
  kind: "rate_limited" | "unavailable";
}

interface StallEpisode {
  /** episode 锚点：最后一次观测到心跳推进的单调时刻。 */
  anchorAt: number;
  sleepSuspected: boolean;
  capture: ProfilingCapture | PlainCapture | null;
  reportPosted: boolean;
}

/**
 * top 帧聚合（R3）：按 sample 命中数排序取前 maxFrames，过滤 (idle)，
 * selfMs = round(hits × samplingIntervalUs / 1000)。纯函数。
 */
export function aggregateStallProfileTopFrames(
  profile: StallSamplerCpuProfile,
  config: Pick<MainStallSamplerConfig, "maxFrames" | "samplingIntervalUs">,
): MainStallFrame[] {
  const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
  const byFrame = new Map<string, MainStallFrame>();
  for (const sampleId of profile.samples ?? []) {
    const callFrame = nodesById.get(sampleId)?.callFrame;
    if (!callFrame || callFrame.functionName === IDLE_FRAME_NAME) continue;
    const fn = callFrame.functionName || "(anonymous)";
    const url = callFrame.url ?? "";
    const line = url ? callFrame.lineNumber + 1 : 0;
    const key = `${fn}\n${url}\n${line}`;
    const existing = byFrame.get(key);
    if (existing) {
      existing.selfMs += config.samplingIntervalUs / 1_000;
    } else {
      byFrame.set(key, { fn, url, line, selfMs: config.samplingIntervalUs / 1_000 });
    }
  }
  return [...byFrame.values()]
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, config.maxFrames)
    .map((frame) => ({ ...frame, selfMs: Math.round(frame.selfMs) }));
}

/**
 * 令牌桶（R4）：maxBurst 容量，每 minCaptureIntervalMs 补 1 枚。
 * 补桶锚点推进方式：满桶时锚点跟随当前时刻，未满时按整数步长推进，
 * 保证长期速率精确等于 1/minCaptureIntervalMs。
 */
export interface StallCaptureTokenBucket {
  tryConsume(nowMs: number): boolean;
  peek(): number;
}

export function createStallCaptureTokenBucket(
  config: Pick<MainStallSamplerConfig, "maxBurstCaptures" | "minCaptureIntervalMs">,
  initialNowMs: number,
): StallCaptureTokenBucket {
  let tokens = config.maxBurstCaptures;
  let refillAnchorAt = initialNowMs;
  const refill = (nowMs: number): void => {
    if (tokens >= config.maxBurstCaptures) {
      refillAnchorAt = nowMs;
      return;
    }
    const gained = Math.floor((nowMs - refillAnchorAt) / config.minCaptureIntervalMs);
    if (gained <= 0) return;
    tokens = Math.min(config.maxBurstCaptures, tokens + gained);
    refillAnchorAt =
      tokens >= config.maxBurstCaptures
        ? nowMs
        : refillAnchorAt + gained * config.minCaptureIntervalMs;
  };
  return {
    tryConsume(nowMs) {
      refill(nowMs);
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    peek() {
      return tokens;
    },
  };
}

export function createStallSamplerCore(deps: StallSamplerCoreDeps): StallSamplerCore {
  const { heartbeat, profiler, post, now, wallNow, config } = deps;
  const tokens = createStallCaptureTokenBucket(config, now());

  let disposed = false;
  let lastSeq = Atomics.load(heartbeat, STALL_HEARTBEAT_SLOT);
  let lastChangeAt = now();
  let lastWallAt = wallNow();
  let episode: StallEpisode | null = null;
  /** 上一 episode 的 stop/报告尚未落定：抑制新开 episode（profiler 忙）。 */
  let reportInFlight = false;

  const sleepJumpThresholdMs = Math.max(4 * config.pollIntervalMs, SLEEP_WALL_JUMP_MIN_MS);

  const postReport = (
    ep: StallEpisode,
    stallMs: number,
    settle: CaptureSettle | null,
    fallback: MainStallCaptureStatus,
  ): void => {
    if (ep.reportPosted || disposed) return;
    ep.reportPosted = true;
    reportInFlight = false;
    post({
      type: "stall_report",
      report: {
        stallMs: Math.round(stallMs),
        sleepSuspected: ep.sleepSuspected,
        captureStatus: settle?.status ?? fallback,
        startLagMs: settle?.startLagMs ?? null,
        sampleCount: settle?.sampleCount ?? null,
        frames: settle?.frames ?? [],
      },
    });
  };

  /**
   * 发起 Profiler.stop 并把聚合结果存进 capture.settle。
   * 只有 episode 已收口（stopRequested）才立即报告；maxCaptureMs 截断路径
   * 在停跳仍在进行时只落定 settle，等恢复时由 closeEpisode 报告完整 stallMs。
   */
  const beginStop = (ep: StallEpisode, capture: ProfilingCapture, stallMs: number): void => {
    if (!profiler || capture.stopStarted) return;
    capture.stopStarted = true;
    profiler.stop().then(
      (profile) => {
        if (capture.discarded || capture.settle) return;
        capture.settle = {
          status: "ok",
          startLagMs: capture.startLagMs,
          sampleCount: profile.samples?.length ?? null,
          frames: aggregateStallProfileTopFrames(profile, config),
        };
        if (capture.stopRequested) postReport(ep, stallMs, capture.settle, "error");
      },
      () => {
        if (capture.discarded || capture.settle) return;
        capture.settle = {
          status: "error",
          startLagMs: capture.startLagMs,
          sampleCount: null,
          frames: [],
        };
        if (capture.stopRequested) postReport(ep, stallMs, capture.settle, "error");
      },
    );
  };

  /** episode 结束时收口 capture：按 start/stop 的落定状态决定立即报告还是等 promise。 */
  const closeEpisode = (ep: StallEpisode, stallMs: number): void => {
    const capture = ep.capture;
    if (!capture || capture.kind !== "profiling") {
      postReport(ep, stallMs, null, capture?.kind ?? "unavailable");
      return;
    }
    capture.stopRequested = true;
    if (capture.discarded) {
      postReport(
        ep,
        stallMs,
        { status: "timeout", startLagMs: null, sampleCount: null, frames: [] },
        "timeout",
      );
      return;
    }
    if (capture.settle) {
      // maxCaptureMs 截断已提前 stop 并落定（R3），直接报告。
      postReport(ep, stallMs, capture.settle, "error");
      return;
    }
    reportInFlight = true;
    if (capture.startedAt !== null) {
      beginStop(ep, capture, stallMs);
      return;
    }
    // start 仍未决：等它落定（成功→stop→报告；失败→error 报告）。
    // 实验实证（spec 可行性判决）：pending 的 inspector promise 不保 worker 事件循环，
    // 保活由 worker entry 的 poll interval 负责，直到本报告发出。
    capture.startPromise.then(
      () => {
        if (capture.discarded || capture.settle) return;
        if (capture.startedAt !== null) beginStop(ep, capture, stallMs);
      },
      () => {
        if (capture.discarded || capture.settle) return;
        capture.settle = { status: "error", startLagMs: null, sampleCount: null, frames: [] };
        postReport(ep, stallMs, capture.settle, "error");
      },
    );
  };

  const openEpisode = (at: number, sleepSuspected: boolean): void => {
    const ep: StallEpisode = {
      anchorAt: lastChangeAt,
      sleepSuspected,
      capture: null,
      reportPosted: false,
    };
    episode = ep;
    if (!profiler) {
      ep.capture = { kind: "unavailable" };
      return;
    }
    if (!tokens.tryConsume(at)) {
      ep.capture = { kind: "rate_limited" };
      return;
    }
    const capture: ProfilingCapture = {
      kind: "profiling",
      detectAt: at,
      startLagMs: null,
      startedAt: null,
      discarded: false,
      stopRequested: false,
      stopStarted: false,
      settle: null,
      startPromise: Promise.resolve(),
    };
    ep.capture = capture;
    capture.startPromise = profiler.start().then(
      () => {
        if (capture.discarded) {
          // 超时放弃后 start 迟到落定：立即补 stop 防采样器泄漏，结果丢弃（R3）。
          void profiler.stop().catch(() => {});
          return;
        }
        capture.startLagMs = Math.round(now() - capture.detectAt);
        capture.startedAt = now();
        // 恢复先于 start 落定时，closeEpisode 挂在 startPromise 上的链会接管 stop→报告
        // （本 handler 先注册先执行，startedAt 已就位）；这里不得抢先 stop。
        if (capture.stopRequested) return;
        if (episode !== ep) {
          // 防御：episode 被 dispose 收走而 stop 链不存在，停掉在跑的采样。
          void profiler.stop().catch(() => {});
        }
      },
      () => {
        if (capture.discarded || capture.settle) return;
        capture.settle = { status: "error", startLagMs: null, sampleCount: null, frames: [] };
        if (capture.stopRequested)
          postReport(ep, Math.round(now() - ep.anchorAt), capture.settle, "error");
      },
    );
  };

  return {
    poll() {
      if (disposed) return;
      const seq = Atomics.load(heartbeat, STALL_HEARTBEAT_SLOT);
      const at = now();
      const wall = wallNow();
      const sleepJump = wall - lastWallAt > sleepJumpThresholdMs;
      lastWallAt = wall;

      if (seq !== lastSeq) {
        lastSeq = seq;
        const stalledFor = at - lastChangeAt;
        lastChangeAt = at;
        if (episode) {
          const ep = episode;
          episode = null;
          if (sleepJump) ep.sleepSuspected = true;
          closeEpisode(ep, stalledFor);
          return;
        }
        if (!reportInFlight && stalledFor >= config.stallThresholdMs) {
          // 停跳发生并结束于两次 poll 之间（poll 曾被冻结——几乎只可能是 OS 睡眠恢复）。
          // 无法再抓 profile，按事实上报（spec R2/R5）；分类靠墙钟跳变。
          postReport(
            {
              anchorAt: at - stalledFor,
              sleepSuspected: sleepJump,
              capture: null,
              reportPosted: false,
            },
            stalledFor,
            null,
            "unavailable",
          );
        }
        return;
      }

      if (episode) episode.sleepSuspected ||= sleepJump;
      if (!episode && !reportInFlight && at - lastChangeAt >= config.stallThresholdMs) {
        openEpisode(at, sleepJump);
        return;
      }
      const capture = episode?.capture;
      if (!episode || !capture || capture.kind !== "profiling" || capture.discarded) return;
      if (capture.startedAt === null) {
        // start 未决超时（R3）：放弃本次 capture，episode 继续等到恢复才报告。
        if (at - capture.detectAt >= config.maxCaptureMs) capture.discarded = true;
        return;
      }
      if (capture.settle === null && at - capture.startedAt >= config.maxCaptureMs) {
        // running 截断（R3）：提前 stop 落定 frames，恢复时直接报告。
        beginStop(episode, capture, at - episode.anchorAt);
      }
    },
    dispose() {
      disposed = true;
      episode = null;
      reportInFlight = false;
    },
  };
}
