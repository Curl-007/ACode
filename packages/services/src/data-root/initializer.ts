/**
 * 数据根初始化器：四态判定（normal/absent/unowned-adopt/unowned-foreign+corrupt）的唯一入口。
 * spec: packages/services/specs/data-root-ownership.md（对照上游 ZCodium 417c961 #19 裁剪版：
 * 无决策窗口/pending/诊断根重定向，四态全部可非交互处置）。
 *
 * IO 形态：同步 fs——消费点是 desktop main 模块加载期（app ready 之前），
 * 必须同步完成才能保证 setDataBaseDir 生效前数据根已判定（启动早期例外，
 * 与 desktopDataBaseDirBootstrap 的 readFileSync 同款豁免）。
 * 运行期的迁移记录入口（recordUserMigrationInDataRoot）为异步。
 */
import { chmodSync, mkdirSync } from "node:fs";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getDataBaseDir } from "../paths.js";
import {
  appendDataRootMigrationRecord,
  forfeitConflictingDataRoot,
  readDataRootStatus,
  resolveDataRootDir,
  writeDataRootManifestIntoRoot,
} from "./ownership.js";
import {
  DATA_ROOT_MANIFEST_SCHEMA_VERSION,
  DATA_ROOT_PRODUCT_ID,
  type DataRootManifest,
  type DataRootManifestCreatedBy,
  type DataRootMigrationRecord,
} from "./types.js";

const log = createServiceLogger("data-root");

/**
 * POSIX 数据根目录权限：数据根含凭据类文件，仅当前用户可访问。
 * Windows 无 POSIX 权限位，mkdir/chmod 的 mode 参数被忽略，访问控制由
 * NTFS ACL（父目录继承）管理——因此权限收紧仅在非 win32 平台执行。
 */
const DATA_ROOT_DIR_MODE = 0o700;

export interface InitializeDataRootInput {
  /** 目标 base（数据根 = {base}/.acode）；缺省 getDataBaseDir()。 */
  baseDir?: string;
  /** absent / 备份让路分支的归属创建者身份；adopt 分支固定 "adoption"。 */
  createdBy: DataRootManifestCreatedBy;
}

export type DataRootInitResult =
  | { state: "ready"; baseDir: string; rootDir: string }
  | { state: "initialized"; baseDir: string; rootDir: string; backupPath?: string }
  | { state: "adopted"; baseDir: string; rootDir: string; marker: string };

function buildManifest(input: {
  createdBy: DataRootManifestCreatedBy;
  migrations?: DataRootMigrationRecord[];
  adoptedFrom?: string;
}): DataRootManifest {
  return {
    product: DATA_ROOT_PRODUCT_ID,
    schemaVersion: DATA_ROOT_MANIFEST_SCHEMA_VERSION,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    migrations: input.migrations ?? [],
    ...(input.adoptedFrom ? { adoptedFrom: input.adoptedFrom } : {}),
  };
}

/** 全新创建数据根目录并收紧权限（仅 absent / 备份让路分支；adopt 不得改动既有目录）。 */
function createFreshRootDir(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true, mode: DATA_ROOT_DIR_MODE });
  if (process.platform !== "win32") {
    // mkdir 的 mode 会被 umask 削减（如 umask 022 → 0700 仍成立，但 0o777 类默认会被放宽），
    // 显式 chmod 兜底保证 0700；Windows 无 POSIX 权限位，跳过（见 DATA_ROOT_DIR_MODE 注释）。
    try {
      chmodSync(rootDir, DATA_ROOT_DIR_MODE);
    } catch {
      // 文件系统不支持 chmod 时不阻断启动。
    }
  }
}

/**
 * 四态判定 + 处置（消费方在 setDataBaseDir 之前调用，保证判定前正式根零写入）：
 * - normal → ready（零写入放行）；
 * - absent → 创建目录（POSIX 0700）+ 写归属文件；
 * - unowned-adopt → 接管存量 ACode 数据：只补写归属文件（createdBy:"adoption"），
 *   数据零改动——老用户升级路径，绝不允许把存量数据备份让路；
 * - unowned-foreign / corrupt → 整体备份让路（rename，不删除不合并）+ 全新初始化，
 *   新归属文件 migrations 记录 backupPath，warn 日志一次。
 */
export function initializeDataRoot(input: InitializeDataRootInput): DataRootInitResult {
  const baseDir = input.baseDir ?? getDataBaseDir();
  const rootDir = resolveDataRootDir(baseDir);
  const status = readDataRootStatus(baseDir);

  if (status.kind === "normal") {
    return { state: "ready", baseDir, rootDir };
  }

  if (status.kind === "absent") {
    createFreshRootDir(rootDir);
    writeDataRootManifestIntoRoot(rootDir, buildManifest({ createdBy: input.createdBy }));
    return { state: "initialized", baseDir, rootDir };
  }

  if (status.kind === "unowned-adopt") {
    writeDataRootManifestIntoRoot(
      rootDir,
      buildManifest({ createdBy: "adoption", adoptedFrom: status.marker }),
    );
    log.info(undefined, `数据根接管（无归属文件但含 ACode 数据特征 ${status.marker}）: ${rootDir}`);
    return { state: "adopted", baseDir, rootDir, marker: status.marker };
  }

  // unowned-foreign / corrupt：备份让路 + 全新初始化。
  const backupPath = forfeitConflictingDataRoot(baseDir);
  const reason = status.kind === "corrupt" ? `corrupt/${status.reason}` : "unowned-foreign";
  log.warn(undefined, `数据根冲突（${reason}），已整体备份让路到 ${backupPath} 并重新初始化`);
  createFreshRootDir(rootDir);
  const record: DataRootMigrationRecord = {
    at: new Date().toISOString(),
    kind: "conflict-backup",
    backupPath,
  };
  writeDataRootManifestIntoRoot(
    rootDir,
    buildManifest({ createdBy: input.createdBy, migrations: [record] }),
  );
  return { state: "initialized", baseDir, rootDir, backupPath };
}

/**
 * settingService.updateDataBaseDir 成功迁移后调用：在目标根归属文件追加
 * kind:"user-migration" 记录；目标根尚无合法归属（首次迁移 / 旧版本布局）时
 * 直接补写完整归属文件，迁移记录作为首条。
 *
 * best-effort：失败只在 data-root scope 记 warn，不向调用方抛出——此时数据已复制
 * 完成，归属缺失时下次启动会被 adopt 判定接管，不应让登记失败反过来让迁移失败。
 */
export async function recordUserMigrationInDataRoot(input: {
  targetBaseDir: string;
  fromBaseDir: string;
}): Promise<void> {
  const record: DataRootMigrationRecord = {
    at: new Date().toISOString(),
    from: input.fromBaseDir,
    to: input.targetBaseDir,
    kind: "user-migration",
  };
  try {
    const status = readDataRootStatus(input.targetBaseDir);
    if (status.kind === "normal") {
      await appendDataRootMigrationRecord(input.targetBaseDir, record);
      return;
    }
    writeDataRootManifestIntoRoot(
      resolveDataRootDir(input.targetBaseDir),
      buildManifest({ createdBy: "desktop", migrations: [record] }),
    );
  } catch (error) {
    log.warn(
      undefined,
      `迁移记录写入目标根归属文件失败（不影响迁移结果）: ${input.targetBaseDir}`,
      error,
    );
  }
}
