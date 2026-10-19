// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/tool.ts（工作区 action 切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// lsp 工具 action 语义（workspace 型）：diagnostics / symbols * /
// capabilities / status / request。位置型在 tool-position-actions.ts。
// ============================================================

import { resolveWorkspacePath } from "../tool/path-policy.js";
import { getOrCreateClient, waitForProjectLoaded } from "./client.js";
import { getActiveClients } from "./client-shutdown.js";
import { reconcileFileFromDisk, refreshFile } from "./client-files.js";
import { sendRequest } from "./client-io.js";
import { getConfig } from "./config.js";
import {
  dedupeWorkspaceSymbols,
  formatDiagnostic,
  formatDiagnosticsSummary,
  formatPathRelativeToCwd,
  formatSymbolInformation,
  filterWorkspaceSymbols,
  resolveSymbolColumn,
  sortDiagnostics,
} from "./format.js";
import { fileToUri } from "./uri.js";
import { getLspServers, getLspServerForFile, getLspServersForFile, isProjectAwareLspServer } from "./servers.js";
import { SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, waitForDiagnostics, WORKSPACE_SYMBOL_LIMIT } from "./diagnostics.js";
import type { Diagnostic, LspConfig, ServerConfig, SymbolInformation } from "./types.js";
import type { LspToolParams } from "./tool-types.js";

export class LspToolError extends Error {}

/** 解析 file 入参为工作区内绝对路径（越界由 path-policy 拒绝）。 */
export function resolveToolPath(file: string, context: { workingDirectory: string; workspaceRoot: string }): string {
  return resolveWorkspacePath({
    inputPath: file,
    operation: "read",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new LspToolError("aborted");
}

// -----------------------------------------------------------------------------
// diagnostics（本波单文件；glob 见 spec §8 削减登记）
// -----------------------------------------------------------------------------

export async function runDiagnosticsAction(
  params: LspToolParams,
  context: { workingDirectory: string; workspaceRoot: string },
  signal: AbortSignal,
  waitMs: number,
): Promise<string> {
  if (!params.file) throw new LspToolError("file parameter required for diagnostics");
  if (params.file.includes("*")) {
    throw new LspToolError("glob diagnostics are not supported in this build; pass a concrete file path");
  }
  const config = getConfig(context.workingDirectory);
  const resolved = resolveToolPath(params.file, context);
  const servers = getLspServersForFile(config, resolved);
  if (servers.length === 0) return `No language server found for ${params.file}`;

  const allDiagnostics: Diagnostic[] = [];
  const failedServers: string[] = [];
  for (const [serverName, serverConfig] of servers) {
    try {
      throwIfAborted(signal);
      const client = await getOrCreateClient(serverConfig, context.workingDirectory, undefined, signal);
      if (isProjectAwareLspServer(serverConfig)) {
        await waitForProjectLoaded(client, signal);
        throwIfAborted(signal);
      }
      const uri = fileToUri(resolved);
      const minVersion = client.diagnosticsVersion;
      await refreshFile(client, resolved, signal);
      const expectedDocumentVersion = client.openFiles.get(uri)?.version;
      // 项目感知服务器首答常超 3s 单文件预算，显式诊断请求可等 waitMs；
      // 非 linter 的普通服务器按 3s，防 "OK" 误报（omp 同规则）。
      const waitCapMs = isProjectAwareLspServer(serverConfig) ? Math.min(waitMs, 15000) : SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS;
      const diagnostics = await waitForDiagnostics(client, uri, {
        timeoutMs: waitCapMs,
        signal,
        minVersion,
        expectedDocumentVersion,
      });
      allDiagnostics.push(...diagnostics);
    } catch (error) {
      if (signal.aborted) throw error;
      failedServers.push(serverName);
    }
  }

  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const d of allDiagnostics) {
    const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(d);
    }
  }
  sortDiagnostics(unique);
  const relPath = formatPathRelativeToCwd(resolved, context.workingDirectory);
  const failureNote = failedServers.length > 0 ? ` (failed servers: ${failedServers.join(", ")})` : "";
  if (unique.length === 0) {
    return failedServers.length === servers.length
      ? `${relPath}: all language servers failed${failureNote}`
      : `OK${failureNote}`;
  }
  const formatted = unique.map((d) => formatDiagnostic(d, relPath));
  return `${relPath}: ${formatDiagnosticsSummary(unique)}${failureNote}\n${formatted.map((m) => `  ${m}`).join("\n")}`;
}

// -----------------------------------------------------------------------------
// workspace symbols（file: "*"）
// -----------------------------------------------------------------------------

export async function runWorkspaceSymbolsAction(
  params: LspToolParams,
  context: { workingDirectory: string; workspaceRoot: string },
  signal: AbortSignal,
): Promise<string> {
  const normalizedQuery = params.query?.trim();
  if (!normalizedQuery) throw new LspToolError("query parameter required for workspace symbol search");
  const config: LspConfig = getConfig(context.workingDirectory);
  const servers = getLspServers(config);
  if (servers.length === 0) throw new LspToolError("No language server found for this action");
  const aggregated: SymbolInformation[] = [];
  const serverFailures: string[] = [];
  let responding = 0;
  for (const [, serverConfig] of servers) {
    throwIfAborted(signal);
    try {
      const client = await getOrCreateClient(serverConfig, context.workingDirectory, undefined, signal);
      const result = (await sendRequest(client, "workspace/symbol", { query: normalizedQuery }, signal)) as SymbolInformation[] | null;
      responding += 1;
      if (result && result.length > 0) {
        for (const symbol of filterWorkspaceSymbols(result, normalizedQuery)) aggregated.push(symbol);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      serverFailures.push(`  ${serverConfig.command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (responding === 0) {
    throw new LspToolError(`Workspace symbol search failed: all language servers failed\n${serverFailures.join("\n")}`);
  }
  const deduped = dedupeWorkspaceSymbols(aggregated);
  const failureSection = serverFailures.length > 0 ? `\nServer failures:\n${serverFailures.join("\n")}` : "";
  if (deduped.length === 0) return `No symbols matching "${normalizedQuery}"${failureSection}`;
  const limited = deduped.slice(0, WORKSPACE_SYMBOL_LIMIT);
  const truncation = deduped.length > WORKSPACE_SYMBOL_LIMIT ? `\n[…${deduped.length - WORKSPACE_SYMBOL_LIMIT} symbols elided…]` : "";
  const lines = limited.map((s) => `  ${formatSymbolInformation(s, context.workingDirectory)}`);
  return `Found ${deduped.length} symbol(s) matching "${normalizedQuery}":\n${lines.join("\n")}${truncation}${failureSection}`;
}

// -----------------------------------------------------------------------------
// capabilities / status / request
// -----------------------------------------------------------------------------

export async function runCapabilitiesAction(
  params: LspToolParams,
  context: { workingDirectory: string; workspaceRoot: string },
  signal: AbortSignal,
): Promise<string> {
  const config = getConfig(context.workingDirectory);
  let serverList: Array<[string, ServerConfig]>;
  if (params.file && params.file !== "*") {
    const resolved = resolveToolPath(params.file, context);
    serverList = getLspServersForFile(config, resolved);
    if (serverList.length === 0) return "No language server found for this file";
  } else {
    serverList = getLspServers(config);
    if (serverList.length === 0) return "No language servers configured";
  }
  const sections: string[] = [];
  for (const [serverName, serverConfig] of serverList) {
    throwIfAborted(signal);
    try {
      const client = await getOrCreateClient(serverConfig, context.workingDirectory, undefined, signal);
      sections.push(
        `${serverName}:\n  capabilities: ${JSON.stringify(client.serverCapabilities ?? {}, null, 2).split("\n").join("\n  ")}`,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      sections.push(`${serverName}: failed to start (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return sections.join("\n");
}

export async function runStatusAction(_context: { workingDirectory: string }, configured: LspConfig): Promise<string> {
  const started = getActiveClients();
  const names = Object.keys(configured.servers);
  if (names.length === 0) return "No language servers configured for this project";
  const labelled = names.map((name) => {
    const serverConfig = configured.servers[name]!;
    const live = started.find((c) => c.name === serverConfig.command);
    return live ? `${name} (${live.status})` : `${name} (configured, not started)`;
  });
  return [
    `Language servers: ${labelled.join(", ")}`,
    "  note: 'configured, not started' means the binary resolves but no request has spawned it yet; 'ready' means a live client process exists for this cwd.",
  ].join("\n");
}

export async function runRequestAction(
  params: LspToolParams,
  context: { workingDirectory: string; workspaceRoot: string },
  signal: AbortSignal,
): Promise<string> {
  const method = params.query?.trim();
  if (!method) throw new LspToolError("action=request requires `query` to specify the LSP method name");
  const config = getConfig(context.workingDirectory);

  let chosenServer: [string, ServerConfig] | null = null;
  let resolvedTarget: string | null = null;
  if (params.file && params.file !== "*") {
    resolvedTarget = resolveToolPath(params.file, context);
    chosenServer = getLspServerForFile(config, resolvedTarget);
    if (!chosenServer) throw new LspToolError(`No language server found for ${params.file}`);
  } else {
    const all = getLspServers(config);
    if (all.length === 0) throw new LspToolError("No language servers configured");
    chosenServer = all[0]!;
  }
  const [chosenName, chosenConfig] = chosenServer;

  let requestParams: unknown;
  if (params.payload !== undefined) {
    try {
      requestParams = JSON.parse(params.payload);
    } catch (error) {
      throw new LspToolError(`invalid JSON in payload: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (resolvedTarget) {
    const uri = fileToUri(resolvedTarget);
    if (params.line !== undefined) {
      const character = await resolveSymbolColumn(resolvedTarget, params.line, params.symbol);
      requestParams = { textDocument: { uri }, position: { line: params.line - 1, character } };
    } else {
      requestParams = { textDocument: { uri } };
    }
  } else {
    requestParams = {};
  }

  try {
    const client = await getOrCreateClient(chosenConfig, context.workingDirectory, undefined, signal);
    if (resolvedTarget) await reconcileFileFromDisk(client, resolvedTarget, signal);
    const result = await sendRequest(client, method, requestParams, signal);
    const formatted =
      result === null || result === undefined ? "null" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return `${chosenName} <- ${method}:\n${formatted}`;
  } catch (error) {
    if (signal.aborted) throw error;
    const previewRaw = JSON.stringify(requestParams ?? null);
    const preview = previewRaw.length > 400 ? `${previewRaw.slice(0, 397)}...` : previewRaw;
    throw new LspToolError(
      `LSP error from ${chosenName} on ${method}: ${error instanceof Error ? error.message : String(error)}\n  params: ${preview}`,
    );
  }
}
