// MCP 连接状态与状态变更事件面（mcp.port.ts 拆分产物，2026-10-15）。
// 状态机、重连熔断挂起附加事实、事件触发原因闭集与监听器契约。

import { type V4McpServerFailureKind } from "@acode/shared/acode-protocol-v4";
import type { McpServerTransportType } from "./mcp-config.port.js";

export type McpServerStatusKind =
  | "connecting"
  | "connected"
  | "disabled"
  | "disconnected"
  | "failed"
  | "untrusted";

/**
 * 自动重连熔断挂起的附加事实（specs/mcp-lifecycle-ttl-approval.md R1/R2）。
 * 双计数器任一耗尽预算后置位：连续连接失败（挂在 `status: "failed"` 上）或
 * 连续中途崩溃（callTool 执行中途 transport 断开，挂在崩溃后的
 * `status: "disconnected"` 上），来源由 `suspendedBy` 区分。
 * 刻意做成**附加字段**而不是新的 McpServerStatusKind 枚举值：wire schema
 * （packages/shared）与 TUI/desktop 消费面对新枚举值的兼容不在本批范围，
 * 忽略本字段的旧消费者至多把挂起显示为普通 failed/disconnected（fail-safe）。
 * 解除挂起的唯一途径是显式操作（设置页重连 / session 启动 / 配置变更下发）。
 */
export interface McpReconnectSuspension {
  /** 触发挂起的连续连接失败次数（connect_failures 维度计数）。 */
  consecutiveFailures: number;
  /** 连续中途崩溃次数（in_call_crashes 维度）；仅该维度计数 > 0 时附加，wire fail-safe。 */
  consecutiveInCallCrashes?: number;
  /** 挂起时刻（ISO 8601）。 */
  suspendedAt: string;
  /** 挂起来源维度；仅挂起时附加，缺失按 connect_failures 理解（历史形态）；wire fail-safe。 */
  suspendedBy?: "connect_failures" | "in_call_crashes" | "crash_storm";
}

export interface McpServerStatus {
  status: McpServerStatusKind;
  transport: McpServerTransportType;
  toolCount: number;
  updatedAt: string;
  error?: string;
  failureKind?: V4McpServerFailureKind;
  serverRequestId?: string;
  protocolEra?: "legacy" | "modern";
  reconnectSuspension?: McpReconnectSuspension;
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
}

/**
 * 连接状态跃迁事件的触发原因闭集（specs/mcp-lifecycle-ttl-approval.md R2）。
 * 上层（desktop 设置页 / TUI 侧栏 / CLI）据此区分「server 自己断了」与
 * 「重连预算耗尽被挂起」，不需要解析 error 文本。
 */
export type McpServerStatusChangeTrigger =
  | "connect-started"
  | "connected"
  | "connect-failed"
  | "disconnected"
  | "disabled"
  | "reconnect-suspended";

export interface McpServerStatusChange {
  serverName: string;
  previousStatus?: McpServerStatusKind;
  status: McpServerStatus;
  trigger: McpServerStatusChangeTrigger;
  /** pool 连接上下文 id（adapter 持有 connectionContext 时携带），用于关联日志。 */
  connectionId?: string;
  /** 事件产生时刻（ISO 8601）。 */
  at: string;
}

/**
 * 状态变更监听器。故障不得反向影响连接生命周期——派发点必须 try/catch
 * （与遥测旁路同一哲学）。
 */
export type McpServerStatusChangeListener = (change: McpServerStatusChange) => void;
