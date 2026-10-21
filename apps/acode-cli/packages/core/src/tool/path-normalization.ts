// ============================================================
// Tool Path Normalization Helpers
// ============================================================

import path, { normalize } from "node:path";
import { platform as currentPlatform } from "node:process";

export type ToolPathPlatform = NodeJS.Platform;
export type ToolPathApi = typeof path.posix | typeof path.win32;

export function getToolPathApi(platform: ToolPathPlatform): ToolPathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

export function normalizeToolPathForComparison(
  filePath: string,
  platform: ToolPathPlatform = currentPlatform,
): string {
  const normalized =
    platform === "win32" ? normalizeWindowsToolPath(filePath) : normalize(filePath);
  return normalized.normalize("NFC");
}

/**
 * read-state 键/路径比较专用归一化：在 normalizeToolPathForComparison 基础上，对 win32
 * 追加大小写折叠。
 *
 * 根因：Windows 文件系统大小写不敏感，但 normalizeToolPathForComparison 只归一化盘符别名、
 * extended-path 前缀和盘符大小写，不折叠其余路径段。同一文件的两种拼写（例如 Read 收到
 * canonical `C:\Users\...`，Edit/Bash cat 收到 Git Bash 风格小写 `/c/users/...`）在 read-state
 * 键空间里分裂成两条：Read 记录在一条键下，Edit/Write/ApplyPatch 按另一条查找，命中不到
 * 就报 FILE_NOT_READ（用户实报「edit 前必须先读、Bash 也会报错」）。折叠大小写让键空间与
 * Windows FS 的大小写不敏感语义一致。
 *
 * 边界：只服务 read-state 键与路径比较，绝不用于回填真实工作目录——bash-cwd-policy 的
 * normalizeCwdBoundary 返回值会交给 setWorkingDirectory，折叠大小写会污染真实 cwd 显示与
 * 下游比较，故那条路径继续用 normalizeToolPathForComparison。用 toLowerCase（非
 * toLocaleLowerCase）保证与运行区域设置无关。
 */
export function normalizeReadStatePathKey(
  filePath: string,
  platform: ToolPathPlatform = currentPlatform,
): string {
  const normalized = normalizeToolPathForComparison(filePath, platform);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeWindowsToolPath(filePath: string): string {
  const driveAliasNormalized = normalizeWindowsDriveAlias(filePath);
  const prefixStripped = stripWindowsExtendedPathPrefix(path.win32.normalize(driveAliasNormalized));
  return canonicalizeWindowsDriveLetter(prefixStripped);
}

function normalizeWindowsDriveAlias(filePath: string): string {
  // Read/Edit/Write 和 Bash cwd 都会收到 Git Bash 风格的 /c/... 路径；
  // 统一转换到 drive-letter 形式，避免各工具重复实现 Windows path 兼容逻辑。
  const driveAliasMatch = filePath.match(/^\/([A-Za-z])\//);
  if (!driveAliasMatch) return filePath;

  const drive = driveAliasMatch[1]!.toUpperCase();
  const rest = filePath.slice(2);
  return `${drive}:${rest}`.replaceAll("/", "\\");
}

function canonicalizeWindowsDriveLetter(filePath: string): string {
  return filePath.replace(/^([a-zA-Z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

function stripWindowsExtendedPathPrefix(filePath: string): string {
  // 只剥离 extended UNC 和 drive path，保留 Volume/GLOBALROOT 等设备命名空间。
  if (filePath.startsWith("\\\\?\\UNC\\")) return `\\\\${filePath.slice("\\\\?\\UNC\\".length)}`;
  if (filePath.startsWith("\\\\?\\") && filePath.length >= 7 && filePath[5] === ":") {
    return filePath.slice("\\\\?\\".length);
  }
  return filePath;
}
