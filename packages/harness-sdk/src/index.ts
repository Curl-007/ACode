// @acode/harness-sdk 公开入口（对外发布名预留 @acode/sdk，spec R4）。
export {
  AcodeHarnessClient,
  type ConnectOptions,
  type LaunchOptions,
  type AcodeHarnessClientOptions,
  type LaunchInfo,
} from "./client.js";
export {
  HarnessSession,
  type CreateSessionInput,
  type SessionRunOptions,
  type ConfigureToolsInput,
  type CustomToolSpec,
} from "./session.js";
export {
  HarnessDisconnectError,
  HarnessRpcError,
  HarnessStructuredOutputError,
  HarnessLaunchError,
  describeDisconnect,
  type HarnessDisconnectReason,
} from "./errors.js";
export {
  HarnessConnection,
  type HarnessConnectionOptions,
  type SpawnTarget,
  type HarnessServerInfo,
} from "./connection.js";
export {
  prepareLaunchRuntime,
  type PrepareRuntimeOptions,
  type PreparedRuntime,
  type LaunchRuntimePaths,
} from "./launch.js";
export {
  SDK_PERMISSION_TIMEOUT_MS,
  SDK_STRUCTURED_RETRY_MAX,
  SDK_HANDSHAKE_TIMEOUT_MS,
} from "./constants.js";
