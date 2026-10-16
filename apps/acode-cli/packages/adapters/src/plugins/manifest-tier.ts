import type { PluginConfig, PluginDiagnostic, PluginManifest } from "@acode/contracts";
import { ACODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@acode/contracts";

/**
 * 插件 manifest `tier` 字段与默认启停派生的单一来源
 * （specs/skill-seeding-registration.md R1）。
 *
 * tier 是包内自描述的默认启停声明，闭集 `always | default_false`，只对官方市场生效；
 * 缺省 = 现状行为（candidate.defaultEnabled || bootstrap 默认名单）。第三方/inline
 * manifest 里的 tier 一律忽略——第三方插件不得自我声明默认启用。
 *
 * contracts 的 PluginManifest 暂无 tier 类型位（禁触面），这里从 unknown 收窄读取；
 * 批 2 提升进 contracts 后本文件的解析收窄退役（spec 边界登记）。
 */

export const PLUGIN_MANIFEST_TIERS = ["always", "default_false"] as const;

export type PluginManifestTier = (typeof PLUGIN_MANIFEST_TIERS)[number];

export interface PluginDefaultEnabledDecision {
  defaultEnabled: boolean;
  /** tier 值非法时的 warning 诊断（不阻断加载，按缺省语义处理）。 */
  diagnostic?: PluginDiagnostic;
}

/** 从 manifest（unknown 收窄）解析 tier；非法值原样返回字符串供诊断。 */
export function parsePluginManifestTier(manifest: unknown): {
  invalidValue?: string;
  tier?: PluginManifestTier;
} {
  if (typeof manifest !== "object" || manifest === null) return {};
  const raw = (manifest as { tier?: unknown }).tier;
  if (raw === undefined) return {};
  if (typeof raw === "string" && (PLUGIN_MANIFEST_TIERS as readonly string[]).includes(raw)) {
    return { tier: raw as PluginManifestTier };
  }
  return { invalidValue: typeof raw === "string" ? raw : (JSON.stringify(raw) ?? String(raw)) };
}

/**
 * 默认启停派生（用户显式配置之外的唯一入口）：
 * 官方市场 + 合法 tier → tier 优先（包是事实源，压过 bootstrap 默认名单）；
 * 其余 → candidate.defaultEnabled || officialPluginsEnabledByDefault（现状语义）。
 */
export function resolvePluginDefaultEnabled(input: {
  candidateDefaultEnabled: boolean;
  manifest: PluginManifest;
  marketplace: string;
  manifestPath: string;
  officialPluginsEnabledByDefault?: ReadonlySet<string>;
  pluginId: string;
}): PluginDefaultEnabledDecision {
  const fallback =
    input.candidateDefaultEnabled ||
    (input.officialPluginsEnabledByDefault?.has(input.pluginId) ?? false);
  if (input.marketplace !== ACODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    return { defaultEnabled: fallback };
  }
  const parsed = parsePluginManifestTier(input.manifest);
  if (parsed.tier) {
    return { defaultEnabled: parsed.tier === "always" };
  }
  if (parsed.invalidValue === undefined) {
    return { defaultEnabled: fallback };
  }
  return {
    defaultEnabled: fallback,
    diagnostic: {
      code: "plugin_manifest_invalid",
      message: `Invalid plugin manifest tier: ${parsed.invalidValue} (expected one of: ${PLUGIN_MANIFEST_TIERS.join(", ")})`,
      path: input.manifestPath,
      pluginId: input.pluginId,
      severity: "warning",
    },
  };
}

/** 用户显式配置永远最高：`enabledPlugins[id] ?? defaultEnabled`（自 index.ts 下沉，语义不变）。 */
export function resolveEnabled(config: PluginConfig, id: string, defaultEnabled: boolean): boolean {
  return config.enabledPlugins[id] ?? defaultEnabled;
}
