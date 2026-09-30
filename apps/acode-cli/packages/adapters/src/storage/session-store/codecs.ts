import {
  SESSION_TASK_TYPES,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_TITLE_SOURCES,
  parseModelSelectionValue,
  TodoConfidenceJsonSchema,
  TodoDepsJsonSchema,
  type CollaborationMode,
  type FileDiff,
  type MessageId,
  type MessageInfo,
  type MessagePart,
  type PartId,
  type PermissionRuleset,
  type ProjectId,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionRevert,
  type SessionTitleSource,
  type SessionEntryType,
  type TodoConfidenceJson,
  type TodoDepsJson,
  type TodoItem,
  type TraceId,
  type WorkspaceId,
  type SessionTaskType,
} from "@acode/contracts";
import { decodeJson } from "./json.js";
import type { MessageRow, PartRow, SessionEntryRow, SessionRow, TodoRow } from "./rows.js";

export function isCollaborationMode(value: unknown): value is CollaborationMode {
  return (
    value === "plan" ||
    value === "build" ||
    value === "edit" ||
    value === "yolo" ||
    value === "auto"
  );
}

function decodeSessionTaskType(value: string | null | undefined): SessionTaskType {
  return SESSION_TASK_TYPES.includes(value as SessionTaskType)
    ? (value as SessionTaskType)
    : "interactive";
}

function decodeSessionTitleSource(value: string | null | undefined): SessionTitleSource {
  return SESSION_TITLE_SOURCES.includes(value as SessionTitleSource)
    ? (value as SessionTitleSource)
    : "first_input";
}

export function decodeSessionRow(row: SessionRow): SessionInfo {
  return {
    id: row.id as SessionId,
    projectID: row.project_id as ProjectId,
    workspaceID: row.workspace_id ? (row.workspace_id as WorkspaceId) : undefined,
    parentID: row.parent_id ? (row.parent_id as SessionId) : undefined,
    traceID: row.trace_id ? (row.trace_id as TraceId) : undefined,
    taskType: decodeSessionTaskType(row.task_type),
    slug: row.slug,
    directory: row.directory,
    path: row.path ?? undefined,
    title: row.title,
    titleSource: decodeSessionTitleSource(row.title_source),
    titleMessageID: row.title_message_id ? (row.title_message_id as MessageId) : undefined,
    version: row.version,
    shareURL: row.share_url ?? undefined,
    summaryAdditions: row.summary_additions ?? undefined,
    summaryDeletions: row.summary_deletions ?? undefined,
    summaryFiles: row.summary_files ?? undefined,
    summaryDiffs: decodeJson<FileDiff[]>(row.summary_diffs),
    revert: decodeJson<SessionRevert>(row.revert),
    permission: decodeJson<PermissionRuleset>(row.permission),
    time: {
      created: row.time_created,
      updated: row.time_updated,
      titleUpdated: row.time_title_updated ?? undefined,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  };
}

export function decodeMessageRow(row: MessageRow): MessageInfo {
  return {
    ...decodeStoredMessage(JSON.parse(row.data) as unknown),
    id: row.id as MessageId,
    sessionID: row.session_id as SessionId,
  } as MessageInfo;
}

function decodeStoredMessage(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.role === "user") {
    const { model: _legacyModel, modelSelection: rawSelection, ...message } = value;
    // 迁移无法确定身份时可能留下 null；回滚后也可能缺字段。不能让配置残缺阻断整条消息的协议读取。
    // 这里只校验新结构，不查执行资格、不回读旧快照，磁盘内容保持不变。
    const modelSelection = parseModelSelectionValue(rawSelection);
    return { ...message, ...(modelSelection ? { modelSelection } : {}) };
  }
  if (value.role === "assistant") {
    const {
      providerID: _legacyProviderId,
      modelID: _legacyModelId,
      variant: _legacyReasoningLevel,
      ...message
    } = value;
    return message;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodePartRow(row: PartRow): MessagePart {
  return {
    ...decodeStoredPart(JSON.parse(row.data) as unknown),
    id: row.id as PartId,
    sessionID: row.session_id as SessionId,
    messageID: row.message_id as MessageId,
  } as MessagePart;
}

function decodeStoredPart(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.type === "timeline" && value.timelineType === "model_change") {
    const {
      fromModel: _oldFrom,
      toModel: _oldTo,
      fromModelSelection,
      toModelSelection,
      ...part
    } = value;
    const fromModel = decodeTimelineSelection(fromModelSelection);
    const toModel = decodeTimelineSelection(toModelSelection);
    return {
      ...part,
      ...(fromModel ? { fromModel } : {}),
      ...(toModel ? { toModel } : {}),
    };
  }
  if (value.type === "subtask") {
    const { model: _oldModel, modelSelection, ...part } = value;
    const model = parseModelSelectionValue(modelSelection);
    return { ...part, ...(model ? { model } : {}) };
  }
  return value;
}

function decodeTimelineSelection(value: unknown) {
  if (!isRecord(value)) return undefined;
  // label 仅是 Timeline 展示信息，不属于严格的 Selection；不能误删合法的带标签历史。
  const { label, ...rawSelection } = value;
  const selection = parseModelSelectionValue(rawSelection);
  return selection ? { ...selection, ...(typeof label === "string" ? { label } : {}) } : undefined;
}

export function decodeSessionEntryRow(row: SessionEntryRow): SessionEntryInfo {
  const rawData = JSON.parse(row.data) as unknown;
  return {
    id: row.id,
    sessionID: row.session_id as SessionId,
    type: row.type as SessionEntryType | string,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
    data:
      row.type === SESSION_ENTRY_MODEL_SELECTION
        ? decodeStoredSessionModelSelection(rawData)
        : rawData,
  };
}

function decodeStoredSessionModelSelection(value: unknown): unknown {
  // 旧平铺字段只属于升级入口。新成员即使为空/非法也不能借旧快照补值。
  // 解包在存储边界完成，core/bootstrap/fork 只消费 port 的当前逻辑 Selection。
  if (!isRecord(value)) return undefined;
  return parseModelSelectionValue(value.modelSelection) ?? value.modelSelection;
}

export function decodeTodoRow(row: TodoRow): TodoItem {
  return {
    content: row.content,
    status: row.status as TodoItem["status"],
    priority: row.priority as TodoItem["priority"],
    // D4（specs/todo-dependency-fields.md R5）：读回必须带上三个新字段——
    // 漏掉的症状是「写进去了、读回来只剩三字段」且不报错。
    ...decodeTodoDeps(row.deps_json),
    // J2-1（specs/todo-confidence-semantics.md R5）：同款纪律——completionConfidence 与
    // 工具自有 confidenceHistory 必须随读回带上，漏掉的症状同样是静默丢字段。
    ...decodeTodoConfidence(row.confidence_json),
  };
}

/**
 * deps_json 编码：只存规范化后的在场成员；三成员全缺席时写 null（与旧行同形）。
 * 序列化形状由 contracts 的 TodoDepsJsonSchema 唯一定义（跨存储边界走 schema，
 * apps/acode-cli/AGENTS.md「模块边界与接口契约」）。
 */
export function encodeTodoDeps(todo: TodoItem): string | null {
  const deps: TodoDepsJson = {};
  if (todo.id !== undefined) deps.id = todo.id;
  if (todo.blockedBy !== undefined) deps.blockedBy = todo.blockedBy;
  if (todo.metadata !== undefined) deps.metadata = todo.metadata;
  return Object.keys(deps).length === 0 ? null : JSON.stringify(deps);
}

/**
 * deps_json 解码：null / 坏 JSON / 形状校验失败（含未来版本写入新成员的前向数据）
 * 一律按「三字段缺席」处理——与 R5 回滚策略「忽略该列」同义，单行脏数据不能让整个
 * 会话的 todos 读不出来。
 */
function decodeTodoDeps(raw: string | null): TodoDepsJson {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = TodoDepsJsonSchema.safeParse(parsed);
  return result.success ? result.data : {};
}

/**
 * J2-1 confidence_json 编码（specs/todo-confidence-semantics.md R5，与 encodeTodoDeps
 * 同款做法）：只存在场成员，两成员全缺席写 null（与旧行同形）；空数组 history 不写
 * （不物化——工具侧追加规则保证 undefined 不变成 []，存储层不加第二份判断）。
 * 序列化形状由 contracts 的 TodoConfidenceJsonSchema 唯一定义（跨存储边界走 schema）。
 */
export function encodeTodoConfidence(todo: TodoItem): string | null {
  const confidence: TodoConfidenceJson = {};
  if (todo.completionConfidence !== undefined) {
    confidence.completionConfidence = todo.completionConfidence;
  }
  if (todo.confidenceHistory !== undefined && todo.confidenceHistory.length > 0) {
    confidence.confidenceHistory = [...todo.confidenceHistory];
  }
  return Object.keys(confidence).length === 0 ? null : JSON.stringify(confidence);
}

/**
 * J2-1 confidence_json 解码：null / 坏 JSON / 形状校验失败（含未来版本写入新成员或
 * 放宽窗口后的前向数据）一律按「两成员缺席」处理——与 decodeTodoDeps 同一纪律：
 * 回滚策略 =「忽略该列」，单行脏数据不能让整个会话的 todos 读不出来。
 */
function decodeTodoConfidence(raw: string | null): TodoConfidenceJson {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = TodoConfidenceJsonSchema.safeParse(parsed);
  return result.success ? result.data : {};
}

export function partCreatedAt(part: MessagePart, fallback: number): number {
  if (part.type === "text" || part.type === "reasoning") return part.time?.start ?? fallback;
  if (part.type === "compaction") return part.time?.start ?? fallback;
  if (part.type === "timeline") return part.time?.start ?? fallback;
  if (part.type === "tool") {
    if (part.state.status === "running") return part.state.time.start;
    if (part.state.status === "completed" || part.state.status === "error") {
      return part.state.time.start;
    }
  }
  if (part.type === "retry") return part.time.created;
  return fallback;
}
