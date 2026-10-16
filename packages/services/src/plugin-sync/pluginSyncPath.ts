import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { isUnsafeWindowsPathSegment, usesWindowsLexicalRules } from "@acode/shared/node";

interface PluginSyncPathOptions {
  unsafePathLabel?: string;
  /**
   * Windows 段级规则开关（DOS 设备名/尾点尾空格/段内冒号 ADS）。
   * 默认跟随 process.platform === "win32"；显式传入供测试与非平台化预检使用。
   * 依据：packages/services/specs/file-containment-trust-tiers.md R1/R6.2。
   */
  windowsRules?: boolean;
}

export function normalizePluginSyncRelativePath(
  path: string,
  options: PluginSyncPathOptions = {},
): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (
    !normalized ||
    // NUL 是路径注入的经典载体（截断语义因平台而异），词法层直接拒绝。
    path.includes("\0") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    path.includes("\\") ||
    /^[a-zA-Z]:/u.test(path) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..") ||
    // Windows 段级危险名：既有校验只拒盘符前缀，段内冒号（NTFS ADS）与
    // con/nul/com¹ 等设备名、尾点/尾空格段（落盘被静默剥离造成别名）此前可穿透。
    (usesWindowsLexicalRules(options) &&
      normalized.split("/").some((part) => isUnsafeWindowsPathSegment(part)))
  ) {
    throw new Error(`${options.unsafePathLabel ?? "unsafe plugin sync path"}: ${path}`);
  }
  return normalized;
}

export function resolvePluginSyncPathWithin(
  targetRoot: string,
  path: string,
  options: PluginSyncPathOptions = {},
): string {
  const normalizedRoot = resolve(targetRoot);
  const normalizedPath = normalizePluginSyncRelativePath(path, options);
  const targetPath = resolve(normalizedRoot, ...normalizedPath.split("/"));
  const relativePath = relative(normalizedRoot, targetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${options.unsafePathLabel ?? "unsafe plugin sync path"}: ${path}`);
  }
  return targetPath;
}
