/**
 * PreviewPane 批次 5 外迁：预览 source 解析与展示选项纯函数族（逐字迁移自 PreviewPane.tsx）。
 *
 * 单一职责：CodeViewerSource → 具体预览形态（image/media/pdf/pptx/plain code）的判别与转换，
 * 以及 header 展示选项（code wrap / markdown / svg 切换）的派生。无 React、无 DOM、无副作用。
 */
import type { FileTextSlice } from "@acode/shared";
import {
  inferImageMediaType,
  inferMediaPreview,
  isPdfPreviewPath,
  isPptxPreviewPath,
  type CodeViewerSource,
  type MediaCodeViewerSource,
} from "@/lib/codeViewer.js";
import { getOfficeFilePreviewKind } from "@/lib/officeFilePreview.js";

export function isMarkdownSource(source: CodeViewerSource): boolean {
  return source.type === "text" && source.language === "markdown";
}

export function isSvgSource(source: CodeViewerSource): boolean {
  return source.type === "text" && source.path?.toLowerCase().endsWith(".svg") === true;
}

export function isMarkdownFilePath(path?: string): boolean {
  if (!path) {
    return false;
  }

  const normalizedPath = path.toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

export function resolvePreviewPaneTextFileResult(result: FileTextSlice): {
  filePreview: FileTextSlice | null;
  fileTooLarge: boolean;
} {
  if (result.isBinary) {
    return {
      filePreview: result,
      fileTooLarge: false,
    };
  }

  return result.truncated
    ? {
        filePreview: null,
        fileTooLarge: true,
      }
    : {
        filePreview: result,
        fileTooLarge: false,
      };
}

export function isSvgFilePath(path?: string): boolean {
  return path?.toLowerCase().endsWith(".svg") ?? false;
}

export function getFileImageMediaType(path?: string): string | null {
  const mediaType = inferImageMediaType(path);
  return mediaType && mediaType !== "image/svg+xml" ? mediaType : null;
}

// 与 service 层 readFileRange 的默认分段大小对齐，一次 range 请求对应一次 RPC 调用。
export const PDF_RANGE_CHUNK_BYTES = 256 * 1024;
// 小 PDF 直接循环拉全量（少量往返、渲染路径最简单）；超过阈值交给 pdf.js range 按需分段加载。
export const PDF_FULL_READ_MAX_BYTES = 2 * 1024 * 1024;
export const PPTX_MAX_FILE_BYTES = 64 * 1024 * 1024;

export function isPptxPreviewFileTooLarge(size: number): boolean {
  return size > PPTX_MAX_FILE_BYTES;
}

export function resolvePreviewPaneImageSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "image" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "image") {
    return source;
  }

  if (source.type !== "file") {
    return null;
  }

  const mediaType = getFileImageMediaType(source.path);
  if (!mediaType) {
    return null;
  }

  return {
    type: "image",
    title: source.title,
    path: source.path,
    mediaType,
  };
}

export function resolvePreviewPaneMediaSource(
  source: CodeViewerSource | null,
): MediaCodeViewerSource | null {
  if (!source) return null;
  if (source.type === "media") return source;
  if (source.type !== "file") return null;
  const media = inferMediaPreview(source.path);
  if (!media) return null;
  return { ...source, type: "media", ...media };
}

export function resolveMediaPlaybackErrorMessageId(
  code: number | undefined,
): "codeViewer.mediaUnsupported" | "codeViewer.mediaLoadFailed" {
  return code === 3 || code === 4 ? "codeViewer.mediaUnsupported" : "codeViewer.mediaLoadFailed";
}

export function resolvePreviewPanePdfSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "pdf" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "pdf") {
    return source;
  }

  if (source.type !== "file" || !isPdfPreviewPath(source.path)) {
    return null;
  }

  return {
    type: "pdf",
    title: source.title,
    path: source.path,
  };
}

export function resolvePreviewPanePptxSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "pptx" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "pptx") {
    return source;
  }

  if (source.type !== "file" || !isPptxPreviewPath(source.path)) {
    return null;
  }

  return {
    ...source,
    type: "pptx",
  };
}

export function shouldShowPreviewPaneHeaderDivider(source: CodeViewerSource | null): boolean {
  return Boolean(
    resolvePreviewPanePdfSource(source) ||
    resolvePreviewPanePptxSource(source) ||
    resolvePreviewPaneMediaSource(source) ||
    (source?.type === "file" && getOfficeFilePreviewKind(source.path)),
  );
}

export function isPlainCodeSource(source: CodeViewerSource | null): boolean {
  if (!source) {
    return false;
  }

  if (source.type === "text") {
    return !isMarkdownSource(source) && !isSvgSource(source);
  }

  if (source.type === "file") {
    return (
      !isMarkdownFilePath(source.path) &&
      !isSvgFilePath(source.path) &&
      !getFileImageMediaType(source.path) &&
      // PDF、Office 和 PPTX 走专用只读预览，没有源码视图，也不该出现自动换行开关。
      !isPdfPreviewPath(source.path) &&
      !getOfficeFilePreviewKind(source.path) &&
      !isPptxPreviewPath(source.path)
    );
  }

  if (source.type === "media") return false;

  if (source.type === "code-review") {
    return true;
  }

  return false;
}

export function getPreviewPaneDisplayOptions(
  source: CodeViewerSource | null,
  viewModes: {
    markdownViewMode?: "preview" | "code";
    svgViewMode?: "preview" | "code";
  } = {},
) {
  const canToggleMarkdownView =
    source !== null &&
    (isMarkdownSource(source) || (source.type === "file" && isMarkdownFilePath(source.path)));
  const canToggleSvgView =
    source !== null &&
    (isSvgSource(source) || (source.type === "file" && isSvgFilePath(source.path)));
  const canToggleCodeWrap =
    isPlainCodeSource(source) ||
    (canToggleMarkdownView && viewModes.markdownViewMode === "code") ||
    (canToggleSvgView && viewModes.svgViewMode === "code");

  return {
    canToggleCodeWrap,
    canToggleMarkdownView,
    canToggleSvgView,
    hasMoreMenu: canToggleMarkdownView || canToggleSvgView || canToggleCodeWrap,
  };
}
