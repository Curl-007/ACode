// ============================================================
// MCP 资源拉取工具（specs/mcp-sampling-resources.md）
// ============================================================
// 只对 `resources: true` 的 server 注册两个普通工具（进 ToolRegistry，权限类别 "mcp"）：
//   mcp__<server>__list_resources  资源清单（元数据，免确认）
//   mcp__<server>__read_resource   读一个资源（外部内容进模型上下文，需确认）
//
// 授权纪律：read 的 uri 必须出现在**最近一次 list 的结果**里（5 分钟窗口）——防任意
// uri 探测（file://、内网地址等 server 侧未声明的目标）。窗口是进程内存事实，不落盘、
// 不跨会话；过期后模型需要重新 list（工具结果里如实告知）。
//
// sampling（server→client 模型采样）**不在本文件**：当前 SDK 在 2026-07-28 协议纪元已把
// sampling 标记为 deprecated（elicitation 是后继面），在弃用面上建新特征需要先立项对齐，
// 见 spec 的范围说明。

import {
  McpListResourcesOutputJsonSchema,
  McpReadResourceOutputJsonSchema,
  type McpPort,
  type McpServerConfig,
  type RiskLevel,
} from "@acode/contracts";
import type { ToolRegistry } from "../tool/registry.js";
import type { ToolEntry } from "../tool/types.js";
import { toModelVisibleMcpNamePart } from "./name.js";

const RESOURCE_TOOL_TIMEOUT_MS = 30_000;
/** uri 白名单窗口：list 之后 5 分钟内 read 有效。 */
const URI_WINDOW_TTL_MS = 5 * 60 * 1000;
/** 单次 read 的模型可见文本上限（adapter 侧已按 512 KiB 截断，这里再钳一道显示层）。 */
const READ_RESULT_MAX_CHARS = 512 * 1024;

interface UriWindow {
  uris: Set<string>;
  expiresAt: number;
}

/**
 * 白名单窗口的作用域是「一次 registerMcpResourceTools 调用」——即一个 runtime。
 * 原因（2026-10-12 修复）：窗口曾是模块级、仅按 serverName 键控的全局 Map
 * （`const uriWindowsByServer = new Map<string, UriWindow>()`）。一个 agent 进程同时
 * 托管多个并发 runtime（每 session 独立 pool lease、fork/child、parent+subagent），它们
 * 注册**同名** server（同一份 .acode/.agents 配置）却各持**独立** MCP 连接（per-lease
 * connectionKey，list 结果可能不同甚至为空）。全局 Map 让 B 的 list 整体覆盖 A 的窗口：
 * A 随后 read 自己刚列出的 uri 被误判 uri_not_listed（错误结果）；反向则 B 能 read 只有
 * A 列过的 uri（越过 per-session 授权边界，正是本窗口要防的探测）——违背 specs
 * mcp-sampling-resources.md「窗口不落盘、不跨会话」与 handler 注释「不跨会话」。
 * 修复：Map 移入 registerMcpResourceTools 内部按 serverName 键控（该 Map 已天然
 * per-runtime，serverName 在其作用域内唯一），由 list/read handler 闭包持有，随 runtime
 * 存续，不再有任何模块级共享写路径。
 */
type UriWindows = Map<string, UriWindow>;

function consumeUriWindow(
  windows: UriWindows,
  serverName: string,
  uri: string,
  now: number,
): boolean {
  const window = windows.get(serverName);
  if (!window) return false;
  if (window.expiresAt <= now) {
    windows.delete(serverName);
    return false;
  }
  return window.uris.has(uri);
}

/**
 * 为所有 `resources: true` 的 server 注册拉取工具。返回注册的工具名（调用方据此决定
 * 是否 invalidateToolCache）。port 未实现资源面（旧 adapter）时跳过——不注册点了就报错的工具。
 */
export function registerMcpResourceTools(
  registry: ToolRegistry,
  mcpPort: McpPort,
  servers: Record<string, McpServerConfig>,
): string[] {
  if (typeof mcpPort.listResources !== "function" || typeof mcpPort.readResource !== "function") {
    return [];
  }
  // 每个 runtime 一份独立窗口：闭包被本次注册的 list/read handler 持有，不跨会话共享。
  const uriWindows: UriWindows = new Map();
  const registered: string[] = [];
  for (const [serverName, config] of Object.entries(servers)) {
    if (config.resources !== true) continue;
    const visible = toModelVisibleMcpNamePart(serverName);
    const listName = `mcp__${visible}__list_resources`;
    const readName = `mcp__${visible}__read_resource`;
    registry.register(createListResourcesToolEntry(listName, serverName, mcpPort, uriWindows));
    registry.register(createReadResourceToolEntry(readName, serverName, mcpPort, uriWindows));
    registered.push(listName, readName);
  }
  return registered;
}

function createListResourcesToolEntry(
  name: string,
  serverName: string,
  mcpPort: McpPort,
  uriWindows: UriWindows,
): ToolEntry {
  const riskLevel: RiskLevel = "low";
  return {
    capability: `List resources exposed by MCP server ${serverName}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: McpListResourcesOutputJsonSchema,
    metadata: {
      name,
      description: `List the resources exposed by MCP server "${serverName}". Returns uri/name/mimeType/description (max 200). Read one with ${name.replace("list_resources", "read_resource")} using a uri from this list.`,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: RESOURCE_TOOL_TIMEOUT_MS,
      sideEffectScope: "network",
      riskLevel,
      needsApproval: false,
      mcpPresentation: { serverName, toolName: "list_resources" },
    },
    permission: {
      permission: "mcp",
      reason: `MCP resource listing for ${serverName} queries an external server (metadata only)`,
      riskLevel,
      sideEffectScope: "network",
      needsApproval: false,
      patternSources: ["toolName", "network"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 100_000,
      maxModelBytes: 50_000,
      strategy: "truncate",
      preview: { maxBytes: 50_000, direction: "head" },
    },
    timeout: { defaultMs: RESOURCE_TOOL_TIMEOUT_MS, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `MCP resource listing ${name} was cancelled`,
    },
    trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
    handler: async () => {
      const resources = await mcpPort.listResources!(serverName, {
        timeoutMs: RESOURCE_TOOL_TIMEOUT_MS,
      });
      // 每次 list 整体替换窗口（旧 uri 不残留）：read 的白名单永远来自最近一次清单。
      uriWindows.set(serverName, {
        uris: new Set(resources.map((resource) => resource.uri)),
        expiresAt: Date.now() + URI_WINDOW_TTL_MS,
      });
      return { resources, count: resources.length };
    },
    formatModelContent: (output) => {
      const parsed = output as { resources?: unknown[]; count?: number };
      if (!Array.isArray(parsed.resources) || parsed.resources.length === 0) {
        return `MCP server ${serverName} exposed no resources.`;
      }
      return `MCP server ${serverName} exposes ${parsed.count ?? parsed.resources.length} resources:\n${JSON.stringify(parsed.resources, null, 2)}`;
    },
  };
}

function createReadResourceToolEntry(
  name: string,
  serverName: string,
  mcpPort: McpPort,
  uriWindows: UriWindows,
): ToolEntry {
  const riskLevel: RiskLevel = "low";
  return {
    capability: `Read one resource exposed by MCP server ${serverName}`,
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description: "Resource uri exactly as returned by the matching list_resources tool.",
        },
      },
      required: ["uri"],
      additionalProperties: false,
    },
    outputSchema: McpReadResourceOutputJsonSchema,
    metadata: {
      name,
      description: `Read one resource from MCP server "${serverName}". The uri must come from a list_resources result within the last 5 minutes; binary resources come back base64-encoded.`,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: RESOURCE_TOOL_TIMEOUT_MS,
      sideEffectScope: "network",
      riskLevel,
      // 外部内容进模型上下文：与 MCP 工具族同一确认纪律（list 是元数据，免确认）。
      needsApproval: true,
      mcpPresentation: { serverName, toolName: "read_resource" },
    },
    permission: {
      permission: "mcp",
      reason: `MCP resource read for ${serverName} fetches external content into the model context`,
      riskLevel,
      sideEffectScope: "network",
      needsApproval: true,
      patternSources: ["toolName", "input", "network"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: READ_RESULT_MAX_CHARS,
      maxModelBytes: 50_000,
      strategy: "truncate",
      preview: { maxBytes: 50_000, direction: "head" },
    },
    timeout: { defaultMs: RESOURCE_TOOL_TIMEOUT_MS, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `MCP resource read ${name} was cancelled`,
    },
    trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
    handler: async (input) => {
      const uri = (input as { uri?: unknown }).uri;
      if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) {
        return { error: "invalid_uri", message: "uri must be a non-empty string (≤ 2048 chars)." };
      }
      // uri 白名单窗口：不在最近一次 list 结果里（或窗口过期）一律拒绝——不拿模型给的
      // 字符串直接打 server，防任意 uri 探测。
      if (!consumeUriWindow(uriWindows, serverName, uri, Date.now())) {
        return {
          error: "uri_not_listed",
          message: `Uri ${uri} is not in the current list_resources window for ${serverName} (windows expire after 5 minutes). Call the matching list_resources tool first, then read a uri from its result.`,
        };
      }
      const result = await mcpPort.readResource!(serverName, uri, {
        timeoutMs: RESOURCE_TOOL_TIMEOUT_MS,
      });
      if (result === undefined) {
        return { error: "not_found", message: `MCP server ${serverName} has no resource ${uri}.` };
      }
      return result;
    },
    formatModelContent: (output) => {
      const parsed = output as {
        error?: string;
        message?: string;
        uri?: string;
        mimeType?: string;
        text?: string;
        base64?: string;
      };
      if (parsed.error) return `${parsed.error}: ${parsed.message ?? ""}`.trim();
      if (typeof parsed.text === "string") {
        const body =
          parsed.text.length > READ_RESULT_MAX_CHARS
            ? `${parsed.text.slice(0, READ_RESULT_MAX_CHARS)}\n…[truncated]`
            : parsed.text;
        return `Resource ${parsed.uri}${parsed.mimeType ? ` (${parsed.mimeType})` : ""}:\n${body}`;
      }
      if (typeof parsed.base64 === "string") {
        return `Resource ${parsed.uri}${parsed.mimeType ? ` (${parsed.mimeType})` : ""} is binary; ${parsed.base64.length} base64 chars returned.`;
      }
      return `Resource ${parsed.uri ?? ""} returned no content.`;
    },
  };
}
