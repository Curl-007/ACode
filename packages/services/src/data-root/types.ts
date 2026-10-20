/**
 * 数据根归属文件契约与四态判定类型。
 * spec: packages/services/specs/data-root-ownership.md（对照上游 ZCodium 417c961 #19 裁剪版）。
 *
 * 归属文件 {dataRoot}/.acode-root.json 是数据根合法性的唯一依据：
 * - 存在、可解析、product 匹配、schemaVersion 支持 → normal；
 * - 目录不存在或为空 → absent；
 * - 无归属文件但含 ACode 数据特征（v2/setting.json 或 v2/）→ unowned-adopt（存量用户零改动接管）；
 * - 无归属文件且无 ACode 特征的非空目录 → unowned-foreign（备份让路）；
 * - 不可解析 / product 不匹配 / schemaVersion 过新 → corrupt（备份让路，禁止静默复用）。
 */

/** 数据根目录名；paths.getACodeDataRootDir 与本模块共用此单一常量，禁止另拼字面量。 */
export const ACODE_DATA_ROOT_DIR_NAME = ".acode";

/** 归属文件名；放数据根目录（不放 v2/），清除所有数据（删 v2）不会重置归属。 */
export const DATA_ROOT_MANIFEST_FILE_NAME = ".acode-root.json";

/** 归属文件 schema 版本；读到更高版本按 corrupt 处理（禁止降级读取）。 */
export const DATA_ROOT_MANIFEST_SCHEMA_VERSION = 1;

/** 归属文件产品标识。 */
export const DATA_ROOT_PRODUCT_ID = "acode";

/** adoption 仅由 unowned-adopt 分支写入，人工/其它入口不得伪造。 */
export type DataRootManifestCreatedBy = "desktop" | "cli" | "server" | "adoption";

/** user-migration：设置页用户决策迁移；conflict-backup：初始化器对冲突目录备份让路。 */
export type DataRootMigrationKind = "user-migration" | "conflict-backup";

export interface DataRootMigrationRecord {
  at: string;
  /** 迁移源 base 绝对路径（仅诊断用）。 */
  from?: string;
  /** 迁移目标 base 绝对路径（仅诊断用）。 */
  to?: string;
  kind: DataRootMigrationKind;
  /** kind=conflict-backup 时的让路落点，供用户手动恢复。 */
  backupPath?: string;
}

export interface DataRootManifest {
  product: string;
  schemaVersion: number;
  createdBy: DataRootManifestCreatedBy;
  createdAt: string;
  /** 追加式迁移记录；无迁移时为空数组。 */
  migrations: DataRootMigrationRecord[];
  /** unowned-adopt 接管时命中的 ACode 数据特征标记（如 "v2/setting.json"）。 */
  adoptedFrom?: string;
}

export type DataRootStatus =
  | { kind: "normal"; manifest: DataRootManifest }
  | { kind: "absent" }
  | { kind: "unowned-adopt"; marker: string; rootDir: string }
  | { kind: "unowned-foreign"; rootDir: string }
  | {
      kind: "corrupt";
      reason: "manifest-unreadable" | "product-mismatch" | "schema-unsupported";
      rootDir: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 可选字符串字段：undefined=缺席放行；null=存在但非法（调用方整体判 corrupt）。 */
function parseOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const raw = value[key];
  if (raw === undefined) return undefined;
  return isNonEmptyString(raw) ? raw : null;
}

function parseMigrationRecord(value: unknown): DataRootMigrationRecord | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value["at"])) return null;
  const kind = value["kind"];
  if (kind !== "user-migration" && kind !== "conflict-backup") return null;
  const from = parseOptionalString(value, "from");
  const to = parseOptionalString(value, "to");
  const backupPath = parseOptionalString(value, "backupPath");
  if (from === null || to === null || backupPath === null) return null;
  return {
    at: value["at"],
    kind,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}

/**
 * 解析并校验归属文件内容（纯函数，无 IO）。
 * 返回 null 表示不可解析 / 字段非法（调用方按 corrupt 处理）。
 */
export function parseDataRootManifest(raw: string): DataRootManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (!isNonEmptyString(parsed["product"])) return null;
  const schemaVersion = parsed["schemaVersion"];
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) return null;
  const createdBy = parsed["createdBy"];
  if (
    createdBy !== "desktop" &&
    createdBy !== "cli" &&
    createdBy !== "server" &&
    createdBy !== "adoption"
  ) {
    return null;
  }
  if (!isNonEmptyString(parsed["createdAt"])) return null;
  const rawMigrations = parsed["migrations"];
  if (!Array.isArray(rawMigrations)) return null;
  const migrations: DataRootMigrationRecord[] = [];
  for (const entry of rawMigrations) {
    const record = parseMigrationRecord(entry);
    if (!record) return null;
    migrations.push(record);
  }
  const adoptedFrom = parseOptionalString(parsed, "adoptedFrom");
  if (adoptedFrom === null) return null;
  return {
    product: parsed["product"],
    schemaVersion,
    createdBy,
    createdAt: parsed["createdAt"],
    migrations,
    ...(adoptedFrom !== undefined ? { adoptedFrom } : {}),
  };
}
