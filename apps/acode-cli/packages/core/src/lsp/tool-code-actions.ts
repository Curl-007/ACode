// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/utils.ts（applyCodeAction 切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// code action 应用：命令直执行、延迟 resolve、workspace edit 应用
// ============================================================

import type { CodeAction, Command } from "./types.js";

export interface CodeActionApplyDependencies {
  resolveCodeAction?: (action: CodeAction) => Promise<CodeAction>;
  applyWorkspaceEdit: (edit: NonNullable<CodeAction["edit"]>) => Promise<string[]>;
  executeCommand: (command: Command) => Promise<void>;
}

export interface AppliedCodeActionResult {
  title: string;
  edits: string[];
  executedCommands: string[];
}

function isCommandItem(action: CodeAction | Command): action is Command {
  return typeof (action as { command?: unknown }).command === "string";
}

export async function applyCodeAction(
  action: CodeAction | Command,
  dependencies: CodeActionApplyDependencies,
): Promise<AppliedCodeActionResult | null> {
  if (isCommandItem(action)) {
    await dependencies.executeCommand(action);
    return { title: action.title, edits: [], executedCommands: [action.command] };
  }

  let resolvedAction = action;
  if (!resolvedAction.edit && dependencies.resolveCodeAction) {
    try {
      resolvedAction = await dependencies.resolveCodeAction(resolvedAction);
    } catch {
      // resolve 可选；继续用未解析 action。
    }
  }

  const edits = resolvedAction.edit ? await dependencies.applyWorkspaceEdit(resolvedAction.edit) : [];
  const executedCommands: string[] = [];
  if (resolvedAction.command) {
    await dependencies.executeCommand(resolvedAction.command);
    executedCommands.push(resolvedAction.command.command);
  }

  if (edits.length === 0 && executedCommands.length === 0) return null;
  return { title: resolvedAction.title, edits, executedCommands };
}
