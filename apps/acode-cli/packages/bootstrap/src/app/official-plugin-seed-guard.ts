/**
 * 官方插件 seed 的入口守卫与清单解析（specs/skill-seeding-registration.md R2/R3）。
 *
 * 从 bundled-plugins.ts（legacy 超限文件，只减不增）下沉的两块纯逻辑：
 * - seed 拒绝判定：required 路径缺失（既有语义，错误码不变）与条目预算超限
 *   （本波新增，防 seed 源失控膨胀；filesystem 与 SEA 两种源同点把关）。
 * - plugin.json 商店文案解析：description（EN 基线）+ description_i18n（包内事实源，
 *   writeOfficialMarketplace 里覆盖 definitions listing seed 的同名字段）。
 *
 * 本文件不依赖 bundled-plugins.ts 的类型（结构化入参），避免循环导入。
 */

/** 单插件 seed 文件条目上限；对齐外部范式 maxEntries=2000（spec R2，调整需登记）。 */
export const MAX_OFFICIAL_PLUGIN_SEED_ENTRIES = 2000;

export const OFFICIAL_PLUGIN_SEED_TOO_LARGE_CODE = "ACODE_PLUGIN_SEED_TOO_LARGE";
export const OFFICIAL_PLUGIN_SEED_INCOMPLETE_CODE = "ACODE_PLUGIN_SEED_INCOMPLETE";

export interface OfficialPluginSeedRejection {
  error: NodeJS.ErrnoException;
  missingSeedPaths?: readonly string[];
}

/**
 * seed 前的拒绝判定：先查 required 路径缺失（更具体，保持既有错误码与消息），
 * 再查条目预算。返回 undefined 表示放行。两种失败都走既有降级协议
 * （warn + failedSeeds 回退旧缓存），不得静默丢插件。
 */
export function findOfficialPluginSeedRejection(input: {
  fileCount: number;
  missingSeedPaths: readonly string[];
  pluginName: string;
}): OfficialPluginSeedRejection | undefined {
  if (input.missingSeedPaths.length > 0) {
    return {
      error: Object.assign(
        new Error(
          `Bundled official plugin ${input.pluginName} is missing required seed assets: ${input.missingSeedPaths.join(", ")}`,
        ),
        { code: OFFICIAL_PLUGIN_SEED_INCOMPLETE_CODE },
      ),
      missingSeedPaths: input.missingSeedPaths,
    };
  }
  if (input.fileCount > MAX_OFFICIAL_PLUGIN_SEED_ENTRIES) {
    return {
      error: Object.assign(
        new Error(
          `Bundled official plugin ${input.pluginName} exceeds the seed entry budget: ${input.fileCount}/${MAX_OFFICIAL_PLUGIN_SEED_ENTRIES}`,
        ),
        { code: OFFICIAL_PLUGIN_SEED_TOO_LARGE_CODE },
      ),
    };
  }
  return undefined;
}

export interface SeedPluginListing {
  description?: string;
  descriptionI18n?: Record<string, string>;
}

/**
 * 解析 plugin.json 的商店文案字段；解析失败按空降级（与既有 readSeedPluginDescription
 * 的容错一致）。description_i18n 只收非空字符串值，空表按未声明处理。
 */
export function parseSeedPluginListing(rawManifest: string | undefined): SeedPluginListing {
  if (rawManifest === undefined) return {};
  try {
    const parsed = JSON.parse(rawManifest) as {
      description?: unknown;
      description_i18n?: unknown;
    };
    const listing: SeedPluginListing = {};
    if (typeof parsed.description === "string" && parsed.description.trim().length > 0) {
      listing.description = parsed.description;
    }
    if (isStringRecord(parsed.description_i18n)) {
      const i18n: Record<string, string> = {};
      for (const [locale, text] of Object.entries(parsed.description_i18n)) {
        if (typeof text === "string" && text.trim().length > 0) i18n[locale] = text;
      }
      if (Object.keys(i18n).length > 0) listing.descriptionI18n = i18n;
    }
    return listing;
  } catch {
    return {};
  }
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
