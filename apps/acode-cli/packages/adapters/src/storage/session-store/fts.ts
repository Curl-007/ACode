/* eslint-disable max-lines -- K4 跨会话搜索:FTS5 索引生命周期(建表迁移、增量索引、snippet、回填与孤儿清理)集中维护,拆散会让索引一致性的单一出处分散。 */
// ============================================================
// K4 跨会话搜索：session_message_fts 投影的维护与检索（specs/session-search.md）
// ============================================================
// 本文件是 session_message_fts 的**唯一投影实现**（R6 不变量：body 投影规则只有
// 一份代码）。修改 projectSessionMessageBody 的收录/排除规则 = 索引语义变更：
// 已落库的行不会自动重投影（投影是写时物化），存量与新写会分叉。终解只有
// 「删投影重建回填」，属破坏性操作默认禁止；规则演进必须新增迁移做全量重投影，
// 不允许悄悄改这里的过滤条件。
//
// 检索口径（spec 附录 2026-10-04 实测定死）：trigram MATCH token 最短 3 字符，
// 查询归一后按段拆分——≥3 字符段进 MATCH（全部短语引号包裹，杜绝语法错误），
// <3 字符段（CJK 两字词、短拉丁）降级 body LIKE '%段%'，LIKE 打在 FTS5 虚表
// session_message_fts 的 body 列上（trigram 的 LIKE/GLOB 索引加速只对虚表列成立，
// SQLite ≥3.34 设计用途；node:sqlite + SQLite 3.52 实测可用，escape 子句语义与
// 普通表一致——M2 对抗复核后不再扫 session_message_doc 普通表），两路结果 OR
// 合并：MATCH 命中按 rank 优先排前，LIKE 兜底命中按时间倒序排后。prefix `seg*`
// 与短语引号都救不了 <3 字符段，不要尝试。
import type { DatabaseSync } from "node:sqlite";
import type { MessageInfo, MessagePart } from "@acode/contracts";
import { decodeMessageRow, decodePartRow } from "./codecs.js";
import type { MessageRow, PartRow } from "./rows.js";

export const FTS_BODY_MAX_CHARS = 20_000;
export const FTS_BACKFILL_BATCH_ROWS = 1_000;
export const SESSION_SEARCH_DEFAULT_LIMIT = 10;
export const SESSION_SEARCH_MAX_LIMIT = 50;
export const SESSION_SEARCH_TIMEOUT_MS = 500;
export const SESSION_SEARCH_QUERY_MAX_CHARS = 256;

const FTS_BODY_TRUNCATION_MARKER = "…[truncated]";
/** tool 调用入参摘要：只收这些键的字符串值（命令行/路径/查询词），按固定序取，保证投影确定性。 */
const FTS_TOOL_INPUT_SUMMARY_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
  "skill",
  "name",
] as const;
const FTS_TOOL_INPUT_FIELD_MAX_CHARS = 512;
const FTS_TOOL_INPUT_SUMMARY_MAX_CHARS = 2_000;
const FTS_QUERY_OPERATOR_TOKENS = new Set(["AND", "OR", "NOT", "NEAR"]);
// snippet 高亮哨兵（U+0001/U+0002，正文里不可能出现的控制字符）：SQL 侧用它做标记，
// 渲染时先整体转义 &<> 再换回 < >，保证正文里的尖括号不可能以真实标签形态出现在
// 工具输出里（R4 防内容注入）。源码用 fromCharCode 构造，不落原始控制字节。
const SNIPPET_HIGHLIGHT_START = String.fromCharCode(1);
const SNIPPET_HIGHLIGHT_END = String.fromCharCode(2);

// ── body 文本投影（唯一实现） ─────────────────────────────

function truncateChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * tool 调用入参摘要：R3 只收「上次那条 pnpm 命令」级别的可检索字段，
 * 排除 state.output/error（噪音主源）与嵌套对象。
 */
function summarizeToolInput(
  tool: string,
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return "";
  const fields: string[] = [];
  for (const key of FTS_TOOL_INPUT_SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    fields.push(truncateChars(value.trim(), FTS_TOOL_INPUT_FIELD_MAX_CHARS));
    if (fields.join(" ").length >= FTS_TOOL_INPUT_SUMMARY_MAX_CHARS) break;
  }
  if (fields.length === 0) return "";
  const summary = `${tool}: ${fields.join(" ")}`;
  return truncateChars(summary, FTS_TOOL_INPUT_SUMMARY_MAX_CHARS);
}

/**
 * 消息行级 body 投影（R3）：
 * - 收录：text 块（真实用户/助手文本）、thinking（reasoning）块、tool 调用入参摘要；
 * - 排除：tool 结果体、file/图片/二进制块、synthetic 文本（reminders/合成通知的持久
 *   形态，每会话雷同，进索引只会污染召回）、legacy `<system-reminder>` 文本形态、
 *   message.system（系统提示词快照，同样每会话雷同）；
 * - parts 顺序由调用方保证（读路径按 sequence 排序后传入），投影确定性依赖它。
 */
export function projectSessionMessageBody(
  info: MessageInfo,
  parts: readonly MessagePart[],
): string {
  // R3：只投影对话消息（MessageInfo 当前只有 user/assistant 两态，防御未来新增的
  // 系统性角色静默进入检索面）；info.system（系统提示词快照）刻意不投影。
  if (info.role !== "user" && info.role !== "assistant") return "";
  const segments: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      // synthetic 是 reminders/系统通知落库的标记（core/session-history-hydrator 同款判定）；
      // ignored 是被显式隐藏的文本。两者都不是「人说过的话」，不进检索面。
      if (part.synthetic === true || part.ignored === true) continue;
      if (part.text.trimStart().startsWith("<system-reminder>")) continue;
      if (part.text.trim().length > 0) segments.push(part.text);
      continue;
    }
    if (part.type === "reasoning") {
      if (part.text.trim().length > 0) segments.push(part.text);
      continue;
    }
    if (part.type === "tool") {
      const summary = summarizeToolInput(part.tool, part.state.input);
      if (summary.length > 0) segments.push(summary);
      continue;
    }
    // file（图片/附件/二进制）、timeline、compaction、subtask、snapshot 等系统块不收录。
  }
  const body = segments.join("\n");
  if (body.length <= FTS_BODY_MAX_CHARS) return body;
  return `${body.slice(0, FTS_BODY_MAX_CHARS - FTS_BODY_TRUNCATION_MARKER.length)}${FTS_BODY_TRUNCATION_MARKER}`;
}

// ── 同事务维护（messages 仓储写路径接线用） ─────────────────

interface MessageProjectionRow {
  session_id: string;
  role: string;
  message_ts: number;
  body: string;
}

interface DocRow {
  id: number;
  message_id: string;
  session_id: string;
  task_id: string;
  role: string;
  message_ts: number;
  body: string;
}

/** 从主表当前状态重算投影。调用方必须已在事务内（写路径同事务不变量）。 */
function readMessageProjection(db: DatabaseSync, messageId: string): MessageProjectionRow | null {
  const messageRow = db
    .prepare("select * from message where id = ?")
    .get(messageId) as unknown as MessageRow | undefined;
  if (!messageRow) return null;
  const partRows = db
    .prepare(
      `
      select * from part
      where message_id = ?
      order by sequence is null, sequence, time_created, id
      `,
    )
    .all(messageId) as unknown as PartRow[];
  const info = decodeMessageRow(messageRow);
  const body = projectSessionMessageBody(
    info,
    partRows.map(decodePartRow),
  );
  return {
    session_id: String(info.sessionID),
    role: info.role,
    message_ts: messageRow.time_created,
    body,
  };
}

/**
 * 外部内容表的 'delete' 命令：按 doc 行**旧值**撤掉倒排 token。必须在更新/删除
 * doc 行之前用旧值调用（FTS5 需要旧 token 序列才能撤销索引）。
 */
function ftsDeleteByDocValues(db: DatabaseSync, doc: DocRow): void {
  db.prepare(
    `
    insert into session_message_fts (
      session_message_fts, rowid, body, session_id, task_id, role, message_ts
    ) values ('delete', ?, ?, ?, ?, ?, ?)
    `,
  ).run(doc.id, doc.body, doc.session_id, doc.task_id, doc.role, doc.message_ts);
}

/**
 * 重投影一条消息并维护 doc + FTS（幂等：以主表当前状态为准全量重写投影行）。
 * 调用方必须已在事务内——本函数不自己开事务，保证「主表写 + FTS 维护」由同一条
 * 事务边界收口（saveMessage/savePart/removeMessage 经 runInSessionMessageFtsTransaction
 * 接线；fork bundle / promote 等外层事务场景直接内联进外层事务）。
 */
export function syncSessionMessageFtsRow(db: DatabaseSync, messageId: string): void {
  const doc = db
    .prepare("select * from session_message_doc where message_id = ?")
    .get(messageId) as unknown as DocRow | undefined;
  const projection = readMessageProjection(db, messageId);
  if (!projection) {
    // 主行不存在（级联删除等旁路）：投影必须先于主表数据消失，这里是防御位。
    if (doc) {
      ftsDeleteByDocValues(db, doc);
      db.prepare("delete from session_message_doc where id = ?").run(doc.id);
    }
    return;
  }
  const now = Date.now();
  let rowid: number;
  if (doc) {
    ftsDeleteByDocValues(db, doc);
    rowid = doc.id;
    db.prepare(
      `
      update session_message_doc
      set session_id = ?, task_id = ?, role = ?, message_ts = ?, body = ?, time_updated = ?
      where id = ?
      `,
    ).run(
      projection.session_id,
      projection.session_id,
      projection.role,
      projection.message_ts,
      projection.body,
      now,
      rowid,
    );
  } else {
    const result = db
      .prepare(
        `
        insert into session_message_doc (
          message_id, session_id, task_id, role, message_ts, body, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        messageId,
        projection.session_id,
        projection.session_id,
        projection.role,
        projection.message_ts,
        projection.body,
        now,
        now,
      );
    rowid = Number(result.lastInsertRowid);
  }
  db.prepare(
    `
    insert into session_message_fts (rowid, body, session_id, task_id, role, message_ts)
    values (?, ?, ?, ?, ?, ?)
    `,
  ).run(
    rowid,
    projection.body,
    projection.session_id,
    projection.session_id,
    projection.role,
    projection.message_ts,
  );
}

/** 删除一条消息的投影行（removeMessage 同事务调用）。 */
export function removeSessionMessageFtsRow(db: DatabaseSync, messageId: string): void {
  const doc = db
    .prepare("select * from session_message_doc where message_id = ?")
    .get(messageId) as unknown as DocRow | undefined;
  if (!doc) return;
  ftsDeleteByDocValues(db, doc);
  db.prepare("delete from session_message_doc where id = ?").run(doc.id);
}

/**
 * 写路径事务包装：不在事务内时把「主表写 + FTS 维护」收进一个 begin immediate；
 * 已在外层事务（fork bundle / promote）时内联执行，由外层事务保证原子性。
 * FTS 维护失败必须让整个写回滚——不允许索引落后于主表（R1 不变量）。
 */
export function runInSessionMessageFtsTransaction(db: DatabaseSync, write: () => void): void {
  if (db.isTransaction) {
    write();
    return;
  }
  db.exec("begin immediate");
  try {
    write();
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

// ── 查询封装 ─────────────────────────────────────────────

export interface SessionSearchQueryPlan {
  /** 存在 ≥3 字符段时非空；形如 `"段1" OR "段2"`（全引号包裹，杜绝 MATCH 语法错误）。 */
  matchExpr: string | null;
  /** <3 字符段的 LIKE 模式（含 % 包裹与 escape 转义）。 */
  likePatterns: string[];
  /** 全部段的原文（去重），供 matchCount 统计。 */
  terms: string[];
}

function countCodePoints(text: string): number {
  return [...text].length;
}

/** 归一侧的防御性截断（handler 已做 256 截断；这里挡住绕过 handler 的直接调用）。 */
function clampQuery(raw: string): string {
  let query = raw.slice(0, SESSION_SEARCH_QUERY_MAX_CHARS);
  // 截断可能切在高代理项上；dangling 高代理会让 FTS5 token 化报错，剥掉。
  const last = query.charCodeAt(query.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) query = query.slice(0, -1);
  return query;
}

/**
 * 查询分解（检索口径，spec 附录定死）：
 * - 引号短语成段（`"exact phrase"` 整段保留）；
 * - 裸 AND/OR/NOT/NEAR 是 FTS5 算符 token——组合语义已定死为段间 OR（多段 OR 组合），
 *   透传它们只会造成「按算符理解却按 OR 执行」的错觉，直接当停用词丢弃；
 * - 每段按字符数（码点）分流：≥3 → MATCH 短语；<3 → LIKE 兜底。
 */
export function planSessionSearchQuery(rawQuery: string): SessionSearchQueryPlan {
  const query = clampQuery(rawQuery);
  const segments: string[] = [];
  let buffer = "";
  const flushBuffer = () => {
    const trimmed = buffer.trim().replace(/\s+/g, " ");
    if (trimmed.length > 0) segments.push(trimmed);
    buffer = "";
  };
  let index = 0;
  while (index < query.length) {
    const ch = query[index];
    if (ch === '"') {
      flushBuffer();
      const close = query.indexOf('"', index + 1);
      const inner = close === -1 ? query.slice(index + 1) : query.slice(index + 1, close);
      const trimmed = inner.trim().replace(/\s+/g, " ");
      if (trimmed.length > 0) segments.push(trimmed);
      index = close === -1 ? query.length : close + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      flushBuffer();
      index += 1;
      continue;
    }
    buffer += ch;
    index += 1;
  }
  flushBuffer();

  const matchTerms: string[] = [];
  const likeTerms: string[] = [];
  for (const segment of segments) {
    if (FTS_QUERY_OPERATOR_TOKENS.has(segment)) continue;
    if (countCodePoints(segment) >= 3) matchTerms.push(segment);
    else likeTerms.push(segment);
  }
  return {
    matchExpr: matchTerms.length > 0 ? matchTerms.map((term) => `"${term}"`).join(" OR ") : null,
    likePatterns: likeTerms.map((term) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`),
    terms: [...new Set([...matchTerms, ...likeTerms])],
  };
}

export interface SessionMessageSearchInput {
  /** 已归一的查询（handler 负责 256 截断/引号修复/* 剥离；此处再防御一次）。 */
  query: string;
  taskId?: string;
  /** 排除的会话（默认隐藏当前会话由 handler 传入）。 */
  excludeTaskId?: string;
  beforeTs?: number;
  afterTs?: number;
  limit?: number;
  timeoutMs?: number;
}

export interface SessionMessageSearchRow {
  messageId: string;
  sessionId: string;
  taskId: string;
  taskTitle: string;
  role: string;
  messageTs: number;
  snippet: string;
  matchCount: number;
}

export interface SessionMessageSearchOutput {
  rows: SessionMessageSearchRow[];
  /** 查询超时（部分返回）或 limit 截断时为 true。 */
  truncated: boolean;
}

interface InternalSearchRow {
  messageId: string;
  sessionId: string;
  taskId: string;
  taskTitle: string;
  role: string;
  messageTs: number;
  body: string;
  snippet: string;
}

/** snippet 渲染的 HTML 转义（& < >）：唯一转义实现（R4 防内容注入）。 */
function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * L1（K4 对抗复核）：正文可能携带字面 U+0001/U+0002（导入历史/恶意模型输出落库），
 * 不先剥除的话正文自己就能拼出「哨兵对」，渲染后变成真实尖括号标签，击穿
 * renderSnippet 注释声明的不变量。所有进入渲染的正文文本必须先经此处剥除：
 * 正文自身永远造不出哨兵（替换为空：控制字符无展示价值）。
 */
function stripSnippetSentinels(text: string): string {
  return text
    .split(SNIPPET_HIGHLIGHT_START)
    .join("")
    .split(SNIPPET_HIGHLIGHT_END)
    .join("");
}

/**
 * snippet 渲染：输入必须是「已剥除正文哨兵的文本 + 高亮哨兵」（L1 前置条件，
 * 见 stripSnippetSentinels 的调用方）。转义 &<> 后再把哨兵换回 < >——正文里的
 * `<script>` 只能以 `&lt;script&gt;` 形态出现，不会产生真实标签
 * （R4 防内容注入 UI）。
 */
function renderSnippet(raw: string): string {
  return escapeHtmlText(raw)
    .split(SNIPPET_HIGHLIGHT_START)
    .join("<")
    .split(SNIPPET_HIGHLIGHT_END)
    .join(">");
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** LIKE 兜底命中没有 MATCH 上下文（OR 场景下 FTS5 拒绝计算 rank/snippet，实测），
 * 片段在 JS 侧以首个命中位置为中心 ±64 字符窗口手工构造。 */
function buildLikeSnippet(rawBody: string, plan: SessionSearchQueryPlan): string {
  // L1：正文先剥除字面哨兵，之后再插入高亮哨兵——正文自身造不出哨兵。
  const body = stripSnippetSentinels(rawBody);
  const lowerBody = body.toLowerCase();
  let hitStart = -1;
  let hitLength = 0;
  for (const term of plan.terms) {
    const index = lowerBody.indexOf(term.toLowerCase());
    if (index !== -1) {
      hitStart = index;
      hitLength = term.length;
      break;
    }
  }
  if (hitStart === -1) return renderSnippet(body.slice(0, 128));
  const windowStart = Math.max(0, hitStart - 64);
  const windowEnd = Math.min(body.length, hitStart + hitLength + 64);
  const prefix = windowStart > 0 ? "…" : "";
  const suffix = windowEnd < body.length ? "…" : "";
  return renderSnippet(
    `${prefix}${body.slice(windowStart, hitStart)}${SNIPPET_HIGHLIGHT_START}${body.slice(
      hitStart,
      hitStart + hitLength,
    )}${SNIPPET_HIGHLIGHT_END}${body.slice(hitStart + hitLength, windowEnd)}${suffix}`,
  );
}

/**
 * MATCH 路径 snippet 渲染（L1，K4 对抗复核）：FTS5 snippet() 的输出把正文与哨兵
 * 混排，事后无法区分「正文自带的哨兵」与「SQL 插入的高亮哨兵」——因此不信任 SQL
 * 侧哨兵：只取它的窗口文本（剥除全部哨兵后的原文，窗口选择仍是 FTS5 的相关性
 * 窗口），在 JS 侧重新定位命中词并加高亮。窗口内找不到命中词时退化为纯转义窗口
 * （无高亮，但不变量不破）。正文自身永远造不出哨兵（R4 防内容注入）。
 */
function renderMatchSnippet(sqlSnippet: string, plan: SessionSearchQueryPlan): string {
  const windowText = stripSnippetSentinels(sqlSnippet);
  const lowerWindow = windowText.toLowerCase();
  for (const term of plan.terms) {
    const index = lowerWindow.indexOf(term.toLowerCase());
    if (index !== -1) {
      return (
        escapeHtmlText(windowText.slice(0, index)) +
        "<" +
        escapeHtmlText(windowText.slice(index, index + term.length)) +
        ">" +
        escapeHtmlText(windowText.slice(index + term.length))
      );
    }
  }
  return escapeHtmlText(windowText);
}

interface SearchFilters {
  taskId?: string;
  excludeTaskId?: string;
  beforeTs?: number;
  afterTs?: number;
}

function searchFilterClauses(filters: SearchFilters): {
  clauses: string[];
  params: (string | number)[];
} {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.taskId !== undefined) {
    clauses.push("d.task_id = ?");
    params.push(filters.taskId);
  }
  if (filters.excludeTaskId !== undefined) {
    clauses.push("d.session_id != ?");
    params.push(filters.excludeTaskId);
  }
  if (filters.beforeTs !== undefined) {
    clauses.push("d.message_ts < ?");
    params.push(filters.beforeTs);
  }
  if (filters.afterTs !== undefined) {
    clauses.push("d.message_ts > ?");
    params.push(filters.afterTs);
  }
  return { clauses, params };
}

/** MATCH 阶段：纯 MATCH 约束（rank 可用，相关性优先，同分新者在前）。 */
function queryMatchPhase(
  db: DatabaseSync,
  matchExpr: string,
  filters: SearchFilters,
  limit: number,
): InternalSearchRow[] {
  const { clauses, params } = searchFilterClauses(filters);
  return db
    .prepare(
      `
      select
        d.message_id as messageId,
        d.session_id as sessionId,
        d.task_id as taskId,
        d.role as role,
        d.message_ts as messageTs,
        d.body as body,
        coalesce(s.title, '') as taskTitle,
        snippet(session_message_fts, 0, '${SNIPPET_HIGHLIGHT_START}', '${SNIPPET_HIGHLIGHT_END}', '…', 8) as snippet
      from session_message_fts
      join session_message_doc d on d.id = session_message_fts.rowid
      left join session s on s.id = d.session_id
      where session_message_fts match ?
        and exists (select 1 from message m where m.id = d.message_id)
        ${clauses.length > 0 ? `and ${clauses.join(" and ")}` : ""}
      order by rank, d.message_ts desc
      limit ?
      `,
    )
    .all(matchExpr, ...params, limit) as unknown as InternalSearchRow[];
}

/** LIKE 阶段：无 MATCH 约束（rank/snippet 在 OR 场景不可用，实测 SQLITE 逻辑错误），
 * 按时间倒序兜底；与 MATCH 阶段结果按 messageId 去重合并。
 *
 * M2（K4 对抗复核）：LIKE 打在 FTS5 虚表 session_message_fts 的 body 列上——
 * trigram 的 LIKE/GLOB 索引加速只对虚表列成立（SQLite ≥3.34 设计用途），此前打在
 * session_message_doc 普通表是必然全表子串扫。JOIN 回元数据列的方式与 MATCH 段
 * 同构（虚表行的 session_id/task_id/role/message_ts 是 UNINDEXED 列，doc 表补
 * message_id）；escape 子句在虚表上实测语义与普通表一致。 */
function queryLikePhase(
  db: DatabaseSync,
  likePatterns: string[],
  filters: SearchFilters,
  limit: number,
): InternalSearchRow[] {
  const { clauses, params } = searchFilterClauses(filters);
  const likeArms = likePatterns.map(() => "session_message_fts.body like ? escape '\\'");
  return db
    .prepare(
      `
      select
        d.message_id as messageId,
        d.session_id as sessionId,
        d.task_id as taskId,
        d.role as role,
        d.message_ts as messageTs,
        d.body as body,
        coalesce(s.title, '') as taskTitle,
        '' as snippet
      from session_message_fts
      join session_message_doc d on d.id = session_message_fts.rowid
      left join session s on s.id = d.session_id
      where (${likeArms.join(" or ")})
        and exists (select 1 from message m where m.id = d.message_id)
        ${clauses.length > 0 ? `and ${clauses.join(" and ")}` : ""}
      order by d.message_ts desc
      limit ?
      `,
    )
    .all(...likePatterns, ...params, limit) as unknown as InternalSearchRow[];
}

/**
 * 查询封装（R4）：trigram MATCH（≥3 字符段）+ 短段 LIKE 兜底，两路 OR 合并；
 * MATCH 命中按 rank 优先、同分新者在前，LIKE 兜底命中按时间倒序排在其后；
 * 超时（默认 500ms）返回已完成部分 + truncated。DatabaseSync 是同步驱动，期限
 * 只能在阶段间检查（排序期不可中断）——个人库规模下排序耗时可忽略，这是同步
 * 驱动下能做到的诚实边界。查询语句本身同样不可中断：阶段跑完后若已超期，必须
 * 如实置 truncated（M2 对抗复核：不能把超期完成的整段结果伪装成完整结果）。
 */
export function searchSessionMessages(
  db: DatabaseSync,
  input: SessionMessageSearchInput,
): SessionMessageSearchOutput {
  const plan = planSessionSearchQuery(input.query);
  const limit = Math.min(
    Math.max(1, input.limit ?? SESSION_SEARCH_DEFAULT_LIMIT),
    SESSION_SEARCH_MAX_LIMIT,
  );
  const startedAt = Date.now();
  const budgetMs = Math.max(0, input.timeoutMs ?? SESSION_SEARCH_TIMEOUT_MS);
  const expired = () => Date.now() - startedAt >= budgetMs;
  const collected: InternalSearchRow[] = [];
  const seen = new Set<string>();
  let moreAvailable = false;
  let timedOut = false;

  // 每阶段多取 1 行探测「还有更多」；超过空余槽位即置截断标记。
  const collect = (rows: InternalSearchRow[]): void => {
    const openSlots = limit - collected.length;
    if (rows.length > openSlots) {
      moreAvailable = true;
      rows.length = Math.max(0, openSlots);
    }
    for (const row of rows) {
      if (seen.has(row.messageId)) continue;
      seen.add(row.messageId);
      collected.push(row);
    }
  };

  if (plan.matchExpr !== null) {
    if (!expired()) {
      collect(queryMatchPhase(db, plan.matchExpr, input, limit - collected.length + 1));
      // M2（K4 对抗复核）：查询语句不可中断，跑完后若已过期限，结果集是「期限内
      // 已完成的部分」——如实置 truncated，后续 LIKE 段也会被期限截掉。
      if (expired()) timedOut = true;
    } else {
      timedOut = true;
    }
  }
  if (plan.likePatterns.length > 0 && collected.length < limit) {
    if (!expired()) {
      collect(queryLikePhase(db, plan.likePatterns, input, limit - collected.length + 1));
      // M2：同上——LIKE 段超期完成时返回已完成部分 + truncated=true，不伪装完整。
      if (expired()) timedOut = true;
    } else {
      timedOut = true;
    }
  }

  const rows: SessionMessageSearchRow[] = collected.map((row) => ({
    messageId: row.messageId,
    sessionId: row.sessionId,
    taskId: row.taskId,
    taskTitle: row.taskTitle,
    role: row.role,
    messageTs: row.messageTs,
    snippet:
      // L1：MATCH 路径不信任 SQL 侧哨兵（正文可携带字面哨兵），窗口文本 JS 侧重加高亮。
      row.snippet.length > 0 ? renderMatchSnippet(row.snippet, plan) : buildLikeSnippet(row.body, plan),
    matchCount: plan.terms.reduce(
      (total, term) => total + countOccurrences(row.body.toLowerCase(), term.toLowerCase()),
      0,
    ),
  }));
  return { rows, truncated: moreAvailable || timedOut };
}

// ── 存量回填与预热（R1 回填 + R5 预热） ────────────────────

export interface SessionMessageFtsFillResult {
  processed: number;
  batches: number;
  /** 本轮是否扫到了队尾（maxBatches 提前停时为 false，账本 done 不置位）。 */
  exhausted: boolean;
}

interface BackfillLedgerRow {
  last_message_rowid: number;
  done: number;
}

function readBackfillLedger(db: DatabaseSync): BackfillLedgerRow {
  const row = db
    .prepare("select last_message_rowid, done from session_message_fts_backfill where id = 1")
    .get() as unknown as BackfillLedgerRow | undefined;
  // 账本行由 migration 0025 建立；万一缺席（手工删库等旁路）按「从零回填」处理。
  return row ?? { last_message_rowid: 0, done: 0 };
}

/** 批次步进（M3，K4 对抗复核）：一次调用 = 一个独立事务的一批反连接补齐（游标
 * 推进 + 账本更新都在事务内）。同步回填与异步预热共用同一步进，保证两条路径的
 * 事务边界与断点语义逐字节一致。 */
function makeFillBatchStep(
  db: DatabaseSync,
  options: { afterRowid: number; batchRows: number },
): () => { rows: number; exhausted: boolean } {
  let cursor = options.afterRowid;
  return () => {
    db.exec("begin immediate");
    try {
      const batch = db
        .prepare(
          `
          select m.rowid as rowid, m.id as id from message m
          where not exists (select 1 from session_message_doc d where d.message_id = m.id)
            and m.rowid > ?
          order by m.rowid
          limit ?
          `,
        )
        .all(cursor, options.batchRows) as unknown as Array<{ rowid: number; id: string }>;
      if (batch.length === 0) {
        db.prepare(
          "update session_message_fts_backfill set done = 1, time_updated = ? where id = 1",
        ).run(Date.now());
        db.exec("commit");
        return { rows: 0, exhausted: true };
      }
      for (const row of batch) syncSessionMessageFtsRow(db, String(row.id));
      const lastRowid = Number(batch[batch.length - 1].rowid);
      db.prepare(
        `
        update session_message_fts_backfill
        set last_message_rowid = case when ? > last_message_rowid then ? else last_message_rowid end,
            processed = processed + ?,
            time_updated = ?
        where id = 1
        `,
      ).run(lastRowid, lastRowid, batch.length, Date.now());
      cursor = lastRowid;
      db.exec("commit");
      return { rows: batch.length, exhausted: false };
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  };
}

/**
 * 反连接找缺口并分批补齐：每批独立事务（防大库长事务锁，R1），批间提交即断点——
 * 异常退出后按账本游标续跑，终态与一次跑完完全一致（幂等：sync 以主表当前状态
 * 全量重写投影行）。游标限定只补 last_message_rowid 之后的缺口（回填路径）。
 */
function fillMissingSessionMessageFtsRows(
  db: DatabaseSync,
  options: { afterRowid: number; batchRows: number; maxBatches?: number },
): SessionMessageFtsFillResult {
  const step = makeFillBatchStep(db, options);
  let processed = 0;
  let batches = 0;
  for (;;) {
    const outcome = step();
    if (outcome.exhausted) return { processed, batches, exhausted: true };
    processed += outcome.rows;
    batches += 1;
    if (options.maxBatches !== undefined && batches >= options.maxBatches) break;
  }
  return { processed, batches, exhausted: false };
}

/** M3（K4 对抗复核）：与同步回填同一批次步进，但每批提交后 setImmediate 让出事件
 * 循环（每批 1000 行）——预热路径不再同步跑完整个回填，大库首启不冻结 CLI 数秒。
 * 同步路径（迁移回填/测试直调）不走这里，行为不变。 */
async function fillMissingSessionMessageFtsRowsAsync(
  db: DatabaseSync,
  options: { afterRowid: number; batchRows: number },
): Promise<SessionMessageFtsFillResult> {
  const step = makeFillBatchStep(db, options);
  let processed = 0;
  let batches = 0;
  for (;;) {
    const outcome = step();
    if (outcome.exhausted) return { processed, batches, exhausted: true };
    processed += outcome.rows;
    batches += 1;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * 存量回填（migration 0025 建账本后的补齐入口）：按账本游标续跑，跑完置 done。
 * maxBatches 模拟「批次间 kill」给测试用；生产调用不带它，一次跑到底。
 */
export function backfillSessionMessageFts(
  db: DatabaseSync,
  options: { batchRows?: number; maxBatches?: number } = {},
): SessionMessageFtsFillResult {
  const ledger = readBackfillLedger(db);
  if (ledger.done === 1) return { processed: 0, batches: 0, exhausted: true };
  return fillMissingSessionMessageFtsRows(db, {
    afterRowid: ledger.last_message_rowid,
    batchRows: options.batchRows ?? FTS_BACKFILL_BATCH_ROWS,
    maxBatches: options.maxBatches,
  });
}

/** 清理孤儿投影（session 级联删除会绕过 removeMessage 的 FTS 接线）。
 * 步进形态（M3）：一次调用 = 一个独立事务的一批，返回本批清理数（0 = 扫完）。 */
function makeOrphanPurgeStep(db: DatabaseSync, batchRows: number): () => number {
  return () => {
    db.exec("begin immediate");
    try {
      const orphans = db
        .prepare(
          `
          select d.* from session_message_doc d
          where not exists (select 1 from message m where m.id = d.message_id)
          order by d.id
          limit ?
          `,
        )
        .all(batchRows) as unknown as DocRow[];
      if (orphans.length === 0) {
        db.exec("commit");
        return 0;
      }
      for (const doc of orphans) {
        ftsDeleteByDocValues(db, doc);
        db.prepare("delete from session_message_doc where id = ?").run(doc.id);
      }
      db.exec("commit");
      return orphans.length;
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  };
}

function purgeSessionMessageFtsOrphans(db: DatabaseSync, batchRows: number): number {
  const step = makeOrphanPurgeStep(db, batchRows);
  let purged = 0;
  for (;;) {
    const batchPurged = step();
    if (batchPurged === 0) return purged;
    purged += batchPurged;
  }
}

/** M3（K4 对抗复核）：孤儿清理的异步形态——批间 setImmediate 让出，预热路径专用。 */
async function purgeSessionMessageFtsOrphansAsync(
  db: DatabaseSync,
  batchRows: number,
): Promise<number> {
  const step = makeOrphanPurgeStep(db, batchRows);
  let purged = 0;
  for (;;) {
    const batchPurged = step();
    if (batchPurged === 0) return purged;
    purged += batchPurged;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export interface SessionMessageFtsReconcileResult {
  purgedOrphans: number;
  backfill: SessionMessageFtsFillResult;
}

/**
 * 预热核对（R5）：storageReady 后低优先级执行。核对方式 = spec R5 原文——主表
 * 与投影行数对账（反连接计数），缺口 >0 则**不限游标**分批补齐。不能用回填账本
 * 游标：游标只对「升级后一次性顺扫」成立，级联删除/异常状态留下的缺口可能在
 * 游标之前，游标续跑看不见它们。与 R1 同事务写入的差额理论上应为零，这里是
 * 防御层；游标账本只服务 backfillSessionMessageFts 的中断续跑语义。
 */
export function reconcileSessionMessageFtsIndex(
  db: DatabaseSync,
  options: { batchRows?: number } = {},
): SessionMessageFtsReconcileResult {
  const batchRows = options.batchRows ?? FTS_BACKFILL_BATCH_ROWS;
  const purgedOrphans = purgeSessionMessageFtsOrphans(db, batchRows);
  const gap = db
    .prepare(
      `
      select count(*) as count from message m
      where not exists (select 1 from session_message_doc d where d.message_id = m.id)
      `,
    )
    .get() as unknown as { count: number };
  if (Number(gap.count) === 0) {
    return { purgedOrphans, backfill: { processed: 0, batches: 0, exhausted: true } };
  }
  return {
    purgedOrphans,
    backfill: fillMissingSessionMessageFtsRows(db, {
      afterRowid: 0,
      batchRows,
    }),
  };
}

/**
 * M3（K4 对抗复核）：反连接计数分片——按 rowid 窗口分段 count、段间让出事件循环，
 * 避免大库一次性全表反连接同步阻塞。语义与单条 count(*) 等价（窗口不重不漏覆盖
 * 全部正 rowid，与回填路径 `m.rowid > cursor` 同一假设）。
 */
async function countMissingProjectionRowsAsync(
  db: DatabaseSync,
  windowRows: number,
): Promise<number> {
  let total = 0;
  let cursor = 0;
  for (;;) {
    const bounds = db
      .prepare(
        `
        select max(rowid) as hi from (
          select rowid from message where rowid > ? order by rowid limit ?
        )
        `,
      )
      .get(cursor, windowRows) as unknown as { hi: number | null };
    if (bounds?.hi == null) return total;
    const counted = db
      .prepare(
        `
        select count(*) as count from message m
        where m.rowid > ? and m.rowid <= ?
          and not exists (select 1 from session_message_doc d where d.message_id = m.id)
        `,
      )
      .get(cursor, Number(bounds.hi)) as unknown as { count: number };
    total += Number(counted.count);
    cursor = Number(bounds.hi);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * M3（K4 对抗复核）：预热的异步核对——孤儿清理、反连接计数、缺口补齐全部分片、
 * 批间让出事件循环。语义与同步版 reconcileSessionMessageFtsIndex 一致（同样的
 * 分批事务与账本更新），只是不再一次性同步跑完整个 reconcile 冻结事件循环。
 */
async function reconcileSessionMessageFtsIndexAsync(
  db: DatabaseSync,
  options: { batchRows?: number } = {},
): Promise<SessionMessageFtsReconcileResult> {
  const batchRows = options.batchRows ?? FTS_BACKFILL_BATCH_ROWS;
  const purgedOrphans = await purgeSessionMessageFtsOrphansAsync(db, batchRows);
  const gap = await countMissingProjectionRowsAsync(db, batchRows);
  if (gap === 0) {
    return { purgedOrphans, backfill: { processed: 0, batches: 0, exhausted: true } };
  }
  return {
    purgedOrphans,
    backfill: await fillMissingSessionMessageFtsRowsAsync(db, { afterRowid: 0, batchRows }),
  };
}

/**
 * 预热调度：延迟让出启动关键路径（storageReady 后的低优先级后台任务），unref
 * 保证不阻塞进程退出；预热是防御层，任何失败（含连接已关闭）静默吞掉——它不
 * 阻塞任何读路径，缺口只影响旧数据的召回完整性，下一轮启动会再核对。
 *
 * M3（K4 对抗复核）：reconcile 走异步分片（每批 1000 行后 setImmediate 让出），
 * 大库首启不再同步冻结 CLI 数秒；「storageReady 后低优先级」语义（延迟 50ms +
 * unref + 失败静默）不变。
 */
export function scheduleSessionMessageFtsPreheat(db: DatabaseSync): void {
  const timer = setTimeout(() => {
    void reconcileSessionMessageFtsIndexAsync(db).catch(() => {
      /* 预热失败不影响任何读写路径；下次启动重试。 */
    });
  }, 50);
  timer.unref?.();
}
