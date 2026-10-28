/**
 * PreviewPane 批次 5 外迁：预览错误分类与安全文案纯函数族（逐字迁移自 PreviewPane.tsx）。
 *
 * 单一职责：把底层读取错误（ENOENT / too large / pptx 不完整）归类成 UI 文案决策，
 * 并把绝对路径从错误消息中脱敏为文件名。无 React、无 DOM、无副作用。
 */
import { getPathLeaf, isAbsoluteFilePath } from "@/lib/path.js";
import { isPptxPreviewIncompleteFileError } from "@/lib/pptxPreviewData.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

export function isPreviewPaneMissingFileError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b/i.test(message) || /no such file or directory/i.test(message);
}

export function shouldToastPptxReferenceFileMissing(
  source: CodeViewerSource | null,
  error: unknown,
): boolean {
  return (
    source?.type === "pptx" &&
    source.referenceNavigation !== undefined &&
    isPreviewPaneMissingFileError(error)
  );
}

export function isPreviewPaneFileTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /file is too large to preview/i.test(message);
}

export function getPreviewPaneSafeErrorMessage(error: unknown, sourcePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isAbsoluteFilePath(sourcePath)) {
    return message;
  }

  const sourceLeaf = getPathLeaf(sourcePath);
  const pathVariants = new Set([
    sourcePath,
    sourcePath.replace(/\\/g, "/"),
    sourcePath.replace(/\//g, "\\"),
  ]);

  let safeMessage = message;
  for (const pathVariant of pathVariants) {
    if (pathVariant !== sourceLeaf) {
      safeMessage = safeMessage.split(pathVariant).join(sourceLeaf);
    }
  }
  return safeMessage;
}

export function resolvePptxPreviewReadErrorMessage(
  error: unknown,
  options: {
    sourcePath: string;
    fileMissingMessage: string;
    legacyFileTooLargeMessage: string;
    incompleteFileMessage: string;
  },
): string {
  if (isPreviewPaneMissingFileError(error)) {
    return options.fileMissingMessage;
  }
  if (isPreviewPaneFileTooLargeError(error)) {
    return options.legacyFileTooLargeMessage;
  }
  if (isPptxPreviewIncompleteFileError(error)) {
    return options.incompleteFileMessage;
  }
  return getPreviewPaneSafeErrorMessage(error, options.sourcePath);
}
