/**
 * 数据根归属文件（{dataRoot}/.acode-root.json）读写与冲突目录备份让路。
 * spec: packages/services/specs/data-root-ownership.md
 *
 * 分层规则：本文件是唯一允许直接读写归属文件的位置；其它模块（含 settingService）
 * 通过 initializer 暴露的接口获取状态与追加记录，不得自行解析归属文件。
 *
 * IO 形态：判定/写入/让路函数使用同步 fs——消费点是 desktop main 模块加载期
 * （app ready 之前，见 desktopDataBaseDirBootstrap 的 readFileSync 同款「启动早期例外」），
 * 必须同步完成才能保证 setDataBaseDir 生效前数据根已判定。
 * 运行期路径（迁移记录追加）使用异步 fs。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACODE_DATA_ROOT_DIR_NAME,
  DATA_ROOT_MANIFEST_FILE_NAME,
  DATA_ROOT_MANIFEST_SCHEMA_VERSION,
  DATA_ROOT_PRODUCT_ID,
  parseDataRootManifest,
  type DataRootManifest,
  type DataRootMigrationRecord,
  type DataRootStatus,
} from "./types.js";

/** 数据根目录绝对路径（{base}/.acode）。 */
export function resolveDataRootDir(baseDir: string): string {
  return join(baseDir, ACODE_DATA_ROOT_DIR_NAME);
}

function resolveManifestPath(rootDir: string): string {
  return join(rootDir, DATA_ROOT_MANIFEST_FILE_NAME);
}

/**
 * ACode 数据特征探测（unowned-adopt 判定依据）：v2/setting.json 或 v2/ 子目录。
 * 返回命中的标记（写入归属文件 adoptedFrom，供诊断）；未命中返回 null。
 */
function detectACodeDataMarker(rootDir: string): string | null {
  try {
    if (statSync(join(rootDir, "v2", "setting.json")).isFile()) {
      return "v2/setting.json";
    }
  } catch {
    // setting.json 不存在，继续探测 v2/ 目录。
  }
  try {
    if (statSync(join(rootDir, "v2")).isDirectory()) {
      return "v2/";
    }
  } catch {
    // 无 v2/ 子目录：不构成 ACode 数据特征。
  }
  return null;
}

/**
 * 判定 base 下数据根的合法性（四态，语义见 spec）。
 *
 * - normal：归属文件存在、可解析、product 匹配、schemaVersion 支持；
 * - absent：目录不存在，或存在但为空目录（视为首次运行）；
 * - unowned-adopt：无归属文件但命中 ACode 数据特征（存量用户，零改动接管）；
 * - unowned-foreign：无归属文件、无 ACode 特征的非空目录（他产品残留）；
 * - corrupt：归属文件不可解析、product 不匹配或 schemaVersion 过新（禁止降级读取）。
 */
export function readDataRootStatus(baseDir: string): DataRootStatus {
  const rootDir = resolveDataRootDir(baseDir);
  let entries: string[];
  try {
    const stat = statSync(rootDir);
    if (!stat.isDirectory()) {
      // .acode 位置被同名文件占用：不是本产品的目录布局，按冲突处理（rename 对文件同样生效）。
      return { kind: "unowned-foreign", rootDir };
    }
    entries = readdirSync(rootDir);
  } catch {
    return { kind: "absent" };
  }
  if (entries.length === 0) {
    return { kind: "absent" };
  }

  const manifestPath = resolveManifestPath(rootDir);
  if (!existsSync(manifestPath)) {
    const marker = detectACodeDataMarker(rootDir);
    if (marker) {
      return { kind: "unowned-adopt", marker, rootDir };
    }
    return { kind: "unowned-foreign", rootDir };
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return { kind: "corrupt", reason: "manifest-unreadable", rootDir };
  }
  const manifest = parseDataRootManifest(raw);
  if (!manifest) {
    return { kind: "corrupt", reason: "manifest-unreadable", rootDir };
  }
  if (manifest.schemaVersion > DATA_ROOT_MANIFEST_SCHEMA_VERSION) {
    return { kind: "corrupt", reason: "schema-unsupported", rootDir };
  }
  if (manifest.product !== DATA_ROOT_PRODUCT_ID) {
    return { kind: "corrupt", reason: "product-mismatch", rootDir };
  }
  return { kind: "normal", manifest };
}

/**
 * 原子写归属文件到指定数据根目录：同目录临时文件 + rename，失败不留半截 JSON。
 * 目录不存在时递归创建（不带 mode：新建目录的权限纪律由 initializer 的 absent 分支负责，
 * adopt 分支不得改动既有目录权限——数据零改动）。
 */
export function writeDataRootManifestIntoRoot(rootDir: string, manifest: DataRootManifest): string {
  mkdirSync(rootDir, { recursive: true });
  const manifestPath = resolveManifestPath(rootDir);
  const tmpPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmpPath, manifestPath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
  return manifestPath;
}

/** ISO 时间戳，冒号替换为 -：保留 ISO-8601 形态且 Windows 文件名安全（冒号非法）。 */
function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/:/gu, "-");
}

/**
 * unowned-foreign / corrupt 冲突目录整体备份让路：rename 为
 * {dataRoot}.backup-<ISO时间戳>（重名追加序号）。不删除、不合并、不读取内容，
 * 用户可按归属文件 migrations[].backupPath 手动恢复。返回备份落点。
 */
export function forfeitConflictingDataRoot(baseDir: string): string {
  const rootDir = resolveDataRootDir(baseDir);
  const stamp = formatBackupTimestamp(new Date());
  let target = `${rootDir}.backup-${stamp}`;
  let attempt = 1;
  while (existsSync(target)) {
    target = `${rootDir}.backup-${stamp}-${attempt}`;
    attempt += 1;
    if (attempt > 100) {
      throw new Error(`无法为冲突数据根生成唯一备份目录: ${rootDir}`);
    }
  }
  renameSync(rootDir, target);
  return target;
}

/**
 * 运行期（异步）在既有合法归属文件上追加迁移记录；归属文件缺失或非法时抛错，
 * 由调用方（recordUserMigrationInDataRoot）决定补写策略。
 */
export async function appendDataRootMigrationRecord(
  baseDir: string,
  record: DataRootMigrationRecord,
): Promise<DataRootManifest> {
  const rootDir = resolveDataRootDir(baseDir);
  const manifestPath = resolveManifestPath(rootDir);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    // 归属文件缺失/不可读：抛语义化错误，由调用方（recordUserMigrationInDataRoot）决定补写策略。
    throw new Error(`数据根归属文件缺失或非法，无法追加迁移记录: ${manifestPath}`);
  }
  const manifest = parseDataRootManifest(raw);
  if (
    !manifest ||
    manifest.product !== DATA_ROOT_PRODUCT_ID ||
    manifest.schemaVersion > DATA_ROOT_MANIFEST_SCHEMA_VERSION
  ) {
    throw new Error(`数据根归属文件缺失或非法，无法追加迁移记录: ${manifestPath}`);
  }
  const updated: DataRootManifest = { ...manifest, migrations: [...manifest.migrations, record] };
  const tmpPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await rename(tmpPath, manifestPath);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
  return updated;
}
