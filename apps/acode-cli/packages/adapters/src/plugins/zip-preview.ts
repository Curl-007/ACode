// 预览不解包（价值提取第二轮 T1-m3 增量层）：商店列表只需要 manifest.json 与其
// icon 指向的档内条目，全量解包会把 zip bomb 面扩大到"只看一眼"的路径上。
// 本模块只读取这两个条目（各自 ≤1MB），icon 为远程 URL 时置 null（绝不发网络
// 请求）；其余条目一律不解包、不落盘。条目名仍过 store 档会话的词法/配额/碰撞
// 检查（防 ../manifest 或 ":" ADS 形 icon 名把读取改道）。
// 规格：apps/acode-cli/specs/file-containment-trust-tiers.md R2。
import * as yauzl from "yauzl";
import { ArchiveExtractionSession } from "@acode/shared/node";
import {
  classifyZipEntry,
  openZipFileFromBuffer,
  readZipEntryBuffer,
} from "./zip-trust-extract.js";

export const ZIP_PREVIEW_MANIFEST_MAX_BYTES = 1024 * 1024;
export const ZIP_PREVIEW_ICON_MAX_BYTES = 1024 * 1024;

export interface ZipPluginArchivePreview {
  /** manifest.json 条目字节；档内无 manifest 或超上限时为 null（尽力而为面）。 */
  manifestBytes: Uint8Array | null;
  /** icon 条目字节；icon 缺失/远程 URL/目录/超上限时为 null。 */
  iconBytes: Uint8Array | null;
}

interface PlannedPreviewEntry {
  entry: yauzl.Entry;
  uncompressedSize: number;
}

/**
 * 从内存 zip 字节读取预览（manifest + icon）。策略违规（词法/碰撞/配额）抛
 * ArchivePolicyViolationError（fail-closed）；manifest JSON 解析失败按无 icon 处理。
 */
export async function readZipPluginArchivePreview(
  archiveBytes: Uint8Array,
): Promise<ZipPluginArchivePreview> {
  const bytes = Buffer.from(archiveBytes);
  // 预览不落盘：rootDir 仅参与会话的纯词法 containment 计算，不发生任何文件访问。
  const session = new ArchiveExtractionSession({
    compressedSizeBytes: bytes.byteLength,
    rootDir: ".",
    tier: "store",
  });
  const zipFile = await openZipFileFromBuffer(bytes);
  try {
    const plannedFiles = new Map<string, PlannedPreviewEntry>();
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
        try {
          const classified = classifyZipEntry(entry);
          const plan = session.planEntry({
            compressedSize: entry.compressedSize,
            isDirectory: classified.kind === "directory",
            name: entry.fileName,
            uncompressedSize: entry.uncompressedSize,
            unixMode: classified.unixMode,
          });
          // 同名重复条目按后者替换前者（与解包面同一去重语义）。
          if (plan.action === "file") {
            plannedFiles.set(plan.name, { entry, uncompressedSize: entry.uncompressedSize });
          }
          zipFile.readEntry();
        } catch (error) {
          rejectOnce(error);
        }
      });
      zipFile.readEntry();
    });

    const manifestCandidate = plannedFiles.get("manifest.json");
    if (
      manifestCandidate === undefined ||
      manifestCandidate.uncompressedSize > ZIP_PREVIEW_MANIFEST_MAX_BYTES
    ) {
      return { iconBytes: null, manifestBytes: null };
    }
    const manifestBytes = await readZipEntryBuffer(zipFile, manifestCandidate.entry);
    const iconBytes = await readPreviewIconBytes(zipFile, plannedFiles, manifestBytes);
    return { iconBytes, manifestBytes };
  } finally {
    zipFile.close();
  }
}

async function readPreviewIconBytes(
  zipFile: yauzl.ZipFile,
  plannedFiles: Map<string, PlannedPreviewEntry>,
  manifestBytes: Buffer,
): Promise<Uint8Array | null> {
  const iconPath = parseManifestIconPath(manifestBytes);
  if (iconPath === null) return null;
  const iconCandidate = plannedFiles.get(iconPath);
  if (iconCandidate === undefined) return null;
  if (
    iconCandidate.entry.fileName.endsWith("/") ||
    iconCandidate.uncompressedSize > ZIP_PREVIEW_ICON_MAX_BYTES
  ) {
    return null;
  }
  return await readZipEntryBuffer(zipFile, iconCandidate.entry);
}

/** icon 必须是档内相对路径字符串；远程 URL（http 前缀）与解析失败一律返回 null。 */
function parseManifestIconPath(manifestBytes: Buffer): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as { icon?: unknown };
    if (typeof parsed.icon !== "string") return null;
    if (parsed.icon.startsWith("http")) return null;
    return parsed.icon;
  } catch {
    return null;
  }
}
