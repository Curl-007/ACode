/**
 * harness-sdk 的唯一公开契约。
 *
 * connect/launch 双模式客户端、会话面、连接层、launch 运行时治理与错误归因都在
 * 模块内部实现；跨模块消费者只 import 本文件（或包根 @acode/harness-sdk——
 * index.ts 整体转发本契约），不深入 client/session/connection/handshake/
 * structured-output 等实现文件（deep import 会被架构检查拒绝）。
 *
 * 有意不入契约的深导出面（与 K7 提交面一致）：resolveHarnessCommand、
 * pickDenyOption、describeZodSchema 仅供诊断与测试回归，从实现文件按需 deep import。
 */
export {
  AcodeHarnessClient,
  type AcodeHarnessClientOptions,
  type ConnectOptions,
  type LaunchInfo,
  type LaunchOptions,
} from "./client.js";
export {
  HarnessSession,
  type ConfigureToolsInput,
  type CreateSessionInput,
  type CustomToolSpec,
  type SessionRunOptions,
} from "./session.js";
export {
  HarnessConnection,
  type HarnessConnectionOptions,
  type HarnessServerInfo,
  type SpawnTarget,
} from "./connection.js";
export {
  prepareLaunchRuntime,
  type LaunchRuntimePaths,
  type PrepareRuntimeOptions,
  type PreparedRuntime,
} from "./launch.js";
export {
  HarnessDisconnectError,
  HarnessLaunchError,
  HarnessRpcError,
  HarnessStructuredOutputError,
  describeDisconnect,
  type HarnessDisconnectReason,
} from "./errors.js";
export {
  SDK_HANDSHAKE_TIMEOUT_MS,
  SDK_PERMISSION_TIMEOUT_MS,
  SDK_STRUCTURED_RETRY_MAX,
} from "./constants.js";
