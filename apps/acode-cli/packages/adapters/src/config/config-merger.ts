// Config Merger - Merge configs by priority

import type {
  HookEventName,
  HookMatcherConfig,
  PluginOptionValues,
  RuntimeConfigPatch,
} from "@acode/contracts";
import { ConfigScope, ConfigScopePriority } from "@acode/contracts";

type PluginOptions = Record<string, PluginOptionValues>;

/**
 * Config source with priority info
 */
interface PrioritizedConfig {
  config: RuntimeConfigPatch;
  scope: ConfigScope;
  priority: number;
}

/**
 * Merge multiple configs by scope priority
 * Lower priority = applied first, higher priority = applied last (overwrites)
 */
export function mergeConfigs(...configs: PrioritizedConfig[]): RuntimeConfigPatch {
  // Sort by priority (ascending)
  const sorted = [...configs].sort((a, b) => a.priority - b.priority);

  const result: RuntimeConfigPatch = {};

  for (const { config: inputConfig, scope } of sorted) {
    const config =
      scope === ConfigScope.Project && inputConfig.plugins
        ? (() => {
            // Marketplace 是 Host User inventory 的目录配置，不属于 Workspace 项目配置。
            // 保留 schema 兼容旧文件，但不能让项目层字段进入 merged RuntimeConfig/catalog。
            const projectPlugins = { ...inputConfig.plugins };
            delete projectPlugins.extraKnownMarketplaces;
            return { ...inputConfig, plugins: projectPlugins };
          })()
        : inputConfig;
    const previousHooks = result.hooks;
    const previousPlugins = result.plugins;
    // 安全加固 P1-6 补漏：必须在 Object.assign 之前快照继承来的 disallowedTools。
    // Object.assign(result, config) 会把 result.permission 整体替换成项目层的对象，
    // 之后再读 result.permission.disallowedTools 拿到的已经是项目值，与项目值并集等于没并集。
    // 这个 bug 被回归测试抓到过两次（先是在展开后读、再是在 assign 后读）。
    const inheritedDisallowedTools =
      scope === ConfigScope.Project ? result.permission?.disallowedTools : undefined;
    Object.assign(result, config);

    // Deep merge nested objects
    if (config.modelStream) {
      result.modelStream = { ...result.modelStream, ...config.modelStream };
    }
    if (config.permission) {
      // 安全加固 P1-6 补漏（对抗评审核实）：`disallowedTools` 若走下面的展开是**整体替换**，
      // 而 ConfigScope.Project 优先级(20)高于 User(10)。于是仓库携带的 permission.disallowedTools
      // 会覆盖用户在 ~/.acode/cli/config.json 里的硬禁用集——例如用户禁了 Bash、仓库写
      // disallowedTools:["WebFetch"] 或 []，Bash 的硬禁用就被静默清空（从 permission/service.ts
      // 的 disallowedTools 硬拒降级为普通 build 模式审批）。这直接违反「项目配置只能收紧、
      // 不能放宽」：disallowedTools 是唯一被有意保留的项目 permission 字段，却恰好能用来放宽。
      //
      // 修法：Project 作用域下对 disallowedTools 做**并集**而非替换。合并按优先级升序进行，
      // 走到 Project 时 result 已含 System(0) 与 User(10)，故并集等价于「项目只能追加禁用项」。
      //
      // 注意 inheritedDisallowedTools 已在循环开头（Object.assign 之前）快照，见上。
      result.permission = { ...result.permission, ...config.permission };
      if (scope === ConfigScope.Project) {
        const incoming = config.permission.disallowedTools;
        if (inheritedDisallowedTools !== undefined || incoming !== undefined) {
          result.permission = {
            ...result.permission,
            disallowedTools: [
              ...new Set([...(inheritedDisallowedTools ?? []), ...(incoming ?? [])]),
            ],
          };
        }
      }
    }
    if (config.storage) {
      result.storage = { ...result.storage, ...config.storage };
    }
    if (config.network) {
      result.network = { ...result.network, ...config.network };
    }
    if (config.features) {
      result.features = { ...result.features, ...config.features };
    }
    if (config.memory) {
      result.memory = { ...result.memory, ...config.memory };
    }
    if (config.mcp) {
      result.mcp = {
        ...result.mcp,
        ...config.mcp,
        servers: {
          ...result.mcp?.servers,
          ...config.mcp.servers,
        },
      };
    }
    if (config.plugins) {
      // Workspace Plugin 配置和 User Plugin 配置共用同一个 RuntimeConfig，不能让后一个
      // `plugins` 对象整体覆盖前一个来源；否则 Workspace 只声明一个插件时会丢掉 User
      // 的其它启用项和 options。enabledPlugins 按 pluginId、options 按 pluginId/option key
      // 合并，dirs 保留两层候选根目录，最终 resolver 再做去重和路径校验。
      result.plugins = {
        // Object.assign 已先把 result.plugins 指向当前高优先级层。若这里只展开
        // result.plugins，Workspace 仅写 options 时会把 User 层 dirs 整体丢掉，导致下一次
        // configure 连插件本身都无法发现。必须显式从 previousPlugins 开始构造。
        ...previousPlugins,
        ...config.plugins,
        ...(config.plugins.dirs
          ? {
              dirs: [...new Set([...(previousPlugins?.dirs ?? []), ...config.plugins.dirs])],
            }
          : {}),
        ...(config.plugins.enabledPlugins
          ? {
              enabledPlugins: {
                ...previousPlugins?.enabledPlugins,
                ...config.plugins.enabledPlugins,
              },
            }
          : {}),
        ...(config.plugins.extraKnownMarketplaces
          ? {
              extraKnownMarketplaces: {
                ...previousPlugins?.extraKnownMarketplaces,
                ...config.plugins.extraKnownMarketplaces,
              },
            }
          : {}),
        ...(config.plugins.options
          ? {
              options: mergePluginOptions(previousPlugins?.options, config.plugins.options),
            }
          : {}),
      };
    }
    if (config.skills) {
      result.skills = {
        ...result.skills,
        ...config.skills,
      };
    }
    if (config.skillOverrides) {
      result.skillOverrides = {
        ...result.skillOverrides,
        ...config.skillOverrides,
      };
    }
    if (config.commandOverrides) {
      result.commandOverrides = {
        ...result.commandOverrides,
        ...config.commandOverrides,
      };
    }
    if (config.logging) {
      result.logging = { ...result.logging, ...config.logging };
    }
    if (config.toolConcurrency) {
      result.toolConcurrency = { ...result.toolConcurrency, ...config.toolConcurrency };
    }
    if (config.modelAnomalyGuard) {
      result.modelAnomalyGuard = {
        ...result.modelAnomalyGuard,
        ...config.modelAnomalyGuard,
      };
    }
    if (config.hooks) {
      result.hooks = mergeHooksConfig(previousHooks, config.hooks);
    }
    if (config.ui) {
      result.ui = { ...result.ui, ...config.ui };
    }
  }

  return result;
}

function mergePluginOptions(
  current: PluginOptions | undefined,
  next: PluginOptions,
): PluginOptions {
  const merged: PluginOptions = { ...(current ?? {}) };
  for (const [pluginId, options] of Object.entries(next)) {
    merged[pluginId] = {
      ...(merged[pluginId] ?? {}),
      ...options,
    };
  }
  return merged;
}

function mergeHooksConfig(
  current: RuntimeConfigPatch["hooks"],
  next: NonNullable<RuntimeConfigPatch["hooks"]>,
): NonNullable<RuntimeConfigPatch["hooks"]> {
  const events: Partial<Record<HookEventName, HookMatcherConfig[]>> = {
    ...current?.events,
  };

  // project hooks 不能整体覆盖 user hooks，空的 project `enabled:false` 也不能
  // 关闭 user hooks。每个配置文件只控制自己的事件，因此仅在该来源启用时追加事件，
  // effective enabled 由任一已启用来源决定。
  if (next.enabled !== false) {
    for (const [eventName, matchers] of Object.entries(next.events ?? {}) as Array<
      [HookEventName, HookMatcherConfig[]]
    >) {
      if (!matchers) continue;
      events[eventName] = [...(events[eventName] ?? []), ...matchers];
    }
  }

  return {
    ...current,
    ...next,
    enabled: current?.enabled === true || next.enabled === true,
    events,
  };
}

/**
 * Get priority for a config scope
 */
export function getScopePriority(scope: ConfigScope): number {
  return ConfigScopePriority[scope];
}

/**
 * Create a prioritized config entry
 */
export function createPrioritizedConfig(
  config: RuntimeConfigPatch,
  scope: ConfigScope,
): PrioritizedConfig {
  return {
    config,
    scope,
    priority: getScopePriority(scope),
  };
}
