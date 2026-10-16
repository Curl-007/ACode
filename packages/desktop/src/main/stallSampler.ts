// main 侧 stall-sampler（specs/main-stall-diagnostics.md）：拉起监控 worker、写心跳、
// 消费 stall_report → 结构化日志。不 import electron（纯 Node），workerUrl/logger/env
// 全部可注入，单测与 e2e 直接驱动。
import { Worker } from "node:worker_threads";
import type { IpcSyncWorstOffender } from "./ipcSyncTiming.js";
import type { PresenceSnapshotPayload } from "./presenceSnapshot.js";
import {
  isMainStallSamplerWorkerMessage,
  MAIN_STALL_SAMPLER_DEFAULT_CONFIG,
  MAIN_STALL_SAMPLER_ENV_DISABLE_KEY,
  STALL_HEARTBEAT_BYTE_LENGTH,
  STALL_HEARTBEAT_SLOT,
  type MainStallCaptureStatus,
  type MainStallFrame,
  type MainStallReport,
  type MainStallSamplerConfig,
  type MainStallSamplerWorkerData,
} from "./stallSamplerProtocol.js";

export interface MainStallSamplerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** 监控 worker 的最小结构面：真实 node:worker_threads Worker 结构兼容，单测注入假实现。 */
export interface MainStallSamplerWorkerLike {
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  unref(): void;
  terminate(): unknown;
}

export type MainStallSamplerWorkerFactory = (
  url: URL,
  options: {
    workerData: MainStallSamplerWorkerData;
    execArgv: string[];
    resourceLimits: { maxOldGenerationSizeMb: number };
  },
) => MainStallSamplerWorkerLike;

export interface MainStallSamplerHandle {
  /** 幂等：清心跳 timer + terminate worker；退出路径与 dispose 汇聚点共用。 */
  stop(): void;
  /**
   * 最近一次 stall_report 的精简归因（R13）：供 unresponsive 聚合报告读取最近
   * 60s 内的 main 卡顿事实。从未收到报告 ⇒ null。
   */
  getLastStallAttribution(): MainStallLastAttribution | null;
}

/** R13：stall_report 到达时 main 侧附加的归因键（依赖注入，本文件不接 electron）。 */
export interface MainStallReportExtras {
  /** R9：采样窗口内同步 IPC worst-offender（消费即清零后的最后一眼）。 */
  ipcSyncWorst?: IpcSyncWorstOffender | null;
  /** R10：报告到达时刻的 presence 快照。 */
  presence?: PresenceSnapshotPayload | null;
}

/** handle 保留的最近 stall 归因（unresponsiveReport.ts 的 LastStallAttribution 同形）。 */
export interface MainStallLastAttribution {
  stallMs: number;
  sleepSuspected: boolean;
  captureStatus: MainStallCaptureStatus;
  ipcSyncWorst: IpcSyncWorstOffender | null;
  /** 接收墙钟时刻（Date.now 系），归因窗口按它计算。 */
  receivedAtMs: number;
}

export interface StartMainStallSamplerOptions {
  logger: MainStallSamplerLogger;
  /** 缺省解析打包产物同目录的 stallSamplerWorker.js（与 storageScanWorkerClient 同款）。 */
  workerUrl?: URL;
  config?: Partial<MainStallSamplerConfig>;
  env?: Record<string, string | undefined>;
  /** 单测注入假 worker；缺省为真实 node:worker_threads Worker。 */
  workerFactory?: MainStallSamplerWorkerFactory;
  /**
   * R13 归因增强回调：每次 stall_report 到达时调用，返回值作为日志附加键。
   * 接线（index.ts）在这里组合 presence 快照与 IPC worst-offender 消费。
   * 未提供时日志 payload 与增强前逐键一致（向后兼容守卫）。
   */
  enrichStallReport?: () => MainStallReportExtras;
}

/**
 * 日志 `status` 闭集（spec R6）：与仓内既有业务 status 值不撞名，
 * 全部带 sampler_/main_thread_ 前缀域。
 */
export const MAIN_STALL_LOG_STATUS = {
  started: "sampler_started",
  spawnFailed: "sampler_spawn_failed",
  protocolViolation: "sampler_protocol_violation",
  workerExited: "sampler_worker_exited",
  stalled: "main_thread_stalled",
  stalledSleepSuspected: "main_thread_stalled_sleep_suspected",
} as const;

/** 函数名钳制形状：合法 JS 函数名/(idle) 类占位；其余归一为 (clamped)，不进日志。 */
const FRAME_FN_PATTERN = /^(?:\([a-z ]+\)|(?:bound )*(?:(?:get|set) )?[\w$<>[\].#-]{1,100})$/u;
const FRAME_URL_MAX_CHARS = 120;

export function sanitizeStallFrameFunctionName(fn: string): string {
  return FRAME_FN_PATTERN.test(fn) ? fn : "(clamped)";
}

/**
 * URL 归一（spec R6）：profile 帧可能含用户目录全路径，日志不落全路径。
 * - `node:*` 原样（截断）；
 * - `file:`/裸路径 → basename；
 * - 其余带 scheme 的外部 URL → `(external)`；
 * - 空 → null（帧无位置信息）。
 */
export function sanitizeStallFrameUrl(url: string): string | null {
  if (!url) return null;
  if (url.startsWith("node:")) return url.slice(0, FRAME_URL_MAX_CHARS);
  const schemeEnd = url.indexOf("://");
  if (schemeEnd >= 0 && !url.startsWith("file://")) return "(external)";
  const withoutQuery = url.split(/[?#]/u)[0] ?? url;
  const basename = withoutQuery.slice(
    Math.max(withoutQuery.lastIndexOf("/"), withoutQuery.lastIndexOf("\\")) + 1,
  );
  return basename ? basename.slice(0, FRAME_URL_MAX_CHARS) : "(external)";
}

export function formatStallFrame(frame: MainStallFrame): string {
  const fn = sanitizeStallFrameFunctionName(frame.fn);
  const url = sanitizeStallFrameUrl(frame.url);
  const location = url ? ` (${url}:${frame.line})` : "";
  return `${fn}${location} ${Math.round(frame.selfMs)}ms`;
}

/**
 * 报告 → 结构化日志：真实停跳 warn，疑似睡眠 info（spec R5/R6）。
 * extras 提供时以附加键带出（R13 向后兼容：未提供时 payload 与增强前逐键一致）。
 */
export function logMainStallReport(
  logger: MainStallSamplerLogger,
  report: MainStallReport,
  extras?: MainStallReportExtras,
): void {
  const payload = {
    status: report.sleepSuspected
      ? MAIN_STALL_LOG_STATUS.stalledSleepSuspected
      : MAIN_STALL_LOG_STATUS.stalled,
    stallMs: report.stallMs,
    captureStatus: report.captureStatus,
    startLagMs: report.startLagMs,
    sampleCount: report.sampleCount,
    frames: report.frames.map(formatStallFrame),
    ...(extras
      ? { ipcSyncWorst: extras.ipcSyncWorst ?? null, presence: extras.presence ?? null }
      : {}),
  };
  const write = report.sleepSuspected ? logger.info : logger.warn;
  write("[main-stall] main thread stalled", payload);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 启动主进程卡顿自诊断（spec R7）：kill switch `ACODE_MAIN_STALL_SAMPLER=0` 时返回
 * null。启动即生效（含 app ready 前的启动阶段）；worker 意外退出不重启（fail-open，
 * 诊断设施不得演化为重启循环），仅记 `sampler_worker_exited`。
 */
export function startMainStallSampler(
  options: StartMainStallSamplerOptions,
): MainStallSamplerHandle | null {
  const env = options.env ?? process.env;
  if (env[MAIN_STALL_SAMPLER_ENV_DISABLE_KEY] === "0") return null;
  const logger = options.logger;
  const config: MainStallSamplerConfig = {
    ...MAIN_STALL_SAMPLER_DEFAULT_CONFIG,
    ...options.config,
  };

  const heartbeatBuffer = new SharedArrayBuffer(STALL_HEARTBEAT_BYTE_LENGTH);
  const heartbeat = new BigInt64Array(heartbeatBuffer);
  const workerUrl = options.workerUrl ?? new URL("./stallSamplerWorker.js", import.meta.url);

  const workerFactory =
    options.workerFactory ?? ((url, factoryOptions) => new Worker(url, factoryOptions));
  let worker: MainStallSamplerWorkerLike;
  try {
    worker = workerFactory(workerUrl, {
      workerData: { heartbeat: heartbeatBuffer, config },
      // 清空 execArgv：worker 不继承 --inspect 之类调试参数（外部范式同款防御）。
      execArgv: [],
      // 常驻监控线程预算钉死，防诊断设施自身膨胀（外部范式同款限额）。
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
  } catch (error) {
    logger.warn("[main-stall] sampler worker spawn failed", {
      status: MAIN_STALL_LOG_STATUS.spawnFailed,
      error: errorMessage(error),
    });
    return null;
  }

  let stopped = false;
  let exitLogged = false;
  let lastWorkerError: string | null = null;
  // R13 归因保留：挂在 handle（每次 start 一份），不引入全局可变状态。
  let lastStallAttribution: MainStallLastAttribution | null = null;

  // 心跳：main 是 beat seq 的唯一写入方（spec R1）。低频 interval + Atomics.add，
  // unref 后不阻止进程退出。
  const heartbeatTimer = setInterval(() => {
    Atomics.add(heartbeat, STALL_HEARTBEAT_SLOT, 1n);
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref();
  worker.unref();

  worker.on("message", (message: unknown) => {
    if (!isMainStallSamplerWorkerMessage(message)) {
      // fail-closed：畸形消息丢弃，不回显载荷（日志纪律）。
      logger.warn("[main-stall] dropped malformed worker message", {
        status: MAIN_STALL_LOG_STATUS.protocolViolation,
      });
      return;
    }
    if (message.type === "sampler_ready") {
      logger.info("[main-stall] sampler ready", {
        status: MAIN_STALL_LOG_STATUS.started,
        mode: message.mode,
        ...(message.reason ? { reason: message.reason } : {}),
      });
      return;
    }
    // R13：归因增强 fail-open——增强回调抛错不得反杀 stall 上报本身。
    let extras: MainStallReportExtras | undefined;
    if (options.enrichStallReport) {
      try {
        extras = options.enrichStallReport();
      } catch {
        extras = undefined;
      }
    }
    logMainStallReport(logger, message.report, extras);
    lastStallAttribution = {
      stallMs: message.report.stallMs,
      sleepSuspected: message.report.sleepSuspected,
      captureStatus: message.report.captureStatus,
      ipcSyncWorst: extras?.ipcSyncWorst ?? null,
      receivedAtMs: Date.now(),
    };
  });
  worker.on("error", (error) => {
    lastWorkerError = errorMessage(error);
  });
  worker.on("exit", (code) => {
    // error 之后必跟 exit：合并成一条，避免双 warn。主动 stop 不记。
    if (stopped || exitLogged) return;
    exitLogged = true;
    logger.warn("[main-stall] sampler worker exited unexpectedly", {
      status: MAIN_STALL_LOG_STATUS.workerExited,
      code,
      ...(lastWorkerError ? { error: lastWorkerError } : {}),
    });
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      void worker.terminate();
    },
    getLastStallAttribution() {
      return lastStallAttribution;
    },
  };
}
