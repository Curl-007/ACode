// 拆分依据：localTarGz.ts 超 400 行架构上限。归档条目路径与 symlink 目标的安全规范化是纯逻辑，
// 独立成叶子后可直接单测（路径逃逸/跨盘符/反斜杠拒绝），不与归档 IO 流程耦合。

import { dirname, isAbsolute, relative, resolve, sep, posix } from "node:path";

export function normalizeCreateEntryPath(entryPath: string): string {
  const normalized = entryPath.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  if (!normalized || normalized === ".") {
    throw new Error("[remote-assets] tar entry path must not be empty");
  }
  return normalized;
}

export function normalizeExtractEntryPath(entryPath: string): string | null {
  const trimmed = entryPath.trim().replace(/^\.\/+/u, "");
  if (!trimmed || trimmed === ".") {
    return null;
  }
  // 判据必须平台无关：POSIX 的 isAbsolute 不认识「C:/…」盘符形态，Linux 解包宿主上
  // win32 语义的 isAbsolute 也不存在，盘符绝对路径会被当作相对段放行（CI Linux 红的
  // 根因；本地 Windows 因 win32 isAbsolute 认识盘符而掩盖）。「C:foo」盘符相对形态
  // 在两个平台都能绕过 isAbsolute，一并按盘符前缀拒绝——与 normalizeSymlinkLinkName
  // 的盘符拒绝纪律对齐。
  if (
    trimmed.includes("\\") ||
    /^[a-zA-Z]:/u.test(trimmed) ||
    isAbsolute(trimmed) ||
    posix.isAbsolute(trimmed)
  ) {
    throw new Error(`[remote-assets] unsafe tar entry path: ${entryPath}`);
  }

  const normalized = posix.normalize(trimmed).replace(/\/+$/u, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`[remote-assets] unsafe tar entry path: ${entryPath}`);
  }
  return normalized;
}

export function normalizeCreateSymlinkTarget({
  archivePath,
  rawLinkTarget,
}: {
  archivePath: string;
  rawLinkTarget: string;
}): string {
  const normalizedLinkTarget = normalizeSymlinkLinkName(rawLinkTarget);
  const parentArchivePath = posix.dirname(archivePath);
  const resolvedArchiveTarget = posix.normalize(
    posix.join(parentArchivePath === "." ? "" : parentArchivePath, normalizedLinkTarget),
  );
  if (
    !resolvedArchiveTarget ||
    resolvedArchiveTarget === "." ||
    resolvedArchiveTarget === ".." ||
    resolvedArchiveTarget.startsWith("../")
  ) {
    throw new Error(`[remote-assets] unsafe tar symlink target: ${rawLinkTarget}`);
  }
  return normalizedLinkTarget;
}

export function normalizeExtractSymlinkTarget({
  rawLinkTarget,
  targetPath,
  targetRoot,
}: {
  rawLinkTarget: string;
  targetPath: string;
  targetRoot: string;
}): string {
  const normalizedLinkTarget = normalizeSymlinkLinkName(rawLinkTarget);
  const resolvedTarget = resolve(dirname(targetPath), ...normalizedLinkTarget.split("/"));
  const relativePath = relative(targetRoot, resolvedTarget);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[remote-assets] unsafe tar symlink target: ${rawLinkTarget}`);
  }
  return normalizedLinkTarget;
}

function normalizeSymlinkLinkName(rawLinkTarget: string): string {
  const normalized = posix.normalize(rawLinkTarget);
  // tar symlink 如果允许绝对路径、Windows drive 或反斜杠，解包后可能把本地缓存指向目标目录外。
  // 这里只保留 POSIX 相对 link target，并在创建/解包两侧继续校验它解析后的落点。
  if (
    !rawLinkTarget ||
    !normalized ||
    normalized === "." ||
    normalized.includes("\\") ||
    isAbsolute(normalized) ||
    posix.isAbsolute(normalized) ||
    /^[a-zA-Z]:/u.test(normalized)
  ) {
    throw new Error(`[remote-assets] unsafe tar symlink target: ${rawLinkTarget}`);
  }
  return normalized;
}

export function ensureTrailingSlash(entryPath: string): string {
  return entryPath.endsWith("/") ? entryPath : `${entryPath}/`;
}

export function resolvePathWithinBase(baseDir: string, entryPath: string): string {
  const targetPath = resolve(baseDir, ...entryPath.split("/"));
  assertPathInsideBase(baseDir, targetPath, entryPath);
  return targetPath;
}

function assertPathInsideBase(baseDir: string, targetPath: string, sourceLabel: string): void {
  const relativePath = relative(baseDir, targetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[remote-assets] unsafe tar entry path: ${sourceLabel}`);
  }
}
