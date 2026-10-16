// 解包信任档策略矩阵 · 档位与常量面（价值提取第二轮 T1-m3 落地件）。
//
// 信任档（bundled/store/local/uploaded）× 能力旗标的冻结策略对象、全局默认上限、
// OS 垃圾条目表、Windows 归一化碰撞键、违规错误类。逐条目检查序与落盘计划在
// archiveExtractionSession.ts（单一解包引擎的会话面）。
// 规格：packages/services/specs/file-containment-trust-tiers.md R3/R4。
import { posix } from "node:path";

export const ARCHIVE_TRUST_TIERS = ["bundled", "store", "local", "uploaded"] as const;

export type ArchiveTrustTier = (typeof ARCHIVE_TRUST_TIERS)[number];

export interface ArchiveTrustPolicy {
  /** 严格段级词法安全（拒空段/./../反斜杠/盘符/NUL；win32 叠加设备名等段规则）。 */
  readonly lexicalPathSafety: boolean;
  /** 单文件未压缩体积上限。 */
  readonly perFileSizeCap: boolean;
  /** 聚合压缩比上限（总量/归档压缩体积，zip bomb 早拒）。 */
  readonly aggregateRatioCap: boolean;
  /** 逐条目压缩比上限。 */
  readonly perEntryRatioCap: boolean;
  /** 嵌套归档禁令（zip/tar/tgz/tar.gz）。 */
  readonly nestedArchiveBan: boolean;
  /** 条目路径长/文件名长上限。 */
  readonly entryLengthCaps: boolean;
  /** 跳过 OS 垃圾条目（.DS_Store、__MACOSX、"._" 前缀、Thumbs.db、desktop.ini、含 CR 名）。 */
  readonly skipOsMetadata: boolean;
}

/** 全局默认上限（冻结）；消费点可传更窄 override，不得放宽。 */
export const ARCHIVE_GLOBAL_LIMITS = Object.freeze({
  maxFileSizeBytes: 512 * 1024 * 1024,
  maxFileCount: 100_000,
  maxCompressionRatio: 50,
  maxPathLength: 1024,
  maxFileNameLength: 255,
});

/**
 * 冻结策略矩阵。档位语义：bundled=随安装包分发；store=市场/商店远程下载；
 * local=同一用户自有设备间同步；uploaded=第三方上传（冻结备用）。
 * 与上游矩阵的有意差异（收紧不放松）：lexicalPathSafety 全档开启；uploaded 档
 * 比率/嵌套全开。
 * store 档不开比率闸：市场 zip 的真实形态（高压缩文本、弱随机负载）普遍超过
 * 50:1——既有回归归档实测聚合 209:1（apps/acode-cli/tests/plugin-zip-extract.
 * test.mjs），比率闸会误杀合法插件；炸弹损害由既有三重闸封顶（单文件 50MB +
 * 总量 500MB + 条目 2 万，全部先于数据读取按 manifest 声明判定）。
 * local 档不开比率上限（markdown/文本 gzip 压缩比常超 50:1 会误杀）、
 * 不开嵌套禁令（同步保真要求用户目录内合法 zip 资产可随档同步）。
 */
export const ARCHIVE_TRUST_POLICIES: Readonly<Record<ArchiveTrustTier, ArchiveTrustPolicy>> =
  Object.freeze({
    bundled: Object.freeze({
      lexicalPathSafety: true,
      perFileSizeCap: false,
      aggregateRatioCap: false,
      perEntryRatioCap: false,
      nestedArchiveBan: false,
      entryLengthCaps: false,
      skipOsMetadata: true,
    }),
    store: Object.freeze({
      lexicalPathSafety: true,
      perFileSizeCap: true,
      aggregateRatioCap: false,
      perEntryRatioCap: false,
      nestedArchiveBan: false,
      entryLengthCaps: true,
      skipOsMetadata: true,
    }),
    local: Object.freeze({
      lexicalPathSafety: true,
      perFileSizeCap: false,
      aggregateRatioCap: false,
      perEntryRatioCap: false,
      nestedArchiveBan: false,
      entryLengthCaps: true,
      skipOsMetadata: true,
    }),
    uploaded: Object.freeze({
      lexicalPathSafety: true,
      perFileSizeCap: true,
      aggregateRatioCap: true,
      perEntryRatioCap: true,
      nestedArchiveBan: true,
      entryLengthCaps: true,
      skipOsMetadata: true,
    }),
  });

/** owner-exec 条目写盘后恢复的固定权限位（仅 owner-exec 才 chmod 700）。 */
export const ARCHIVE_OWNER_EXECUTABLE_FILE_MODE = 0o700;

/** OS 垃圾条目判定（跨平台生效：垃圾条目在任何宿主上都不值得落盘）。 */
export function isOsMetadataArchiveEntry(entryName: string): boolean {
  const lower = entryName.toLowerCase();
  const base = posix.basename(lower);
  return (
    base === ".ds_store" ||
    base === ".localized" ||
    base === "__macosx" ||
    base.startsWith("._") ||
    base === "thumbs.db" ||
    base === "ehthumbs.db" ||
    base === "desktop.ini" ||
    lower.startsWith("__macosx/") ||
    // 含 CR 的条目名来自缺陷打包器（如 "icon\r"），在 POSIX 上可落盘成不可见陷阱名。
    lower.includes("\r")
  );
}

function trimTrailingCharsMatching(value: string, pattern: RegExp): string {
  let end = value.length;
  while (end > 0 && pattern.test(value[end - 1] as string)) {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Windows 归一化碰撞键（平台无关执行——归档跨平台互提）：反斜杠归一为斜杠、
 * posix.normalize、逐段剥尾点/尾空格（Windows 落盘时会被静默剥掉）、过滤空段、
 * 小写化（NTFS/FAT 大小写不敏感）。两个不同原始名归一到同一键即碰撞。
 */
export function normalizeArchiveEntryNameForCollision(entryName: string): string {
  return posix
    .normalize(entryName.replaceAll("\\", "/"))
    .split("/")
    .map((segment) => trimTrailingCharsMatching(segment, /[. ]/u))
    .filter(Boolean)
    .join("/")
    .toLowerCase();
}

export const ARCHIVE_POLICY_VIOLATION_REASONS = [
  "too_many_files",
  "unsafe_path",
  "file_too_large",
  "total_too_large",
  "aggregate_ratio",
  "entry_too_long",
  "filename_too_long",
  "nested_archive",
  "entry_ratio",
  "root_escape",
  "file_dir_conflict",
  "name_collision",
] as const;

export type ArchivePolicyViolationReason = (typeof ARCHIVE_POLICY_VIOLATION_REASONS)[number];

export class ArchivePolicyViolationError extends Error {
  readonly reason: ArchivePolicyViolationReason;
  readonly entryName: string;

  constructor(reason: ArchivePolicyViolationReason, message: string, entryName: string) {
    super(message);
    this.name = "ArchivePolicyViolationError";
    this.reason = reason;
    this.entryName = entryName;
  }
}
