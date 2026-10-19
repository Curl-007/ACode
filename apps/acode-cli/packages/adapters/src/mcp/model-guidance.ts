// 面向模型的 MCP 失败文案（specs/mcp-lifecycle-ttl-approval.md R2.1 + R2.2 降级阶梯、
// specs/mcp-protocol-negotiation-increments.md R2/R4）。
//
// 失败文案即模型的下一步：每条文案都必须说明事实、给出明确动作指引，并且
// - 不粘贴内部堆栈、不含 env/凭据；
// - 保留「不要在循环里重试」的既有指引短语（R2.1 落点惯例，测试钉住）；
// - R2.2 降级阶梯：server 可能在会话开始后稍晚才连上 → 连接错误稍候重试一次而不是
//   立即回落替代路径 → 重试仍不可用才「说出来并交付替代产物，别放着不做」；
// - R2.2 缺席即诊断：自动恢复已挂起时，从缺席推断环境状态（宿主进程/应用多半
//   未启动或已离线），让模型停止重试并向用户说明，而不是继续消耗调用。
//
// 从 index.ts 迁出成独立叶子：index.ts 已带存量行数豁免，文案面是纯函数、
// 无状态，单独成文件便于测试直接断言。

import type { McpServerStatus } from "@acode/contracts";
import type { McpCrashStormTrip } from "./crash-storm-breaker.js";
import type { McpReconnectGateVerdict } from "./reconnect-budget.js";

/**
 * 自动重连被拒（挂起/冷却）时的模型指引文案（R2.1 + R2.2 缺席即诊断）。
 */
export function buildMcpReconnectRefusalError(
  serverName: string,
  verdict: Exclude<McpReconnectGateVerdict, { allowed: true }>,
  cause?: unknown,
): Error {
  if (verdict.reason === "suspended") {
    const options = cause !== undefined ? { cause } : {};
    if (verdict.suspendedBy === "in_call_crashes") {
      const crashes = verdict.suspension.consecutiveInCallCrashes ?? verdict.consecutiveFailures;
      return new Error(
        `MCP server "${serverName}" is unavailable: automatic reconnection was suspended after ${crashes} consecutive tool calls crashed the connection mid-call. The server process is most likely crashing on every request - stop retrying and treat it as down until it is fixed. Do not retry this tool in a loop - every attempt will fail until the server recovers. Tell the user this MCP server needs attention (check its configuration and logs); reconnecting it explicitly from the MCP settings will resume automatic recovery.`,
        options,
      );
    }
    // 缺席即诊断（R2.2）：反复连不上 = 从缺席推断环境状态，让模型停止重试。
    return new Error(
      `MCP server "${serverName}" is unavailable: automatic reconnection was suspended after ${verdict.consecutiveFailures} consecutive connection failures. The process or host application behind this server is most likely not running or offline - infer that from its absence and stop retrying. Do not retry this tool in a loop - every attempt will fail until the server recovers. Tell the user this MCP server needs attention (check its configuration and logs); reconnecting it explicitly from the MCP settings will resume automatic recovery.`,
      options,
    );
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  return new Error(
    `MCP server "${serverName}" is unavailable: its last automatic reconnection failed and the next attempt is throttled for about ${retryAfterSeconds}s. Do not retry this tool in a loop; continue with other work or report the failure to the user.`,
  );
}

/**
 * 崩溃风暴熔断（specs/mcp-startup-gate-breaker.md R2）触发后的懒重连拒绝文案。
 * 与 R1 挂起文案的关键差别：风暴的证据是「连上了又立刻死」——server 进程/端点
 * 大概率在每次启动后立即退出，spawn 循环只会加重它，必须显式止损；恢复途径只有
 * 显式重连（修复后）。
 */
export function buildMcpCrashStormRefusalError(
  serverName: string,
  trip: McpCrashStormTrip,
  cause?: unknown,
): Error {
  return new Error(
    `MCP server "${serverName}" is unavailable: it disconnected ${trip.windowCount} times within ${Math.round(trip.windowMs / 1000)}s, so automatic recovery is suspended by the crash-storm breaker. The server most likely crashes or exits immediately after every start - retrying cannot fix it and only keeps restarting it. Do not retry this tool in a loop. Tell the user this MCP server keeps crashing and needs attention (check its command, logs and dependencies); after it is fixed, an explicit reconnect from the MCP settings resumes automatic recovery.`,
    cause !== undefined ? { cause } : {},
  );
}

/**
 * 工具调用发现 server 未连接时的失败文案（R2.1 + R2.2 降级阶梯）：
 * 保留既有前缀「MCP server is not connected」，追加阶梯指引。
 */
export function buildMcpNotConnectedMessage(serverName: string, status?: McpServerStatus): string {
  const base = `MCP server is not connected: ${serverName}`;
  const suspension = status?.reconnectSuspension;
  if (suspension) {
    // 挂起来源维度（spec R1）：中途崩溃挂起挂在 disconnected 状态上，文案按维度
    // 给出真实计数，避免把中途崩溃说成连接失败。
    const reason =
      suspension.suspendedBy === "in_call_crashes"
        ? `${suspension.consecutiveInCallCrashes ?? suspension.consecutiveFailures} consecutive mid-call crashes`
        : `${suspension.consecutiveFailures} consecutive failures`;
    // 缺席即诊断（R2.2）：挂起 = 自动恢复已停，从缺席推断宿主进程/应用未启动或离线。
    return `${base} (automatic reconnection suspended after ${reason}). The process or host application behind this server is most likely not running or offline - infer that from its absence and stop retrying. Do not retry this tool in a loop; tell the user the MCP server needs attention - an explicit reconnect from the MCP settings will resume automatic recovery.`;
  }
  // 降级阶梯（R2.2）：稍晚连上 → 稍候重试一次而非立即回落 → 仍不可用才交付替代产物。
  return [
    `${base}.`,
    "The server may still be starting up - MCP servers can finish connecting shortly after the session begins.",
    "If this call hit a connection error, wait a moment and retry once instead of immediately falling back to another route.",
    "If it is still unavailable after that retry, say so in your reply and deliver the best alternative you can (for example a plain file or manual steps) instead of leaving the task undone.",
    "Do not retry this tool in a loop while the server stays disconnected; continue with other work or report the failure to the user.",
  ].join(" ");
}

/**
 * HTTP 403 永久拒绝的快速失败文案（negotiation-increments spec R2）：
 * 403 = 身份被认出但访问被拒——重试不会改变结果，第一次失败即终态，
 * 不消耗重连预算循环，指引模型向用户解释而不是绕行。
 */
export function buildMcpAccessDeniedError(serverName: string, cause?: unknown): Error {
  const options = cause !== undefined ? { cause } : {};
  return new Error(
    `MCP server "${serverName}" denied access (HTTP 403): the server rejected the credentials, or this account is not permitted to use it. Retrying cannot change this outcome - do not retry this tool in a loop. Tell the user that access was denied and what to check (the server's credentials or authorization header, its plan/permission requirements, or its access policy); after they fix it, an explicit reconnect from the MCP settings will resume recovery.`,
    options,
  );
}

/**
 * 调用中途连接断开的「结果未知」文案（negotiation-increments spec R4 防双跑）：
 * 请求已经写上线、响应没有回来——server 可能已执行、正在执行或根本没收到。
 * 文案必须阻止模型盲目重发（副作用类工具重发 = 双跑），指引先核实效果。
 * 原错误保留在 cause 链。
 */
export function buildMcpOutcomeUnknownError(
  serverName: string,
  toolName: string,
  cause: unknown,
): Error {
  return new Error(
    `MCP server "${serverName}" stopped answering the call to tool "${toolName}" mid-call (the connection closed). The outcome is unknown: the call may have completed on the server, may still be running, or may never have started. Check what it did before repeating it - do not resend the same call blindly, and do not retry this tool in a loop while the server stays disconnected.`,
    { cause },
  );
}
