// 市场 zip 解包 · store 信任档两阶段引擎（价值提取第二轮 T1-m3 落地件）。
//
// 为什么两阶段：碰撞预检/比率闸/配额必须在**任何写盘之前**对全量条目判定完成
// （先收集计划、后落盘），否则 zip bomb 与归一化碰撞会在拒绝生效前已写出半成品。
// 归档已整包驻留内存（下载面 200MB 上限），元数据预扫成本可忽略；yauzl fd 流式
// 读取路径有既有挂起缺陷（见 zip-source.ts 修复注释），因此两阶段都走内存句柄。
//
// 档位与能力旗标：ARCHIVE_TRUST_POLICIES.store（@acode/shared/node），既有上限
// 常量语义原样保留并作为会话 override：单文件 50MB / 条目 20 000 / 解压总量 500MB
// （比率闸 store 档刻意关闭，理由见 archiveTrustTiers.ts 矩阵注释与 spec R3）。
// 规格：apps/acode-cli/specs/file-containment-trust-tiers.md R1；
//       packages/services/specs/file-containment-trust-tiers.md R3/R4。
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as yauzl from "yauzl";
import {
  ARCHIVE_OWNER_EXECUTABLE_FILE_MODE,
  ArchiveExtractionSession,
  type ArchiveFileEntryPlan,
} from "@acode/shared/node";

export const ZIP_EXTRACT_MAX_BYTES = 500 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 20_000;
export const ZIP_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;

export type ZipEntryKind = "directory" | "file";

export interface ClassifiedZipEntry {
  kind: ZipEntryKind;
  /** zip externalFileAttributes 高 16 位的 unix mode；无则 0。 */
  unixMode: number;
}

/**
 * 条目类型闸门：加密条目、symlink 条目、未知类型条目一律拒绝。
 * 消息字面量被 github-archive-source.ts 的诊断分类正则引用，改动必须同步。
 */
export function classifyZipEntry(entry: yauzl.Entry): ClassifiedZipEntry {
  const isDirectoryByName = entry.fileName.endsWith("/");
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error(`Encrypted plugin zip entries are not supported: ${entry.fileName}`);
  }

  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) {
    throw new Error(`Plugin zip entry symlinks are not supported: ${entry.fileName}`);
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new Error(`Unsupported plugin zip entry type: ${entry.fileName}`);
  }
  if (fileType === 0o040000 || isDirectoryByName) {
    return { kind: "directory", unixMode };
  }
  return { kind: "file", unixMode };
}

export function openZipFileFromBuffer(bytes: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!zipFile) {
        rejectPromise(new Error("Failed to open plugin zip archive"));
        return;
      }
      resolvePromise(zipFile);
    });
  });
}

export function readZipEntryBuffer(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!stream) {
        rejectPromise(new Error(`Failed to read plugin zip entry: ${entry.fileName}`));
        return;
      }

      const chunks: Buffer[] = [];
      let bytesRead = 0;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        stream.destroy(new Error("Plugin operation cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.byteLength;
        if (bytesRead > ZIP_MAX_SINGLE_FILE_BYTES) {
          stream.destroy(
            new Error(`Plugin zip entry exceeds single file limit: ${entry.fileName}`),
          );
          return;
        }
        chunks.push(buffer);
      });
      stream.once("error", (streamError) => {
        cleanup();
        rejectPromise(streamError);
      });
      stream.once("end", () => {
        cleanup();
        resolvePromise(Buffer.concat(chunks));
      });
    });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Plugin operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}

/** lazyEntries 顺序遍历（内存句柄）；visitor 抛错即终止并关闭。 */
async function walkZipEntries(
  bytes: Buffer,
  visitor: (zipFile: yauzl.ZipFile, entry: yauzl.Entry) => Promise<void>,
): Promise<void> {
  const zipFile = await openZipFileFromBuffer(bytes);
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const rejectOnce = (error: unknown): void => {
        zipFile.close();
        rejectPromise(error);
      };
      zipFile.once("error", rejectOnce);
      zipFile.once("end", () => {
        zipFile.removeListener("error", rejectOnce);
        resolvePromise();
      });
      zipFile.on("entry", (entry) => {
        void (async () => {
          try {
            await visitor(zipFile, entry);
            zipFile.readEntry();
          } catch (error) {
            rejectOnce(error);
          }
        })();
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
}

export interface ZipTrustExtractResult {
  topLevelSegments: Set<string>;
}

/**
 * store 档两阶段解包：
 * 阶段一（元数据预扫）——classify 闸门 + 会话逐条目检查（垃圾跳过/配额/单文件/
 * 聚合与逐条目比率/长度/containment/归一化碰撞/文件目录冲突），产出按条目序号
 * 索引的落盘计划；同名重复条目按后者替换前者（旧序号作废，上游 Map 去重语义）。
 * 阶段二（落盘）——只读计划内条目：目录 mkdir；文件读流（运行时单文件与总量双闸
 * 保留）→ wx 独占写（EEXIST 归一为碰撞错误）→ owner-exec 条目非 win32 chmod 0o700。
 */
export async function extractZipArchiveTrustTiered(input: {
  archiveBytes: Uint8Array;
  signal?: AbortSignal;
  targetRoot: string;
}): Promise<ZipTrustExtractResult> {
  const targetRoot = resolve(input.targetRoot);
  await mkdir(targetRoot, { recursive: true });
  const bytes = Buffer.from(input.archiveBytes);
  const session = new ArchiveExtractionSession({
    compressedSizeBytes: bytes.byteLength,
    limits: {
      maxFileCount: ZIP_MAX_ENTRIES,
      maxFileSizeBytes: ZIP_MAX_SINGLE_FILE_BYTES,
      maxTotalUncompressedBytes: ZIP_EXTRACT_MAX_BYTES,
    },
    rootDir: targetRoot,
    tier: "store",
  });

  const topLevelSegments = new Set<string>();
  const fileActionsByOrdinal = new Map<number, ArchiveFileEntryPlan>();
  const directoryTargetsByOrdinal = new Map<number, string>();
  const lastFileOrdinalByName = new Map<string, number>();
  const lastDirectoryOrdinalByName = new Map<string, number>();

  // 阶段一：元数据预扫（不打开任何数据流、不写盘）。
  let scanOrdinal = 0;
  await walkZipEntries(bytes, async (_zipFile, entry) => {
    throwIfAborted(input.signal);
    scanOrdinal += 1;
    const classified = classifyZipEntry(entry);
    const plan = session.planEntry({
      compressedSize: entry.compressedSize,
      isDirectory: classified.kind === "directory",
      name: entry.fileName,
      uncompressedSize: entry.uncompressedSize,
      unixMode: classified.unixMode,
    });
    if (plan.action === "skip") return;
    // 顶层段只统计计划内条目：__MACOSX 等垃圾不再污染单根判定（spec R1）。
    topLevelSegments.add(plan.name.split("/")[0] ?? plan.name);
    if (plan.action === "directory") {
      const previousOrdinal = lastDirectoryOrdinalByName.get(plan.name);
      if (previousOrdinal !== undefined) directoryTargetsByOrdinal.delete(previousOrdinal);
      lastDirectoryOrdinalByName.set(plan.name, scanOrdinal);
      directoryTargetsByOrdinal.set(scanOrdinal, plan.targetPath);
      return;
    }
    const previousOrdinal = lastFileOrdinalByName.get(plan.name);
    if (previousOrdinal !== undefined) fileActionsByOrdinal.delete(previousOrdinal);
    lastFileOrdinalByName.set(plan.name, scanOrdinal);
    fileActionsByOrdinal.set(scanOrdinal, plan);
  });

  // 阶段二：按计划落盘。
  let writeOrdinal = 0;
  let extractedBytes = 0;
  await walkZipEntries(bytes, async (zipFile, entry) => {
    throwIfAborted(input.signal);
    writeOrdinal += 1;
    const directoryTarget = directoryTargetsByOrdinal.get(writeOrdinal);
    if (directoryTarget !== undefined) {
      await mkdir(directoryTarget, { recursive: true });
      return;
    }
    const filePlan = fileActionsByOrdinal.get(writeOrdinal);
    if (filePlan === undefined) return; // 垃圾条目与被替换的同名重复条目不落盘。
    const entryBytes = await readZipEntryBuffer(zipFile, entry, input.signal);
    extractedBytes += entryBytes.byteLength;
    if (extractedBytes > ZIP_EXTRACT_MAX_BYTES) {
      throw new Error(
        `Plugin zip extracted content exceeds limit: ${extractedBytes}/${ZIP_EXTRACT_MAX_BYTES}`,
      );
    }
    await mkdir(dirname(filePlan.targetPath), { recursive: true });
    try {
      // wx 独占写兜底：预检漏网的冲突（含落盘竞态）一律拒绝，绝不静默覆盖。
      await writeFile(filePlan.targetPath, entryBytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Plugin zip entry collides with another entry after filesystem name normalization: ${filePlan.name}`,
        );
      }
      throw error;
    }
    if (filePlan.restoreOwnerExecutable && process.platform !== "win32") {
      // 可执行位策略：仅归档 mode 带 owner-exec 才恢复，固定收敛为 0o700。
      await chmod(filePlan.targetPath, ARCHIVE_OWNER_EXECUTABLE_FILE_MODE);
    }
  });

  return { topLevelSegments };
}
