/* eslint-disable max-lines -- 存量基线豁免:该文件先于 CLI lint 门禁建立即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,turbo lint 因此从未变绿)。头注豁免以恢复门禁信号;拆分重构超出本批范围。 */
// ============================================================
// ApplyPatch Tool Handler（批次 4/S2 落地，规格 specs/apply-patch-tool.md）
// ============================================================
// 上游遗留的悬空 contract 在此获得真实实现：多文件结构化补丁，两段式执行——
// 校验段零写入（解析/存在性/read-before-patch/staleness/hunk 唯一匹配），全部通过
// 后才进入应用段。下游接线（compat hook 别名、ruleSubjects patch_text、isWriteTool、
// shared identity file-write family、breaker WRITE_TOOLS）此前已预铺，本文件使其生效。

import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import {
  ApplyPatchErrorCode,
  ApplyPatchInputJsonSchema,
  ApplyPatchInputSchema,
  ApplyPatchOutputJsonSchema,
  ApplyPatchOutputSchema,
  CoreErrorType,
  createCoreError,
  isFileSystemPortError,
  type ApplyPatchFileChange,
  type ApplyPatchInput,
  type ApplyPatchOutput,
  type DiffHunk,
  type FileSystemReadTextResult,
  type FileSystemStatResult,
  type TraceContext,
} from "@acode/contracts";
import { createStructuredPatch } from "../diff.js";
import { stampMemoryOriginSessionId } from "../../memory/origin-session.js";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  createReadFileStateKey,
  findEditableReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import {
  parseApplyPatch,
  type ApplyPatchHunkLine,
  type ApplyPatchSection,
} from "../apply-patch-format.js";
import {
  attachToolExecutionTelemetry,
  elapsedMsSince,
  fileByteCount,
  workspaceKind,
} from "./tool-perf.js";

const APPLY_PATCH_PROVIDER_DESCRIPTION = [
  "Applies a structured patch that can add, update, and delete multiple files in one call.",
  "",
  "Every section is validated first (existence, read state, exact context match); files are written only after all sections pass. Prefer Edit for a single-file change and Write for creating or rewriting one whole file; use ApplyPatch for coordinated changes across several files.",
  "",
  "Patch format (`patch_text`):",
  "*** Begin Patch",
  "*** Add File: path/to/new.ts",
  "+added line",
  "*** Update File: path/to/existing.ts",
  " unchanged context line",
  "-line to remove",
  "+line to add",
  "*** Delete File: path/to/old.ts",
  "*** End Patch",
  "",
  "Rules:",
  "- Files in Update/Delete sections must have been Read in this conversation first.",
  "- Context and removed lines must match the file exactly (including indentation) and be unique within it; add more context lines if a match is ambiguous.",
  "- Every path must stay inside the workspace. Moving/renaming files is not supported here — use Bash (e.g. git mv) instead.",
].join("\n");

// 与 Edit 同值（MAX_EDIT_FILE_SIZE_BYTES）：同为经 readTextFile 全量读入的编辑面。
const MAX_PATCH_FILE_SIZE_BYTES = 1024 * 1024 * 1024;
const PATCH_NOT_READ_MESSAGE = "File has not been read yet. Read it first before patching it.";
const PATCH_STALE_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to patch it.";
const PATCH_FRESHNESS_SUFFIX = " (file state is current in your context — no need to Read it back)";
// v1 拒绝 Move：FileSystemPort 无 rename 原语，read+write+remove 模拟对二进制不安全（spec R1，v2 登记）。
const MOVE_NOT_SUPPORTED_MESSAGE =
  "Move sections are not supported yet. Rename the file with Bash (e.g. git mv) first, then patch its content.";
// 与 Edit 的 F7 修复文案同源：只指向真实存在的工具路径。
const NOTEBOOK_MESSAGE =
  "File is a Jupyter Notebook (.ipynb). ApplyPatch does not support notebooks; rewrite the full notebook JSON with Write, or edit it structurally via Bash (e.g. jq).";

function patchFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createPatchTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

/** 校验段产出的单文件执行计划；writtenContent/writeRevision 在应用段回填。 */
interface PlannedFile {
  section: Extract<ApplyPatchSection, { kind: "add" | "update" | "delete" }>;
  inputPath: string;
  resolvedPath: string;
  oldContent: string | undefined;
  newContent: string | undefined;
  read: FileSystemReadTextResult | undefined;
  additions: number;
  deletions: number;
  writtenContent?: string;
  writeRevision?: FileSystemReadTextResult["revision"];
}

async function statPatchFile(
  filePath: string,
  context: ToolExecutionContext,
): Promise<FileSystemStatResult | null> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return null;
  try {
    return await fileSystemPort.stat(
      { path: filePath, trace: createPatchTrace(context) },
      { signal: context.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return null;
    throw error;
  }
}

// ── read-before-patch 与 staleness（语义与 Edit 的 getEditableReadStateFailure 一致，
//    用 read-file-state.ts 导出原语实现；write.ts 对自己的变体同样是本地实现，先例一致）──

function getPatchableReadStateFailure(
  filePath: string,
  currentRead: FileSystemReadTextResult,
  readFileState: ReadFileStateMap | undefined,
): ToolHandlerFailure | undefined {
  if (!readFileState) return undefined;

  const lastRead = findEditableReadFileState(readFileState, filePath);
  if (!lastRead || lastRead.isPartialView) {
    return patchFailure(ApplyPatchErrorCode.FILE_NOT_READ, PATCH_NOT_READ_MESSAGE);
  }
  if (!hasPatchTargetChanged(lastRead, currentRead)) return undefined;
  if (isStrictFullRead(lastRead) && lastRead.content === currentRead.content) return undefined;

  return patchFailure(ApplyPatchErrorCode.STALE_FILE, PATCH_STALE_MESSAGE);
}

function isStrictFullRead(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}

function hasPatchTargetChanged(
  lastRead: ReadFileStateEntry,
  currentRead: FileSystemReadTextResult,
): boolean {
  const currentMtimeMs = currentRead.revision?.mtimeMs;
  if (lastRead.mtimeMs !== undefined && currentMtimeMs !== undefined) {
    const normalizedCurrent = normalizeReadFileStateMtimeMs(currentMtimeMs);
    const normalizedLast = normalizeReadFileStateMtimeMs(lastRead.mtimeMs);
    const mtimeAdvanced =
      normalizedCurrent !== undefined && normalizedLast !== undefined && normalizedCurrent > normalizedLast;
    return mtimeAdvanced || lastRead.sizeBytes !== currentRead.sizeBytes;
  }
  if (lastRead.sizeBytes !== undefined && lastRead.sizeBytes !== currentRead.sizeBytes) {
    return true;
  }
  const currentRevisionId = currentRead.revision?.id;
  return Boolean(lastRead.revisionId && currentRevisionId && lastRead.revisionId !== currentRevisionId);
}

function updateReadFileStateAfterPatch(
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
    sourceTool: "ApplyPatch",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs),
    sizeBytes: revision?.sizeBytes ?? Buffer.byteLength(content, "utf8"),
  };
  readFileState.set(createReadFileStateKey(filePath, 1, undefined), entry);
  return entry;
}

function removeReadFileStateAfterDelete(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
): void {
  readFileState?.delete(createReadFileStateKey(filePath, 1, undefined));
}

function recordPatchReadFileStateMetadata(
  context: ToolExecutionContext,
  entry: ReadFileStateEntry | undefined,
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: "ApplyPatch",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

// ── hunk 匹配与应用（LF 归一后的行数组；语义与 Edit 同纪律：精确 + 唯一）──

function applyUpdateHunks(
  oldContent: string,
  hunks: ApplyPatchHunkLine[][],
  inputPath: string,
): { content: string; additions: number; deletions: number } | { failure: ToolHandlerFailure } {
  const trailingNewline = oldContent.endsWith("\n");
  let lines = oldContent === "" ? [] : oldContent.replace(/\n$/, "").split("\n");
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    const search: string[] = [];
    for (const line of hunk) {
      if (line.type !== "add") search.push(line.text);
    }
    if (search.length === 0) {
      // v1 无 @@ 行号消歧（提示行解析但不参与匹配），纯新增 hunk 无锚点可定位。
      return {
        failure: patchFailure(
          ApplyPatchErrorCode.HUNK_NOT_FOUND,
          `Hunk in '${inputPath}' has no context or removal lines to anchor it. Include at least one unchanged context line.`,
        ),
      };
    }
    const positions: number[] = [];
    for (let start = 0; start + search.length <= lines.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < search.length; offset += 1) {
        if (lines[start + offset] !== search[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        positions.push(start);
        if (positions.length > 1) break;
      }
    }
    if (positions.length === 0) {
      return {
        failure: patchFailure(
          ApplyPatchErrorCode.HUNK_NOT_FOUND,
          `Hunk in '${inputPath}' does not match the file content exactly (including indentation). Re-read the file if its state may have changed, then retry with exact lines.`,
        ),
      };
    }
    if (positions.length > 1) {
      return {
        failure: patchFailure(
          ApplyPatchErrorCode.AMBIGUOUS_HUNK,
          `Hunk in '${inputPath}' matches multiple locations. Add more surrounding context lines to make it unique.`,
        ),
      };
    }
    const start = positions[0];
    const replacement: string[] = [];
    for (const line of hunk) {
      if (line.type === "remove") {
        deletions += 1;
        continue;
      }
      if (line.type === "add") additions += 1;
      replacement.push(line.text);
    }
    lines = [...lines.slice(0, start), ...replacement, ...lines.slice(start + search.length)];
  }

  const content = lines.length === 0 ? "" : lines.join("\n") + (trailingNewline ? "\n" : "");
  return { content, additions, deletions };
}

function countContentLines(content: string): number {
  if (content === "") return 0;
  return content.replace(/\n$/, "").split("\n").length;
}

function describeChange(change: ApplyPatchFileChange): string {
  if (change.type === "add") return `${change.filePath} added (+${change.additions})`;
  if (change.type === "delete") return `${change.filePath} deleted (-${change.deletions})`;
  return `${change.filePath} updated (+${change.additions} -${change.deletions})`;
}

function formatApplyPatchModelContent(output: unknown): string {
  if (isRecord(output) && typeof output.summary === "string") {
    return `${output.summary}.${PATCH_FRESHNESS_SUFFIX}`;
  }
  return `Patch applied.${PATCH_FRESHNESS_SUFFIX}`;
}

const applyPatchHandler: ToolHandler = async (input, context) => {
  const { patch_text } = ApplyPatchInputSchema.parse(input) as ApplyPatchInput;
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for ApplyPatch tool",
      {
        context: { toolCallId: context.toolCallId, toolName: "ApplyPatch" },
        recoverable: false,
      },
    );
  }

  const parsed = parseApplyPatch(patch_text);
  if (!parsed.ok) {
    return patchFailure(
      parsed.code === "empty" ? ApplyPatchErrorCode.EMPTY_PATCH : ApplyPatchErrorCode.INVALID_PATCH,
      parsed.reason,
    );
  }
  if (parsed.sections.some((section) => section.kind === "move")) {
    return patchFailure(ApplyPatchErrorCode.INVALID_PATCH, MOVE_NOT_SUPPORTED_MESSAGE);
  }

  // ── 校验段：零写入。任何失败都在此返回，文件系统保持原样。──
  const plans: PlannedFile[] = [];
  let fsReadMs = 0;
  let patchMatchMs = 0;
  for (const section of parsed.sections) {
    if (section.kind === "move") continue; // 上方已拒绝；类型收窄用
    let resolvedPath: string;
    try {
      resolvedPath = resolveWorkspacePath({
        inputPath: section.path,
        operation: "write",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });
    } catch (error) {
      return patchFailure(
        ApplyPatchErrorCode.INVALID_PATH,
        `Invalid patch path ${JSON.stringify(section.path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const statStartedAt = Date.now();
    const stat = await statPatchFile(resolvedPath, context);

    if (section.kind === "add") {
      if (stat) {
        return patchFailure(
          ApplyPatchErrorCode.FILE_EXISTS,
          `Cannot add file: ${section.path} already exists. Use an '*** Update File' section to modify it.`,
        );
      }
      fsReadMs += elapsedMsSince(statStartedAt);
      const newContent = section.lines.map((line) => `${line}\n`).join("");
      plans.push({
        section,
        inputPath: section.path,
        resolvedPath,
        oldContent: undefined,
        newContent,
        read: undefined,
        additions: section.lines.length,
        deletions: 0,
      });
      continue;
    }

    if (!stat) {
      return patchFailure(
        ApplyPatchErrorCode.FILE_NOT_EXIST,
        `File does not exist: ${section.path}. Note: your current working directory is ${context.workingDirectory}.`,
      );
    }
    if (stat.sizeBytes > MAX_PATCH_FILE_SIZE_BYTES) {
      return patchFailure(
        ApplyPatchErrorCode.FILE_TOO_LARGE,
        `File is too large to patch (1GB): ${section.path}`,
      );
    }
    if (section.kind === "update" && resolvedPath.endsWith(".ipynb")) {
      return patchFailure(ApplyPatchErrorCode.NOTEBOOK_FILE, NOTEBOOK_MESSAGE);
    }

    const read = await fileSystemPort.readTextFile(
      { path: resolvedPath, trace: createPatchTrace(context) },
      { signal: context.abortSignal },
    );
    fsReadMs += elapsedMsSince(statStartedAt);
    const readStateFailure = getPatchableReadStateFailure(resolvedPath, read, context.readFileState);
    if (readStateFailure) return readStateFailure;

    if (section.kind === "delete") {
      plans.push({
        section,
        inputPath: section.path,
        resolvedPath,
        oldContent: read.content,
        newContent: undefined,
        read,
        additions: 0,
        deletions: countContentLines(read.content),
      });
      continue;
    }

    const matchStartedAt = Date.now();
    const applied = applyUpdateHunks(read.content, section.hunks, section.path);
    patchMatchMs += elapsedMsSince(matchStartedAt);
    if ("failure" in applied) return applied.failure;
    plans.push({
      section,
      inputPath: section.path,
      resolvedPath,
      oldContent: read.content,
      newContent: applied.content,
      read,
      additions: applied.additions,
      deletions: applied.deletions,
    });
  }

  // ── 应用段：按 section 序写盘。中途 IO 失败如实报告已应用集合（spec R2：不回滚、
  //    不谎称事务；expectedRevision 乐观并发挡住校验后、写入前的外部变更）。──
  const appliedPaths: string[] = [];
  const writeStartedAt = Date.now();
  for (const plan of plans) {
    try {
      if (plan.section.kind === "delete") {
        await fileSystemPort.removeFile(
          { path: plan.resolvedPath, trace: createPatchTrace(context) },
          { signal: context.abortSignal },
        );
      } else {
        const contentToWrite = stampMemoryOriginSessionId({
          content: plan.newContent ?? "",
          filePath: plan.resolvedPath,
          memoryRoot: context.memoryRoot,
          sessionId: context.sessionId,
        });
        const writeResult = await fileSystemPort.writeTextFile(
          {
            path: plan.resolvedPath,
            content: contentToWrite,
            encoding: plan.read?.encoding,
            lineEndings: plan.read?.lineEndings,
            createParents: true,
            atomic: true,
            expectedRevision: plan.read?.revision,
            trace: createPatchTrace(context),
          },
          { signal: context.abortSignal },
        );
        plan.writtenContent = contentToWrite;
        plan.writeRevision = writeResult.revision;
      }
      appliedPaths.push(plan.inputPath);
    } catch (error) {
      const appliedNote =
        appliedPaths.length > 0
          ? ` Files already applied before the failure: ${appliedPaths.join(", ")}.`
          : "";
      const reason = isFileSystemPortError(error)
        ? `file system error (${error.code})`
        : error instanceof Error
          ? error.message
          : String(error);
      return patchFailure(
        ApplyPatchErrorCode.IO_ERROR,
        `Patch application failed on ${plan.inputPath}: ${reason}.${appliedNote}`,
      );
    }
  }
  const fsWriteMs = elapsedMsSince(writeStartedAt);

  // ── 应用后状态：readFileState 逐文件更新（Delete 移除条目），输出聚合。──
  const files: ApplyPatchFileChange[] = [];
  const aggregatedHunks: DiffHunk[] = [];
  let totalBytes = 0;
  let maxFileBytes = 0;
  for (const plan of plans) {
    if (plan.section.kind === "delete") {
      removeReadFileStateAfterDelete(context.readFileState, plan.resolvedPath);
      const hunks = createStructuredPatch({
        filePath: plan.inputPath,
        oldContent: plan.oldContent ?? "",
        newContent: "",
      });
      aggregatedHunks.push(...hunks);
      files.push({
        filePath: plan.inputPath,
        type: "delete",
        structuredPatch: hunks,
        additions: 0,
        deletions: plan.deletions,
      });
      continue;
    }
    const written = plan.writtenContent ?? plan.newContent ?? "";
    const entry = updateReadFileStateAfterPatch(
      context.readFileState,
      plan.resolvedPath,
      written,
      plan.writeRevision,
    );
    recordPatchReadFileStateMetadata(context, entry);
    const hunks = createStructuredPatch({
      filePath: plan.inputPath,
      oldContent: plan.oldContent ?? "",
      newContent: written,
    });
    aggregatedHunks.push(...hunks);
    const bytes = fileByteCount(written);
    totalBytes += bytes;
    maxFileBytes = Math.max(maxFileBytes, bytes);
    files.push({
      filePath: plan.inputPath,
      type: plan.section.kind === "add" ? "add" : "update",
      structuredPatch: hunks,
      additions: plan.additions,
      deletions: plan.deletions,
    });
  }

  const output: ApplyPatchOutput = {
    files,
    structuredPatch: aggregatedHunks,
    summary: `Applied patch to ${files.length} file(s): ${files.map(describeChange).join("; ")}`,
  };
  ApplyPatchOutputSchema.parse(output);

  return attachToolExecutionTelemetry(output, {
    // contracts 的 telemetry 判别联合本就为补丁类工具准备了 "patch" 变体（edit.ts 同款）：
    // 文件系统事实与匹配事实分层，matchAttempts = 校验段尝试应用的 hunk 总数（每 hunk 一次）。
    detail: {
      kind: "patch",
      filesystem: {
        readMs: fsReadMs,
        writeMs: fsWriteMs,
        fileCount: files.length,
        totalBytes,
        maxFileBytes,
        workspaceKind: workspaceKind(context),
      },
      patch: {
        matchMs: patchMatchMs,
        hunkCount: aggregatedHunks.length,
        matchAttempts: plans.reduce(
          (total, plan) =>
            total + (plan.section.kind === "update" ? plan.section.hunks.length : 0),
          0,
        ),
      },
    },
  });
};

export const applyPatchToolEntry: ToolEntry = {
  capability: "Apply a structured multi-file patch through the file-system adapter",
  metadata: {
    name: "ApplyPatch",
    description: APPLY_PATCH_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: applyPatchHandler,
  formatModelContent: formatApplyPatchModelContent,
  inputSchema: ApplyPatchInputJsonSchema,
  outputSchema: ApplyPatchOutputJsonSchema,
  runtimeInputSchema: ApplyPatchInputSchema,
  runtimeOutputSchema: ApplyPatchOutputSchema,
  permission: {
    permission: "edit",
    reason: "ApplyPatch adds, updates and deletes files through the file-system adapter",
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
    userVisibleMessage: "ApplyPatch was cancelled before the file operations completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
