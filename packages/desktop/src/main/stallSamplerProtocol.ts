// main↔stall-sampler worker 的边界契约（specs/main-stall-diagnostics.md）。
//
// 单一所有者纪律：心跳 seq 只由 main 写入（Atomics.add），停跳检测状态机与令牌桶
// 只活在 worker 一侧；本文件只定义两侧共享的形状与默认配置，纯类型 + 纯函数，无 IO。
// 不 import electron——保持纯 Node，可被单测直接驱动、可被 e2e esbuild 打包。

/** SharedArrayBuffer 心跳布局：slot 0 = BigInt64 单调递增 beat seq。 */
export const STALL_HEARTBEAT_SLOT = 0;
export const STALL_HEARTBEAT_BYTE_LENGTH = BigInt64Array.BYTES_PER_ELEMENT;

export interface MainStallSamplerConfig {
  /** main 侧心跳写入间隔（低频 interval + Atomics.add，开销可忽略）。 */
  heartbeatIntervalMs: number;
  /** worker 轮询心跳的间隔。 */
  pollIntervalMs: number;
  /** 心跳停跳超过该时长判定为一次 stall episode。 */
  stallThresholdMs: number;
  /** 令牌桶补充间隔：每经过该时长补 1 枚 capture 令牌。 */
  minCaptureIntervalMs: number;
  /** 令牌桶容量（突发抓取上限）。 */
  maxBurstCaptures: number;
  /** 单次 capture 的最长窗口：start 未决超时 / running 截断都以它为界。 */
  maxCaptureMs: number;
  /** V8 CPU profiler 采样间隔（微秒）。 */
  samplingIntervalUs: number;
  /** 聚合上报的 top 帧数量上限。 */
  maxFrames: number;
}

/** 默认值来自外部范式实测形态；粒度上界 = heartbeatInterval + pollInterval（spec R2）。 */
export const MAIN_STALL_SAMPLER_DEFAULT_CONFIG: Readonly<MainStallSamplerConfig> = Object.freeze({
  heartbeatIntervalMs: 250,
  pollIntervalMs: 100,
  stallThresholdMs: 1_000,
  minCaptureIntervalMs: 300_000,
  maxBurstCaptures: 3,
  maxCaptureMs: 30_000,
  samplingIntervalUs: 1_000,
  maxFrames: 8,
});

/** 环境变量 kill switch：值为 "0" 时完全禁用（spec R7）。 */
export const MAIN_STALL_SAMPLER_ENV_DISABLE_KEY = "ACODE_MAIN_STALL_SAMPLER";

export interface MainStallSamplerWorkerData {
  heartbeat: SharedArrayBuffer;
  config: MainStallSamplerConfig;
}

/** worker 运行模式：inspector 路线任一环节失败降级为 heartbeat_only（spec R8）。 */
export type MainStallSamplerMode = "profiling" | "heartbeat_only";

/** capture 结果闭集（spec R6）。 */
export type MainStallCaptureStatus = "ok" | "rate_limited" | "unavailable" | "error" | "timeout";

export interface MainStallFrame {
  fn: string;
  url: string;
  line: number;
  selfMs: number;
}

export interface MainStallReport {
  /** 观测停跳时长（粒度上界见 spec R2），非精确阻塞时长。 */
  stallMs: number;
  /** 墙钟跳变分类：疑似 OS 睡眠/挂起（spec R5），main 侧降为 info 级。 */
  sleepSuspected: boolean;
  captureStatus: MainStallCaptureStatus;
  /** 判定停跳 → Profiler.start 落定的滞后；诊断命令是否在阻塞期间落地。 */
  startLagMs: number | null;
  sampleCount: number | null;
  frames: MainStallFrame[];
}

export type MainStallSamplerWorkerMessage =
  | { type: "sampler_ready"; mode: MainStallSamplerMode; reason?: string }
  | { type: "stall_report"; report: MainStallReport };

const CAPTURE_STATUS_VALUES: ReadonlySet<string> = new Set<MainStallCaptureStatus>([
  "ok",
  "rate_limited",
  "unavailable",
  "error",
  "timeout",
]);

/** 防御性上限：worker 已按 maxFrames 截断，这里再兜一层畸形载荷。 */
const MAX_REPORT_FRAMES = 64;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMainStallFrame(value: unknown): value is MainStallFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<MainStallFrame>;
  return (
    typeof frame.fn === "string" &&
    typeof frame.url === "string" &&
    isFiniteNumber(frame.line) &&
    isFiniteNumber(frame.selfMs)
  );
}

function isMainStallReport(value: unknown): value is MainStallReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<MainStallReport>;
  if (!isFiniteNumber(report.stallMs) || report.stallMs < 0) return false;
  if (typeof report.sleepSuspected !== "boolean") return false;
  if (typeof report.captureStatus !== "string") return false;
  if (!CAPTURE_STATUS_VALUES.has(report.captureStatus)) return false;
  if (!(report.startLagMs === null || isFiniteNumber(report.startLagMs))) return false;
  if (!(report.sampleCount === null || isFiniteNumber(report.sampleCount))) return false;
  if (!Array.isArray(report.frames) || report.frames.length > MAX_REPORT_FRAMES) return false;
  return report.frames.every(isMainStallFrame);
}

/**
 * worker → main 消息的运行时形状守卫（fail-closed）：畸形消息一律按不匹配处理，
 * 调用方丢弃并 warn（spec R6）。
 */
export function isMainStallSamplerWorkerMessage(
  value: unknown,
): value is MainStallSamplerWorkerMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { type?: unknown; mode?: unknown; reason?: unknown; report?: unknown };
  if (message.type === "sampler_ready") {
    return (
      (message.mode === "profiling" || message.mode === "heartbeat_only") &&
      (message.reason === undefined || typeof message.reason === "string")
    );
  }
  if (message.type === "stall_report") {
    return isMainStallReport(message.report);
  }
  return false;
}
