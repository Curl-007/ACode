import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";

/**
 * K5 外部会话导入来源（spec：packages/services/specs/external-session-import-sources.md R1）。
 * 与 agent runtime 的 ACodeProvider 无关，只描述「从哪个外部工具的本地历史导入」。
 */
export type ExternalSessionSource =
  | "claude-code"
  | "openai-codex"
  | "gemini-cli"
  | "opencode"
  | "cursor";

/** 消息角色白名单；外部文件里的其它 role 一律丢弃并计数（R2 伪 role 防护）。 */
export type ExternalMessageRole = "user" | "assistant";

/** 工具调用摘要：只保留名称与文本投影，不还原执行环境（spec 裁剪边界）。 */
export interface ExternalToolCallSummary {
  toolName: string;
  summary?: string;
}

export interface ExternalMessageRecord {
  role: ExternalMessageRole;
  /** 用户可见文本投影；只取已知文本字段，不执行文件内任何可计算内容（R2）。 */
  content: string;
  ts?: number;
  model?: string;
  /** 消息段标记，如 Cursor subagent 拍平后的 "[subagent]"（R5）。 */
  segmentLabel?: string;
  toolCallSummaries?: ExternalToolCallSummary[];
}

/**
 * 单次解析的防护计数。行级/消息级跳过必须可解释（R2），
 * 导入结果据此聚合 skipped 原因，不静默吞。
 */
export interface ExternalSessionParseStats {
  skippedLines: number;
  skippedLinesOverSize: number;
  skippedLinesMalformed: number;
  skippedLinesTooDeep: number;
  /** 顶层数组/标量等「合法 JSON 但不是事件对象」的行。 */
  skippedLinesNonObject: number;
  /** 超过 1 MiB 上限被截断的字符串字段数。 */
  truncatedFields: number;
  /** role 不在白名单而被丢弃的消息数。 */
  droppedMessagesInvalidRole: number;
  /** 未知事件类型计数（forward-compat：静默跳过但记录）。 */
  unknownEventTypeCount: number;
  /** 已知但明确不导入的事件（心跳/token 计数/与主事件流重复的投影等）。 */
  knownNonMessageEventCount: number;
}

export interface ExternalSessionSummary {
  source: ExternalSessionSource;
  sourceSessionId: string;
  /** workspace 匹配提示；Cursor 解码失败时为原始目录名（R5：不猜）。 */
  projectHint?: string;
  cwd?: string;
  lastActivityTs: number;
  /**
   * 发现阶段的粗略消息数估计。受头部扫描窗口限制，只保证数量级，
   * 0 表示该来源发现阶段不估算（如 Gemini 的单文件 JSON 全量读取成本高）。
   */
  messageCountEstimate: number;
  sourcePath: string;
  title?: string;
  /** R7 repo_ranking 可选排序提示；feature flag 缺省关闭。 */
  rankHint?: number;
}

export interface ExternalSessionRecord {
  source: ExternalSessionSource;
  sourceSessionId: string;
  /** 任务 id 前缀；claude-code 保持历史值 "claude-import-" 以防关联断裂。 */
  importedTaskIdPrefix: string;
  cwd?: string;
  startedAtTs?: number;
  lastActivityTs?: number;
  title?: string;
  model?: string;
  messages: ExternalMessageRecord[];
  parseStats: ExternalSessionParseStats;
  sourcePath: string;
  /** claude-code 专用透传：既有原生解析产物原样保留，下游 buildImportedClaudeTaskFile 零改动。 */
  native?: ClaudeNativeImportedSessionSource;
}

/** parse 的会话引用：sourceSessionId 必填，sourcePath 可选（发现阶段已拿到时直读）。 */
export interface ExternalSessionRef {
  sourceSessionId: string;
  sourcePath?: string;
}

export interface ExternalSessionSourceAdapter {
  readonly source: ExternalSessionSource;
  readonly importedTaskIdPrefix: string;
  /**
   * 发现阶段的可选过滤参数。F4 契约：workspacePath 只是列表层的提示过滤——
   * adapter 能廉价判定 cwd 时可以过滤（claude-code 复用既有 repo 扫描），判定不了
   * （gemini 无 cwd）或判定不权威（codex/cursor/opencode 的发现 cwd 来自头部扫描，
   * 与 parse 全量 cwd 可能不一致）时返回全集，由 importExternalSessions 的
   * workspace-mismatch 守卫在导入时兜底；正确性的唯一所有者是 importService。
   */
  discoverSessions(params: {
    sinceTs?: number;
    limit?: number;
    workspacePath?: string;
  }): Promise<ExternalSessionSummary[]>;
  parseSession(ref: ExternalSessionRef): Promise<ExternalSessionRecord>;
}

export interface ExternalImportedItem {
  source: ExternalSessionSource;
  sourceSessionId: string;
  taskId: string;
  workspacePath?: string;
}

export interface ExternalSkippedItem {
  source: ExternalSessionSource;
  sourceSessionId: string;
  reason: string;
  workspacePath?: string;
}

export interface ExternalFailedItem {
  source: ExternalSessionSource;
  sourceSessionId: string;
  error: string;
  workspacePath?: string;
}

/**
 * services 层结构化导入结果（R2/R4）。不直接复用 shared 的
 * ACodeImportSessionsResult，因为其 provider 字段当前只允许 "claude"，
 * 而 shared 协议面不在本批次写权限内；见 spec 附录「origin 与结果类型」。
 */
export interface ExternalImportResult {
  imported: ExternalImportedItem[];
  skipped: ExternalSkippedItem[];
  /** 按原因聚合的 skipped 计数，供 UI 解释。 */
  skippedReasons: { reason: string; count: number }[];
  failed: ExternalFailedItem[];
}

/** 多来源并行发现时单来源失败的记录（allSettled 语义，不拖垮整轮）。 */
export interface ExternalImportFailedSource {
  source: ExternalSessionSource;
  error: string;
}
