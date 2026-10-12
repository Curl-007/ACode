import type {
  ConversationExportChunkResult,
  ConversationExportFormat,
  ConversationExportSelection,
  IConversationExportService,
} from "@acode/services";
import type { IPlatformService, Locale } from "@acode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { buildConversationExportFilename } from "@/lib/conversation-export/conversationExportFilename.js";
import { createConversationExportLabels } from "@/lib/conversation-export/conversationExportLabels.js";
import {
  serializeConversationMarkdownChunk,
  serializeConversationMarkdownHead,
  serializeConversationMarkdownTail,
  type ConversationExportSerializeContext,
} from "@/lib/conversation-export/serializeConversationMarkdown.js";
import {
  serializeConversationHtmlChunk,
  serializeConversationHtmlHead,
  serializeConversationHtmlTail,
} from "@/lib/conversation-export/serializeConversationHtml.js";

/**
 * 导出动作的唯一编排者（阶段机 + 写盘/降级分支）。
 *
 * 状态所有者：本函数只持有局部变量（parts / bytes / cursor），不进 store、不落中间产物、
 * 不跨窗口共享。同一窗口同一时刻最多一个导出任务由调用方（弹层的 disabled）保证。
 *
 * 关键顺序规则：**先生成内容、再 saveFile**。saveFile 会弹系统对话框；若先弹框再生成，
 * 大会话会让用户选完路径后长时间等待，且生成失败会在磁盘上留下零字节文件。
 */

/**
 * 导出内容上限：48 MiB，比 saveFile 的 50 MiB 硬上限（desktopSaveFile.ts:12）留 2 MiB 余量。
 * 超限时中止并给出可操作提示，不静默截断。
 */
export const EXPORT_MAX_BYTES = 48 * 1024 * 1024;

export type ConversationExportFailureKind =
  | "empty"
  | "running"
  | "no_selection"
  | "too_large"
  | "changed"
  | "failed";

export interface ConversationExportOutcome {
  ok: boolean;
  /** 失败分类；ok 为 true 时不存在。 */
  failure?: ConversationExportFailureKind;
  /** 失败详情（错误码/消息），供 toast 的 {error} 占位。 */
  errorDetail?: string;
  /** 保存路径（仅 Desktop 且成功时）。 */
  path?: string;
  /** Web 端 Markdown 走剪贴板时为 true。 */
  copied?: boolean;
}

export interface RunConversationExportInput {
  exportService: IConversationExportService;
  /** saveFile 是可选方法：Web 端不提供，缺省即走浏览器降级路径。 */
  platform: Pick<IPlatformService, "saveFile"> | null;
  intl: IntlInstance;
  locale: Locale;
  format: ConversationExportFormat;
  selection: ConversationExportSelection;
  target: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    sessionId: string;
  };
  title: string;
  /** 生成时刻，仅用于 HTML 的 meta 标签与文件名；不参与内容比对。 */
  now: Date;
}

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/** 把分片拼出的字符串转成 ArrayBuffer（saveFile 契约是一次性 ArrayBuffer）。 */
function toArrayBuffer(value: string): ArrayBuffer {
  const bytes = encoder.encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 逐片序列化并累加字节数。
 *
 * 用 `parts: string[]` + 最后一次 join：禁止在循环里做 `content += chunk`（O(n²) 拷贝）。
 * 单页序列化是同步纯函数，出错即中止（不写盘）。
 */
function createStreamingAccumulator() {
  const parts: string[] = [];
  let bytes = 0;
  return {
    push(text: string): boolean {
      bytes += utf8Length(text);
      if (bytes > EXPORT_MAX_BYTES) return false;
      parts.push(text);
      return true;
    },
    get bytes(): number {
      return bytes;
    },
    join(): string {
      return parts.join("");
    },
    get partCount(): number {
      return parts.length;
    },
  };
}

function createSerializer(format: ConversationExportFormat) {
  if (format === "html") {
    return {
      head: (options: { title: string; context: ConversationExportSerializeContext }) =>
        serializeConversationHtmlHead({
          title: options.title,
          locale: options.context.locale,
          intl: options.context.intl,
          generatedAt: new Date().toISOString(),
        }),
      chunk: (result: ConversationExportChunkResult, context: ConversationExportSerializeContext) =>
        serializeConversationHtmlChunk(result.chunk, context),
      tail: (skippedRowCount: number, context: ConversationExportSerializeContext) =>
        serializeConversationHtmlTail(skippedRowCount, context.labels),
    };
  }
  return {
    head: (options: { title: string; context: ConversationExportSerializeContext }) =>
      serializeConversationMarkdownHead({ title: options.title, labels: options.context.labels }),
    chunk: (result: ConversationExportChunkResult, context: ConversationExportSerializeContext) =>
      serializeConversationMarkdownChunk(result.chunk, context),
    tail: (skippedRowCount: number, context: ConversationExportSerializeContext) =>
      serializeConversationMarkdownTail(skippedRowCount, context.labels),
  };
}

/** 收集 IR 里出现过的 artifact 显示名，供 citation 剥离把 directive 换成显示名。 */
function collectArtifactNames(
  artifactNames: Map<string, string>,
  result: ConversationExportChunkResult,
): void {
  for (const row of result.chunk.rows) {
    if (row.kind === "artifact") {
      artifactNames.set(row.displayName, row.displayName);
    }
  }
}

async function writeViaPlatform(
  platform: Pick<Required<IPlatformService>, "saveFile">,
  content: string,
  suggestedName: string,
): Promise<ConversationExportOutcome> {
  const result = await platform.saveFile({
    data: toArrayBuffer(content),
    suggestedName,
  });
  // 用户取消：静默结束，不提示、不报错。
  if (result.canceled) return { ok: true };
  if (!result.success || !result.path) {
    logger.warn("[conversation-export] 保存文件失败", { errorCode: result.error ?? "unknown" });
    return { ok: false, failure: "failed", errorDetail: result.error ?? "save_failed" };
  }
  return { ok: true, path: result.path };
}

async function writeViaBrowser(
  content: string,
  suggestedName: string,
  format: ConversationExportFormat,
): Promise<ConversationExportOutcome> {
  if (format === "markdown") {
    // 手机 Web 上「复制」比「下载 .md」更符合直觉（下载的 .md 很难再用）。
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) {
      return { ok: false, failure: "failed", errorDetail: "clipboard_unavailable" };
    }
    await clipboard.writeText(content);
    return { ok: true, copied: true };
  }
  const blob = new Blob([content], { type: "text/html;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = suggestedName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return { ok: true };
}

export async function runConversationExport(
  input: RunConversationExportInput,
): Promise<ConversationExportOutcome> {
  const clientRequestId = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
  const startedAt = Date.now();
  const artifactNames = new Map<string, string>();
  const context: ConversationExportSerializeContext = {
    labels: createConversationExportLabels(input.intl),
    locale: input.locale,
    intl: input.intl,
    artifactNames,
    turnCounter: { value: 0 },
  };

  logger.info("[conversation-export] 开始导出", {
    sessionId: input.target.sessionId,
    format: input.format,
    scope: input.selection.kind,
    clientRequestId,
  });

  // 阶段 1: preparing —— 预检先失败就先拒绝，不进入 streaming，也不弹对话框。
  let preflight;
  try {
    preflight = await input.exportService.preflight({
      ...input.target,
      selection: input.selection,
    });
  } catch (error) {
    logger.warn("[conversation-export] 读取会话行失败", {
      sessionId: input.target.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      failure: "failed",
      errorDetail: error instanceof Error ? error.message : String(error),
    };
  }
  const firstBlocking = preflight.blockingReasons[0];
  if (firstBlocking) {
    return { ok: false, failure: firstBlocking };
  }

  // 阶段 2: streaming —— 逐页读 + 逐片序列化 + 字节守卫。
  const serializer = createSerializer(input.format);
  const accumulator = createStreamingAccumulator();
  let cursor: number | undefined;
  let skippedRowCount = 0;
  let chunkCount = 0;

  if (!accumulator.push(serializer.head({ title: input.title, context }))) {
    return { ok: false, failure: "too_large" };
  }

  for (;;) {
    let page: ConversationExportChunkResult;
    try {
      page = await input.exportService.readChunk({
        ...input.target,
        selection: input.selection,
        ...(cursor === undefined ? {} : { beforeRowId: cursor }),
        // 跨页水位比对：服务层内部也校验一次，这里再比对一次形成双保险。
        expectedWatermark: { logEpoch: preflight.atLogEpoch, revision: preflight.atRevision },
      });
    } catch (error) {
      logger.warn("[conversation-export] 读取会话行失败", {
        sessionId: input.target.sessionId,
        beforeRowId: cursor,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        failure: "failed",
        errorDetail: error instanceof Error ? error.message : String(error),
      };
    }

    if (page.atLogEpoch !== preflight.atLogEpoch || page.atRevision !== preflight.atRevision) {
      logger.warn("[conversation-export] 导出期间会话发生变化", {
        sessionId: input.target.sessionId,
        expectedEpoch: preflight.atLogEpoch,
        actualEpoch: page.atLogEpoch,
      });
      return { ok: false, failure: "changed" };
    }

    collectArtifactNames(artifactNames, page);
    skippedRowCount += page.skippedRowCount;
    chunkCount += 1;
    if (!accumulator.push(serializer.chunk(page, context))) {
      logger.warn("[conversation-export] 内容超过体积上限", {
        sessionId: input.target.sessionId,
        byteLength: accumulator.bytes,
        limit: EXPORT_MAX_BYTES,
      });
      return { ok: false, failure: "too_large" };
    }

    if (!page.hasMore) break;
    if (page.nextBeforeRowId === undefined) {
      // 服务层已保证 hasMore 时游标存在；这里兜住契约被破坏的情况，避免死循环。
      logger.warn("[conversation-export] 分页游标缺失", { sessionId: input.target.sessionId });
      return { ok: false, failure: "failed", errorDetail: "invalid_pagination" };
    }
    cursor = page.nextBeforeRowId;
  }

  // 阶段 3: finalizing —— 补尾（HTML 的 </body></html>、跳过计数）后一次性写盘。
  if (!accumulator.push(serializer.tail(skippedRowCount, context))) {
    return { ok: false, failure: "too_large" };
  }

  const content = accumulator.join();
  const byteLength = utf8Length(content);
  if (byteLength > EXPORT_MAX_BYTES) {
    logger.warn("[conversation-export] 内容超过体积上限", {
      sessionId: input.target.sessionId,
      byteLength,
      limit: EXPORT_MAX_BYTES,
    });
    return { ok: false, failure: "too_large" };
  }

  const suggestedName = buildConversationExportFilename({
    title: input.title,
    extension: input.format === "html" ? "html" : "md",
    now: input.now,
  });

  let outcome: ConversationExportOutcome;
  try {
    const saveFile = input.platform?.saveFile;
    outcome = saveFile
      ? await writeViaPlatform({ saveFile }, content, suggestedName)
      : await writeViaBrowser(content, suggestedName, input.format);
  } catch (error) {
    logger.warn("[conversation-export] 保存文件失败", {
      errorCode: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      failure: "failed",
      errorDetail: error instanceof Error ? error.message : String(error),
    };
  }

  if (outcome.ok) {
    logger.info("[conversation-export] 导出完成", {
      sessionId: input.target.sessionId,
      format: input.format,
      byteLength,
      chunkCount,
      skippedRowCount,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }
  return outcome;
}
