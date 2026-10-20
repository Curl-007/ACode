// lsp 工具入口（specs/lsp-diagnostics-loop.md §4）
// ============================================================
// 13 action 的 ACode ToolEntry：审批分级（只读 action 免审批，写入 action
// 走静态审批），超时合成 signal，诊断/位置/工作区 action 分发到
// core/src/lsp/tool-actions.ts 与 tool-position-actions.ts。
// 入参校验与 schema 用字面量 JSON Schema + 手写校验：core 未依赖 zod
// （package.json 属共享桶，本波不改动），不能走 toToolJsonSchema 路线。
// ============================================================

import { createCoreError, CoreErrorType, type ToolCancellationPolicy, type ToolTimeoutPolicy } from "@acode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolRuntimePermissionCapability,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { LSP_READONLY_ACTIONS } from "../../lsp/servers.js";
import { LspToolError } from "../../lsp/tool-actions.js";
import { runPositionAction } from "../../lsp/tool-position-actions.js";
import {
  runCapabilitiesAction,
  runDiagnosticsAction,
  runRequestAction,
  runStatusAction,
  runWorkspaceSymbolsAction,
} from "../../lsp/tool-actions.js";
import { getConfig } from "../../lsp/config.js";
import { logger } from "../../lsp/logger.js";

const LSP_TOOL_NAME = "Lsp";

const DEFAULT_TIMEOUT_SEC = 30;
const MIN_TIMEOUT_SEC = 5;
const MAX_TIMEOUT_SEC = 300;

const LSP_ACTIONS = [
  "diagnostics",
  "definition",
  "references",
  "hover",
  "symbols",
  "rename",
  "code_actions",
  "type_definition",
  "implementation",
  "status",
  "reload",
  "capabilities",
  "request",
] as const;

type LspInput = {
  action: (typeof LSP_ACTIONS)[number];
  file?: string;
  line?: number;
  symbol?: string;
  query?: string;
  new_name?: string;
  apply?: boolean;
  timeout?: number;
  payload?: string;
};

const LSP_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...LSP_ACTIONS], description: "LSP operation to perform" },
    file: { type: "string", description: "Target file path ('*' = workspace scope for symbols/reload)" },
    line: { type: "integer", minimum: 1, description: "1-indexed line" },
    symbol: { type: "string", description: "Symbol substring on the line; `name#N` = Nth occurrence" },
    query: { type: "string", description: "Workspace symbol query / code action filter / raw method name" },
    new_name: { type: "string", description: "New name for rename" },
    apply: { type: "boolean", description: "rename/code_actions apply by default; false previews" },
    timeout: {
      type: "integer",
      minimum: MIN_TIMEOUT_SEC,
      maximum: MAX_TIMEOUT_SEC,
      description: `Timeout in seconds for this call (default ${DEFAULT_TIMEOUT_SEC}, range ${MIN_TIMEOUT_SEC}-${MAX_TIMEOUT_SEC})`,
    },
    payload: { type: "string", description: "JSON params for action=request" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const LSP_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string" },
    serverName: { type: "string" },
    text: { type: "string" },
  },
  required: ["action", "text"],
  additionalProperties: false,
} as const;

/** 运行时入参校验（模拟 zod safeParse 的失败通道，错误文本回传模型）。 */
function parseLspInput(input: unknown): { ok: true; value: LspInput } | { ok: false; message: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "Lsp input must be an object with an `action` field" };
  }
  const raw = input as Record<string, unknown>;
  const action = raw.action;
  if (typeof action !== "string" || !LSP_ACTIONS.includes(action as (typeof LSP_ACTIONS)[number])) {
    return { ok: false, message: `Lsp requires a valid \`action\`; got ${JSON.stringify(action)}. Valid: ${LSP_ACTIONS.join(", ")}` };
  }
  const value: LspInput = { action: action as LspInput["action"] };
  const stringFields = ["file", "symbol", "query", "new_name", "payload"] as const;
  for (const field of stringFields) {
    const v = raw[field];
    if (v === undefined) continue;
    if (typeof v !== "string") return { ok: false, message: `Lsp field \`${field}\` must be a string` };
    (value as Record<string, unknown>)[field] = v;
  }
  const numberFields = ["line", "timeout"] as const;
  for (const field of numberFields) {
    const v = raw[field];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      return { ok: false, message: `Lsp field \`${field}\` must be an integer` };
    }
    (value as Record<string, unknown>)[field] = v;
  }
  if (value.line !== undefined && value.line < 1) {
    return { ok: false, message: "Lsp field `line` is 1-indexed and must be >= 1" };
  }
  if (value.timeout !== undefined && (value.timeout < MIN_TIMEOUT_SEC || value.timeout > MAX_TIMEOUT_SEC)) {
    return { ok: false, message: `Lsp \`timeout\` must be between ${MIN_TIMEOUT_SEC} and ${MAX_TIMEOUT_SEC} seconds` };
  }
  if (raw.apply !== undefined) {
    if (typeof raw.apply !== "boolean") return { ok: false, message: "Lsp field `apply` must be a boolean" };
    value.apply = raw.apply;
  }
  return { ok: true, value };
}

const LSP_PROVIDER_DESCRIPTION = [
  "Symbol-aware code intelligence from language servers — navigation, refactors, and diagnostics where text tools miss callsites.",
  "",
  "Actions: diagnostics | definition | references | hover | symbols | rename | code_actions | type_definition | implementation | status | reload | capabilities | request",
  "- Position-based actions need `file` + `line` (+ `symbol` substring; `#N` for Nth match). Project-aware lookups ERROR without `symbol` — no silent fallback.",
  "- `rename` applies by default (`apply: false` previews); `code_actions` lists by default, apply ONE with `apply: true` + `query` (title substring or index).",
  "- `symbols`: `file` lists file symbols; `file: \"*\"` + `query` searches the workspace. `reload`: one server via `file`, all via `*` (re-reads LSP config).",
  "- `request`: raw escape hatch — `query` = method name, `payload` = JSON params (auto-built from file/line/symbol when omitted).",
  "Reach for `lsp` before text-based cross-file renames or lookups whenever a server is available.",
].join("\n");

function lspFailure(message: string): ToolHandlerFailure {
  return { result: false, errorCode: 1, message };
}

const lspHandler: ToolHandler = async (input, context: ToolExecutionContext) => {
  const parsed = parseLspInput(input);
  if (!parsed.ok) return lspFailure(parsed.message);
  const params = parsed.value;
  const { action, timeout } = params;
  const timeoutSec = timeout ?? DEFAULT_TIMEOUT_SEC;
  const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
  const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeoutSignal]) : timeoutSignal;

  const waitMs = timeoutSec * 1000;
  const toolContext = { workingDirectory: context.workingDirectory, workspaceRoot: context.workspaceRoot };

  try {
    let text: string;
    switch (action) {
      case "status": {
        text = await runStatusAction(toolContext, getConfig(context.workingDirectory));
        break;
      }
      case "diagnostics": {
        text = await runDiagnosticsAction(params, toolContext, signal, waitMs);
        break;
      }
      case "symbols": {
        text =
          params.file === "*"
            ? await runWorkspaceSymbolsAction(params, toolContext, signal)
            : await runPositionAction(params, toolContext, signal, waitMs);
        break;
      }
      case "reload": {
        text =
          params.file === "*"
            ? await runReloadAllAction(context, signal)
            : await runPositionAction(params, toolContext, signal, waitMs);
        break;
      }
      case "capabilities": {
        text = await runCapabilitiesAction(params, toolContext, signal);
        break;
      }
      case "request": {
        text = await runRequestAction(params, toolContext, signal);
        break;
      }
      default: {
        text = await runPositionAction(params, toolContext, signal, waitMs);
        break;
      }
    }
    return { action, text };
  } catch (error) {
    if (signal.aborted && !context.abortSignal?.aborted) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `LSP ${action} timed out after ${timeoutSec}s. The server may still be indexing; try again or pass timeout=<larger>.`,
        { context: { toolName: LSP_TOOL_NAME, action }, recoverable: true },
      );
    }
    if (error instanceof LspToolError) return lspFailure(error.message);
    logger.debug("lsp action failed", { action, error: logger.formatError(error) });
    throw error;
  }
};

/** reload *：重读配置 + 关停被取代配置的客户端，再逐服务器 reload。 */
async function runReloadAllAction(context: ToolExecutionContext, signal: AbortSignal): Promise<string> {
  const { configCache } = await import("../../lsp/config.js");
  const { shutdownStaleClients } = await import("../../lsp/client-shutdown.js");
  const { reconcileIdleChecker, clearInitializationFailure } = await import("../../lsp/client-idle.js");
  const { getLspServers, reloadServer } = await import("../../lsp/servers.js");
  const { getOrCreateClient } = await import("../../lsp/client.js");

  configCache.delete(context.workingDirectory);
  const refreshed = getConfig(context.workingDirectory);
  reconcileIdleChecker();
  const serverEntries = Object.entries(refreshed.servers);
  const stopped = await shutdownStaleClients(
    context.workingDirectory,
    serverEntries.map(([, serverConfig]) => serverConfig),
    signal,
  );
  if (serverEntries.length === 0) return "No language server found for this action";

  const outputs: string[] = [];
  if (stopped.length > 0) {
    outputs.push(`Stopped ${stopped.length} server(s) with superseded configuration: ${stopped.join(", ")}`);
  }
  for (const [name, serverConfig] of getLspServers(refreshed)) {
    clearInitializationFailure(serverConfig, context.workingDirectory);
    try {
      const client = await getOrCreateClient(serverConfig, context.workingDirectory, undefined, signal);
      outputs.push(await reloadServer(client, name, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      outputs.push(`Failed to reload ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return outputs.join("\n");
}

/** 只读 action 动态降级：免审批、只读（写入 action 走 entry 静态审批）。 */
export function resolveLspPermissionCapability(
  input: unknown,
  _context?: ToolRuntimePermissionCapabilityContext,
): ToolRuntimePermissionCapability | undefined {
  const parsed = parseLspInput(input);
  if (!parsed.ok) return undefined;
  if (!LSP_READONLY_ACTIONS.has(parsed.value.action)) return undefined;
  // permission（Partial<ToolPermissionSpec>）不含 readOnly/destructive——
  // 只读语义落在外层 capability 字段上。
  return {
    readOnly: true,
    needsApproval: false,
    destructive: false,
    riskLevel: "low",
    sideEffectScope: "session",
    permission: {
      needsApproval: false,
      riskLevel: "low",
      sideEffectScope: "session",
    },
  };
}

const lspTimeout: ToolTimeoutPolicy = {
  defaultMs: DEFAULT_TIMEOUT_SEC * 1000,
  maxMs: MAX_TIMEOUT_SEC * 1000,
  allowCallOverride: true,
};

const lspCancellation: ToolCancellationPolicy = {
  supported: true,
  cleanup: "bestEffort",
  userVisibleMessage: "LSP request was cancelled",
};

export const lspToolEntry: ToolEntry = {
  capability: "Query language servers for diagnostics, definitions, references, hover, symbols, and refactors",
  metadata: {
    shouldDefer: true, // tool-search wave1a: 非常驻内置工具默认 defer(specs/tool-search.md R4)
    name: LSP_TOOL_NAME,
    description: LSP_PROVIDER_DESCRIPTION,
    // 静态面按写入分级（保守默认）；只读 action 由 resolveLspPermissionCapability
    // 按输入动态降级为只读免审批。
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: lspTimeout.defaultMs,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  resolvePermissionCapability: resolveLspPermissionCapability,
  handler: lspHandler,
  inputSchema: LSP_INPUT_JSON_SCHEMA,
  outputSchema: LSP_OUTPUT_JSON_SCHEMA,
  runtimeInputSchema: undefined,
  runtimeOutputSchema: undefined,
  permission: {
    permission: "lsp",
    reason: "LSP write actions (rename, apply code actions, reload, raw request) can mutate workspace files and server state",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 1_000_000,
    maxModelBytes: 100_000,
    strategy: "truncate",
    preview: { maxBytes: 100_000, direction: "head" },
  },
  timeout: lspTimeout,
  cancellation: lspCancellation,
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
