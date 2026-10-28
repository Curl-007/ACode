/**
 * message.tsx 批次 5 外迁：markdown 文件链接目标纯函数族（逐字迁移）。
 *
 * 单一职责：markdown href → 文件链接目标的解析/改写（rehype harden 前的 href 规整、
 * 目录判定、相对路径计算、第三方应用打开前的 stat 确认）。无 React；唯一的树操作是
 * rehype 插件对 hast 节点的纯遍历。
 */
import type { FileStat, OpenInEditorOptions } from "@acode/shared";
import {
  normalizeWorkspaceRelativeFilePath,
  parseMarkdownFileLinkTarget,
  resolveMarkdownFileLink,
} from "@/lib/markdownFileLink.js";
import { getPathLeaf } from "@/lib/path.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";

export interface MessageFileLinkTarget {
  path: string;
  label: string;
  /** 仅用于显式尾随斜杠的目录展示提示；打开第三方应用前必须重新 stat。 */
  pathKind?: NonNullable<OpenInEditorOptions["pathKind"]>;
  relativePath?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

const fileUrlProtocolPattern = /^file:\/\//i;
const windowsDriveAbsolutePathPattern = /^[a-zA-Z]:[\\/]/;

export type HastElementNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastElementNode[];
};

export function formatMarkdownFileLinkTargetHref(href: string): string {
  const parsedTarget = parseMarkdownFileLinkTarget(href);
  // Windows 盘符的 `C:` 会被 rehype-harden 当成未知 URI scheme，
  // 在自定义文件链接 renderer 运行前直接替换成 `[blocked]`。临时补成 `/C:/...`
  // 让安全层按普通 path 放行；resolveMarkdownFileLink 会在 Windows Host 上对称还原。
  const path = windowsDriveAbsolutePathPattern.test(parsedTarget.path)
    ? `/${parsedTarget.path.replaceAll("\\", "/")}`
    : fileUrlProtocolPattern.test(href)
      ? parsedTarget.path
      : parsedTarget.path.startsWith("./") ||
          parsedTarget.path.startsWith("/") ||
          parsedTarget.path.startsWith("#") ||
          parsedTarget.path.startsWith("../") ||
          /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(parsedTarget.path)
        ? parsedTarget.path
        : `./${parsedTarget.path}`;
  if (parsedTarget.lineNumber === null) {
    return path;
  }

  if (parsedTarget.columnNumber === null) {
    return `${path}:${parsedTarget.lineNumber}`;
  }

  return `${path}:${parsedTarget.lineNumber}:${parsedTarget.columnNumber}`;
}

export function shouldRewriteMarkdownFileLinkHref(href: string): boolean {
  if (resolveMarkdownFileLink(undefined, href)) {
    return true;
  }

  const parsedTarget = parseMarkdownFileLinkTarget(href);
  return (
    Boolean(parsedTarget.path) &&
    !parsedTarget.path.startsWith("/") &&
    !parsedTarget.path.startsWith("#") &&
    !parsedTarget.path.startsWith("../") &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(parsedTarget.path) &&
    // 越界路径若先经过 rehype rewrite/harden，`..` 可能被 URL 归一后丢失，
    // 点击层就无法还原原始逃逸意图；必须在改写前复用相对路径词法边界校验。
    normalizeWorkspaceRelativeFilePath(parsedTarget.path) !== null &&
    // `[README.md](README.md)` 这类裸文件名链接以前不会在 harden 前改写，
    // Streamdown 会把它当成不安全链接渲染成 `[blocked]`。有扩展名的裸路径按工作区文件处理，
    // 先规整成 `./README.md`，再交给统一的文件链接打开逻辑解析。
    (parsedTarget.path.includes("/") ||
      parsedTarget.path.includes("\\") ||
      hasFileExtension(getPathLeaf(parsedTarget.path)))
  );
}

export function rewriteLocalFileMarkdownTargetsRehypePlugin() {
  return (tree: HastElementNode) => {
    const visitNode = (node: HastElementNode) => {
      const targetProperty = node.tagName === "a" ? "href" : node.tagName === "img" ? "src" : null;
      if (
        node.type === "element" &&
        targetProperty &&
        typeof node.properties?.[targetProperty] === "string" &&
        shouldRewriteMarkdownFileLinkHref(node.properties[targetProperty])
      ) {
        // markdown 图片和链接一样会先经过 rehype-harden。`file://` 会被安全层硬拦，
        // 裸文件名又会被当成未知 URL；这里在 harden 前统一规整成本地路径/相对路径。
        node.properties[targetProperty] = formatMarkdownFileLinkTargetHref(
          node.properties[targetProperty],
        );
      }

      node.children?.forEach(visitNode);
    };

    visitNode(tree);
  };
}

export function hasFileExtension(pathLeaf: string): boolean {
  return /\.[^./\\]+$/.test(pathLeaf);
}

export function isExplicitDirectoryMarkdownLink(path: string, href: string): boolean {
  const trimmedHref = href.trim();
  return /[\\/]$/.test(trimmedHref) || /[\\/]$/.test(path);
}

export function buildMessageFileLinkTarget(input: {
  href: string;
  label: string;
  path: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): MessageFileLinkTarget {
  // 文件名是否带扩展名不能代表文件系统类型；env、hosts、config 等无扩展名文件
  // 过去会被误判为目录。这里只保留显式尾随斜杠作为图标提示，打开方式必须再 stat。
  const pathKind = isExplicitDirectoryMarkdownLink(input.path, input.href)
    ? ("directory" as const)
    : undefined;
  return {
    path: input.path,
    label: input.label,
    pathKind,
    relativePath: input.workspacePath
      ? getWorkspaceFileRelativePath(input.workspacePath, input.path)
      : input.label,
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    workspaceRemoteSessionId: input.workspaceRemoteSessionId,
  };
}

export async function openMessageFileLinkInEditor({
  editorId,
  fileLink,
  openInEditor,
  remoteTarget,
  statFile,
}: {
  editorId: string;
  fileLink: MessageFileLinkTarget;
  openInEditor: (
    editorId: string,
    path: string,
    options: OpenInEditorOptions,
  ) => Promise<{ success: boolean; error?: string }>;
  remoteTarget?: OpenInEditorOptions["remoteTarget"];
  statFile: (params: { path: string }) => Promise<Pick<FileStat, "type">>;
}) {
  // Markdown 渲染层无法从名称可靠判断文件/目录。这里在动作发生时通过
  // 当前 workspace scope 的 file service 取真实类型，stat 失败时不会调用本机应用。
  const fileStat = await statFile({ path: fileLink.path });
  return openInEditor(editorId, fileLink.path, {
    pathKind: fileStat.type,
    remoteTarget,
    workspaceIdentity: fileLink.workspaceIdentity,
  });
}

export function isExternalWebHref(href: string): boolean {
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
