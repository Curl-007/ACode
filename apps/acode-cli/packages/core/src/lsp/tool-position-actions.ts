// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/tool.ts（位置型 action 切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 位置型 lsp action：definition / type_definition / implementation /
// references / hover / symbols / rename / code_actions / reload
// ============================================================

import { getOrCreateClient, waitForProjectLoaded } from "./client.js";
import { reconcileFileFromDisk } from "./client-files.js";
import { sendRequest } from "./client-io.js";
import { getConfig } from "./config.js";
import {
  isOnlyQueriedDeclaration,
  normalizeLocationResult,
  PROJECT_INDEXED_ACTIONS,
  REFERENCE_CONTEXT_LIMIT,
  REFERENCES_RETRY_COUNT,
  REFERENCES_RETRY_DELAY_MS,
  SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
  waitForDiagnostics,
} from "./diagnostics.js";
import { applyWorkspaceEditWithLsp } from "./tool-edits.js";
import { isProjectAwareLspServer, reloadServer } from "./servers.js";
import {
  extractHoverText,
  formatCodeAction,
  formatDocumentSymbol,
  formatLocation,
  formatLocationWithContext,
  formatPathRelativeToCwd,
  formatWorkspaceEdit,
  resolveSymbolColumn,
  symbolKindToName,
} from "./format.js";
import { fileToUri } from "./uri.js";
import { getLspServerForFile } from "./servers.js";
import { LspToolError, resolveToolPath } from "./tool-actions.js";
import { applyCodeAction } from "./tool-code-actions.js";
import type { LspToolParams } from "./tool-types.js";
import type { CodeAction, Command, DocumentSymbol, LspClient, SymbolInformation } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new LspToolError("aborted");
}

async function positionForAction(
  client: LspClient,
  action: string,
  resolvedFile: string,
  params: LspToolParams,
  signal: AbortSignal,
): Promise<{ uri: string; position: { line: number; character: number }; reconciledFromDisk: boolean }> {
  const uri = fileToUri(resolvedFile);
  const reconciledFromDisk = await reconcileFileFromDisk(client, resolvedFile, signal);
  const needsProjectIndex = PROJECT_INDEXED_ACTIONS.has(action) && isProjectAwareLspServer(client.config);
  if (needsProjectIndex) await waitForProjectLoaded(client, signal);

  // 项目感知服务器上 references/rename/definition 无 symbol 会静默回退行首列，
  // 常常指向错误标识符——必须显式给 symbol。
  if (
    params.line !== undefined &&
    !params.symbol &&
    (action === "references" || action === "rename" || action === "definition") &&
    isProjectAwareLspServer(client.config)
  ) {
    throw new LspToolError(
      `symbol is required for project-aware ${action}; pass symbol=<name>, optionally symbol#N for repeated occurrences`,
    );
  }
  const resolvedLine = params.line ?? 1;
  const character = await resolveSymbolColumn(resolvedFile, resolvedLine, params.symbol);
  return { uri, position: { line: resolvedLine - 1, character }, reconciledFromDisk };
}

export async function runPositionAction(
  params: LspToolParams,
  context: { workingDirectory: string; workspaceRoot: string },
  signal: AbortSignal,
  waitMs: number,
): Promise<string> {
  if (!params.file) throw new LspToolError(`file parameter required for ${params.action}`);
  const config = getConfig(context.workingDirectory);
  const resolvedFile = resolveToolPath(params.file, context);
  const serverInfo = getLspServerForFile(config, resolvedFile);
  if (!serverInfo) throw new LspToolError(`No language server found for ${params.file}`);
  const [serverName, serverConfig] = serverInfo;

  const client = await getOrCreateClient(serverConfig, context.workingDirectory, undefined, signal);
  const { uri, position, reconciledFromDisk } = await positionForAction(
    client,
    params.action ?? "",
    resolvedFile,
    params,
    signal,
  );

  switch (params.action) {
    case "definition":
    case "type_definition":
    case "implementation": {
      const method =
        params.action === "definition"
          ? "textDocument/definition"
          : params.action === "type_definition"
            ? "textDocument/typeDefinition"
            : "textDocument/implementation";
      const result = await sendRequest(client, method, { textDocument: { uri }, position }, signal);
      const locations = normalizeLocationResult(result as never);
      if (locations.length === 0) return `No ${params.action.replace("_", " ")} found`;
      const lines = await Promise.all(locations.map((location) => formatLocationWithContext(location, context.workingDirectory)));
      return `Found ${locations.length} ${params.action}(s):\n${lines.join("\n")}`;
    }

    case "references": {
      // 项目感知服务器偶尔在工程索引就绪前只报声明本身：重试几次并等待工程加载。
      let result: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> | null = null;
      for (let attempt = 0; attempt <= REFERENCES_RETRY_COUNT; attempt += 1) {
        result = (await sendRequest(
          client,
          "textDocument/references",
          { textDocument: { uri }, position, context: { includeDeclaration: true } },
          signal,
        )) as typeof result;
        const locations = result ?? [];
        if (!isProjectAwareLspServer(serverConfig) || attempt === REFERENCES_RETRY_COUNT) break;
        if (locations.length > 0 && !isOnlyQueriedDeclaration(locations, uri, position)) break;
        await waitForProjectLoaded(client, signal);
        throwIfAborted(signal);
        await sleep(REFERENCES_RETRY_DELAY_MS);
      }
      const locations = result ?? [];
      if (locations.length === 0) return "No references found";
      const contextual = locations.slice(0, REFERENCE_CONTEXT_LIMIT);
      const contextualLines = await Promise.all(contextual.map((location) => formatLocationWithContext(location, context.workingDirectory)));
      const rest = locations.slice(REFERENCE_CONTEXT_LIMIT).map((location) => `  ${formatLocation(location, context.workingDirectory)}`);
      const lines = rest.length
        ? [...contextualLines, `  ... ${rest.length} additional reference(s) shown without context`, ...rest]
        : contextualLines;
      return `Found ${locations.length} reference(s):\n${lines.join("\n")}`;
    }

    case "hover": {
      const result = (await sendRequest(client, "textDocument/hover", { textDocument: { uri }, position }, signal)) as {
        contents?: unknown;
      } | null;
      if (!result?.contents) return "No hover information";
      return extractHoverText(result.contents as never);
    }

    case "symbols": {
      const result = (await sendRequest(client, "textDocument/documentSymbol", { textDocument: { uri } }, signal)) as
        | DocumentSymbol[]
        | SymbolInformation[]
        | null;
      if (!result || result.length === 0) return "No symbols found";
      const relPath = formatPathRelativeToCwd(resolvedFile, context.workingDirectory);
      const first = result[0] as unknown as Record<string, unknown>;
      if ("selectionRange" in first) {
        const lines = (result as DocumentSymbol[]).flatMap((s) => formatDocumentSymbol(s));
        return `Symbols in ${relPath}:\n${lines.join("\n")}`;
      }
      const lines = (result as SymbolInformation[]).map(
        (s) => `${symbolKindToName(s.kind)} ${s.name} @ line ${s.location.range.start.line + 1}`,
      );
      return `Symbols in ${relPath}:\n${lines.join("\n")}`;
    }

    case "rename": {
      if (!params.new_name) throw new LspToolError("new_name parameter required for rename");
      const result = (await sendRequest(
        client,
        "textDocument/rename",
        { textDocument: { uri }, position, newName: params.new_name },
        signal,
      )) as Parameters<typeof formatWorkspaceEdit>[0] | null;
      if (!result) return "Rename returned no edits";
      if (params.apply === false) {
        const preview = formatWorkspaceEdit(result, context.workingDirectory);
        return `Rename preview:\n${preview.map((p) => `  ${p}`).join("\n")}`;
      }
      const applied = await applyWorkspaceEditWithLsp(result, context.workingDirectory, signal);
      return `Applied rename:\n${applied.map((a) => `  ${a}`).join("\n")}`;
    }

    case "code_actions": {
      let diagnostics = client.diagnostics.get(uri)?.diagnostics ?? [];
      if (reconciledFromDisk) {
        try {
          diagnostics = await waitForDiagnostics(client, uri, {
            timeoutMs: Math.min(isProjectAwareLspServer(serverConfig) ? waitMs : SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, 15000),
            signal,
            expectedDocumentVersion: client.openFiles.get(uri)?.version,
          });
        } catch {
          if (signal.aborted) throw signal.reason;
          diagnostics = client.diagnostics.get(uri)?.diagnostics ?? [];
        }
      }
      const result = (await sendRequest(
        client,
        "textDocument/codeAction",
        {
          textDocument: { uri },
          range: { start: position, end: position },
          context: { diagnostics, only: params.apply !== true && params.query ? [params.query] : undefined, triggerKind: 1 },
        },
        signal,
      )) as Array<CodeAction | Command> | null;

      if (!result || result.length === 0) return "No code actions available";
      const listed = result.map((item, index) => `  ${formatCodeAction(item, index)}`).join("\n");

      if (params.apply === true) {
        const normalizedQuery = params.query?.trim() ?? "";
        if (!normalizedQuery) throw new LspToolError("query parameter required when apply=true for code_actions");
        const parsedIndex = /^\d+$/.test(normalizedQuery) ? Number.parseInt(normalizedQuery, 10) : null;
        const selected =
          parsedIndex !== null
            ? result[parsedIndex]
            : result.find((item) => item.title.toLowerCase().includes(normalizedQuery.toLowerCase()));
        if (!selected) return `No code action matches "${normalizedQuery}". Available actions:\n${listed}`;

        const appliedAction = await applyCodeAction(selected, {
          resolveCodeAction: async (actionItem) =>
            (await sendRequest(client, "codeAction/resolve", actionItem, signal)) as CodeAction,
          applyWorkspaceEdit: async (edit) => applyWorkspaceEditWithLsp(edit, context.workingDirectory, signal),
          executeCommand: async (commandItem) => {
            await sendRequest(
              client,
              "workspace/executeCommand",
              { command: commandItem.command, arguments: commandItem.arguments ?? [] },
              signal,
            );
          },
        });
        if (!appliedAction) return `Action "${selected.title}" has no workspace edit or command to apply`;
        const summaryLines: string[] = [];
        if (appliedAction.edits.length > 0) summaryLines.push(...appliedAction.edits.map((item) => `    ${item}`));
        if (appliedAction.executedCommands.length > 0) {
          summaryLines.push(...appliedAction.executedCommands.map((commandName) => `    executed: ${commandName}`));
        }
        return `Applied "${appliedAction.title}":\n${summaryLines.join("\n")}`;
      }
      return `${result.length} code action(s):\n${listed}`;
    }

    case "reload": {
      return reloadServer(client, serverName, signal);
    }

    default:
      throw new LspToolError(`Unknown position action: ${params.action}`);
  }
}
