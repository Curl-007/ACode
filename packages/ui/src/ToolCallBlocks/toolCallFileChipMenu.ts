import type { EditorInfo } from "@acode/shared";
import { isFileManagerOpenTarget } from "@/lib/openWithEditors.js";
import { decodeFilePathUriEscapes, isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";

/**
 * 工具卡文件 chip 的文件动作需要一个绝对路径，但 `RawToolCallFileSummary.path`
 * 来自工具原文，`specs/agent-teams.md` 与 `D:\...\agent-teams.md` 两种都会出现。
 * 解析规则与 `GitPane.resolveChangePath` / `codeViewer.resolveViewerPath` 保持一致，
 * 不在这里另立一套。
 */
export function resolveToolCallFileChipPath(path: string, workspacePath?: string): string {
  const decodedPath = decodeFilePathUriEscapes(path);
  if (isAbsoluteFilePath(decodedPath) || !workspacePath) {
    return decodedPath;
  }

  return joinFilePath(workspacePath, decodedPath);
}

/** 复制相对路径的取值；没有 workspace scope 时退回工具原文路径。 */
export function resolveToolCallFileChipRelativePath(path: string, workspacePath?: string): string {
  const absolutePath = resolveToolCallFileChipPath(path, workspacePath);
  return workspacePath ? getWorkspaceFileRelativePath(workspacePath, absolutePath) : path;
}

export interface ToolCallFileChipMenuPlan {
  /** 「打开」分组里的编辑器条目（已按远程能力过滤）。 */
  editors: EditorInfo[];
  /** 是否渲染「打开」分组。全平台都没有可打开的东西时整组不渲染，避免死条目。 */
  showOpenGroup: boolean;
  /** 是否渲染禁用的提示条目（加载中 / 未找到可用 App）。 */
  showNoEditorsHint: boolean;
  /** 是否渲染显式的「在文件管理器中打开」。 */
  showRevealInFileManager: boolean;
}

/**
 * 菜单结构是纯函数算出来的：DOM 测试基建拿不到 Radix 菜单内容（见 spec §5），
 * 把「渲染哪些条目」和「怎么渲染」分开，前者才能被单测钉住。
 *
 * 「打开位置」在任何平台上都只出现一次——Windows/macOS 的编辑器白名单里本来就有
 * 资源管理器 / Finder，那一条就是打开位置；只有列表里没有文件管理器条目时
 * （Linux 白名单为空、或枚举失败）才补一条显式入口。
 */
export function planToolCallFileChipMenu(input: {
  availableEditors: EditorInfo[];
  /** 编辑器枚举是否已结束（成功或失败都算结束）。未结束时不给「打开位置」，避免条目先出现再消失。 */
  editorsResolved: boolean;
  /** 平台能否打开本机文件管理器（Desktop 且非 Web）。 */
  canOpenLocalFileManager: boolean;
  /** `fileActions.canRevealInFileManager({ path, kind: "file" })` 的结果。 */
  canRevealInFileManager: boolean;
}): ToolCallFileChipMenuPlan {
  const { availableEditors, editorsResolved, canOpenLocalFileManager, canRevealInFileManager } =
    input;
  const hasFileManagerEditor = availableEditors.some(isFileManagerOpenTarget);
  const showRevealInFileManager =
    editorsResolved && canRevealInFileManager && !hasFileManagerEditor;
  // 枚举未结束时 editors 恒为空，此时提示「加载中」；枚举结束仍为空且没有可用的
  // 本地打开位置时提示「未找到可用 App」。Web 端 canOpenLocalFileManager 为 false，
  // 整组不渲染——远端机器上没有任何本地 App 能打开这些路径。
  const showNoEditorsHint =
    availableEditors.length === 0 && canOpenLocalFileManager && !showRevealInFileManager;

  return {
    editors: availableEditors,
    showOpenGroup:
      availableEditors.length > 0 || showRevealInFileManager || showNoEditorsHint,
    showNoEditorsHint,
    showRevealInFileManager,
  };
}
