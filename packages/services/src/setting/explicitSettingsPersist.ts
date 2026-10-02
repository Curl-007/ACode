import type { AppSettings } from "@acode/shared";

/**
 * J1-4 配置持久化全量覆盖审计的修复辅助（spec：apps/acode-cli/specs/config-persistence-audit.md）。
 *
 * jcode 事故教训（Config::save() 全量序列化把旧默认值冻结进 168 个用户配置文件，
 * 之后翻转默认值也救不回来）：普通偏好保存不再把 schema 默认值物化后的整份对象写回，
 * 只保留「磁盘已有键 ∪ 本次显式设置键 ∪ 迁移标记键」。用户从未显式设置过的键保持缺席，
 * 后续读取仍随 schema 默认值演进，翻转默认值对新装用户和未固化的老键都能生效。
 */

// 迁移标记键必须始终随普通保存落盘：shouldPersistSettingsMigrations 以「raw 文件里标记 !== true」
// 判定一次性迁移是否收敛。若「只写显式键」模式省略标记，get() 每次都会重新触发迁移写，永不收敛。
export const MIGRATION_MARKER_KEYS: readonly string[] = [
  "closeToTrayOnWindows",
  "closeToTrayOnWindowsMigrationInitialized",
  "messageStreamShowReasoning",
  "messageStreamShowReasoningMigrationInitialized",
];

/**
 * 计算「只写显式键」模式下应落盘的设置对象（不含 rollbackFields，由调用方合并）。
 *
 * 键在归一化 patch 里但值为 undefined（清空语义，见 normalizeSettingsPatch）时，
 * 不会出现在 schema parse 产物中；跳过写入即等价于从磁盘删除该键，
 * 与旧全量写 + JSON.stringify 丢弃 undefined 的行为一致。
 */
export function buildExplicitKeyPersistedSettings(
  settings: AppSettings,
  raw: Record<string, unknown>,
  explicitKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const persisted: Record<string, unknown> = {};
  const settingsRecord = settings as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(raw), ...explicitKeys, ...MIGRATION_MARKER_KEYS])) {
    if (key in settingsRecord) persisted[key] = settingsRecord[key];
  }
  return persisted;
}
