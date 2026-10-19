/**
 * 遥测诊断日志 sink（结构化最小面）。
 *
 * 独立成叶子文件：init.ts（静态图）与 impl.ts（懒加载图）共享同一类型，
 * 避免 init 对 impl 的任何 import（哪怕 type-only）——懒加载边界必须是
 * 物理边界（specs/otel-telemetry.md「落点与分层」）。
 */
export interface TelemetryLogSink {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
}
