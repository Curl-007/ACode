// Harness SDK 错误分类与断连归因。
// 参照 jcode (MIT) sdk 的「断连人话归因」方法论，自撰实现。

import { HARNESS_MAX_LINE_LENGTH } from "@acode/shared/harness-api";

/** 服务端 response.ok=false 的结构化错误。 */
export class HarnessRpcError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HarnessRpcError";
    this.code = code;
    this.details = details;
  }
}

/** 结构化输出连续违例（含每次原始输出摘要）。 */
export class HarnessStructuredOutputError extends Error {
  readonly attempts: readonly { output: string; issue: string }[];
  constructor(attempts: readonly { output: string; issue: string }[]) {
    super(
      `structured output failed after ${attempts.length} attempt(s): ${attempts
        .map((item, index) => `#${index + 1} ${item.issue} (output: ${item.output.slice(0, 120)})`)
        .join("; ")}`,
    );
    this.name = "HarnessStructuredOutputError";
    this.attempts = attempts;
  }
}

/** 连接层失败（进程退出/握手失败/版本不匹配/管道断裂等），经 describeDisconnect 归因。 */
export class HarnessDisconnectError extends Error {
  readonly reason: HarnessDisconnectReason;
  constructor(reason: HarnessDisconnectReason, message: string) {
    super(message);
    this.name = "HarnessDisconnectError";
    this.reason = reason;
  }
}

export type HarnessDisconnectReason =
  | "process-exit"
  | "handshake-failed"
  | "version-mismatch"
  | "spawn-failed"
  | "stream-closed"
  | "frame-too-large"
  | "unknown";

/** launch 模式准备失败（M7：凭据继承 fail 等环境问题，launch 在 spawn 前中止）。 */
export class HarnessLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessLaunchError";
  }
}

/** 断连人话归因（R4）：把底层错误翻译成消费方可读的分类与建议。 */
export function describeDisconnect(error: unknown): {
  reason: HarnessDisconnectReason;
  description: string;
  suggestion: string;
} {
  if (error instanceof HarnessDisconnectError) {
    switch (error.reason) {
      case "version-mismatch":
        return {
          reason: "version-mismatch",
          description: "SDK 与 harness 服务端的主版本不匹配（major 不兼容，minor 差异会被容忍）。",
          suggestion: "升级 @acode/harness-sdk 或 acode-harness 服务端，使主版本一致。",
        };
      case "handshake-failed":
        return {
          reason: "handshake-failed",
          description: `握手在完成前中断：${error.message}`,
          suggestion:
            "确认目标是 acode-harness --stdio 入口（不是其它 stdio RPC 面），并检查子进程 stderr 日志。",
        };
      case "process-exit":
        return {
          reason: "process-exit",
          description: `harness 子进程提前退出：${error.message}`,
          suggestion: "查看子进程 stderr；常见原因是服务端崩溃或被系统回收。",
        };
      case "spawn-failed":
        return {
          reason: "spawn-failed",
          description: `无法启动 harness 子进程：${error.message}`,
          suggestion: "检查 command/可执行文件路径与执行权限。",
        };
      case "stream-closed":
        return {
          reason: "stream-closed",
          description: "stdio 流在对端仍在运行时被关闭（管道断裂）。",
          suggestion: "确认没有其它消费者读取同一子进程的 stdout。",
        };
      case "frame-too-large":
        return {
          reason: "frame-too-large",
          description: `服务端单帧超出 ${HARNESS_MAX_LINE_LENGTH} 字符上限，SDK 已主动断连（防无界缓冲）。`,
          suggestion: "检查服务端是否在输出无换行的失控数据流；正常 NDJSON 帧远小于该上限。",
        };
      default:
        return {
          reason: "unknown",
          description: error.message,
          suggestion: "收集子进程 stderr 与 SDK 日志后反馈。",
        };
    }
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") {
      return {
        reason: "spawn-failed",
        description: `无法启动 harness 子进程：${error.message}`,
        suggestion: "检查 command/可执行文件路径与执行权限。",
      };
    }
    return {
      reason: "unknown",
      description: error.message,
      suggestion: "收集子进程 stderr 与 SDK 日志后反馈。",
    };
  }
  return {
    reason: "unknown",
    description: String(error),
    suggestion: "收集子进程 stderr 与 SDK 日志后反馈。",
  };
}
