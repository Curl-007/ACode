// ============================================================
// Memory Pressure Source - 内存压力源与 cap 公式（WI-E4）
// (apps/acode-cli/specs/cli-governor.md R1/R5)
// ============================================================
// 压力源抽象为可注入接口：native 事件（未来注入位）与轮询采样统一走
// MemoryPressureSource.subscribe；core 只消费接口，desktop 侧同阈值独立实现
// （跨进程不转发，spec 非目标 #1）。cap 公式的 RAM 读取平台裁决：CLI 侧统一
// node:os.totalmem()（三平台一致语义：物理内存总量）。

import { freemem, totalmem } from "node:os";

/** cap 地板：再小的机器也允许 6 个在册会话（蓝本 Math.max(6, …)）。 */
const SESSION_CAP_MINIMUM = 6;
/** cap 步进：每 3GiB 物理内存 +1 会话（蓝本 totalmem/(3*1024^3)）。 */
const SESSION_CAP_MEMORY_STEP_BYTES = 3 * 1024 ** 3;
/** 缺省轮询源采样间隔（蓝本 pollIntervalMs ?? 1e4）。 */
const PRESSURE_POLL_INTERVAL_MS = 10_000;
/** free-ratio warning 阈值：5%（蓝本 tp）。 */
const PRESSURE_WARNING_RATIO = 0.05;
/** free-ratio critical 阈值：2%（蓝本 np）。 */
const PRESSURE_CRITICAL_RATIO = 0.02;

/** cap 公式（spec R1）：max(6, floor(RAM/3GiB))。 */
export function computeSessionCap(totalMemoryBytes: number): number {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return SESSION_CAP_MINIMUM;
  }
  return Math.max(
    SESSION_CAP_MINIMUM,
    Math.floor(totalMemoryBytes / SESSION_CAP_MEMORY_STEP_BYTES),
  );
}

export type MemoryPressureLevel = "warning" | "critical";

/**
 * 可注入压力源：native 事件（未来注入位）与轮询采样统一走本接口。
 * level=null 表示压力解除（normal）。返回退订函数（轮询实现须在退订时清定时器）。
 */
export interface MemoryPressureSource {
  subscribe(listener: (level: MemoryPressureLevel | null) => void): () => void;
}

/** free-ratio → level 的纯判定（阈值缺省 5%/2%，desktop 侧同阈值独立实现）。 */
export function evaluateMemoryPressureLevel(
  freeMemoryRatio: number,
  thresholds: { warningRatio?: number; criticalRatio?: number } = {},
): MemoryPressureLevel | null {
  const warningRatio = thresholds.warningRatio ?? PRESSURE_WARNING_RATIO;
  const criticalRatio = thresholds.criticalRatio ?? PRESSURE_CRITICAL_RATIO;
  if (!Number.isFinite(freeMemoryRatio)) return null;
  if (freeMemoryRatio < criticalRatio) return "critical";
  if (freeMemoryRatio < warningRatio) return "warning";
  return null;
}

export interface PollingMemoryPressureSourceOptions {
  /** 缺省 os.freemem()/os.totalmem()（平台裁决见 spec R5）。 */
  getFreeMemoryRatio?: () => number;
  intervalMs?: number;
  warningRatio?: number;
  criticalRatio?: number;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
}

/**
 * 缺省轮询源（spec R5）：每 intervalMs 采样 free-ratio 折算 level。
 * 定时器 unref（不阻塞进程退出）；读取抛错 → 视为压力解除（null）且 warn
 * 只记一次（蓝本 memoryReadFailureLogged 同款）。
 * 蓝本偏差：蓝本在 darwin 跳过轮询（依赖 native 事件但接线未传源，darwin
 * 实际无信号）——移植裁决为全平台轮询，native 事件留 subscribe 注入位。
 */
export function createPollingMemoryPressureSource(
  options: PollingMemoryPressureSourceOptions = {},
): MemoryPressureSource {
  const getFreeMemoryRatio = options.getFreeMemoryRatio ?? (() => freemem() / totalmem());
  const intervalMs = options.intervalMs ?? PRESSURE_POLL_INTERVAL_MS;
  const thresholds = {
    ...(options.warningRatio === undefined ? {} : { warningRatio: options.warningRatio }),
    ...(options.criticalRatio === undefined ? {} : { criticalRatio: options.criticalRatio }),
  };
  return {
    subscribe(listener) {
      let readFailureLogged = false;
      const timer = setInterval(() => {
        let ratio: number;
        try {
          ratio = getFreeMemoryRatio();
        } catch (error) {
          if (!readFailureLogged) {
            readFailureLogged = true;
            options.logger?.warn?.(
              "[cli-governor] getFreeMemoryRatio failed; treating memory pressure as clear",
              { error: String(error) },
            );
          }
          listener(null);
          return;
        }
        listener(evaluateMemoryPressureLevel(ratio, thresholds));
      }, intervalMs);
      // Node Timeout 才有 unref；被替身调度器包过时跳过（防御性 duck-typing，蓝本同款）。
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref?: () => void }).unref?.();
      }
      return () => {
        clearInterval(timer);
      };
    },
  };
}
