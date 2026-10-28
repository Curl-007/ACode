/**
 * PreviewPane 批次 5 外迁：顶部路径面包屑的纯构建逻辑（逐字迁移自 PreviewPane.tsx）。
 *
 * 单一职责：CodeViewerSource + workspacePath → 面包屑数据（root 段 / 父段 / 文件段 / 图标），
 * 以及面包屑左右遮罩的 class 映射。无 React、无 DOM、无副作用。
 */
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { getPathLeaf } from "@/lib/path.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

export interface CodeViewerBreadcrumbData {
  rootLabel: string | null;
  parentSegments: string[];
  fileLabel: string;
  fileIconSrc: string | null;
}

export type BreadcrumbMaskState = "none" | "left" | "right" | "both";

export const BREADCRUMB_MASK_CLASS_BY_STATE: Record<BreadcrumbMaskState, string> = {
  none: "",
  left: "[mask-image:linear-gradient(to_right,transparent_0,black_16px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_16px,black_100%)]",
  right:
    "[mask-image:linear-gradient(to_right,black_0,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0,black_calc(100%-16px),transparent_100%)]",
  both: "[mask-image:linear-gradient(to_right,transparent_0,black_16px,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_16px,black_calc(100%-16px),transparent_100%)]",
};

export function normalizeBreadcrumbPathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

export function buildCodeViewerBreadcrumb(
  source: CodeViewerSource,
  workspacePath?: string,
): CodeViewerBreadcrumbData | null {
  const sourcePath = source.path;
  if (!sourcePath) {
    if (!source.title.trim()) {
      return null;
    }

    return {
      rootLabel: null,
      parentSegments: [],
      fileLabel: source.title,
      fileIconSrc: null,
    };
  }

  const normalizedSourcePath = sourcePath.replace(/\\/g, "/");
  const normalizedWorkspacePath = workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "") ?? null;
  const sourceLeaf = getPathLeaf(sourcePath);
  const descriptor = resolveFileDisplayDescriptor(sourcePath);
  if (
    normalizedWorkspacePath &&
    (normalizedSourcePath === normalizedWorkspacePath ||
      normalizedSourcePath.startsWith(`${normalizedWorkspacePath}/`))
  ) {
    const relativePath =
      normalizedSourcePath === normalizedWorkspacePath
        ? ""
        : normalizedSourcePath.slice(normalizedWorkspacePath.length + 1);
    const relativeSegments = normalizeBreadcrumbPathSegments(relativePath);

    return {
      rootLabel: getPathLeaf(normalizedWorkspacePath),
      parentSegments: relativeSegments.slice(0, -1),
      fileLabel: relativeSegments.at(-1) ?? sourceLeaf,
      fileIconSrc: descriptor.fileIconSrc,
    };
  }

  const sourceSegments = normalizeBreadcrumbPathSegments(normalizedSourcePath);
  return {
    rootLabel: sourcePath.startsWith("/") ? "/" : (sourceSegments[0] ?? null),
    parentSegments: sourcePath.startsWith("/")
      ? sourceSegments.slice(0, -1)
      : sourceSegments.slice(1, -1),
    fileLabel: sourceSegments.at(-1) ?? sourceLeaf,
    fileIconSrc: descriptor.fileIconSrc,
  };
}
