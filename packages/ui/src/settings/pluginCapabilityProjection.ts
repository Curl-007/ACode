import {
  resolveManagedPluginDisplay,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import type { SkillSummary, ACodeCommand } from "@acode/shared";
import { type V4InstalledPluginSummary, type V4PluginInfo, type V4PluginScope } from "@acode/shared/acode-protocol-v4";
import { compareDocumentPluginPriority, isPluginCommand, isUserCommand } from "@acode/shared";
import { pluginSearchMatches } from "@/settings/pluginSearch.js";

function canonicalPluginName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function selectBuiltInPlugins(
  plugins: readonly V4PluginInfo[],
  installedPlugins: readonly V4InstalledPluginSummary[],
): V4PluginInfo[] {
  const installedIds = new Set(installedPlugins.map((plugin) => plugin.id));
  return plugins.filter((plugin) => plugin.source === "official" && !installedIds.has(plugin.id));
}

interface PluginSettingsGroups {
  installed: V4PluginInfo[];
  builtIn: V4PluginInfo[];
}

/**
 * 设置页只展示已物化的插件；Agent 为保留目标 Host 配置而返回的 missing 投影不能
 * 进入 Installed / Built-in，否则会出现“已安装分组 + 未安装状态”的矛盾行。
 */
export function partitionPluginsForSettings(
  plugins: readonly V4PluginInfo[],
  builtInPluginIds: ReadonlySet<string>,
): PluginSettingsGroups {
  const materializedPlugins = plugins.filter((plugin) => plugin.packageStatus !== "missing");
  return {
    installed: materializedPlugins.filter((plugin) => !builtInPluginIds.has(plugin.id)),
    builtIn: materializedPlugins
      .filter((plugin) => builtInPluginIds.has(plugin.id))
      .toSorted((left, right) => compareDocumentPluginPriority(left.id, right.id)),
  };
}

export function filterPluginsByQuery(
  plugins: readonly V4PluginInfo[],
  query: string,
  itemsById?: ReadonlyMap<string, StorePluginItem>,
  locale = "en-US",
): V4PluginInfo[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...plugins];
  return plugins.filter((plugin) => {
    const candidate = itemsById?.get(plugin.id);
    const item = candidate?.id === plugin.id ? candidate : undefined;
    const display = resolveManagedPluginDisplay(plugin, item, locale);
    return pluginSearchMatches(
      normalizedQuery,
      [plugin.name, plugin.id, plugin.marketplace, display.name, display.description],
      [
        plugin.name,
        item?.listing?.displayName,
        ...Object.values(item?.listing?.displayNameI18n ?? {}),
      ],
    );
  });
}

export function selectPluginsForScope(
  plugins: readonly V4PluginInfo[],
  _installedPlugins: readonly V4InstalledPluginSummary[],
  _scope: V4PluginScope,
): V4PluginInfo[] {
  // User / Workspace 已经由 plugins/list(configScope) 返回各自的配置投影。
  // 这里不能再按 enabledSource/rootSource 做“归属”过滤，否则 Workspace 会丢掉继承 User
  // 的 Host inventory，User 也会被当前 Workspace override 污染后的来源字段误删。
  return [...plugins];
}

export function selectSkillsForScope(
  skills: readonly SkillSummary[],
  scopedPlugins: readonly Pick<V4PluginInfo, "id" | "name" | "enabled">[],
  scope: V4PluginScope,
): SkillSummary[] {
  const enabledPlugins = scopedPlugins.filter((plugin) => plugin.enabled);
  const scopedPluginIds = new Set(enabledPlugins.map((plugin) => plugin.id));
  const scopedPluginIdsByName = new Map<string, string[]>();
  for (const plugin of enabledPlugins) {
    const name = canonicalPluginName(plugin.name);
    scopedPluginIdsByName.set(name, [...(scopedPluginIdsByName.get(name) ?? []), plugin.id]);
  }
  return skills.filter((skill) => {
    if (skill.scope !== "plugin") {
      // bundled 是全局只读资源，不属于任一 scope：跨 user/workspace 两 tab 展示，
      // 不受 scopeFilter 过滤（与 plugin 分支同型的全局资源待遇，spec I5.3）。
      if (skill.scope === "bundled") {
        return true;
      }
      return skill.scope === scope;
    }
    if (skill.pluginId) return scopedPluginIds.has(skill.pluginId);
    const matchingIds = skill.pluginName
      ? scopedPluginIdsByName.get(canonicalPluginName(skill.pluginName))
      : undefined;
    // 旧协议没有 pluginId 时，仅在名称唯一的兼容场景下回退，避免跨 marketplace 合并。
    return matchingIds?.length === 1;
  });
}

export function selectCommandsForScope(
  commands: readonly ACodeCommand[],
  scopedPlugins: readonly Pick<V4PluginInfo, "id" | "name" | "enabled">[],
  scope: V4PluginScope,
): ACodeCommand[] {
  const enabledPlugins = scopedPlugins.filter((plugin) => plugin.enabled);
  const scopedPluginIds = new Set(enabledPlugins.map((plugin) => plugin.id));
  const scopedPluginIdsByName = new Map<string, string[]>();
  for (const plugin of enabledPlugins) {
    const name = canonicalPluginName(plugin.name);
    scopedPluginIdsByName.set(name, [...(scopedPluginIdsByName.get(name) ?? []), plugin.id]);
  }
  return commands.filter((command) => {
    if (isUserCommand(command)) {
      return command.location.scope === (scope === "user" ? "user" : "project");
    }
    if (!isPluginCommand(command)) return false;
    const marketplace = command.pluginMarketplace?.trim() ?? "";
    const pluginId = `${command.pluginName.trim()}@${marketplace}`;
    if (marketplace) return scopedPluginIds.has(pluginId);
    const matchingIds = scopedPluginIdsByName.get(canonicalPluginName(command.pluginName));
    return matchingIds?.length === 1;
  });
}

interface SkillSourceGroup {
  id: string;
  label: string;
  pluginId?: string;
  skills: SkillSummary[];
  source: "direct" | "plugin" | "bundled";
}

export function groupScopedSkillsBySource(
  skills: readonly SkillSummary[],
  directLabel: string,
  bundledLabel: string,
): SkillSourceGroup[] {
  const direct: SkillSummary[] = [];
  const bundled: SkillSummary[] = [];
  const pluginGroups = new Map<string, SkillSourceGroup>();
  for (const skill of skills) {
    if (skill.scope !== "plugin") {
      // bundled 独立成组（「内置技能」），不进 direct：否则会与用户自建技能混在
      // 「已安装」组，既混淆只读语义，也会让 bundled 掩盖「没有技能」空态（spec I5.2）。
      if (skill.scope === "bundled") {
        bundled.push(skill);
      } else {
        direct.push(skill);
      }
      continue;
    }
    const pluginName = skill.pluginName?.trim();
    if (!pluginName) continue;
    const pluginId = skill.pluginId?.trim();
    const id = pluginId || canonicalPluginName(pluginName);
    const group = pluginGroups.get(id) ?? {
      id: `plugin:${id}`,
      label: pluginName,
      ...(pluginId ? { pluginId } : {}),
      skills: [],
      source: "plugin" as const,
    };
    group.skills.push(skill);
    pluginGroups.set(id, group);
  }
  return [
    ...(direct.length > 0
      ? [
          {
            id: "direct",
            label: directLabel,
            skills: direct,
            source: "direct" as const,
          },
        ]
      : []),
    // bundled 组固定排在 direct 之后、插件分区之前（spec I5.4 分组顺序）；
    // 组内保持传入顺序（调用方的 skills 已按 name 排序，与 direct 组同约定）。
    ...(bundled.length > 0
      ? [
          {
            id: "bundled",
            label: bundledLabel,
            skills: bundled,
            source: "bundled" as const,
          },
        ]
      : []),
    ...Array.from(pluginGroups.values()).sort((left, right) =>
      left.label.localeCompare(right.label),
    ),
  ];
}
