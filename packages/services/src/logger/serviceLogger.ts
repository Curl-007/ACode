import { formatLogPrefix, type TraceId } from "@acode/shared";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";
import { redactServiceLogArg } from "#src/logger/logPrivacy.js";

interface ServiceLogSink {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface ServiceLogger {
  debug: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  info: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  error: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export function createServiceLogger(
  scope: string,
  options?: {
    pid?: number;
    sink?: ServiceLogSink;
    // debug 日志默认只在本地开发运行时打印；测试/正式安装包都使用 production 构建，避免高频日志落盘。
    isDebugEnabled?: boolean | (() => boolean);
  },
): ServiceLogger {
  const pid = options?.pid ?? process.pid;
  const sink = options?.sink ?? console;
  const debugOption = options?.isDebugEnabled;
  const resolveDebugEnabled: () => boolean =
    typeof debugOption === "function"
      ? debugOption
      : typeof debugOption === "boolean"
        ? () => debugOption
        : () => isEffectiveDevelopmentNodeEnv();

  function write(
    level: "debug" | "info" | "warn" | "error",
    traceId: TraceId | undefined,
    ...args: unknown[]
  ): void {
    // 服务层日志过去常被复用到 ACode Agent 命名 logger，导致新 ACode 路径继续依赖 ACode Agent 目录。
    // 这里把通用分级日志抽到独立模块，后续删除 ACode Agent runtime 时不会牵连非 ACode Agent 服务。
    if (level === "debug" && !resolveDebugEnabled()) {
      return;
    }
    const source = traceId ? `${scope}][trace:${traceId}` : scope;
    const consoleFn =
      level === "error"
        ? sink.error
        : level === "warn"
          ? sink.warn
          : level === "debug"
            ? (sink.debug ?? sink.log)
            : sink.log;
    // 服务层日志的单一脱敏漏斗（specs/log-privacy-redaction.md services R1-R2）：
    // 字符串与 Error 在源头脱敏（覆盖 CLI/server 等非桌面 sink），对象原样透传
    // 由终局字符串化漏斗（桌面 main write / host reportHostLog）再脱敏；
    // 双层串联依赖脱敏幂等不变量。任何管线异常 → 该参数 <withheld>（fail-closed）。
    consoleFn(formatLogPrefix(source, pid), ...args.map(redactServiceLogArg));
  }

  return {
    debug: (traceId, ...args) => write("debug", traceId, ...args),
    info: (traceId, ...args) => write("info", traceId, ...args),
    warn: (traceId, ...args) => write("warn", traceId, ...args),
    error: (traceId, ...args) => write("error", traceId, ...args),
  };
}
