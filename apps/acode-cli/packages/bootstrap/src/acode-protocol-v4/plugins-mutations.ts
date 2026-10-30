// plugins 域写路径 v4 handler（M2-5，specs/m2-5-plugins.md）：setEnabled/marketplace×3/
// install/uninstall/update/restoreBuiltin/configure/resetConfig 十法，自 legacy
// acode-protocol/plugins.ts 逐字迁。共享投影/helper 在 ./plugins-management.js（读路径同文件）。
// storage 锁串行化与可取消语义（abort 只阻断响应/UI 写入，配置写入不可回滚）逐字保留。
import {
  v4PluginsConfigureParamsSchema,
  v4PluginsResetConfigParamsSchema,
  v4PluginsInstallParamsSchema,
  v4PluginsMarketplaceAddParamsSchema,
  v4PluginsMarketplaceRemoveParamsSchema,
  v4PluginsMarketplaceUpdateParamsSchema,
  v4PluginsSetEnabledParamsSchema,
  v4PluginsUninstallParamsSchema,
  v4PluginsUpdateParamsSchema,
  v4PluginsRestoreBuiltinParamsSchema,
  type V4PluginDiagnostic,
  type V4InstalledPluginSummary,
  type V4PluginsConfigureResult,
  type V4PluginsInstallResult,
  type V4PluginsMarketplaceMutationResult,
  type V4PluginsRestoreBuiltinResult,
  type V4PluginsSetEnabledResult,
  type V4PluginsUninstallResult,
} from "@acode/shared/acode-protocol-v4";
import {
  addACodePluginMarketplace,
  configureACodePlugin,
  installACodeMarketplacePlugin,
  removeACodePluginMarketplace,
  resetACodePluginConfig,
  restoreBuiltinPlugin as restoreBuiltinPluginCore,
  setACodePluginEnabled,
  uninstallACodeMarketplacePlugin,
  updateACodePluginMarketplace,
} from "../plugins.js";
import { listInstalledPluginRecords } from "@acode/adapters/plugins";
import { withPluginStorageLock } from "../lib/plugin-storage-lock.js";
import {
  resolvePluginStorageRoot,
  toInstalledPluginSummary,
  toMarketplaceSummary,
  toPluginDiagnostic,
  toPluginInfo,
} from "./plugins-management.js";
import { parseParams, type ACodeProtocolAgentServerContext } from "./server-types.js";

export async function setPluginEnabled(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<V4PluginsSetEnabledResult> {
  const params = parseParams(v4PluginsSetEnabledParamsSchema, rawParams);
  abortSignal?.throwIfAborted();
  const result = await setACodePluginEnabled({
    enabled: params.enabled,
    logger: context.logger,
    plugin: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  // 启用配置写入当前不可回滚；若取消在 IO 期间到达，只阻断后续响应和 UI 写入。
  abortSignal?.throwIfAborted();
  return {
    plugin: {
      ...toPluginInfo(result.plugin),
      enabledSource: params.scope ?? "user",
    },
    enabled: result.enabled,
  };
}

export async function addPluginMarketplace(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<V4PluginsMarketplaceMutationResult> {
  const params = parseParams(v4PluginsMarketplaceAddParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const marketplace = await withPluginStorageLock(pluginStorageRoot, async () =>
    addACodePluginMarketplace({
      abortSignal,
      dryRun: params.dryRun,
      logger: context.logger,
      source: params.source,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return { marketplace: toMarketplaceSummary(marketplace), diagnostics: [] };
}

export async function removePluginMarketplace(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsMarketplaceMutationResult> {
  const params = parseParams(v4PluginsMarketplaceRemoveParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  await withPluginStorageLock(pluginStorageRoot, async () =>
    removeACodePluginMarketplace({
      logger: context.logger,
      marketplace: params.marketplace,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return { diagnostics: [] };
}

export async function updatePluginMarketplace(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<V4PluginsMarketplaceMutationResult> {
  const params = parseParams(v4PluginsMarketplaceUpdateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    updateACodePluginMarketplace({
      abortSignal,
      logger: context.logger,
      marketplace: params.marketplace,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    marketplaces: result.marketplaces.map(toMarketplaceSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

export async function installPlugin(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<V4PluginsInstallResult> {
  const params = parseParams(v4PluginsInstallParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    installACodeMarketplacePlugin({
      abortSignal,
      dryRun: params.dryRun,
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      scope: params.scope,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    dependencyClosure: result.dependencyClosure,
    installedPlugins: result.installedPlugins.map(toInstalledPluginSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

export async function uninstallPlugin(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsUninstallResult> {
  const params = parseParams(v4PluginsUninstallParamsSchema, rawParams);
  const removed = await uninstallACodeMarketplacePlugin({
    logger: context.logger,
    marketplace: params.marketplace,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    removeCache: params.removeCache,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    ...(removed ? { removedPlugin: toInstalledPluginSummary(removed) } : {}),
    diagnostics: [],
  };
}

export async function updatePlugin(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsInstallResult> {
  const params = parseParams(v4PluginsUpdateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const installed = listInstalledPluginRecords(pluginStorageRoot).filter((record) => {
    if (params.pluginId) return record.id === params.pluginId;
    if (params.marketplace) return record.marketplace === params.marketplace;
    return true;
  });
  // 与 uninstall 一样把整个重装循环串行化到同一 storageRoot 的 in-process 锁里，
  // 避免并发 update/install 交错读改写 installed_plugins.json / cache。
  return withPluginStorageLock(pluginStorageRoot, async () => {
    const installedPlugins: V4InstalledPluginSummary[] = [];
    const dependencyClosure: string[] = [];
    // 聚合每条记录重装产生的诊断：installACodeMarketplacePlugin 失败时不抛错，而是返回
    // CLI 形态的 PluginDiagnostic（见其错误分支的 toMarketplaceInstallDiagnostic），
    // 这里逐条经协议侧 toPluginDiagnostic 投影成 V4PluginDiagnostic 回传，
    // 让失败的重装显式暴露，而不是静默"成功"。
    const diagnostics: V4PluginDiagnostic[] = [];
    for (const record of installed) {
      const result = await installACodeMarketplacePlugin({
        logger: context.logger,
        marketplace: record.marketplace,
        pluginName: record.name,
        scope: record.scope,
        workingDirectory: params.workspace.workspacePath,
      });
      installedPlugins.push(...result.installedPlugins.map(toInstalledPluginSummary));
      dependencyClosure.push(...result.dependencyClosure);
      diagnostics.push(...result.diagnostics.map(toPluginDiagnostic));
    }
    return { dependencyClosure, installedPlugins, diagnostics };
  });
}

// 恢复一个被抑制（"卸载"）的内置插件：清除 suppressedBuiltins 标记并立即重新 seed。
// bootstrap 侧的同名函数被别名为 restoreBuiltinPluginCore，避免与本协议处理器重名。
export async function restoreBuiltinPlugin(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsRestoreBuiltinResult> {
  const params = parseParams(v4PluginsRestoreBuiltinParamsSchema, rawParams);
  await restoreBuiltinPluginCore({
    logger: context.logger,
    pluginId: params.pluginId,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function configurePlugin(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsConfigureResult> {
  const params = parseParams(v4PluginsConfigureParamsSchema, rawParams);
  await configureACodePlugin({
    clearOptionKeys: params.clearOptionKeys,
    dryRun: params.dryRun,
    logger: context.logger,
    options: params.options,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function resetPluginConfig(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4PluginsConfigureResult> {
  const params = parseParams(v4PluginsResetConfigParamsSchema, rawParams);
  await resetACodePluginConfig({
    logger: context.logger,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}
