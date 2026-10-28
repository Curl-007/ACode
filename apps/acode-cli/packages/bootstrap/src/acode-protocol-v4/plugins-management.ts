// 插件管理面 v4 handler（M2-5，specs/m2-5-plugins.md）：本文件 = 共享投影/helper + 读路径
// 四法（list/overview/validate/describe），自 legacy acode-protocol/plugins.ts 逐字迁
// （该文件的全部 dispatch case 消费归零后随本批删除）；写路径十法在 ./plugins-mutations.js。
// 形状由 @acode/shared/acode-protocol-v4 的 plugins 三叶承载（与 legacy 逐字 parity，
// protocol-boundary 测试钉住）；storage 锁、missing 配置行投影、sensitive 过滤等不变量逐字保留。
// helper 导出给 plugins-mutations.js 复用（投影单点，避免双份实现漂移）。
import {
  v4PluginsOverviewParamsSchema,
  v4PluginsListParamsSchema,
  v4PluginsValidateParamsSchema,
  v4PluginsDescribeParamsSchema,
  type V4AvailablePluginSummary,
  type V4InstalledPluginSummary,
  type V4PluginComponentGroup,
  type V4PluginDiagnostic,
  type V4PluginInfo,
  type V4PluginMarketplaceSummary,
  type V4PluginsDescribeResult,
  type V4PluginsListResult,
  type V4PluginsOverviewResult,
  type V4PluginsValidateResult,
} from "@acode/shared/acode-protocol-v4";
import type { PluginDiagnostic, PluginMetadata } from "@acode/contracts";
import {
  describeACodePlugin,
  getACodePluginsOverview,
  resolveACodePlugins,
  validateACodePlugin,
} from "../plugins.js";
import { withPluginStorageLock } from "../lib/plugin-storage-lock.js";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";
import { resolveOfficialPluginHostMcpServerNames } from "../app/official-plugin-definitions.js";
import { createConfig, resolvePath, type ConfigResult } from "@acode/adapters/config";
import { parseParams, type ACodeProtocolAgentServerContext } from "../acode-protocol/server-types.js";

// 把 CLI 的 PluginMetadata 投影成协议可序列化的 V4PluginInfo (只保留 UI 需要的字段)。
export function toPluginInfo(plugin: PluginMetadata, configResult?: ConfigResult): V4PluginInfo {
  const hostMcpServerNames = resolveOfficialPluginHostMcpServerNames(plugin.id);
  const configuredOptions = Object.fromEntries(
    Object.entries(plugin.configuredOptions ?? {}).filter(
      ([key]) => plugin.userConfig?.[key]?.sensitive !== true,
    ),
  );
  const enabledSource = configResult?.sources.plugins.enabled[plugin.id];
  const optionSources = configResult?.sources.plugins.options[plugin.id];
  const rootSource =
    plugin.source === "inline" && configResult
      ? resolveInlinePluginRootSource(plugin.rootPath, configResult)
      : undefined;
  return {
    id: plugin.id,
    name: plugin.name,
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    enabled: plugin.enabled,
    source: plugin.source,
    marketplace: plugin.marketplace,
    // manifest 的作者/主页回退字段（商店 listing 优先）。
    ...(plugin.author !== undefined ? { author: plugin.author } : {}),
    ...(plugin.authorUrl !== undefined ? { authorUrl: plugin.authorUrl } : {}),
    ...(plugin.homepage !== undefined ? { homepage: plugin.homepage } : {}),
    skillCount: plugin.skillCount,
    skillRootCount: plugin.skillRootCount,
    commandRootCount: plugin.commandRootCount,
    // 权威组件清单随 list 下发，名称+描述由 loader 枚举（与启用态无关），供详情 UI 直接展示。
    components: plugin.components.map((group) => ({
      kind: group.kind,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    })),
    declaredMcpServerNames: plugin.declaredMcpServerNames,
    mcpServerNames: plugin.mcpServerNames,
    ...(hostMcpServerNames.length > 0 ? { hostMcpServerNames } : {}),
    hookDetails: plugin.hookDetails,
    rootPath: plugin.rootPath,
    ...(plugin.userConfig ? { userConfig: plugin.userConfig } : {}),
    ...(Object.keys(configuredOptions).length > 0 ? { configuredOptions } : {}),
    ...(rootSource ? { rootSource } : {}),
    ...(enabledSource ? { enabledSource } : {}),
    ...(optionSources && Object.keys(optionSources).length > 0 ? { optionSources } : {}),
  };
}

function resolveInlinePluginRootSource(
  pluginRootPath: string,
  configResult: ConfigResult,
): "user" | "workspace" | undefined {
  const resolvedPluginRoot = normalizePluginRootForComparison(pluginRootPath);
  // Workspace 优先：同一路径同时出现在两层配置时，项目声明是更高优先级的归属证据。
  if (
    configResult.sources.plugins.dirs.workspace.some(
      (rootPath) => normalizePluginRootForComparison(rootPath) === resolvedPluginRoot,
    )
  ) {
    return "workspace";
  }
  if (
    configResult.sources.plugins.dirs.user.some(
      (rootPath) => normalizePluginRootForComparison(rootPath) === resolvedPluginRoot,
    )
  ) {
    return "user";
  }
  return undefined;
}

function createPluginConfigView(
  context: ACodeProtocolAgentServerContext,
  workspacePath: string,
  configScope: "user" | "workspace" | undefined,
): ConfigResult {
  // Settings 的 User 与 Workspace 现在是同一批 Host Plugin 的两个配置视图。
  // User 视图若继续加载 project config，会把 Workspace override 投影成 User 当前值；
  // 不传 workingDirectory 可保留 User/default 层，同时仍由调用方的 workspacePath 决定
  // package storage 和相对执行上下文。
  return createConfig({
    env: context.deps?.env,
    ...(configScope === "user" ? {} : { workingDirectory: workspacePath }),
  });
}

function createMissingConfiguredPluginInfos(
  configResult: ConfigResult,
  discoveredPluginIds: ReadonlySet<string>,
): V4PluginInfo[] {
  const configuredPluginIds = new Set([
    ...Object.keys(configResult.config.plugins.enabledPlugins),
    ...Object.keys(configResult.config.plugins.options),
  ]);
  return [...configuredPluginIds].flatMap((pluginId) => {
    if (discoveredPluginIds.has(pluginId)) return [];
    const separatorIndex = pluginId.lastIndexOf("@");
    if (separatorIndex <= 0 || separatorIndex === pluginId.length - 1) {
      return [];
    }
    const enabledSource = configResult.sources.plugins.enabled[pluginId];
    const optionSources = configResult.sources.plugins.options[pluginId];
    return [
      {
        id: pluginId,
        name: pluginId.slice(0, separatorIndex),
        enabled: configResult.config.plugins.enabledPlugins[pluginId] ?? false,
        source: "missing",
        marketplace: pluginId.slice(separatorIndex + 1),
        skillCount: 0,
        skillRootCount: 0,
        commandRootCount: 0,
        components: [],
        declaredMcpServerNames: [],
        mcpServerNames: [],
        rootPath: "",
        packageStatus: "missing",
        ...(enabledSource ? { enabledSource } : {}),
        ...(optionSources && Object.keys(optionSources).length > 0 ? { optionSources } : {}),
      },
    ];
  });
}

function normalizePluginRootForComparison(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolvedRoot = resolvePath(rootPath);
  // Windows 路径不区分大小写，且配置与 loader 可能分别返回正斜杠和反斜杠。
  // 若直接做字符串比较，会把同一个 Workspace plugins.dirs 根误判为无归属。
  return platform === "win32" ? resolvedRoot.replaceAll("\\", "/").toLowerCase() : resolvedRoot;
}

export function toPluginDiagnostic(diagnostic: PluginDiagnostic): V4PluginDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.pluginId !== undefined ? { pluginId: diagnostic.pluginId } : {}),
  };
}

export async function listPlugins(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsListResult> {
  const params = parseParams(v4PluginsListParamsSchema, rawParams);
  const configResult = createPluginConfigView(
    context,
    params.workspace.workspacePath,
    params.configScope,
  );
  const outcome = resolveACodePlugins({
    configResult,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  const plugins = outcome.plugins.map((plugin) => toPluginInfo(plugin, configResult));
  return {
    plugins: [
      ...plugins,
      ...createMissingConfiguredPluginInfos(
        configResult,
        new Set(plugins.map((plugin) => plugin.id)),
      ),
    ],
    diagnostics: outcome.diagnostics.map(toPluginDiagnostic),
  };
}

export async function getPluginsOverview(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsOverviewResult> {
  const params = parseParams(v4PluginsOverviewParamsSchema, rawParams);
  const overview = getACodePluginsOverview({
    configResult: createPluginConfigView(
      context,
      params.workspace.workspacePath,
      params.configScope,
    ),
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    marketplaces: overview.marketplaces.map(toMarketplaceSummary),
    availablePlugins: overview.availablePlugins.map(toAvailablePluginSummary),
    installedPlugins: overview.installedPlugins.map(toInstalledPluginSummary),
    restorableBuiltins: overview.restorableBuiltins.map(toAvailablePluginSummary),
    diagnostics: overview.diagnostics.map(toPluginDiagnostic),
    capability: { supported: true },
  };
}

export async function validatePlugin(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsValidateResult> {
  const params = parseParams(v4PluginsValidateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const diagnostics = await withPluginStorageLock(pluginStorageRoot, async () =>
    validateACodePlugin({
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      source: params.source,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    diagnostics: diagnostics.map(toPluginDiagnostic),
    compatibility: {
      runnable: ["skills", "commands", "hooks", "mcpServers", "userConfig"],
      diagnosticOnly: ["agents", "lspServers", "outputStyles", "channels", "settings"],
      unsupported: ["mcpb", "dxt", "npm", "hostPattern", "pathPattern"],
    },
  };
}

export async function describePlugin(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsDescribeResult> {
  const params = parseParams(v4PluginsDescribeParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    describeACodePlugin({
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  const components: V4PluginComponentGroup[] = result.components.map((group) => ({
    kind: group.kind,
    items: group.items.map((item) => ({
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
    })),
  }));
  const diagnostics = result.diagnostics.map(toPluginDiagnostic);
  return {
    components,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

export function toMarketplaceSummary(input: {
  id: string;
  name: string;
  source: Record<string, unknown>;
  description?: string;
  lastUpdated?: string;
  pluginCount: number;
  isOfficial?: boolean;
  featured?: string[];
  refreshFailure?: V4PluginMarketplaceSummary["refreshFailure"];
}): V4PluginMarketplaceSummary {
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    ...(input.description ? { description: input.description } : {}),
    ...(input.lastUpdated ? { lastUpdated: input.lastUpdated } : {}),
    pluginCount: input.pluginCount,
    ...(input.isOfficial !== undefined ? { isOfficial: input.isOfficial } : {}),
    ...(input.featured ? { featured: input.featured } : {}),
    ...(input.refreshFailure ? { refreshFailure: input.refreshFailure } : {}),
  };
}

function toAvailablePluginSummary(input: {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: string[];
  listing?: V4AvailablePluginSummary["listing"];
}): V4AvailablePluginSummary {
  return {
    id: input.id,
    name: input.name,
    marketplace: input.marketplace,
    ...(input.description ? { description: input.description } : {}),
    ...(input.version ? { version: input.version } : {}),
    installed: input.installed,
    ...(input.componentTypes ? { componentTypes: input.componentTypes } : {}),
    ...(input.listing ? { listing: input.listing } : {}),
  };
}

export function toInstalledPluginSummary(input: {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope: "user" | "workspace";
  installPath?: string;
  installedAt?: string;
  componentTypes?: string[];
  hookDetails?: V4InstalledPluginSummary["hookDetails"];
  updateStatus?: "none" | "update-available" | "version-changed";
  latestVersion?: string;
  listing?: V4InstalledPluginSummary["listing"];
}): V4InstalledPluginSummary {
  return {
    id: input.id,
    name: input.name,
    marketplace: input.marketplace,
    ...(input.description ? { description: input.description } : {}),
    ...(input.version ? { version: input.version } : {}),
    enabled: input.enabled,
    scope: input.scope,
    ...(input.installPath ? { installPath: input.installPath } : {}),
    ...(input.installedAt ? { installedAt: input.installedAt } : {}),
    ...(input.componentTypes ? { componentTypes: input.componentTypes } : {}),
    ...(input.hookDetails ? { hookDetails: input.hookDetails } : {}),
    ...(input.updateStatus ? { updateStatus: input.updateStatus } : {}),
    ...(input.latestVersion ? { latestVersion: input.latestVersion } : {}),
    ...(input.listing ? { listing: input.listing } : {}),
  };
}

export function resolvePluginStorageRoot(workingDirectory: string): string {
  const config = createConfig({ workingDirectory });
  const storageRoot = resolvePath(config.config.storage.dir);
  return getPluginStorageRoot(getCliStorageRoot(storageRoot));
}
