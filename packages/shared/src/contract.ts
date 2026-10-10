/**
 * shared 模块公开契约（治理用精选视图）。
 *
 * 权威公开面以 packages/shared/package.json 的 20 个子路径 exports 为准（包根
 * index.ts、./acode-protocol-v4、./harness-api、./node、./model-selection、
 * ./model-config、./config-schema 等）；跨模块导入一律走这些包入口，内部实现
 * 文件的 deep import 会被架构检查拒绝。本文件不替代、也不整体转发权威面，
 * 只精选跨模块最常用的核心协议 / schema 名字，供架构 context 阅读包与
 * 新消费者作为有界速览入口。
 */

// ── App/会话核心协议类型（包根面）──────────────────────────────────
export { DEFAULT_LOCALE } from "./protocol.js";
export type { AppSettings, Locale, ResourceUsageSnapshot, TabId, TabState } from "./protocol.js";
export type { ACodeEnv, ACodeProductFlavor } from "./env.js";
export type {
  DockerConnectOptions,
  RemoteTarget,
  SSHConnectOptions,
  ServerConnectOptions,
  WSLConnectOptions,
} from "./remoteTarget.js";

// ── 账号访问类别（acode-protocol 面；唯一事实源 account-access-types.ts，
//    叶子文件——usage-stats.ts 与 acode-protocol/index.ts 共用且无环）──────
export {
  acodeAccountAccessSchema,
  acodeProviderAccountAccessSchema,
  type ACodeAccountAccess,
  type ACodeProviderAccountAccess,
} from "./account-access-types.js";

// ── 模型选择（./model-selection 子路径面）───────────────────────────
export {
  formatModelPickerValue,
  modelSelectionSchema,
  parseModelPickerValue,
  type ModelSelection,
} from "./model-selection.js";

// ── 协议 v4 核心（完整面见 ./acode-protocol-v4 子路径）──────────────
export {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  V4_WIRE_PROTOCOL_VERSION,
  type DeliveryProfileName,
} from "./acode-protocol-v4/core.js";
export { commandTypeSchema, type CommandType } from "./acode-protocol-v4/command.js";
export { sessionPhaseSchema, type SessionPhase } from "./acode-protocol-v4/snapshot.js";
