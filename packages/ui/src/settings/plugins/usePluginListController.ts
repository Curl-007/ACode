/**
 * PluginList 的 controller hook：把 store 绑定、派生 memo、回调与详情/draft 状态全部收口，
 * PluginList 组件本体只保留 JSX 分支。
 * 批次 4 helper 外迁（2026-10-28）：自 settings/PluginsSection.tsx 的 PluginList 组件体
 * 逐字迁移（hook 调用顺序与 useMemo/useCallback/useEffect 的 deps 数组一律未动），仅两处
 * 非逐字：
 *   1. 本地 workspaceKey 别名去重——`target ? workspaceKey(target) : ""` 改用
 *      PluginScopeMenu 导出的 getPluginWorkspaceKey（原包装函数体仅一行纯委托，语义相同）；
 *   2. 尾部新增 return 汇总 JSX 所需的全部值与回调。
 * 注：onAdd/onCreateTask/showMarketplaceBreadcrumb 仅被 JSX 使用，不进 controller，
 * 由 PluginList 组件继续持有。配置草稿三件套（pluginOptionsDrafts/setPluginOptionDraft/
 * getPluginOptionValue/savePluginOptions）因本文件超过 400 行再切一刀，迁至
 * ./usePluginOptionDrafts.js；调用点占据原 drafts useState 的顺序槽位，hook 顺序不变。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ACodePluginScope } from "@acode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import {
  buildStoreItems,
  resolveManagedPluginDisplay,
} from "@/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  filterPluginsByQuery,
  partitionPluginsForSettings,
  selectBuiltInPlugins,
  selectPluginsForScope,
} from "@/settings/pluginCapabilityProjection.js";
import {
  isComputerUseRemoteOrLinux,
  matchesComputerUseSearch,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import {
  shouldShowRemoteSyncActions,
  useRemoteSyncDialogIntent,
} from "@/settings/RemoteSyncActions.js";
import { usePluginOptionDrafts } from "@/settings/plugins/usePluginOptionDrafts.js";

export function usePluginListController({
  target,
  configScope,
  searchQuery,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  onDetailOpenChange,
  onOpenPluginStore,
  onVisibleCountChange,
}: {
  target: WorkspaceTabState | null;
  configScope: ACodePluginScope;
  searchQuery: string;
  isDesktop: boolean;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  onVisibleCountChange?: (count: number) => void;
}) {
  const { intl, locale } = useACodeIntl();
  const targetServiceResolution = useWorkspaceServicesResolution(
    target?.workspacePath,
    target?.remoteSessionId,
    target?.workspaceIdentity,
    target?.remoteTarget,
  );
  const baseServices = useBaseWorkspaceServices();
  // Scope 可选择非激活 workspace，若继续从当前 ServiceProvider 取服务，
  // 会把 B 的路径发往 A 的 host。插件读写必须和 Scope target 共用同一服务解析结果。
  const { pluginManagementService } = targetServiceResolution.services;
  const plugins = usePluginManagementStore((state) => state.plugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaces = usePluginManagementStore((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const restorableBuiltins = usePluginManagementStore((state) => state.restorableBuiltins);
  const loading = usePluginManagementStore((state) => state.loading);
  const pluginDiagnostics = usePluginManagementStore((state) => state.diagnostics);
  const currentWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const currentWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const initialize = usePluginManagementStore((state) => state.initialize);
  const setEnabled = usePluginManagementStore((state) => state.setEnabled);
  const updatePlugin = usePluginManagementStore((state) => state.updatePlugin);
  const configurePlugin = usePluginManagementStore((state) => state.configurePlugin);
  const currentConfigScope = usePluginManagementStore((state) => state.configScope);
  const resetPluginConfig = usePluginManagementStore((state) => state.resetPluginConfig);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const operationId = usePluginManagementStore((state) => state.operationId);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  // 配置草稿三件套外迁 ./usePluginOptionDrafts.js（第二刀）；本调用占据原 useState 槽位。
  const optionDrafts = usePluginOptionDrafts({ configScope, configurePlugin, pluginManagementService });
  // 设置页重构后只保留了 Plugin 管理列表，漏掉了旧版插件页的远端同步入口。
  // 同步目标必须沿用当前 Scope 的 target services，不能回退到激活 workspace 的 host。
  const connectedRemoteSyncTarget =
    targetServiceResolution.rpcReady &&
    shouldShowRemoteSyncActions({
      remoteSessionId: target?.remoteSessionId,
      remoteTarget: target?.remoteTarget,
      clientMode: "desktop-continuous" as const,
      hasLocalSourceService: Boolean(baseServices.pluginSyncService),
    }) &&
    target?.workspacePath
      ? target.remoteTarget
      : null;
  // 设置页重构时只迁移了插件远程同步操作，遗漏了当前远端工作区提示，
  // 用户无法确认插件列表实际对应的是哪个远程目标。
  const remotePluginSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSkillSyncTarget(connectedRemoteSyncTarget, target?.workspacePath ?? "")
    : "";
  const targetKey = target ? getPluginWorkspaceKey(target) : "";
  const pluginSyncTargetKey = target
    ? `${targetKey}\u0000${target.remoteSessionId?.trim() ?? ""}`
    : "";
  const { open: remotePluginSyncOpen, setOpen: setRemotePluginSyncOpen } =
    useRemoteSyncDialogIntent({
      rpcReady: targetServiceResolution.rpcReady,
      targetKey: pluginSyncTargetKey,
    });
  const storeKey = currentWorkspaceIdentity?.trim() || currentWorkspacePath || "";
  const storeMatchesTarget = storeKey === targetKey && currentConfigScope === configScope;
  const storeItemById = useMemo(
    () =>
      new Map(
        buildStoreItems({
          marketplaces,
          marketplaceAvailabilityKnown,
          availablePlugins,
          installedPlugins,
          plugins,
          restorableBuiltins,
        }).map((item) => [item.id, item]),
      ),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  const visiblePlugins = useMemo(() => {
    if (!storeMatchesTarget) return [];
    return filterPluginsByQuery(
      selectPluginsForScope(plugins, installedPlugins, configScope),
      searchQuery,
      storeItemById,
      locale,
    );
  }, [
    configScope,
    installedPlugins,
    locale,
    plugins,
    searchQuery,
    storeItemById,
    storeMatchesTarget,
  ]);
  const scopedPlugins = useMemo(
    () => (storeMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, configScope) : []),
    [configScope, installedPlugins, plugins, storeMatchesTarget],
  );
  const builtInPluginIds = useMemo(
    () => new Set(selectBuiltInPlugins(plugins, installedPlugins).map((plugin) => plugin.id)),
    [installedPlugins, plugins],
  );
  const visiblePluginGroups = useMemo(
    () => partitionPluginsForSettings(visiblePlugins, builtInPluginIds),
    [builtInPluginIds, visiblePlugins],
  );
  const scopedPluginGroups = useMemo(
    () => partitionPluginsForSettings(scopedPlugins, builtInPluginIds),
    [builtInPluginIds, scopedPlugins],
  );
  const visibleBuiltInPlugins = visiblePluginGroups.builtIn;
  const visibleInstalledPlugins = visiblePluginGroups.installed;
  const installedPluginCount = scopedPluginGroups.installed.length;
  const computerUseAvailability = resolveComputerUseAvailability({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    remoteSessionId: target?.remoteSessionId,
    remoteTarget: target?.remoteTarget,
    workspaceIdentity: target?.workspaceIdentity,
  });
  const showUnavailableComputerUse = Boolean(
    configScope === "user" &&
    target &&
    !loading &&
    isComputerUseRemoteOrLinux(computerUseAvailability) &&
    matchesComputerUseSearch(searchQuery),
  );
  const hasEmptySearchResult = Boolean(
    target &&
    !loading &&
    searchQuery.trim() &&
    visibleInstalledPlugins.length === 0 &&
    visibleBuiltInPlugins.length === 0 &&
    !showUnavailableComputerUse,
  );
  const hideInstalledGroup = Boolean(searchQuery.trim() && visibleInstalledPlugins.length === 0);
  useEffect(() => {
    onVisibleCountChange?.(visibleInstalledPlugins.length + visibleBuiltInPlugins.length);
  }, [onVisibleCountChange, visibleBuiltInPlugins.length, visibleInstalledPlugins.length]);
  const refreshAfterPluginChange = useCallback(async () => {
    if (!target || !targetServiceResolution.rpcReady) return;
    await initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [initialize, pluginManagementService, configScope, target, targetServiceResolution.rpcReady]);
  const handleSetEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      const succeeded = await setEnabled(pluginId, enabled, pluginManagementService, configScope);
      if (!succeeded) {
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      const messageId =
        configScope === "workspace"
          ? enabled
            ? "settings.plugins.toggle.workspaceEnabled"
            : "settings.plugins.toggle.workspaceDisabled"
          : enabled
            ? "settings.plugins.toggle.enabled"
            : "settings.plugins.toggle.disabled";
      toast(intl.formatMessage({ id: messageId }, { plugin: pluginLabel }));
    },
    [configScope, intl, locale, pluginManagementService, plugins, setEnabled, storeItemById],
  );
  const handleResetPluginConfig = useCallback(
    async (pluginId: string) => {
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      const restored = await resetPluginConfig(pluginId, pluginManagementService, "workspace");
      if (!restored) {
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      toast(intl.formatMessage({ id: "settings.plugins.scope.restored" }, { plugin: pluginLabel }));
    },
    [intl, locale, pluginManagementService, plugins, resetPluginConfig, storeItemById],
  );
  const uninstall = usePluginUninstall({
    pluginService: pluginManagementService,
    installedPlugins,
    plugins,
    operationId,
    onAfterUninstall: refreshAfterPluginChange,
  });
  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      await updatePlugin(pluginId, pluginManagementService);
      if (usePluginManagementStore.getState().error) return;
      await refreshAfterPluginChange();
    },
    [pluginManagementService, refreshAfterPluginChange, updatePlugin],
  );
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? null;
  // 插件自身 warning 诊断（如声明的技能路径扫描为空）：详情高级区展示，避免静默失败。
  const pluginWarningsForSelected = selectedPlugin
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === selectedPlugin.id && diagnostic.severity === "warning",
      )
    : [];
  const selectedStoreItem = selectedPluginId ? storeItemById.get(selectedPluginId) : undefined;
  const closeDetail = useCallback(() => {
    setSelectedPluginId(null);
    onDetailOpenChange?.(false);
  }, [onDetailOpenChange]);
  useEffect(() => {
    closeDetail();
  }, [closeDetail, targetKey]);
  useEffect(() => {
    if (selectedPluginId && !selectedPlugin) closeDetail();
  }, [closeDetail, selectedPlugin, selectedPluginId]);
  const actions: PluginStoreActions = useMemo(
    () => ({
      onOpenDetail: (pluginId) => {
        setSelectedPluginId(pluginId);
        onDetailOpenChange?.(true);
      },
      onInstall: () => onOpenPluginStore(),
      onUninstall: uninstall.requestUninstall,
      onSetEnabled: (pluginId, enabled) => void handleSetEnabled(pluginId, enabled),
      onResetConfig:
        configScope === "workspace"
          ? (pluginId) => void handleResetPluginConfig(pluginId)
          : undefined,
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      operationId,
      togglingPluginId,
    }),
    [
      configScope,
      handleResetPluginConfig,
      handleSetEnabled,
      handleUpdatePlugin,
      onDetailOpenChange,
      onOpenPluginStore,
      operationId,
      togglingPluginId,
      uninstall.requestUninstall,
    ],
  );
  useEffect(() => {
    if (!target || !targetServiceResolution.rpcReady) return;
    void initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [initialize, pluginManagementService, configScope, target, targetServiceResolution.rpcReady]);

  return {
    intl,
    locale,
    targetServiceResolution,
    baseServices,
    connectedRemoteSyncTarget,
    remotePluginSyncTargetLabel,
    remotePluginSyncOpen,
    setRemotePluginSyncOpen,
    storeItemById,
    visiblePlugins,
    visibleInstalledPlugins,
    visibleBuiltInPlugins,
    installedPluginCount,
    computerUseAvailability,
    showUnavailableComputerUse,
    hasEmptySearchResult,
    hideInstalledGroup,
    loading,
    operationId,
    togglingPluginId,
    refreshAfterPluginChange,
    handleUpdatePlugin,
    handleResetPluginConfig,
    uninstall,
    selectedPlugin,
    pluginWarningsForSelected,
    selectedStoreItem,
    closeDetail,
    optionDrafts,
    actions,
  };
}
