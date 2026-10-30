import { formatLogPrefix } from "@acode/shared";

/**
 * HTTP server 进程日志（2026-10-30 自 http.ts 拆出，前缀与进程号口径不变）。
 * `warn` 用于安全拒绝等生产可用事件（AGENTS.md 日志分级），不打敏感数据。
 */
export const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("acode-server:http", process.pid), ...args);

export const warn = (...args: unknown[]) =>
  console.warn(formatLogPrefix("acode-server:http", process.pid), ...args);
