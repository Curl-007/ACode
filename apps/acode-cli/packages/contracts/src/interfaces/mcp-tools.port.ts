// MCP 工具描述与调用面（mcp.port.ts 拆分产物，2026-10-15）。
// annotations、_meta 键闭集、descriptor、callTool 请求/结果与连接快照。

import type { JsonSchema } from "../model/index.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { McpServerStatus } from "./mcp-status.port.js";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export const ACODE_MCP_ERROR_PRESENTATION_META_KEY = "acode/errorPresentation";
export const ACODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY = "message-only";
/** MCP content 中来自模型显式 tab.screenshot() 的 image block 索引。 */
export const ACODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY =
  "acode/browserScreenshotContentIndices";
/**
 * 本次 node_repl cell 操作的目标应用身份，供工具卡显示 App 图标。
 *
 * **只能由 node-repl-host 写入**：宿主的 CUA bridge 从 broker 响应里读 producer 的
 * `acode.cua/app-associations-v1`，投影成这里的最小形态。producer 那个键本身经
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` 也能到达 `_meta`，而这两个
 * API 挂在模型可见的 sandbox globals 上，因此不可信、必须在宿主侧丢弃（同
 * `ACODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY` 的处置）。
 */
export const ACODE_MCP_NODE_REPL_CUA_APP_META_KEY = "acode/nodeReplCuaApp";
/**
 * 官方 Server MCP 响应头里的 `x-request-id`，附在失败的 tool result 上（值为 string）。
 *
 * 用短前缀 `acode/` 而不是 `com.acode/`：这不是跨语言协议——服务端在 header 里给，客户端
 * 读到后自己搬进 `_meta`，产出与消费都在客户端（`com.acode/` 留给 Go 侧直接产出的键，
 * 如 `com.acode/mcp-unavailable`）。
 *
 * 只在 `isError` 时附加：这是给人看的排障线索（拿它去查服务端日志），成功路径上是纯噪声。
 */
export const ACODE_MCP_SERVER_REQUEST_ID_META_KEY = "acode/officialMcpServerRequestId";

export interface McpToolDescriptor {
  serverName: string;
  toolName: string;
  name?: string;
  description?: string;
  timeoutMs?: number;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
  /**
   * 该 tool 的结果**可信到足以据此改变界面**：来自 `type: "http"` 且声明
   * `auth.type = acode_official` 的 MCP server。
   *
   * 唯一用途是信任结果里的结构化标识（额度耗尽 / 无套餐的 `error_code`）。判据是"结果由谁产出"
   * 而不是"插件是谁"：
   * - http：响应来自 ACode 后端。连接存活即意味着每个请求都过了 origin 校验且 fail closed，
   *   第三方插件即使声明官方鉴权，也只能把请求打到真实 ACode，响应体不由它写；
   * - stdio：结果由插件进程自己产出、可任意伪造，因此**不置位**。
   *
   * 刻意**不**按"插件是否来自官方 marketplace"判定：那会让非官方安装源（含本地自测与
   * acode-plugins-test）的官方插件失效，而它也不是真实屏障——详见 `@acode/shared` 的
   * `isOfficialMcpOriginTrusted`。
   */
  official?: boolean;
}

export type McpContentBlock = Record<string, unknown>;

export interface McpToolCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpConnectionSnapshot {
  statuses: Record<string, McpServerStatus>;
  tools: McpToolDescriptor[];
}

export interface McpConnectOptions {
  /**
   * authorization_code OAuth callback 的等待上限。
   * 普通 MCP timeoutMs 只约束协议请求，session 启动需要单独限制 OAuth 授权等待。
   */
  oauthAuthorizationTimeoutMs?: number;
  /**
   * 复用既有连接前先校验其存活性（见 McpPort.pingServer），已死则重连。
   * 设置页刷新这类"用户明确要求重新探测"的调用必须置位；session 启动不需要，
   * 复用池中刚建立的连接即可。
   */
  revalidate?: boolean;
  signal?: AbortSignal;
  trace?: TraceContext;
  workingDirectory?: string;
  /** 身份隔离使用 workspaceIdentity；本地缺省时才 fallback 到 workingDirectory。 */
  workspaceIdentity?: string;
}

export interface McpCallToolRequest {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  trace?: TraceContext;
  /** 调用来源；宿主 MCP 可据此限制不能安全继承到 subagent 的能力。 */
  runtimeScope?: "main" | "subagent";
  /** 请求上下文仅用于 shared-host 隔离，不改变 MCP tool 参数。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: string;
  deliveryKind?: string;
  turnId?: string;
}

export interface McpCallToolOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
