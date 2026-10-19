// lsp 工具共享小类型（omp LspParams + applyCodeAction 依赖）。
import type { CodeAction, Command } from "./types.js";

export type LspActionName =
  | "diagnostics"
  | "definition"
  | "references"
  | "hover"
  | "symbols"
  | "rename"
  | "code_actions"
  | "type_definition"
  | "implementation"
  | "status"
  | "reload"
  | "capabilities"
  | "request";

export interface LspToolParams {
  action: LspActionName;
  file?: string;
  line?: number;
  symbol?: string;
  query?: string;
  new_name?: string;
  apply?: boolean;
  timeout?: number;
  payload?: string;
}

export type ApplyCodeActionFn = (action: CodeAction) => Promise<CodeAction>;
export type { CodeAction, Command };
