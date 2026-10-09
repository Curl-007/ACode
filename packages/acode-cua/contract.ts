/**
 * acode-cua 公开契约（type-only 精选面；架构治理与阅读工件）。
 *
 * 本包的真实公开面是 package.json exports 的 12 个子路径（扁平 .js/.d.ts 占位
 * 构建，全部 fail-closed）。本文件把跨模块边界实际消费的核心类型收拢为单一
 * 阅读入口，不新增任何运行时导出、不参与构建。类型按导出子路径分组；
 * NodeNext 语义下 "./x.js" 的类型解析落到相邻的 "x.d.ts"。
 *
 * 不变量（类型无法表达的部分见 CONTRACT.md 与 specs/module-boundary.md）：
 * 占位构建中所有运行时入口都报告 unavailable 并 fail-closed，谓词恒为 false。
 */

// ── 子路径 "."（index.js）：Computer Use 运行时入口 ──────────────────────
export type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
  ComputerUseRuntimeExecuteInput,
  ComputerUseRuntimeOptions,
} from "./index.js";

// ── 子路径 "./frame-contract"：官方 CUA 帧的识别与保全契约 ────────────────
export type { OfficialCuaFrameAttestation, OfficialCuaFrameContentPair } from "./frame-contract.js";

// ── 子路径 "./host-display-contract"：宿主展示元数据键（值导出，无类型面）──

// ── 子路径 "./request-access-contract"：权限申请状态 schema ───────────────
export type {
  CuaRequestAccessStatus,
  CuaRequestAccessStatusSchema,
} from "./request-access-contract.js";

// ── 子路径 "./pip-session" 与 "./pip-session/node"：PiP 会话事件与客户端 ──
export type { PipSessionEvent } from "./pip-session.js";
export type {
  PipSessionApplyResult,
  PipSessionClient,
  PipSessionClientOptions,
} from "./pip-session-node.js";

// ── 子路径 "./broker"：权限 broker 协议、错误与健康探测 ───────────────────
export type {
  BrokerRequest,
  BrokerResponse,
  CallBrokerMethodArgs,
  CuaPermissionRestartOptions,
  CuaPermissionRestartResult,
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusQueryOptions,
  CuaPermissionStatusResult,
  HelperHealth,
  ICuaPermissionService,
  ProbeHelperHealthOptions,
  SocketPathOptions,
} from "./broker.js";

// ── 子路径 "./broker/server"：Helper 宿主 / 安装器 / MCP 解析器 ───────────
export type {
  CuaHelperHandle,
  CuaHelperHost,
  CuaHelperInstaller,
  CuaHelperInstallerOptions,
  CuaHelperTransportHandle,
  CuaProductMcpServerResolver,
  CuaScreenCaptureProbeResult,
  HelperPermissionRequestResult,
  HelperPermissionSubjectIdentity,
} from "./broker-server.js";

// ── 子路径 "./broker/ports"：权限端口的隐私 fail-closed 谓词（值导出）─────
// ── 子路径 "./broker/socketPath"：socket 路径解析（复用 ./broker 类型）────
// ── 子路径 "./broker/helperConstants"：Helper 名称常量（值导出，无类型面）──
// ── 子路径 "./broker/helperHealth"：健康探测（复用 ./broker 类型）─────────
