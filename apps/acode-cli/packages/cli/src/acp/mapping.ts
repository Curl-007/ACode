// ============================================================
// R2 消息映射表：harness 事件/错误/权限面 ↔ ACP session/update 面。
// 逐条对应 spec R2 表与附录 A.3 的映射落点；纯函数、无状态——
// 每 turn 的 reset 语义由调用方（session-registry）的 turnCounter 承载。
//
// 参照 jcode (MIT) acp.rs 的「翻译函数独立于会话状态机」组织法，自撰实现。
// ============================================================

import {
  ACP_UNKNOWN_ERROR_CODE,
  AcpProtocolError,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
} from "./protocol.js";
import { HarnessRpcError } from "@acode/harness-sdk";
import type {
  HarnessEvent,
  PermissionRequestedEvent,
  ToolCallFinishedEvent,
  ToolCallStartedEvent,
} from "@acode/shared/harness-api";

/**
 * 从权限选项里挑「拒绝」语义项（fail-closed 兜底）。
 *
 * 为什么本地实现而不 import harness-sdk：SDK 的 pickDenyOption 未在
 * @acode/harness-sdk 公开入口导出（K7 提交面），本包写权限不含 SDK——
 * 语义与 K7 session.ts 的 pickDenyOption 逐字对齐：显式匹配 deny/reject
 * （optionId/kind/name 任一命中，词边界防 "undeny" 误报），无显式拒绝项时
 * 兜底取末项。契约假设（K7 同款登记）：ACode 权限选项按风险升序、末项最保守。
 */
export function pickEngineDenyOption(
  event: PermissionRequestedEvent,
): { optionId: string } | undefined {
  const deny = event.options.find((option) => {
    const haystack = `${option.optionId} ${option.kind ?? ""} ${option.name ?? ""}`.toLowerCase();
    return /\bdeny\b|\breject\b/.test(haystack);
  });
  if (deny) return { optionId: deny.optionId };
  const last = event.options[event.options.length - 1];
  return last ? { optionId: last.optionId } : undefined;
}

/** ACP v1 稳定版 SessionUpdate 的适配层子集（附录 A.2 变体集）。 */
export type AcpSessionUpdate =
  | {
      sessionUpdate: "agent_message_chunk";
      messageId?: string;
      content: { type: "text"; text: string };
    }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      name?: string;
      kind: AcpToolKind;
      status: "pending" | "in_progress";
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status: "completed" | "failed";
      content: { type: "text"; text: string }[];
    };

/** ACP ToolKind 枚举（附录 A.2 schema）。 */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

/** ACP PermissionOptionKind 枚举（四值，附录 A.2 schema）。 */
export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  kind: AcpPermissionOptionKind;
  name: string;
}

/**
 * 引擎权限档位 → ACP 档位（R2：映射不到的档位按更严侧折叠，附录 A.3）：
 * - 精确命中四枚举则原样保留；
 * - 含 deny/reject/block 语义词 → reject_once（引擎 deny 无 ACP 对应名，折叠到
 *   拒绝族的最小档——保留「本次拒绝」粒度，不替用户记住永久拒绝）；
 * - 其余（allow 族未知档位，如 create_once/run_once）→ allow_once——家族内更严侧，
 *   绝不折叠出 allow_always。
 */
export function mapPermissionOptionKind(engineKind: string | undefined): AcpPermissionOptionKind {
  const value = `${engineKind ?? ""}`.toLowerCase();
  if (value === "allow_once" || value === "allow_always" || value === "reject_once" || value === "reject_always") {
    return value;
  }
  if (/deny|reject|block/.test(value)) return "reject_once";
  return "allow_once";
}

/**
 * 引擎权限选项集 → ACP 选项集（双向）：折叠可能改写 optionId 语义，所以同时
 * 产出「ACP optionId → 引擎 optionId」还原表，client 应答经它回译；
 * 同一引擎 optionId 折叠后冲突时追加序号去重（保持可还原）。
 */
export function mapPermissionOptions(
  event: PermissionRequestedEvent,
): { acpOptions: AcpPermissionOption[]; engineOptionIdByAcpId: Map<string, string> } {
  const acpOptions: AcpPermissionOption[] = [];
  const engineOptionIdByAcpId = new Map<string, string>();
  const usedAcpIds = new Set<string>();
  for (const option of event.options) {
    const kind = mapPermissionOptionKind(option.kind);
    let acpId = `${option.optionId}`;
    if (usedAcpIds.has(acpId)) acpId = `${acpId}#${usedAcpIds.size + 1}`;
    usedAcpIds.add(acpId);
    acpOptions.push({
      optionId: acpId,
      kind,
      name: option.name ?? option.optionId,
    });
    engineOptionIdByAcpId.set(acpId, option.optionId);
  }
  return { acpOptions, engineOptionIdByAcpId };
}

/** 工具名 → ACP ToolKind（启发式分类，仅影响 client 图标展示）。 */
export function mapToolKind(toolName: string | undefined): AcpToolKind {
  const name = `${toolName ?? ""}`.toLowerCase();
  if (/read|glob|ls$|list|todo/.test(name)) return "read";
  if (/grep|search|find|scan/.test(name)) return "search";
  if (/bash|exec|run|command|terminal|node|python/.test(name)) return "execute";
  if (/edit|write|apply.?patch|patch/.test(name)) return "edit";
  if (/delete|remove|rm/.test(name)) return "delete";
  if (/move|rename|mv/.test(name)) return "move";
  if (/fetch|web|http|url|browser/.test(name)) return "fetch";
  if (/think|plan|reason|task/.test(name)) return "think";
  return "other";
}

/**
 * 流 reset 标记（spec R2 流形态）：ACP 出向 messageId 按
 * `acp-<turnCounter>-<harnessMessageId>` 命名——turn 边界递增 turnCounter 即
 * 隐式 reset，吸收引擎跨 turn 重发/替换同一 messageId 的语义，不反向要求
 * K7 加事件。
 */
export function acpMessageIdForTurn(turnCounter: number, harnessMessageId: string): string {
  return `acp-${turnCounter}-${harnessMessageId}`;
}

/** text_delta → agent_message_chunk（append 语义，同 messageId 追加）。 */
export function textDeltaToUpdate(
  turnCounter: number,
  event: Extract<HarnessEvent, { kind: "text_delta" }>,
): AcpSessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    messageId: acpMessageIdForTurn(turnCounter, event.messageId),
    content: { type: "text", text: event.delta },
  };
}

/** tool_call_started → tool_call 更新（status in_progress）。 */
export function toolCallStartedToUpdate(event: ToolCallStartedEvent): AcpSessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: event.toolCallId,
    title: event.description ?? event.toolName ?? event.toolCallId,
    ...(event.toolName ? { name: event.toolName } : {}),
    kind: mapToolKind(event.toolName),
    status: "in_progress",
  };
}

/** tool_call_finished → tool_call_update 更新（completed/failed + 文本 content）。 */
export function toolCallFinishedToUpdate(event: ToolCallFinishedEvent): AcpSessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: event.toolCallId,
    status: event.ok ? "completed" : "failed",
    content: [
      { type: "text", text: event.ok ? "completed" : (event.error?.message ?? "tool call failed") },
    ],
  };
}

/** 权限请求前置的 tool_call 播报（status pending；未播报过的 toolCallId 才发）。 */
export function permissionToolCallToUpdate(event: PermissionRequestedEvent): AcpSessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: event.toolCallId ?? event.requestId,
    title: event.reason ?? event.toolName ?? "permission required",
    ...(event.toolName ? { name: event.toolName } : {}),
    kind: mapToolKind(event.toolName),
    status: "pending",
  };
}

/** ACP session/request_permission 的 params 构造。 */
export function permissionRequestParams(
  acpSessionId: string,
  event: PermissionRequestedEvent,
  acpOptions: AcpPermissionOption[],
): { sessionId: string; toolCall: { toolCallId: string; title: string; kind: AcpToolKind; status: "pending" }; options: AcpPermissionOption[] } {
  return {
    sessionId: acpSessionId,
    toolCall: {
      toolCallId: event.toolCallId ?? event.requestId,
      title: event.reason ?? event.toolName ?? "permission required",
      kind: mapToolKind(event.toolName),
      status: "pending",
    },
    options: acpOptions,
  };
}

/**
 * prompt ContentBlock[] → 引擎文本（附录 A.3）：text 块拼接、resource_link
 * 降级为 `name: uri` 行；其余块类型（image/audio/resource）未在能力声明中开放。
 */
export function promptBlocksToEngineText(blocks: unknown): string {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new AcpProtocolError(
      JSONRPC_INVALID_PARAMS,
      "session/prompt requires a non-empty prompt array",
    );
  }
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      throw new AcpProtocolError(JSONRPC_INVALID_PARAMS, "prompt block must be an object");
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text") {
      if (typeof record.text !== "string") {
        throw new AcpProtocolError(JSONRPC_INVALID_PARAMS, "text block requires a string field");
      }
      parts.push(record.text);
      continue;
    }
    if (record.type === "resource_link") {
      const uri = typeof record.uri === "string" ? record.uri : "";
      const name = typeof record.name === "string" ? record.name : "resource";
      if (!uri) {
        throw new AcpProtocolError(JSONRPC_INVALID_PARAMS, "resource_link requires a uri");
      }
      parts.push(`${name}: ${uri}`);
      continue;
    }
    throw new AcpProtocolError(
      JSONRPC_INVALID_PARAMS,
      `unsupported prompt block type '${String(record.type)}' (agent advertises text and resource_link only)`,
    );
  }
  return parts.join("\n");
}

/** 引擎 turn 终态 → ACP stopReason（附录 A.3；error 由调用方回 JSON-RPC 错误）。 */
export function resultTypeToStopReason(
  resultType: "success" | "cancelled" | "error",
): "end_turn" | "cancelled" | undefined {
  if (resultType === "success") return "end_turn";
  if (resultType === "cancelled") return "cancelled";
  return undefined;
}

/**
 * 引擎错误 → JSON-RPC error body（R2 错误映射；附录 A.3）：
 * 未知引擎错误归 internal，message 人话化，data.reason 保留段位语义，
 * 不透内部栈（只取 error.message，不取 stack）。
 */
export function harnessErrorToRpcBody(error: unknown): {
  code: number;
  message: string;
  data?: unknown;
} {
  if (error instanceof AcpProtocolError) {
    return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
  }
  if (error instanceof HarnessRpcError) {
    if (error.code === "invalid_params") {
      return { code: JSONRPC_INVALID_PARAMS, message: error.message };
    }
    if (error.code === "unknown_method") {
      return { code: JSONRPC_METHOD_NOT_FOUND, message: error.message };
    }
    return {
      code: ACP_UNKNOWN_ERROR_CODE,
      message: error.message || "harness request failed",
      data: { reason: error.code },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: ACP_UNKNOWN_ERROR_CODE,
    message: message || "internal error",
    data: { reason: "internal" },
  };
}
