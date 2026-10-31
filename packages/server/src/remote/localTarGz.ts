// 拆分说明：tar 二进制格式编解码已移到 localTarGzFormat.ts、条目路径与 symlink 安全规范化
// 已移到 localTarGzPaths.ts（满足 400 行架构上限）；本文件保留 extract/create 的归档流程编排。
import { gzip, gunzip } from "node:zlib";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import {
  TAR_BLOCK_SIZE,
  TAR_END_BLOCK_BYTES,
  createTarHeader,
  isZeroBlock,
  parseTarOctal,
  readTarEntryPath,
  readTarString,
  readTarTypeFlag,
  roundUpToTarBlock,
} from "./localTarGzFormat.js";
import {
  ensureTrailingSlash,
  normalizeCreateEntryPath,
  normalizeCreateSymlinkTarget,
  normalizeExtractEntryPath,
  normalizeExtractSymlinkTarget,
  resolvePathWithinBase,
} from "./localTarGzPaths.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface LocalTarGzEntry {
  sourcePath: string;
  archivePath: string;
}

// Windows 客户端不一定能 spawn System32\tar.exe，远端资源本地缓存不能依赖系统 tar。
// 这里仅支持 ACode remote assets 使用的普通文件/目录子集，避免扩大归档格式的行为面。
export async function extractTarGzArchive(archivePath: string, targetDir: string): Promise<void> {
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });

  const archiveBuffer = await gunzipAsync(await readFile(archivePath));
  let offset = 0;
  let nextEntryName: string | null = null;

  while (offset + TAR_BLOCK_SIZE <= archiveBuffer.length) {
    const header = archiveBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;

    if (isZeroBlock(header)) {
      break;
    }

    const size = parseTarOctal(header, 124, 12);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (dataEnd > archiveBuffer.length) {
      throw new Error(`[remote-assets] truncated tar entry in ${archivePath}`);
    }

    const data = archiveBuffer.subarray(dataStart, dataEnd);
    offset = dataStart + roundUpToTarBlock(size);

    const typeFlag = readTarTypeFlag(header);
    if (typeFlag === "L") {
      nextEntryName = readTarString(data, 0, data.length);
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g") {
      continue;
    }

    const rawEntryName = nextEntryName ?? readTarEntryPath(header);
    nextEntryName = null;
    const safeEntryPath = normalizeExtractEntryPath(rawEntryName);
    if (!safeEntryPath) {
      continue;
    }

    const targetPath = resolvePathWithinBase(targetRoot, safeEntryPath);
    const mode = parseTarOctal(header, 100, 8);

    if (typeFlag === "5") {
      await mkdir(targetPath, { recursive: true });
      await applyMode(targetPath, mode);
      continue;
    }

    if (typeFlag === "0" || typeFlag === "\0") {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, data);
      await applyMode(targetPath, mode);
      continue;
    }

    if (typeFlag === "2") {
      const linkTarget = normalizeExtractSymlinkTarget({
        rawLinkTarget: readTarString(header, 157, 100),
        targetPath,
        targetRoot,
      });
      await mkdir(dirname(targetPath), { recursive: true });
      await unlinkIfExists(targetPath);
      await symlink(linkTarget, targetPath);
      continue;
    }

    throw new Error(
      `[remote-assets] unsupported tar entry type ${JSON.stringify(typeFlag)} for ${rawEntryName}`,
    );
  }
}

export async function createTarGzArchive(
  archivePath: string,
  entries: readonly LocalTarGzEntry[],
): Promise<void> {
  const archiveParts: Buffer[] = [];
  for (const entry of entries) {
    await appendTarEntry(archiveParts, entry.sourcePath, entry.archivePath);
  }
  archiveParts.push(Buffer.alloc(TAR_END_BLOCK_BYTES));

  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, await gzipAsync(Buffer.concat(archiveParts)));
}

async function appendTarEntry(
  archiveParts: Buffer[],
  sourcePath: string,
  archivePath: string,
): Promise<void> {
  const sourceStat = await lstat(sourcePath);
  const normalizedArchivePath = normalizeCreateEntryPath(archivePath);

  if (sourceStat.isDirectory()) {
    const directoryEntryPath = ensureTrailingSlash(normalizedArchivePath);
    archiveParts.push(
      createTarHeader({
        entryPath: directoryEntryPath,
        // Windows lstat 的目录 mode 只有读写语义，常见为 0666；原样写进 tar 后，
        // 远端 tar 叠加 umask 会落成不可遍历的 0644。远端资源目录统一使用 POSIX 0755。
        mode: 0o755,
        mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
        size: 0,
        typeFlag: "5",
      }),
    );

    const children = (await readdir(sourcePath, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const child of children) {
      await appendTarEntry(
        archiveParts,
        join(sourcePath, child.name),
        posix.join(normalizedArchivePath, child.name),
      );
    }
    return;
  }

  if (!sourceStat.isFile()) {
    if (sourceStat.isSymbolicLink()) {
      const linkTarget = normalizeCreateSymlinkTarget({
        archivePath: normalizedArchivePath,
        rawLinkTarget: await readlink(sourcePath),
      });
      archiveParts.push(
        createTarHeader({
          entryPath: normalizedArchivePath,
          linkName: linkTarget,
          mode: 0o777,
          mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
          size: 0,
          typeFlag: "2",
        }),
      );
      return;
    }

    throw new Error(`[remote-assets] unsupported local archive source: ${sourcePath}`);
  }

  const content = await readFile(sourcePath);
  archiveParts.push(
    createTarHeader({
      entryPath: normalizedArchivePath,
      mode: sourceStat.mode,
      mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
      size: content.length,
      typeFlag: "0",
    }),
    content,
    Buffer.alloc(roundUpToTarBlock(content.length) - content.length),
  );
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function applyMode(filePath: string, mode: number): Promise<void> {
  if (!mode) {
    return;
  }
  try {
    await chmod(filePath, mode & 0o777);
  } catch {
    // 权限位在 Windows 或受限文件系统上可能不可写，远端部署会按 executable 参数重新 chmod。
  }
}
