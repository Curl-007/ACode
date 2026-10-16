// 解包信任档策略矩阵 · 会话面（单一解包引擎的逐条目检查序与落盘计划）。
//
// 引擎不绑定归档格式：zip（yauzl，adapters 侧）与 tar（services 侧自研读取器）
// 各自保留解码器，逐条目策略判定统一走 ArchiveExtractionSession；落盘纪律
// （wx 独占写、exec 位 chmod、目录先建）由消费点按 plan 输出执行。
// 检查序（顺序即上游语义）与档位矩阵见 archiveTrustTiers.ts。
// 规格：packages/services/specs/file-containment-trust-tiers.md R4。
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { isUnsafeWindowsPathSegment } from "./fileContainmentLexical.js";
import {
  ARCHIVE_GLOBAL_LIMITS,
  ARCHIVE_TRUST_POLICIES,
  ArchivePolicyViolationError,
  isOsMetadataArchiveEntry,
  normalizeArchiveEntryNameForCollision,
  type ArchivePolicyViolationReason,
  type ArchiveTrustPolicy,
  type ArchiveTrustTier,
} from "./archiveTrustTiers.js";

/** 严格段级词法校验（比遏制层 findRelativePathEscapeReason 更严：拒空段与 "." 段）。 */
function findStrictEntryPathViolation(entryName: string, windowsRules: boolean): string | null {
  if (typeof entryName !== "string" || entryName.length === 0) return "empty_name";
  if (entryName.includes("\0")) return "nul_byte";
  // 归档条目名中反斜杠只可能是分隔符伪装或 Windows 陷阱名，一律拒绝（既有消费点语义）。
  if (entryName.includes("\\")) return "backslash";
  const withoutTrailingSlash = entryName.replace(/\/+$/u, "");
  if (withoutTrailingSlash.length === 0) return "empty_name";
  if (isAbsolute(entryName) || posix.isAbsolute(entryName)) return "absolute";
  if (/^[A-Za-z]:/u.test(entryName)) return "drive_prefix";
  for (const part of withoutTrailingSlash.split("/")) {
    if (!part || part === "." || part === "..") return "unsafe_segment";
    if (windowsRules && isUnsafeWindowsPathSegment(part)) return "windows_unsafe_segment";
  }
  return null;
}

export interface ArchiveEntryDescriptor {
  /** 归档内原始条目名（目录条目允许尾斜杠）。 */
  name: string;
  uncompressedSize: number;
  compressedSize: number;
  isDirectory: boolean;
  /** 归档携带的 unix mode（zip externalFileAttributes 高 16 位 / tar mode）；可选。 */
  unixMode?: number;
}

export interface ArchiveExtractionSessionLimits {
  /** 解压总量上限（消费点既有常量语义经此传入；undefined 表示不设总量闸）。 */
  maxTotalUncompressedBytes?: number;
  maxFileCount?: number;
  maxFileSizeBytes?: number;
  maxCompressionRatio?: number;
  maxPathLength?: number;
  maxFileNameLength?: number;
}

export interface ArchiveFileEntryPlan {
  action: "file";
  /** 去尾斜杠后的原始条目名（同名重复条目按后者替换前者）。 */
  name: string;
  /** 落盘绝对路径（已做结构 containment）。 */
  targetPath: string;
  /** 归档 mode 带 owner-exec：消费点在非 win32 平台写盘后 chmod 0o700。 */
  restoreOwnerExecutable: boolean;
  unixMode: number | undefined;
}

export interface ArchiveDirectoryEntryPlan {
  action: "directory";
  name: string;
  targetPath: string;
}

export interface ArchiveSkipEntryPlan {
  action: "skip";
  name: string;
}

export type ArchiveEntryPlan =
  | ArchiveFileEntryPlan
  | ArchiveDirectoryEntryPlan
  | ArchiveSkipEntryPlan;

export interface ArchiveExtractionSessionOptions {
  tier: ArchiveTrustTier;
  /** 解包锚根（必须是消费点 freshly 创建的私有目录；引擎在其内做结构 containment）。 */
  rootDir: string;
  /** 归档压缩体积（聚合比率分母；未知则聚合比率闸不生效）。 */
  compressedSizeBytes?: number;
  limits?: ArchiveExtractionSessionLimits;
  /** Windows 段级规则开关，默认跟随 process.platform（测试可显式覆盖）。 */
  windowsRules?: boolean;
}

/**
 * 逐条目解包会话：单一事实源执行 12 步检查序，增量维护碰撞/冲突登记，输出落盘
 * 计划。一个归档一个会话实例，不复用。同名重复条目按上游 Map 语义后者替换前者
 * （配额照计、保留首插入顺序）；不同原始名归一化碰撞 → name_collision 拒绝。
 */
export class ArchiveExtractionSession {
  readonly tier: ArchiveTrustTier;
  readonly policy: ArchiveTrustPolicy;
  private readonly rootDir: string;
  private readonly compressedSizeBytes: number | undefined;
  private readonly maxTotalUncompressedBytes: number | undefined;
  private readonly maxFileCount: number;
  private readonly maxFileSizeBytes: number;
  private readonly maxCompressionRatio: number;
  private readonly maxPathLength: number;
  private readonly maxFileNameLength: number;
  private readonly windowsRules: boolean;
  private countedEntries = 0;
  private totalUncompressedBytes = 0;
  /** 归一化碰撞键 → 首次登记的原始条目名。 */
  private readonly collisionKeys = new Map<string, string>();
  /** 已登记为目录的目标绝对路径（含文件条目的祖先展开）。 */
  private readonly directoryTargets = new Set<string>();
  /** 已登记为文件的目标绝对路径（文件/目录冲突检测用）。 */
  private readonly fileTargets = new Set<string>();
  private readonly filePlans = new Map<string, ArchiveFileEntryPlan>();
  private readonly directoryPlans = new Map<string, ArchiveDirectoryEntryPlan>();

  constructor(options: ArchiveExtractionSessionOptions) {
    this.tier = options.tier;
    this.policy = ARCHIVE_TRUST_POLICIES[options.tier];
    this.rootDir = resolve(options.rootDir);
    this.compressedSizeBytes = options.compressedSizeBytes;
    this.maxTotalUncompressedBytes = options.limits?.maxTotalUncompressedBytes;
    this.maxFileCount = options.limits?.maxFileCount ?? ARCHIVE_GLOBAL_LIMITS.maxFileCount;
    this.maxFileSizeBytes = options.limits?.maxFileSizeBytes ?? ARCHIVE_GLOBAL_LIMITS.maxFileSizeBytes;
    this.maxCompressionRatio =
      options.limits?.maxCompressionRatio ?? ARCHIVE_GLOBAL_LIMITS.maxCompressionRatio;
    this.maxPathLength = options.limits?.maxPathLength ?? ARCHIVE_GLOBAL_LIMITS.maxPathLength;
    this.maxFileNameLength =
      options.limits?.maxFileNameLength ?? ARCHIVE_GLOBAL_LIMITS.maxFileNameLength;
    this.windowsRules = options.windowsRules ?? process.platform === "win32";
  }

  get countedEntryCount(): number {
    return this.countedEntries;
  }

  get totalPlannedUncompressedBytes(): number {
    return this.totalUncompressedBytes;
  }

  /** 计划内文件条目（去重后，按首见顺序）。 */
  get plannedFiles(): readonly ArchiveFileEntryPlan[] {
    return [...this.filePlans.values()];
  }

  /** 计划内显式目录条目（消费点通常按文件 dirname 递归 mkdir，此集合用于预建/审计）。 */
  get plannedDirectories(): readonly ArchiveDirectoryEntryPlan[] {
    return [...this.directoryPlans.values()];
  }

  planEntry(entry: ArchiveEntryDescriptor): ArchiveEntryPlan {
    const name = entry.name;
    // 1. 垃圾条目跳过：不计配额、不进碰撞登记（skip 先于一切检查）。
    if (this.policy.skipOsMetadata && isOsMetadataArchiveEntry(name)) {
      return { action: "skip", name };
    }
    this.countedEntries += 1;
    // 2. 条目数上限。
    if (this.countedEntries > this.maxFileCount) {
      throw this.violation(
        "too_many_files",
        `archive contains too many entries: ${this.countedEntries} (max ${this.maxFileCount})`,
        name,
      );
    }
    // 3. 严格段级词法安全。
    if (this.policy.lexicalPathSafety) {
      const violation = findStrictEntryPathViolation(name, this.windowsRules);
      if (violation !== null) {
        throw this.violation(
          "unsafe_path",
          `archive entry path rejected (${violation}): ${JSON.stringify(name)}`,
          name,
        );
      }
    }
    const withoutTrailingSlash = name.replace(/\/+$/u, "");
    const declaredSize = entry.isDirectory ? 0 : entry.uncompressedSize;
    // 4. 单文件上限。
    if (this.policy.perFileSizeCap && declaredSize > this.maxFileSizeBytes) {
      throw this.violation(
        "file_too_large",
        `archive entry exceeds the single file limit: ${JSON.stringify(name)} (${declaredSize} bytes, max ${this.maxFileSizeBytes})`,
        name,
      );
    }
    // 5. 聚合总量。
    this.totalUncompressedBytes += declaredSize;
    if (
      this.maxTotalUncompressedBytes !== undefined &&
      this.totalUncompressedBytes > this.maxTotalUncompressedBytes
    ) {
      throw this.violation(
        "total_too_large",
        `archive total uncompressed size exceeds the limit: ${this.totalUncompressedBytes}/${this.maxTotalUncompressedBytes} bytes`,
        name,
      );
    }
    // 6. 聚合压缩比（zip bomb 早拒：按 manifest 尺寸判，先于任何数据解压）。
    if (
      this.policy.aggregateRatioCap &&
      this.compressedSizeBytes !== undefined &&
      this.compressedSizeBytes > 0 &&
      this.totalUncompressedBytes / this.compressedSizeBytes > this.maxCompressionRatio
    ) {
      throw this.violation(
        "aggregate_ratio",
        `suspicious aggregate compression ratio: ${(this.totalUncompressedBytes / this.compressedSizeBytes).toFixed(1)}:1 (max ${this.maxCompressionRatio}:1), possible archive bomb`,
        name,
      );
    }
    // 7. 条目长度上限。
    if (this.policy.entryLengthCaps) {
      if (name.length > this.maxPathLength) {
        throw this.violation(
          "entry_too_long",
          `archive entry path too long: ${name.length} characters (max ${this.maxPathLength})`,
          name,
        );
      }
      const baseName = posix.basename(withoutTrailingSlash);
      if (baseName.length > this.maxFileNameLength) {
        throw this.violation(
          "filename_too_long",
          `archive entry filename too long: ${baseName.length} characters (max ${this.maxFileNameLength})`,
          name,
        );
      }
    }
    const lowerName = withoutTrailingSlash.toLowerCase();
    // 8. 嵌套归档禁令（目录条目豁免；上游仅 .zip，此处为有意超集：tar 面同样能嵌套）。
    if (
      this.policy.nestedArchiveBan &&
      !entry.isDirectory &&
      (lowerName.endsWith(".zip") ||
        lowerName.endsWith(".tar") ||
        lowerName.endsWith(".tgz") ||
        lowerName.endsWith(".tar.gz"))
    ) {
      throw this.violation(
        "nested_archive",
        `nested archives are not allowed in this trust tier: ${JSON.stringify(name)}`,
        name,
      );
    }
    // 9. 逐条目压缩比。
    if (
      this.policy.perEntryRatioCap &&
      !entry.isDirectory &&
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > this.maxCompressionRatio
    ) {
      throw this.violation(
        "entry_ratio",
        `suspicious compression ratio for entry ${JSON.stringify(name)}: ${Math.round(entry.uncompressedSize / entry.compressedSize)}:1 (max ${this.maxCompressionRatio}:1)`,
        name,
      );
    }
    // 10. 结构 containment：目标必须严格位于锚根内；解析到根自身时目录忽略、文件拒。
    const targetPath = resolve(this.rootDir, ...withoutTrailingSlash.split("/"));
    const relativeToRoot = relative(this.rootDir, targetPath);
    if (
      relativeToRoot === "" ||
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(`..${sep}`) ||
      relativeToRoot.startsWith("../") ||
      isAbsolute(relativeToRoot)
    ) {
      if (entry.isDirectory && relativeToRoot === "") {
        return { action: "skip", name };
      }
      throw this.violation(
        "root_escape",
        `archive entry escapes the extraction root: ${JSON.stringify(name)}`,
        name,
      );
    }
    // 12. Windows 归一化碰撞预检（平台无关；含 ":" 直接拒——NTFS ADS 面）。
    if (name.includes(":")) {
      throw this.violation(
        "name_collision",
        `archive entry name contains ':': ${JSON.stringify(name)}`,
        name,
      );
    }
    const collisionKey = normalizeArchiveEntryNameForCollision(name);
    const previousName = this.collisionKeys.get(collisionKey);
    const isExactDuplicate = previousName === name;
    if (previousName !== undefined && !isExactDuplicate) {
      throw this.violation(
        "name_collision",
        `archive entries collide after filesystem name normalization: ${JSON.stringify(previousName)} vs ${JSON.stringify(name)}`,
        name,
      );
    }
    // 11. 文件/目录冲突（含祖先展开：任一祖先已被登记为文件即冲突）。
    const ancestorPaths: string[] = [];
    let ancestor = resolve(targetPath, "..");
    while (ancestor !== this.rootDir && ancestor !== resolve(ancestor, "..")) {
      ancestorPaths.push(ancestor);
      ancestor = resolve(ancestor, "..");
    }
    const ancestorIsFile = ancestorPaths.some((path) => this.fileTargets.has(path));
    if (entry.isDirectory) {
      if (this.fileTargets.has(targetPath) || ancestorIsFile) {
        throw this.violation(
          "file_dir_conflict",
          `archive entry is both a file and a directory: ${JSON.stringify(name)}`,
          name,
        );
      }
      this.directoryTargets.add(targetPath);
      for (const path of ancestorPaths) this.directoryTargets.add(path);
      if (!isExactDuplicate) this.collisionKeys.set(collisionKey, name);
      const plan: ArchiveDirectoryEntryPlan = { action: "directory", name, targetPath };
      this.directoryPlans.set(name, plan);
      return plan;
    }
    if (this.directoryTargets.has(targetPath) || ancestorIsFile) {
      throw this.violation(
        "file_dir_conflict",
        `archive entry is both a file and a directory: ${JSON.stringify(name)}`,
        name,
      );
    }
    if (!isExactDuplicate) this.collisionKeys.set(collisionKey, name);
    this.fileTargets.add(targetPath);
    for (const path of ancestorPaths) this.directoryTargets.add(path);
    const plan: ArchiveFileEntryPlan = {
      action: "file",
      name: withoutTrailingSlash,
      targetPath,
      restoreOwnerExecutable: ((entry.unixMode ?? 0) & 0o100) !== 0,
      unixMode: entry.unixMode,
    };
    // 同名重复条目：Map.set 替换值、保留首插入顺序（上游 Map 去重语义，后者生效）。
    this.filePlans.set(name, plan);
    return plan;
  }

  private violation(
    reason: ArchivePolicyViolationReason,
    message: string,
    entryName: string,
  ): ArchivePolicyViolationError {
    return new ArchivePolicyViolationError(reason, message, entryName);
  }
}
