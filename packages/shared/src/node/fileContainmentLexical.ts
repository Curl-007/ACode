// 文件遏制层 · 词法基座（五层防线中的第①层 + 封闭错误词表）。
//
// 封闭错误类：FileContainmentError，code 为小写下划线闭集
// escape | symlink | multilink | not_regular | size | root（不新增、不自由文本化）。
// 词法校验是同步纯函数：拒绝绝对路径/UNC/设备路径前缀/盘符/NUL/normalize 后 ..；
// Windows 段级拒 DOS 设备名（含上标 ¹²³ 变体——Windows 文件名大写映射会把上标折叠
// 为 1/2/3，com¹ 即 COM1）、尾点/尾空格段、段内冒号（NTFS ADS）。
// 规格：packages/services/specs/file-containment-trust-tiers.md R1。
import { isAbsolute, posix, resolve, join } from "node:path";

export const FILE_CONTAINMENT_ERROR_CODES = [
  "escape",
  "symlink",
  "multilink",
  "not_regular",
  "size",
  "root",
] as const;

export type FileContainmentErrorCode = (typeof FILE_CONTAINMENT_ERROR_CODES)[number];

export class FileContainmentError extends Error {
  readonly code: FileContainmentErrorCode;
  readonly path?: string;
  /** code === "not_regular" 时标记目标是否为目录，便于调用方分流文案。 */
  readonly isDirectory?: boolean;

  constructor(
    code: FileContainmentErrorCode,
    message: string,
    details?: { path?: string; isDirectory?: boolean; cause?: unknown },
  ) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "FileContainmentError";
    this.code = code;
    if (details?.path !== undefined) this.path = details.path;
    if (details?.isDirectory !== undefined) this.isDirectory = details.isDirectory;
  }
}

const WINDOWS_DEVICE_SEGMENT_PATTERN =
  /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i;
const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;
// \\?\ 与 //?/（含 \\.\）设备路径前缀。
const DEVICE_PATH_PREFIX_PATTERN = /^[\\/]{2}[?.][\\/]/u;
const UNC_PREFIX_PATTERN = /^[\\/]{2}/u;

export interface RelativePathLexicalOptions {
  /**
   * 是否启用 Windows 段级规则（设备名/尾点尾空格/段内冒号）。
   * 默认跟随 process.platform === "win32"；显式传入用于测试与跨平台归档预检。
   */
  windowsRules?: boolean;
}

export function usesWindowsLexicalRules(options: RelativePathLexicalOptions | undefined): boolean {
  return options?.windowsRules ?? process.platform === "win32";
}

/** Windows 段级危险段判定（纯函数，供归档会话跨平台预检复用）。 */
export function isUnsafeWindowsPathSegment(segment: string): boolean {
  return (
    WINDOWS_DEVICE_SEGMENT_PATTERN.test(segment) || /[. ]$/u.test(segment) || segment.includes(":")
  );
}

function stripTrailingSlash(normalized: string): string {
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function toSegments(slashed: string): string[] {
  const normalized = stripTrailingSlash(posix.normalize(slashed));
  return normalized === "." ? [] : normalized.split("/").filter(Boolean);
}

/**
 * 词法校验（同步纯函数）：返回拒绝原因（封闭短语），合法返回 null。
 * 反斜杠→斜杠归一仅在 Windows 规则下执行（POSIX 上反斜杠是合法文件名字符）。
 */
export function findRelativePathEscapeReason(
  relativePath: string,
  options?: RelativePathLexicalOptions,
): string | null {
  if (typeof relativePath !== "string") return "not_a_string";
  if (relativePath.includes("\0")) return "nul_byte";
  const windowsRules = usesWindowsLexicalRules(options);
  const slashed = windowsRules ? relativePath.replaceAll("\\", "/") : relativePath;
  // 设备路径前缀（\\?\、\\.\）比 UNC 更具体，先判以免被 UNC 前缀吸收。
  if (DEVICE_PATH_PREFIX_PATTERN.test(slashed)) return "device_path_prefix";
  if (UNC_PREFIX_PATTERN.test(slashed)) return "unc_prefix";
  if (windowsRules && DRIVE_PREFIX_PATTERN.test(slashed)) return "drive_prefix";
  if (isAbsolute(slashed) || posix.isAbsolute(slashed)) return "absolute";
  const normalized = stripTrailingSlash(posix.normalize(slashed));
  // normalize 后仍以 .. 显形（"a/../.." → ".."）即逃逸；".." 前缀短语本身合法
  // （如 "..foo" 是普通文件名），只拒整段形态。
  if (normalized === ".." || normalized.startsWith("../")) return "parent_escape";
  for (const segment of toSegments(slashed)) {
    if (segment === "..") return "parent_escape";
    if (windowsRules && isUnsafeWindowsPathSegment(segment)) return "windows_unsafe_segment";
  }
  return null;
}

export interface ContainedPathResolution {
  /** rootDir 与合法段 join 后的绝对路径（segments 为空时即 rootDir）。 */
  fullPath: string;
  /** 归一化后的相对路径（"/" 连接；空相对路径为 ""）。 */
  relativePath: string;
  segments: string[];
  /** 除末段外的目录段（逐段 lstat 的对象）。 */
  directorySegments: string[];
  /** 末段名；相对路径为空（指向根自身）时 undefined。 */
  leaf: string | undefined;
}

/** 词法层：解析相对路径为遏制结构；任何拒绝原因 → FileContainmentError("escape")。 */
export function resolveContainedPath(
  rootDir: string,
  relativePath: string,
  options?: RelativePathLexicalOptions,
): ContainedPathResolution {
  const reason = findRelativePathEscapeReason(relativePath, options);
  if (reason !== null) {
    throw new FileContainmentError(
      "escape",
      `relative path escapes containment root (${reason}): ${JSON.stringify(relativePath)}`,
      { path: relativePath },
    );
  }
  const windowsRules = usesWindowsLexicalRules(options);
  const slashed = windowsRules ? relativePath.replaceAll("\\", "/") : relativePath;
  const segments = toSegments(slashed);
  const root = resolve(rootDir);
  return {
    fullPath: segments.length === 0 ? root : join(root, ...segments),
    relativePath: segments.join("/"),
    segments,
    directorySegments: segments.slice(0, -1),
    leaf: segments.length > 0 ? segments[segments.length - 1] : undefined,
  };
}
