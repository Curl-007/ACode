// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。本地缓存文件系统层（就绪标记、
// 关键路径完整性、目录物化、原子提交重试、内容哈希）是纯 fs 逻辑，独立成叶。
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
} from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileExists } from "@acode/server/remote/deployShared.js";
import { normalizeRemoteAssetRelativePath } from "@acode/server/remote/remoteAssetCdn.js";
import {
  READY_MARKER_CANDIDATES,
  REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS,
} from "@acode/server/remote/remoteAssetCacheTypes.js";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isReadyReleaseDirForRequestedPaths(
  releaseDir: string,
  platformArch: string,
  requiredReleasePaths: readonly string[],
): Promise<boolean> {
  if (!(await isReadyReleaseDir(releaseDir, platformArch))) {
    return false;
  }

  return (await findMissingLocalRelativePaths(releaseDir, requiredReleasePaths)).length === 0;
}

export async function isReadyComponentDirForRequiredPaths(
  componentDir: string,
  requiredRelativePaths: readonly string[],
): Promise<boolean> {
  const missingPaths = await findMissingReadyComponentPaths(componentDir, requiredRelativePaths);
  return missingPaths?.length === 0;
}

export async function findMissingReadyComponentPaths(
  componentDir: string,
  requiredRelativePaths: readonly string[],
): Promise<string[] | null> {
  if (!(await isReadyComponentDir(componentDir))) {
    return null;
  }

  return findMissingLocalRelativePaths(componentDir, requiredRelativePaths);
}

export async function findMissingLocalRelativePaths(
  baseDir: string,
  requiredRelativePaths: readonly string[],
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const requiredRelativePath of requiredRelativePaths) {
    const absolutePath = resolvePathWithinBase(
      baseDir,
      requiredRelativePath,
      "required cache path",
    );
    if (!(await pathExists(absolutePath))) {
      missingPaths.push(absolutePath);
    }
  }
  return missingPaths;
}

export function resolvePathWithinBase(baseDir: string, relativePath: string, label: string): string {
  const normalizedRelativePath = normalizeRemoteAssetRelativePath(relativePath, label);
  const targetPath = resolve(baseDir, ...normalizedRelativePath.split("/"));
  const normalizedBaseDir = resolve(baseDir);
  if (targetPath !== normalizedBaseDir && !targetPath.startsWith(`${normalizedBaseDir}${sep}`)) {
    throw new Error(`[remote-assets] ${label} escapes base dir: ${relativePath}`);
  }
  return targetPath;
}

export async function materializeDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (READY_MARKER_CANDIDATES.includes(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`[remote-assets] symlink is not allowed in component cache: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await materializeDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await linkOrCopyFile(sourcePath, targetPath);
      continue;
    }

    throw new Error(`[remote-assets] unsupported component entry type: ${sourcePath}`);
  }
}

async function linkOrCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await link(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!shouldFallbackToCopy(error)) {
      throw error;
    }
  }
  await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
}

function shouldFallbackToCopy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EXDEV" || code === "EPERM" || code === "EACCES" || code === "EMLINK";
}

export async function commitStagingDirectoryAtomically(
  stagingDir: string,
  targetDir: string,
): Promise<void> {
  await mkdir(dirname(targetDir), { recursive: true });

  const targetExists = await pathExists(targetDir);
  const backupDir = targetExists ? `${targetDir}.backup-${process.pid}-${randomUUID()}` : null;

  if (backupDir) {
    await renameRemoteAssetDirectoryWithRetry(targetDir, backupDir);
  }

  try {
    await renameRemoteAssetDirectoryWithRetry(stagingDir, targetDir);
  } catch (error) {
    if (backupDir) {
      try {
        await renameRemoteAssetDirectoryWithRetry(backupDir, targetDir);
      } catch (restoreError) {
        throw new Error(
          `[remote-assets] failed to commit staged directory and failed to restore backup: ` +
            `commit=${String(error)}, restore=${String(restoreError)}`,
        );
      }
    }
    throw error;
  }

  if (backupDir) {
    await removeRemoteAssetDirectoryBestEffort(backupDir);
  }
}

async function removeRemoteAssetDirectoryBestEffort(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryDelayMs = REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableRemoteAssetDirectoryCommitError(error)) {
        return;
      }
      await sleep(retryDelayMs);
    }
  }
}

async function renameRemoteAssetDirectoryWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retryDelayMs = REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableRemoteAssetDirectoryCommitError(error)) {
        throw error;
      }

      // Windows 上 AppData remote-assets-cache 目录 rename 可能被 Defender、索引器
      // 或另一个刚退出的 host 进程短暂占用，表现为 EPERM/EBUSY/EACCES/ENOTEMPTY。
      // 提权不能释放这些文件句柄，因此这里对目录提交做有限退避重试，避免缓存已下载完成却连接 WSL 失败。
      await sleep(retryDelayMs);
    }
  }
}

function isRetryableRemoteAssetDirectoryCommitError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

export async function assertExtractedArchiveNotEmpty(
  extractRoot: string,
  errorMessage: string,
): Promise<void> {
  const entries = await readdir(extractRoot, { withFileTypes: true });
  if (entries.length === 0) {
    throw new Error(errorMessage);
  }
}

export async function isReadyReleaseDir(releaseDir: string, platformArch: string): Promise<boolean> {
  if (!(await isValidReleaseDir(releaseDir, platformArch))) {
    return false;
  }

  return hasReadyMarker(releaseDir);
}

export async function isValidReleaseDir(releaseDir: string, platformArch: string): Promise<boolean> {
  try {
    const dirStat = await stat(releaseDir);
    if (!dirStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  if (!(await fileExists(releaseDir, "server", "acode-server.cjs"))) {
    return false;
  }

  // 分平台归档落地后，继续硬编码校验 linux 目录会把 darwin 包误判为无效。
  // 这里改成按目标 platformArch 校验 node runtime，确保 cache 判断与下载策略一致。
  if (!(await fileExists(releaseDir, "node", platformArch, "node"))) {
    return false;
  }

  return true;
}

export async function isReadyComponentDir(componentDir: string): Promise<boolean> {
  try {
    const dirStat = await stat(componentDir);
    if (!dirStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  return hasReadyMarker(componentDir);
}

async function hasReadyMarker(baseDir: string): Promise<boolean> {
  for (const readyMarker of READY_MARKER_CANDIDATES) {
    if (await fileExists(baseDir, readyMarker)) {
      return true;
    }
  }
  return false;
}

export async function writeReadyMarker(baseDir: string, markerFileName: string): Promise<void> {
  await writeFile(join(baseDir, markerFileName), `${Date.now()}\n`, "utf8");
}

export async function readCachedRemoteAssetMarker(cacheDir: string): Promise<string | null> {
  for (const readyMarker of READY_MARKER_CANDIDATES) {
    const markerPath = join(cacheDir, readyMarker);
    try {
      return await readFile(markerPath, "utf8");
    } catch {
      // continue
    }
  }
  return null;
}

export function resolveFallbackRemoteAssetCacheDir(): string {
  return join(tmpdir(), "acode-remote-assets-cache");
}

export async function isDirectoryPath(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    return pathStat.isDirectory();
  } catch {
    return false;
  }
}

export async function computePathContentSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const pathStat = await stat(path);

  if (pathStat.isDirectory()) {
    hash.update("root:dir\n");
    await hashDirectoryContent(hash, path);
  } else if (pathStat.isFile()) {
    hash.update("root:file\n");
    await hashFileContent(hash, path, "root-file");
  } else {
    throw new Error(`unsupported path type: ${path}`);
  }

  return hash.digest("hex");
}

async function hashDirectoryContent(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativeDir = "",
): Promise<void> {
  const entries = (await readdir(rootDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    const entryRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const dirStat = await stat(entryPath);
      hash.update(`dir:${entryRelativePath}:${dirStat.mode & 0o777}\n`);
      await hashDirectoryContent(hash, entryPath, entryRelativePath);
      continue;
    }
    if (entry.isFile()) {
      await hashFileContent(hash, entryPath, entryRelativePath);
      continue;
    }

    throw new Error(`unsupported entry type: ${entryPath}`);
  }
}

async function hashFileContent(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  relativePath: string,
): Promise<void> {
  const fileStat = await stat(filePath);
  hash.update(`file:${relativePath}:${fileStat.mode & 0o777}:${fileStat.size}\n`);
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
