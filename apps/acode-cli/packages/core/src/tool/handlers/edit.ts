/* eslint-disable max-lines -- Edit 工具需要集中维护文本匹配、read-before-edit 与写回状态，避免 bugfix 期间拆分扩大行为面。 */
// ============================================================
// Edit Tool Handler
// ============================================================

import { basename, dirname, extname } from "node:path";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolEntry,
} from "../types.js";
import {
  CoreErrorType,
  EditInputJsonSchema,
  EditInputSchema,
  EditOutputJsonSchema,
  EditOutputSchema,
  EditErrorCode,
  createCoreError,
  isFileSystemPortError,
  type EditInput,
  type EditOutput,
  type FileSystemReadTextResult,
  type FileSystemStatResult,
  type TraceContext,
} from "@acode/contracts";
import { createStructuredPatch } from "../diff.js";
import { stampMemoryOriginSessionId } from "../../memory/origin-session.js";
// LSP 诊断回流（specs/lsp-diagnostics-loop.md）：落盘 .ts/.tsx 或 LSP 适用文件后，
// 新增诊断经 ledger 去重挂进模型内容；迟到诊断转 deferred 队列由下一次注入。
import {
  consumeDeferredDiagnostics,
  consumePendingModelContent,
  runPostWriteDiagnostics,
  stashPendingModelContent,
} from "../../lsp/edit-diagnostics-hook.js";
import {
  findEditMatch,
  normalizeLineEndings,
  normalizeReplacementForMatch,
  preserveQuoteStyle,
} from "../edit-matchers.js";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  createReadFileStateKey,
  findEditableReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import {
  attachToolExecutionTelemetry,
  elapsedMsSince,
  fileByteCount,
  workspaceKind,
} from "./tool-perf.js";

const EDIT_PROVIDER_DESCRIPTION = [
  "Performs exact string replacement in a file.",
  "",
  "- You must Read the file in this conversation before editing, or the call will fail.",
  "- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.",
  "- `replace_all: true` replaces every occurrence instead.",
].join("\n");
const NON_UNIQUE_OLD_STRING_MESSAGE =
  "old_string is not unique in the file. Provide more surrounding context or set replace_all to true.";
const MAX_EDIT_FILE_SIZE_BYTES = 1024 * 1024 * 1024;
const EDIT_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
// partial view（token 上限截断的 Read）与「从未读过」必须区分文案
// （specs/post-compact-read-state.md R3）：合并报"未读"会让模型重读整文件仍被截断、原地打转。
const EDIT_PARTIAL_VIEW_MESSAGE =
  "File was read with a truncated view, so its full contents are not in your context. Read the range covering your edit (offset/limit) before writing to it.";
const EDIT_STALE_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
const EDIT_FRESHNESS_SUFFIX = " (file state is current in your context — no need to Read it back)";

function formatEditModelContent(output: unknown): string {
  const filePath =
    isRecord(output) && typeof output.filePath === "string" ? output.filePath : "the file";
  const userModified = isRecord(output) && output.userModified === true;
  const replaceAll = isRecord(output) && output.replaceAll === true;
  const modifiedNote = userModified
    ? ".  The user modified your proposed changes before accepting them. "
    : "";
  const freshnessSuffix = userModified ? "" : EDIT_FRESHNESS_SUFFIX;

  let base: string;
  if (replaceAll) {
    base = `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.${freshnessSuffix}`;
  } else {
    base = `The file ${filePath} has been updated successfully${modifiedNote}.${freshnessSuffix}`;
  }

  // LSP 诊断回流（specs/lsp-diagnostics-loop.md）：落盘后钩子挂起的新增诊断
  // 块附在模型内容尾部；键未命中（无诊断/非 TS 文件）时内容保持原样。
  const pendingDiagnostics = consumePendingModelContent(filePath);
  return pendingDiagnostics ? `${base}\n\n${pendingDiagnostics}` : base;
}

const editHandler: ToolHandler = async (input, context) => {
  const { file_path, old_string, new_string, replace_all } = EditInputSchema.parse(
    input,
  ) as EditInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Edit tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Edit",
        },
        recoverable: false,
      },
    );
  }

  if (old_string === new_string) {
    return editFailure(
      EditErrorCode.NO_CHANGE,
      "No changes to make: old_string and new_string are exactly the same.",
    );
  }

  if (!file_path) {
    // 空路径由共享 path-policy 抛出普通异常，绕过了 Edit 自己维护的
    // code + message 失败契约，导致 provider-visible 内容丢失 tool_use_error envelope。
    return editFailure(EditErrorCode.INVALID_PATH, "Tool path must not be empty");
  }

  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  const stat = await statEditableFile(filePath, context);
  if (!stat) {
    if (old_string === "") {
      return writeEditResult({
        context,
        filePath,
        inputFilePath: file_path,
        originalFile: "",
        actualOldString: "",
        actualNewString: new_string,
        newContent: new_string,
        replaceAll: replace_all,
        fsReadMs: 0,
        patchMatchMs: 0,
        matchAttempts: 0,
      });
    }

    return editFailure(
      EditErrorCode.FILE_NOT_EXIST,
      await createMissingEditFileMessage(filePath, context),
    );
  }

  if (stat.sizeBytes > MAX_EDIT_FILE_SIZE_BYTES) {
    return editFailure(
      EditErrorCode.FILE_TOO_LARGE,
      "File is too large to edit (1GB). Maximum editable file size is 1GB.",
    );
  }

  const readStartedAt = Date.now();
  const read = await fileSystemPort.readTextFile(
    {
      path: filePath,
      trace: createEditTrace(context),
    },
    { signal: context.abortSignal },
  );
  const fsReadMs = elapsedMsSince(readStartedAt);
  const content = normalizeLineEndings(read.content);
  const oldString = normalizeLineEndings(old_string);
  const requestedNewString = normalizeLineEndings(new_string);

  if (old_string === "") {
    if (content.trim() !== "") {
      return editFailure(
        EditErrorCode.FILE_EXISTS_NO_OLD_STRING,
        "Cannot create new file - file already exists.",
      );
    }
    const readStateFailure = getEditableReadStateFailure(filePath, read, context.readFileState);
    if (readStateFailure) return readStateFailure;
    return writeEditResult({
      context,
      filePath,
      inputFilePath: file_path,
      originalFile: content,
      actualOldString: "",
      actualNewString: requestedNewString,
      newContent: requestedNewString,
      read,
      replaceAll: replace_all,
      fsReadMs,
      patchMatchMs: 0,
      matchAttempts: 0,
    });
  }

  if (filePath.endsWith(".ipynb")) {
    return editFailure(
      EditErrorCode.NOTEBOOK_FILE,
      // 修复依据（prompt-corpus-audit F7）：原文案指向 NotebookEdit——provider-visible-order.ts
      // 的保留名、无 handler，模型照做会调用不存在的工具。改为指向真实可用路径：
      // Write 无 .ipynb 门禁可整写 notebook JSON，Bash 可做结构化编辑（如 jq）。
      "File is a Jupyter Notebook (.ipynb). Edit does not support notebooks; rewrite the full notebook JSON with Write, or edit it structurally via Bash (e.g. jq).",
    );
  }

  const readStateFailure = getEditableReadStateFailure(filePath, read, context.readFileState);
  if (readStateFailure) return readStateFailure;

  const patchMatchStartedAt = Date.now();
  const match = findEditMatch({
    content,
    search: oldString,
    replaceAll: replace_all,
  });
  const patchMatchMs = elapsedMsSince(patchMatchStartedAt);
  if (match.status === "not_found") {
    return editFailure(
      EditErrorCode.OLD_STRING_NOT_FOUND,
      `String to replace not found in file.\nString: ${old_string}`,
    );
  }
  if (match.status === "ambiguous") {
    return editFailure(
      EditErrorCode.AMBIGUOUS_REPLACE,
      createAmbiguousEditMessage(match.candidateCount, old_string),
    );
  }

  const actualOldString = match.actualString;
  const matchCount = countOccurrences(content, actualOldString);
  if (!replace_all && matchCount > 1) {
    return editFailure(
      EditErrorCode.AMBIGUOUS_REPLACE,
      createAmbiguousEditMessage(matchCount, old_string),
    );
  }

  const normalizedNewString = normalizeReplacementForMatch(match.strategy, requestedNewString);
  const actualNewString = preserveQuoteStyle(oldString, actualOldString, normalizedNewString);
  const newContent = applyEditToContent(content, actualOldString, actualNewString, replace_all);

  return writeEditResult({
    context,
    filePath,
    inputFilePath: file_path,
    originalFile: content,
    actualOldString,
    actualNewString,
    newContent,
    read,
    replaceAll: replace_all,
    matchStrategy: match.strategy,
    matchCandidateCount: match.candidateCount,
    fsReadMs,
    patchMatchMs,
    matchAttempts: 1,
  });
};

export const editToolEntry: ToolEntry = {
  capability: "Replace exact text in a file through the file-system adapter",
  metadata: {
    name: "Edit",
    description: EDIT_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: editHandler,
  formatModelContent: formatEditModelContent,
  inputSchema: EditInputJsonSchema,
  outputSchema: EditOutputJsonSchema,
  runtimeInputSchema: EditInputSchema,
  runtimeOutputSchema: EditOutputSchema,
  permission: {
    permission: "edit",
    reason: "Edit modifies file contents through the file-system adapter",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 1_000_000,
    maxModelBytes: 100_000,
    strategy: "truncate",
    preview: {
      maxBytes: 100_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Edit was cancelled before the file operation completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function editFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let position = 0;
  while (position < content.length) {
    const index = content.indexOf(needle, position);
    if (index === -1) break;
    count += 1;
    position = index + needle.length;
  }
  return count;
}

function createEditTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

async function statEditableFile(
  filePath: string,
  context: ToolExecutionContext,
): Promise<FileSystemStatResult | null> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return null;
  try {
    return await fileSystemPort.stat(
      { path: filePath, trace: createEditTrace(context) },
      { signal: context.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return null;
    throw error;
  }
}

async function createMissingEditFileMessage(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string> {
  const suggestion = await findSimilarFilename(filePath, context);
  return [
    `File does not exist. Note: your current working directory is ${context.workingDirectory}.`,
    suggestion ? ` Did you mean ${suggestion}?` : "",
  ].join("");
}

async function findSimilarFilename(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return undefined;

  try {
    const parent = dirname(filePath);
    const targetName = basename(filePath);
    const targetStem = basename(filePath, extname(filePath));
    const listed = await fileSystemPort.listDirectory(
      { path: parent, trace: createEditTrace(context) },
      { signal: context.abortSignal },
    );
    const entries = listed.entries
      .filter((entry) => entry.kind === "file" || entry.kind === "symlink")
      .map((entry) => entry.name)
      .filter((name) => name !== targetName)
      .sort();

    const sameStem = entries.find((name) => basename(name, extname(name)) === targetStem);
    if (sameStem) return sameStem;

    return entries.find((name) => levenshteinDistance(name, targetName) <= 3);
  } catch {
    return undefined;
  }
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index]!;
    }
  }

  return previous[right.length] ?? 0;
}

function getEditableReadStateFailure(
  filePath: string,
  currentRead: FileSystemReadTextResult,
  readFileState: ReadFileStateMap | undefined,
): ToolHandlerFailure | undefined {
  if (!readFileState) return undefined;

  const lastRead = findEditableReadFileState(readFileState, filePath);
  if (!lastRead) {
    return editFailure(EditErrorCode.FILE_NOT_READ, EDIT_NOT_READ_MESSAGE);
  }
  if (lastRead.isPartialView) {
    return editFailure(EditErrorCode.FILE_NOT_READ, EDIT_PARTIAL_VIEW_MESSAGE);
  }

  if (!hasReadStateChanged(lastRead, currentRead)) return undefined;
  if (isStrictFullRead(lastRead) && lastRead.content === currentRead.content) return undefined;

  return editFailure(EditErrorCode.STALE_FILE, EDIT_STALE_MESSAGE);
}

function isStrictFullRead(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}

function hasReadStateChanged(
  lastRead: ReadFileStateEntry,
  currentRead: FileSystemReadTextResult,
): boolean {
  const currentMtimeMs = currentRead.revision?.mtimeMs;
  if (lastRead.mtimeMs !== undefined && currentMtimeMs !== undefined) {
    // 亚毫秒级精度，只在当前文件的整数毫秒晚于 Read 记录或大小变化时判 stale，减少误报。
    const normalizedCurrentMtimeMs = normalizeReadFileStateMtimeMs(currentMtimeMs);
    const normalizedLastReadMtimeMs = normalizeReadFileStateMtimeMs(lastRead.mtimeMs);
    const mtimeAdvanced =
      normalizedCurrentMtimeMs !== undefined &&
      normalizedLastReadMtimeMs !== undefined &&
      normalizedCurrentMtimeMs > normalizedLastReadMtimeMs;
    return mtimeAdvanced || lastRead.sizeBytes !== currentRead.sizeBytes;
  }

  if (lastRead.sizeBytes !== undefined && lastRead.sizeBytes !== currentRead.sizeBytes) {
    return true;
  }

  const currentRevisionId = currentRead.revision?.id;
  return Boolean(
    lastRead.revisionId && currentRevisionId && lastRead.revisionId !== currentRevisionId,
  );
}

async function writeEditResult(input: {
  context: ToolExecutionContext;
  filePath: string;
  inputFilePath: string;
  originalFile: string;
  actualOldString: string;
  actualNewString: string;
  newContent: string;
  read?: FileSystemReadTextResult;
  replaceAll: boolean;
  fsReadMs: number;
  patchMatchMs: number;
  matchAttempts: number;
  matchStrategy?: string;
  matchCandidateCount?: number;
}): Promise<EditOutput> {
  const fileSystemPort = input.context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Edit tool",
      {
        context: {
          toolCallId: input.context.toolCallId,
          toolName: "Edit",
        },
        recoverable: false,
      },
    );
  }

  const contentToWrite = stampMemoryOriginSessionId({
    content: input.newContent,
    filePath: input.filePath,
    memoryRoot: input.context.memoryRoot,
    sessionId: input.context.sessionId,
  });
  const writeStartedAt = Date.now();
  const writeResult = await fileSystemPort.writeTextFile(
    {
      path: input.filePath,
      content: contentToWrite,
      encoding: input.read?.encoding,
      lineEndings: input.read?.lineEndings ?? detectLineEndings(input.originalFile),
      createParents: true,
      atomic: true,
      expectedRevision: input.read?.revision,
      trace: createEditTrace(input.context),
    },
    { signal: input.context.abortSignal },
  );
  const fsWriteMs = elapsedMsSince(writeStartedAt);

  const readFileStateEntry = updateReadFileStateAfterEdit(
    input.context.readFileState,
    input.filePath,
    contentToWrite,
    writeResult.revision,
  );
  recordReadFileStateMetadata(input.context, readFileStateEntry);

  // LSP 诊断回环（specs/lsp-diagnostics-loop.md）：落盘成功后跑进程内 TS 诊断或
  // LSP writethrough，新增诊断经 ledger 去重挂进模型内容。诊断失败只降级为
  // debug 日志，绝不影响编辑主流程的成败与现有输出形状。
  const diagnosticsOutcome = await runPostWriteDiagnostics({
    resolvedPath: input.filePath,
    inputPath: input.inputFilePath,
    content: contentToWrite,
    workspaceIdentity: input.context.workspaceIdentity,
    workingDirectory: input.context.workingDirectory,
    abortSignal: input.context.abortSignal,
  }).catch(() => undefined);
  // 上一次变更的迟到诊断（deferred 通道）随本次结果一并注入（运行时轮次级
  // drain 接线为共享桶申请，见 spec §6）。
  const deferredText = consumeDeferredDiagnostics({
    workspaceIdentity: input.context.workspaceIdentity,
    workingDirectory: input.context.workingDirectory,
  });
  const pendingDiagnostics =
    diagnosticsOutcome?.modelContent === undefined
      ? deferredText
      : deferredText
        ? `${diagnosticsOutcome.modelContent}\n\n${deferredText}`
        : diagnosticsOutcome.modelContent;
  if (pendingDiagnostics) {
    stashPendingModelContent(input.inputFilePath, pendingDiagnostics);
  }

  const structuredPatch = createStructuredPatch({
    filePath: input.inputFilePath,
    oldContent: input.originalFile,
    newContent: contentToWrite,
  });
  // perf 里 totalBytes/maxFileBytes 语义相同，缓存结果避免大文件编辑时重复扫描新内容。
  const newContentBytes = fileByteCount(contentToWrite);

  return attachToolExecutionTelemetry(
    {
      filePath: input.inputFilePath,
      oldString: input.actualOldString,
      newString: input.actualNewString,
      originalFile: input.originalFile,
      structuredPatch,
      userModified: false,
      replaceAll: input.replaceAll,
      matchStrategy: input.matchStrategy,
      matchCandidateCount: input.matchCandidateCount,
    } satisfies EditOutput,
    {
      detail: {
        kind: "patch",
        filesystem: {
          readMs: input.fsReadMs,
          writeMs: fsWriteMs,
          fileCount: 1,
          totalBytes: newContentBytes,
          maxFileBytes: newContentBytes,
          workspaceKind: workspaceKind(input.context),
        },
        patch: {
          matchMs: input.patchMatchMs,
          hunkCount: structuredPatch.length,
          matchAttempts: input.matchAttempts,
        },
      },
    },
  );
}

function updateReadFileStateAfterEdit(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  content: string,
  revision: FileSystemReadTextResult["revision"] | undefined,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;
  const entry: ReadFileStateEntry = {
    path: filePath,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: "Edit",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs),
    sizeBytes: revision?.sizeBytes ?? Buffer.byteLength(content, "utf8"),
  };
  readFileState.set(createReadFileStateKey(filePath, 1, undefined), entry);
  return entry;
}

function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  entry: ReadFileStateEntry | undefined,
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: "Edit",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

function applyEditToContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  const replacement = newString;
  if (replacement !== "") {
    return replaceLiteral(content, oldString, replacement, replaceAll);
  }

  const search =
    !oldString.endsWith("\n") && content.includes(`${oldString}\n`) ? `${oldString}\n` : oldString;

  return replaceLiteral(content, search, replacement, replaceAll);
}

function replaceLiteral(
  content: string,
  search: string,
  replacement: string,
  replaceAll: boolean,
): string {
  // String.replace 的字符串 replacement 会把 $$/$& 当特殊 token；
  return replaceAll
    ? content.replaceAll(search, () => replacement)
    : content.replace(search, () => replacement);
}

function createAmbiguousEditMessage(matchCount: number, oldString: string): string {
  if (matchCount > 0) {
    return `Found ${matchCount} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`;
  }
  return NON_UNIQUE_OLD_STRING_MESSAGE;
}

function detectLineEndings(content: string): "LF" | "CRLF" {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    if (index > 0 && content[index - 1] === "\r") {
      crlfCount += 1;
    } else {
      lfCount += 1;
    }
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}
