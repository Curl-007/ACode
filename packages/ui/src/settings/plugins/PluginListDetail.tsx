/**
 * PluginList 的详情分支（受控组件）：命中 selectedPlugin 且 rpcReady 时渲染商店详情 +
 * 已安装态高级配置 + 卸载确认弹窗。
 * 批次 4 helper 外迁（2026-10-28）：自 settings/PluginsSection.tsx 的 PluginList 详情分支
 * 逐字迁移（经 PluginList 中转），入参用解构改名保持 JSX 内标识符与原闭包逐字一致；
 * intl 由原闭包改为 useACodeIntl 自取（原文 intl 也只用于 formatMessage，行为等价）；
 * 卸载确认弹窗复用 ./PluginListUninstallDialog.js（原两处逐字重复块的收口）。
 */

import { type V4PluginInfo, type V4PluginScope } from "@acode/shared/acode-protocol-v4";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import { PluginConfigControls } from "@/settings/PluginConfigControls.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";
import {
  resolvePluginDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import type { PluginUninstallController } from "@/settings/usePluginUninstall.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";
import { PluginListUninstallDialog } from "@/settings/plugins/PluginListUninstallDialog.js";
import type { PluginOptionDraftsController } from "@/settings/plugins/usePluginOptionDrafts.js";

export interface PluginListDetailProps {
  plugin: V4PluginInfo;
  storeItem: StorePluginItem;
  pluginWarnings: PluginManagementState["diagnostics"];
  optionDrafts: PluginOptionDraftsController;
  uninstall: PluginUninstallController;
  storeItemById: ReadonlyMap<string, StorePluginItem>;
  actions: PluginStoreActions;
  configScope: V4PluginScope;
  operationId: string | null;
  locale: string;
  showMarketplaceBreadcrumb: boolean;
  closeDetail: () => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
}

export function PluginListDetail({
  plugin: selectedPlugin,
  storeItem: selectedStoreItem,
  pluginWarnings: pluginWarningsForSelected,
  optionDrafts: {
    pluginOptionsDrafts,
    setPluginOptionsDrafts,
    setPluginOptionDraft,
    getPluginOptionValue,
    savePluginOptions,
  },
  uninstall,
  storeItemById,
  actions,
  configScope,
  operationId,
  locale,
  showMarketplaceBreadcrumb,
  closeDetail,
  onOpenPluginStore,
  onCreateTask,
}: PluginListDetailProps) {
  const { intl } = useACodeIntl();
  const pluginBreadcrumbLabel = resolvePluginDisplayName(selectedStoreItem, locale);
  const pluginsBreadcrumbLabel = intl.formatMessage({ id: "settings.plugins.title" });
  // Plugin 不打开仅含管理字段的简化弹窗：那会与插件商店详情形成两套内容模型，
  // 导致介绍、Hero、示例提示词与能力清单缺失。这里直接复用权威商店详情页，只注入已安装态高级配置。
  return (
    <section className="space-y-5">
      <SettingsBreadcrumbReporter
        items={
          showMarketplaceBreadcrumb
            ? [
                { label: pluginsBreadcrumbLabel, onSelect: closeDetail },
                { label: pluginBreadcrumbLabel },
              ]
            : [{ label: pluginBreadcrumbLabel }]
        }
        onSectionSelect={showMarketplaceBreadcrumb ? onOpenPluginStore : closeDetail}
      />
      <PluginStoreDetailView
        item={selectedStoreItem}
        actions={actions}
        onRetryDescribe={() => {}}
        onUsePrompt={(item, prompt) => {
          if (!onCreateTask) return;
          onCreateTask({
            initialPrompt: buildPluginStoreTryPrompt({
              item,
              locale,
              prompt,
            }),
            initialPromptMention: buildPluginStoreTryMention({
              item,
              locale,
            }),
          });
        }}
        advanced={
          selectedPlugin.packageStatus === "missing" ? undefined : (
            <PluginStoreAdvancedSection>
              {pluginWarningsForSelected.length > 0 ? (
                <div>
                  <div className="mb-2 text-ui-xs font-medium text-foreground">
                    {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                  </div>
                  <PluginWarningList warnings={pluginWarningsForSelected} />
                </div>
              ) : null}
              <PluginDetailRow
                label={intl.formatMessage({
                  id: "settings.plugins.detail.rootPath",
                })}
                value={selectedPlugin.rootPath}
              />
              {(selectedPlugin.hookDetails ?? []).length > 0 ? (
                <PluginHookDetails hooks={selectedPlugin.hookDetails ?? []} />
              ) : null}
              <PluginConfigControls
                getValue={getPluginOptionValue}
                isOptionClearPending={(pluginId, key) =>
                  pluginOptionsDrafts[pluginId]?.[key] === null
                }
                onClearOption={(pluginId, key, clear) =>
                  setPluginOptionsDrafts((current) => {
                    const nextPluginDrafts = { ...current[pluginId] };
                    if (clear) nextPluginDrafts[key] = null;
                    else delete nextPluginDrafts[key];
                    return {
                      ...current,
                      [pluginId]: nextPluginDrafts,
                    };
                  })
                }
                onSave={(plugin) => void savePluginOptions(plugin)}
                onSetDraft={setPluginOptionDraft}
                operationId={operationId}
                plugin={selectedPlugin}
                scope={configScope}
              />
            </PluginStoreAdvancedSection>
          )
        }
      />
      <PluginListUninstallDialog
        uninstall={uninstall}
        storeItemById={storeItemById}
        locale={locale}
      />
    </section>
  );
}
