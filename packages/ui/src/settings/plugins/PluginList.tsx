/**
 * PluginList 组件本体：store/hook 逻辑已全部收口到 usePluginListController，
 * 这里只做 controller 调用与详情/列表两个 JSX 分支的分发（批次 4 helper 外迁 2026-10-28，
 * 自 settings/PluginsSection.tsx 逐字迁移，JSX 结构、data-testid 与 aria 属性未改一字）。
 * 接缝替换：
 *   详情分支                    → <PluginListDetail … />（受控组件，逐字迁入同目录）
 *   renderPluginRows(items)     → <PluginListRows … />（受控组件，props 显式传入）
 *   renderUnavailableComputerUse() → <PluginUnavailableComputerUseRow … />
 *   卸载确认弹窗（两处逐字重复） → <PluginListUninstallDialog … />
 *   <EmptyState … />            → <PluginEmptyState … />（与主组件共用，单独成叶避免循环依赖）
 */
import { Plus, UploadCloud } from "lucide-react";
import { TID_PLUGIN_STORE_BROWSE } from "@acode/shared";

import { type V4PluginScope } from "@acode/shared/acode-protocol-v4";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { PluginAddMenu } from "@/settings/PluginAddMenu.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
} from "@/settings/PluginInstallEmptyState.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { RemoteSyncDialogs } from "@/settings/RemoteSyncActions.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { PluginEmptyState } from "@/settings/plugins/PluginEmptyState.js";
import { PluginListDetail } from "@/settings/plugins/PluginListDetail.js";
import { PluginListRows } from "@/settings/plugins/PluginListRows.js";
import { PluginListUninstallDialog } from "@/settings/plugins/PluginListUninstallDialog.js";
import { PluginUnavailableComputerUseRow } from "@/settings/plugins/PluginUnavailableComputerUseRow.js";
import { usePluginListController } from "@/settings/plugins/usePluginListController.js";

export function PluginList({
  target,
  configScope,
  searchQuery,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  onAdd,
  onCreateTask,
  onDetailOpenChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  onVisibleCountChange,
}: {
  target: WorkspaceTabState | null;
  configScope: V4PluginScope;
  searchQuery: string;
  isDesktop: boolean;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
  onAdd?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
  onVisibleCountChange?: (count: number) => void;
}) {
  const {
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
  } = usePluginListController({
    target,
    configScope,
    searchQuery,
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    onDetailOpenChange,
    onOpenPluginStore,
    onVisibleCountChange,
  });

  if (selectedPlugin && selectedStoreItem && targetServiceResolution.rpcReady) {
    return (
      <PluginListDetail
        plugin={selectedPlugin}
        storeItem={selectedStoreItem}
        pluginWarnings={pluginWarningsForSelected}
        optionDrafts={optionDrafts}
        uninstall={uninstall}
        storeItemById={storeItemById}
        actions={actions}
        configScope={configScope}
        operationId={operationId}
        locale={locale}
        showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
        closeDetail={closeDetail}
        onOpenPluginStore={onOpenPluginStore}
        onCreateTask={onCreateTask}
      />
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="plugin-installed-title">
      {hasEmptySearchResult ? (
        <PluginEmptyState
          message={intl.formatMessage({
            id: "settings.plugin.plugins.empty",
          })}
        />
      ) : null}
      <div className={hideInstalledGroup ? "hidden" : "space-y-4"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3
            id="plugin-installed-title"
            className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground"
          >
            {intl.formatMessage({ id: "settings.plugin.plugins.installed" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleInstalledPlugins.length}
            </span>
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {connectedRemoteSyncTarget ? (
              <ControlHintTooltip
                title={intl.formatMessage({
                  id: "settings.plugins.remoteSync.open",
                })}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon-md"
                  aria-label={intl.formatMessage({
                    id: "settings.plugins.remoteSync.open",
                  })}
                  onClick={() => setRemotePluginSyncOpen(true)}
                >
                  <UploadCloud className="size-3.5" aria-hidden="true" />
                </Button>
              </ControlHintTooltip>
            ) : null}
            <SettingsResourceHeaderActions onRefresh={() => void refreshAfterPluginChange()} />
            {configScope === "user" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  data-testid={TID_PLUGIN_STORE_BROWSE}
                  onClick={onAdd}
                >
                  {intl.formatMessage({ id: "settings.plugin.plugins.browse" })}
                </Button>
                <PluginAddMenu
                  testId="plugin-settings-add"
                  onCreateTask={onCreateTask}
                  onAddMarketplace={() => onOpenPluginStore(undefined, "add-marketplace")}
                />
              </>
            ) : null}
          </div>
        </div>
        {configScope === "workspace" && target ? (
          <div
            className="rounded-lg border border-border bg-card px-3 py-2 text-ui-sm text-foreground-subtle"
            data-testid="plugin-settings-workspace-scope-hint"
          >
            {intl.formatMessage({ id: "settings.plugins.scope.workspaceHint" })}
          </div>
        ) : null}
        {connectedRemoteSyncTarget ? (
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.plugins.remoteContext" },
              { target: remotePluginSyncTargetLabel },
            )}
          </div>
        ) : null}
        {!target ? (
          <PluginEmptyState
            message={intl.formatMessage({
              id: "settings.plugin.noWorkspace",
            })}
          />
        ) : !targetServiceResolution.rpcReady ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
        ) : loading && visiblePlugins.length === 0 ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
        ) : visibleInstalledPlugins.length > 0 ? (
          <PluginListRows
            items={visibleInstalledPlugins}
            storeItemById={storeItemById}
            actions={actions}
            configScope={configScope}
            operationId={operationId}
            togglingPluginId={togglingPluginId}
            locale={locale}
            onUpdatePlugin={handleUpdatePlugin}
            onResetPluginConfig={handleResetPluginConfig}
            onRequestUninstall={uninstall.requestUninstall}
          />
        ) : installedPluginCount === 0 && !showUnavailableComputerUse ? (
          <PluginInstallEmptyState
            title={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledTitle",
            })}
            description={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledDescription",
            })}
            actions={
              onAdd ? (
                <Button type="button" variant="default" size="lg" onClick={onAdd}>
                  <Plus aria-hidden="true" data-icon="inline-start" />
                  {intl.formatMessage({
                    id: "settings.plugin.plugins.browse",
                  })}
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>
      {!hasEmptySearchResult && visibleBuiltInPlugins.length > 0 ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.plugin.plugins.builtIn" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleBuiltInPlugins.length}
            </span>
          </h3>
          <PluginListRows
            items={visibleBuiltInPlugins}
            storeItemById={storeItemById}
            actions={actions}
            configScope={configScope}
            operationId={operationId}
            togglingPluginId={togglingPluginId}
            locale={locale}
            onUpdatePlugin={handleUpdatePlugin}
            onResetPluginConfig={handleResetPluginConfig}
            onRequestUninstall={uninstall.requestUninstall}
          />
        </div>
      ) : null}
      {showUnavailableComputerUse ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.unsupported.group" })}
          </h3>
          <PluginUnavailableComputerUseRow computerUseAvailability={computerUseAvailability} />
        </div>
      ) : null}
      <PluginListUninstallDialog
        uninstall={uninstall}
        storeItemById={storeItemById}
        locale={locale}
      />
      <RemoteSyncDialogs
        canSyncSkills={false}
        canSyncMcp={false}
        canSyncPlugins={Boolean(connectedRemoteSyncTarget && target?.workspacePath)}
        skillOpen={false}
        mcpOpen={false}
        pluginOpen={remotePluginSyncOpen}
        onSkillOpenChange={() => {}}
        onMcpOpenChange={() => {}}
        onPluginOpenChange={setRemotePluginSyncOpen}
        localPluginSyncService={baseServices.pluginSyncService}
        remotePluginSyncService={targetServiceResolution.services.pluginSyncService}
        localACodeAgentService={baseServices.acodeAgentService}
        remoteACodeAgentService={targetServiceResolution.services.acodeAgentService}
        remoteTarget={connectedRemoteSyncTarget}
        skillWorkspacePath=""
        mcpWorkspacePath=""
        pluginWorkspacePath={target?.workspacePath ?? ""}
        pluginLocalWorkspacePath={target?.localWorkspacePath}
        workspaceIdentity={target?.workspaceIdentity}
        onSkillsSynced={() => {}}
        onMcpSynced={() => {}}
        onPluginsSynced={refreshAfterPluginChange}
      />
    </section>
  );
}
