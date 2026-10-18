// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/types.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// LSP 协议与客户端类型（omp 移植，Bun 无关的纯类型面）
// ============================================================

// -----------------------------------------------------------------------------
// Tool 参数与诊断结果（工具面共享形状）
// -----------------------------------------------------------------------------

export const LSP_ACTIONS = [
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

export type LspAction = (typeof LSP_ACTIONS)[number];

export interface LspParams {
  action: LspAction;
  file?: string;
  line?: number;
  symbol?: string;
  query?: string;
  new_name?: string;
  apply?: boolean;
  timeout?: number;
  payload?: string;
}

/** 诊断/格式化状态的单文件结果（模型可见形状，omp pi-tui/tools/lsp.ts 同形）。 */
export interface FileDiagnosticsResult {
  server?: string;
  messages: string[];
  summary: string;
  errored: boolean;
  formatter?: FileFormatResult;
}

/** 自动格式化结果枚举。 */
export enum FileFormatResult {
  UNCHANGED = "unchanged",
  FORMATTED = "formatted",
  FAILED = "failed",
  UNSUPPORTED = "unsupported",
}

/** 迟到诊断条目（omp tools/index.ts DeferredDiagnosticsEntry 同形）。 */
export interface DeferredDiagnosticsEntry {
  path: string;
  summary: string;
  messages: string[];
  errored: boolean;
  /** 注入时求值：同文件出现更新的变更则丢弃，模型永不看陈旧内容。 */
  isStale: () => boolean;
}

// -----------------------------------------------------------------------------
// Core LSP Protocol Types
// -----------------------------------------------------------------------------

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

export type DiagnosticSeverity = 1 | 2 | 3 | 4; // error, warning, info, hint

export interface DiagnosticRelatedInformation {
  location: Location;
  message: string;
}

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: string | number;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  tags?: number[];
  relatedInformation?: DiagnosticRelatedInformation[];
  data?: unknown;
}

export interface PublishedDiagnostics {
  diagnostics: Diagnostic[];
  version: number | null;
}

export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
  version?: number | null;
}

export interface TextEdit {
  range: Range;
  newText: string;
  insertTextFormat?: 1 | 2;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface OptionalVersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version?: number | null;
}

export interface TextDocumentEdit {
  textDocument: OptionalVersionedTextDocumentIdentifier;
  edits: (TextEdit | { range?: Range; newText?: string })[];
}

export interface CreateFile {
  kind: "create";
  uri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface RenameFile {
  kind: "rename";
  oldUri: string;
  newUri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export interface DeleteFile {
  kind: "delete";
  uri: string;
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
}

export type DocumentChange = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: DocumentChange[];
}

// -----------------------------------------------------------------------------
// Code Actions / Symbols / Hover
// -----------------------------------------------------------------------------

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
  data?: unknown;
}

export interface CodeActionContext {
  diagnostics: Diagnostic[];
  only?: string[];
  triggerKind?: 1 | 2;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

export interface Hover {
  contents: string | { kind: string; value: string } | { language: string; value: string } | unknown[];
  range?: Range;
}

// -----------------------------------------------------------------------------
// Server Configuration
// -----------------------------------------------------------------------------

export interface ServerConfig {
  command: string;
  args?: string[];
  fileTypes: string[];
  /** didOpen 发送的 LSP languageId；缺省按扩展名推断。 */
  languageId?: string;
  rootMarkers: string[];
  initOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  disabled?: boolean;
  /** 专用 linter/格式化服务器：不做类型智能；format-on-write 优先选它。 */
  isLinter?: boolean;
  /** 解析后的命令绝对路径（配置装载期写入）。 */
  resolvedCommand?: string;
}

export interface LspConfig {
  servers: Record<string, ServerConfig>;
  /** 空闲超时毫秒；未设置则不启用空闲关停。 */
  idleTimeoutMs?: number;
}

// -----------------------------------------------------------------------------
// Client State
// -----------------------------------------------------------------------------

export interface OpenFile {
  version: number;
  languageId: string;
  /** 最近同步给服务器的文本哈希；缺失 = 未知，下次 reconcile 视为 dirty。 */
  syncedHash?: string;
}

export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

export interface LspServerCapabilities {
  renameProvider?: boolean | { prepareProvider?: boolean };
  codeActionProvider?: boolean | { resolveProvider?: boolean };
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  documentSymbolProvider?: boolean;
  workspaceSymbolProvider?: boolean;
  diagnosticProvider?: boolean | Record<string, unknown>;
  documentFormattingProvider?: boolean;
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: { includeText?: boolean } };
  executeCommandProvider?: { commands?: string[] };
  [key: string]: unknown;
}

/** 传输面：node:child_process 的 stdin/stdout/exit 投影（omp LspTransport 降解形）。 */
export interface LspTransport {
  stdin: { write(data: string | Uint8Array): boolean; end(): void };
  stdout: NodeJS.ReadableStream;
  kill(): void;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  peekStderr(): string;
  pid?: number;
}

export interface LspClient {
  name: string;
  cwd: string;
  config: ServerConfig;
  proc: LspTransport;
  requestId: number;
  /** 等价 URI 键的发布诊断缓存。 */
  diagnostics: Map<string, PublishedDiagnostics>;
  diagnosticsVersion: number;
  /** 服务端动态注册（registrationId→method），用于 pull 诊断能力判定。 */
  dynamicCapabilityRegistrations: Map<string, string>;
  openFiles: Map<string, OpenFile>;
  pendingRequests: Map<number | string, PendingRequest>;
  isReading: boolean;
  status: "connecting" | "ready" | "error";
  serverCapabilities?: LspServerCapabilities;
  lastActivity: number;
  startedAt: number;
  /** 出站写队列（串行化）。 */
  writeQueue: Promise<void>;
  activeProgressTokens: Set<string | number>;
  projectLoaded: Promise<void>;
  resolveProjectLoaded: () => void;
}

// -----------------------------------------------------------------------------
// JSON-RPC
// -----------------------------------------------------------------------------

export type LspJsonRpcId = number | string;

export interface LspJsonRpcRequest {
  jsonrpc: "2.0";
  id: LspJsonRpcId;
  method: string;
  params: unknown;
}

export interface LspJsonRpcResponse {
  jsonrpc: "2.0";
  id?: LspJsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface LspJsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface LspServerStatus {
  name: string;
  status: "connecting" | "ready" | "error";
  fileTypes: string[];
  error?: string;
}
