// ============================================================
// conflict:// 集成门面（specs/conflict-uri-resolution.md）
// ============================================================
// 四个消费点：read-text 输出尾注（annotateReadConflicts）、Read 工具
// conflict:// 读形态（readConflictRegion）、Write 工具 conflict:// 解决形态
// （resolveConflictWrite）、权限/台账 subject 解析（resolveConflictSubjects）。
// 全部函数对「sessionId 缺席/无冲突」零行为变化，保证既有面零回归。

import type { FileSystemPort, TraceContext } from "@acode/contracts";
import { scanConflictLines, type ConflictBlock } from "./detect.js";
import {
  getConflictEntry,
  invalidateFileEntries,
  listSessionConflicts,
  registerConflicts,
  type ConflictEntry,
} from "./history.js";
import { expandConflictToken, isConflictSideToken, spliceConflicts, splitLinesLf } from "./splice.js";
import {
  buildConflictFooter,
  isConflictUri,
  parseBulkDirectives,
  parseConflictUri,
  type ConflictFooterEntry,
} from "./uri.js";

export * from "./detect.js";
export * from "./history.js";
export * from "./splice.js";
export * from "./uri.js";

/** 冲突面统一错误（模型可操作文案；handler 层转 ToolExecutionFailed recoverable）。 */
export class ConflictUriError extends Error {}

function failConflict(message: string): never {
  throw new ConflictUriError(message);
}

// ── read 侧：扫描 + 注册 + 尾注 ────────────────────────────────

export interface AnnotateReadConflictsInput {
  /** 会话身份；缺席（测试/无会话执行面）= 不注册不尾注（R2 零回归面）。 */
  sessionId: string | undefined;
  absolutePath: string;
  /** read 输出用的展示路径（相对化形态，与正文同口径）。 */
  displayPath: string;
  /** 已收集的正文行（LF 归一形态；read 管线产物，零额外 IO）。 */
  lines: readonly string[];
  /** lines[0] 的 1-based 行号（窗口读取传窗口起点）。 */
  firstLineNumber: number;
}

export interface AnnotateReadConflictsResult {
  /** 本次注册的条目（含 id 复用），无冲突/无会话时为空。 */
  entries: ConflictEntry[];
  /** 尾注文本（无冲突时为空串）。 */
  footer: string;
}

export function annotateReadConflicts(
  input: AnnotateReadConflictsInput,
): AnnotateReadConflictsResult {
  if (!input.sessionId) return { entries: [], footer: "" };
  const blocks: ConflictBlock[] = scanConflictLines(input.lines, input.firstLineNumber);
  if (blocks.length === 0) return { entries: [], footer: "" };
  const entries = registerConflicts(input.sessionId, input.absolutePath, blocks);
  const footerEntries: ConflictFooterEntry[] = entries.map((entry) => ({
    id: entry.id,
    path: input.displayPath,
    startLine: entry.block.startLine,
    hasBase: entry.block.hasBase,
  }));
  return { entries, footer: buildConflictFooter(footerEntries) };
}

// ── Read 工具 conflict:// 读形态（R4） ────────────────────────

export function readConflictRegion(request: {
  sessionId: string | undefined;
  rawUri: string;
}): { content: string; sourcePath: string; startLine: number; endLine: number } {
  if (!request.sessionId) {
    return failConflict(
      "conflict:// requires an active session (no session context). Read the conflicted file directly instead.",
    );
  }
  const parsed = parseConflictUri(request.rawUri);
  if ("error" in parsed) return failConflict(parsed.error);
  if (parsed.kind === "bulk") {
    return failConflict(
      "conflict://* is write-only (bulk resolution). To inspect, read the file or conflict://<id>.",
    );
  }
  const entry = getConflictEntry(request.sessionId, parsed.id);
  if (!entry) return failConflict(unknownIdError(request.sessionId, parsed.id));
  const { startLine, endLine } = entry.block;
  if (!parsed.side) {
    return { content: entry.block.lines.join("\n"), sourcePath: entry.absolutePath, startLine, endLine };
  }
  if (parsed.side === "base") {
    if (!entry.block.hasBase || entry.block.baseLines === undefined) {
      return failConflict(
        `conflict://${parsed.id} has no base section (||||||| absent; not a diff3-style merge).`,
      );
    }
    return {
      content: entry.block.baseLines.join("\n"),
      sourcePath: entry.absolutePath,
      startLine,
      endLine,
    };
  }
  const sideLines = parsed.side === "ours" ? entry.block.oursLines : entry.block.theirsLines;
  return {
    content: sideLines.join("\n"),
    sourcePath: entry.absolutePath,
    startLine,
    endLine,
  };
}

function unknownIdError(sessionId: string, id: number): string {
  const known = listSessionConflicts(sessionId);
  const knownText =
    known.length > 0
      ? `Registered ids: ${known.map((entry) => `conflict://${entry.id} (${entry.absolutePath}:${entry.block.startLine})`).join(", ")}.`
      : "No conflict blocks are registered in this session yet — read the conflicted file first (ids are assigned when read output contains conflict markers).";
  return `conflict://${id} is not registered (ids are invalidated after any resolution or external edit). ${knownText}`;
}

// ── Write 工具 conflict:// 解决形态（R5/R6） ───────────────────

export interface ConflictWriteRequest {
  sessionId: string | undefined;
  rawUri: string;
  content: string;
  fileSystemPort: FileSystemPort;
  abortSignal: AbortSignal | undefined;
  /** write.ts 同款 trace 构造（透传，避免本模块依赖 handler 内部件）。 */
  createTrace: () => TraceContext;
  /** 写后 readFileState 更新回调（write.ts updateReadFileStateAfterWrite 同口径）。 */
  afterWrite: (filePath: string, contentLf: string, revision: unknown) => void;
}

export interface ConflictWriteOutcome {
  /** 模型可见结果文本。 */
  modelContent: string;
  /** 实际写入的真实文件路径（provenance/审批信息面用）。 */
  resolvedPaths: string[];
  /** 每文件明细（handler 组装 write 输出信封：真实路径 diff 渲染）。 */
  files: ConflictWriteFileDetail[];
}

export interface ConflictWriteFileDetail {
  path: string;
  /** 磁盘旧内容（LF 归一，port readTextFile 原值）。 */
  oldContent: string;
  /** 拼接后新内容（LF 归一；EOL 由 port 写回时恢复）。 */
  newContent: string;
  splicedIds: number[];
}

export async function resolveConflictWrite(
  request: ConflictWriteRequest,
): Promise<ConflictWriteOutcome> {
  if (!request.sessionId) {
    failConflict("conflict:// requires an active session (no session context).");
  }
  const sessionId = request.sessionId as string;
  const parsed = parseConflictUri(request.rawUri);
  if ("error" in parsed) failConflict(parsed.error);

  // 指派收集：id → 替换行（LF 归一）。token 展开在**注册块数据**上进行，
  // 拼接前还有磁盘重验证兜底（R5）。
  const replacements = new Map<number, string[]>();
  if (parsed.kind === "bulk") {
    const directives = parseBulkDirectives(request.content);
    if ("error" in directives) failConflict(directives.error);
    for (const directive of directives) {
      const entry = getConflictEntry(sessionId, directive.id);
      if (!entry) failConflict(unknownIdError(sessionId, directive.id));
      const expanded = expandConflictToken(directive.token, entry.block);
      if ("error" in expanded) failConflict(`conflict://${directive.id}: ${expanded.error}`);
      replacements.set(directive.id, expanded.lines);
    }
  } else if (parsed.kind === "single") {
    const entry = getConflictEntry(sessionId, parsed.id);
    if (!entry) failConflict(unknownIdError(sessionId, parsed.id));
    const trimmed = request.content.trim();
    if (isConflictSideToken(trimmed)) {
      const expanded = expandConflictToken(trimmed, entry.block);
      if ("error" in expanded) failConflict(`conflict://${parsed.id}: ${expanded.error}`);
      replacements.set(parsed.id, expanded.lines);
    } else {
      // 字面量替换内容：模型自撰合并结果，按 LF 拆行整块替换（尾部换行剥除，
      // 块替换语义不引入多余空行）。
      replacements.set(parsed.id, splitLinesLf(request.content.replace(/\n$/, "")));
    }
  } else {
    return failConflict(`Unsupported conflict URI: ${request.rawUri}`);
  }

  // 按文件分组，逐文件 all-or-nothing（R5）。
  const byFile = new Map<string, ConflictEntry[]>();
  for (const id of replacements.keys()) {
    const entry = getConflictEntry(sessionId, id);
    if (!entry) failConflict(unknownIdError(sessionId, id));
    const list = byFile.get(entry.absolutePath) ?? [];
    list.push(entry);
    byFile.set(entry.absolutePath, list);
  }

  const resolvedPaths: string[] = [];
  const resolvedIds: number[] = [];
  const files: ConflictWriteFileDetail[] = [];
  for (const [absolutePath, entries] of byFile) {
    const read = await request.fileSystemPort.readTextFile(
      { path: absolutePath, trace: request.createTrace() },
      { signal: request.abortSignal },
    );
    // port 返回 LF 归一内容；EOL 恢复由 writeTextFile(lineEndings) 承担
    // （splice 层同纪律，防 \r\r\n 双重换算）。
    const fileReplacements = new Map<number, readonly string[]>();
    for (const entry of entries) {
      fileReplacements.set(entry.id, replacements.get(entry.id)!);
    }
    const outcome = spliceConflicts(read.content, entries, fileReplacements);
    if ("error" in outcome) failConflict(outcome.error);
    await request.fileSystemPort.writeTextFile(
      {
        path: absolutePath,
        content: outcome.text,
        encoding: read.encoding,
        lineEndings: read.lineEndings,
        atomic: true,
        expectedRevision: read.revision,
        trace: request.createTrace(),
      },
      { signal: request.abortSignal },
    );
    request.afterWrite(absolutePath, outcome.text, read.revision);
    // R5 成功面：本文件全部注册块失效（行号已位移，旧锚作废防陈旧拼接）。
    invalidateFileEntries(sessionId, absolutePath);
    resolvedPaths.push(absolutePath);
    resolvedIds.push(...outcome.splicedIds);
    files.push({
      path: absolutePath,
      oldContent: read.content,
      newContent: outcome.text,
      splicedIds: outcome.splicedIds,
    });
  }

  const sessionRemaining = listSessionConflicts(sessionId).length;
  const modelContent = [
    `Resolved ${resolvedIds.length} conflict block(s) (${resolvedIds.map((id) => `conflict://${id}`).join(", ")}) in ${resolvedPaths.length} file(s):`,
    ...resolvedPaths.map((path) => `- ${path}`),
    sessionRemaining > 0
      ? `${sessionRemaining} conflict block(s) still registered in this session. Ids of resolved files were invalidated (line numbers shifted) — re-read those files to register any remaining blocks with fresh ids.`
      : "No conflict blocks remain registered in this session.",
  ].join("\n");
  return { modelContent, resolvedPaths, files };
}

// ── 权限/台账 subject 解析（R6 实现注记） ──────────────────────

/**
 * conflict:// file_path → 真实路径 subject 列表（permission ruleSubjects 与
 * provenance ledger 可消费）。未注册/非 conflict URI 返回 undefined（调用方
 * 回落原始字符串，fail-safe：审批面按默认 write 裁决，绝不因解析失败放行）。
 */
export function resolveConflictSubjects(
  sessionId: string | undefined,
  filePath: string,
): string[] | undefined {
  if (!sessionId || !isConflictUri(filePath)) return undefined;
  const parsed = parseConflictUri(filePath);
  if ("error" in parsed) return undefined;
  if (parsed.kind === "bulk") {
    const paths = new Set(listSessionConflicts(sessionId).map((entry) => entry.absolutePath));
    return paths.size > 0 ? [...paths] : undefined;
  }
  const entry = getConflictEntry(sessionId, parsed.id);
  return entry ? [entry.absolutePath] : undefined;
}
