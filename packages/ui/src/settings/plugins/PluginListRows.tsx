/**
 * PluginList 已安装/内置分组的插件行列表（受控组件，纯渲染）。
 * 批次 4 helper 外迁（2026-10-28）：自 settings/PluginsSection.tsx 内部 renderPluginRows
 * 逐字迁移为受控组件，原闭包捕获改为显式 props（storeItemById/actions/configScope/
 * operationId/togglingPluginId/locale/onUpdatePlugin/onResetPluginConfig/onRequestUninstall）；
 * intl 由原闭包改为 useACodeIntl 自取（原文 intl 也只用于 formatMessage，行为等价）。
 * JSX 结构与 data-testid/aria 属性逐字保留，仅三处回调改名：
 *   void handleUpdatePlugin(plugin.id)        → void onUpdatePlugin(plugin.id)
 *   void handleResetPluginConfig(plugin.id)   → void onResetPluginConfig(plugin.id)
 *   uninstall.requestUninstall(plugin.id)     → onRequestUninstall(plugin.id)
 */
import { Fragment } from "react";
import { Loader2, MoreHorizontal, RefreshCw, RotateCcw, Trash2 } from "lucide-react";

import { type V4PluginInfo, type V4PluginScope } from "@acode/shared/acode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Switch } from "@/components/ui/switch.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { SettingsScopeBadge } from "@/settings/SettingsScopeBadge.js";
import {
  PluginStoreUpdateBadge,
  PluginStoreUpdateButton,
  type PluginStoreActions,
} from "@/settings/PluginStoreCard.js";
import {
  canUpdatePluginItem,
  resolveManagedPluginDisplay,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";

export interface PluginListRowsProps {
  items: V4PluginInfo[];
  storeItemById: ReadonlyMap<string, StorePluginItem>;
  actions: PluginStoreActions;
  configScope: V4PluginScope;
  operationId: string | null;
  togglingPluginId: string | null;
  locale: string;
  onUpdatePlugin: (pluginId: string) => Promise<void>;
  onResetPluginConfig: (pluginId: string) => Promise<void>;
  onRequestUninstall: (pluginId: string) => void;
}

export function PluginListRows({
  items,
  storeItemById,
  actions,
  configScope,
  operationId,
  togglingPluginId,
  locale,
  onUpdatePlugin,
  onResetPluginConfig,
  onRequestUninstall,
}: PluginListRowsProps) {
  const { intl } = useACodeIntl();
  return (
    <div className="overflow-hidden rounded-xl bg-surface">
      {items.map((plugin, index) => (
        <Fragment key={plugin.id}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          <div
            className="group/plugin-row flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
            data-testid="plugin-settings-plugin-row"
            data-plugin-id={plugin.id}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              onClick={() => actions.onOpenDetail(plugin.id)}
            >
              <PluginStoreAvatar
                item={storeItemById.get(plugin.id) ?? { name: plugin.name }}
                className="size-9 bg-background"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                    {resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name}
                  </span>
                  <PluginStoreUpdateBadge item={storeItemById.get(plugin.id)} />
                </div>
                {resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale)
                  .description ? (
                  <div className="mt-0.5 line-clamp-1 text-ui-sm text-foreground-subtle">
                    {
                      resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale)
                        .description
                    }
                  </div>
                ) : null}
                <div className="mt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SettingsScopeBadge
                      scope={plugin.enabledSource ?? "default"}
                      label={
                        configScope === "user" && plugin.enabledSource === "user"
                          ? intl.formatMessage({
                              id: "settings.plugins.scope.userDefault",
                            })
                          : plugin.enabledSource === "user"
                            ? intl.formatMessage({
                                id: "settings.plugins.scope.inheritedUser",
                              })
                            : plugin.enabledSource === "workspace"
                              ? intl.formatMessage({
                                  id: "settings.plugins.scope.workspaceOverride",
                                })
                              : undefined
                      }
                    />
                  </div>
                </div>
              </div>
            </button>
            <PluginStoreUpdateButton item={storeItemById.get(plugin.id)} actions={actions} />
            {plugin.packageStatus === "missing" ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({ id: "common.more" })}
                    className="text-foreground-subtle opacity-0 group-hover/plugin-row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canUpdatePluginItem(storeItemById.get(plugin.id)) ? (
                    <DropdownMenuItem
                      disabled={operationId !== null}
                      onSelect={() => void onUpdatePlugin(plugin.id)}
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.plugins.detail.update",
                      })}
                    </DropdownMenuItem>
                  ) : null}
                  {configScope === "workspace" && plugin.enabledSource === "workspace" ? (
                    <DropdownMenuItem
                      disabled={operationId !== null || togglingPluginId === plugin.id}
                      onSelect={() => void onResetPluginConfig(plugin.id)}
                    >
                      <RotateCcw className="size-4" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.plugins.scope.restoreUserDefault",
                      })}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={operationId !== null}
                    onSelect={() => onRequestUninstall(plugin.id)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    {intl.formatMessage({
                      id: "settings.plugins.detail.uninstall",
                    })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <div className="flex shrink-0 items-center gap-2">
              {togglingPluginId === plugin.id ? (
                <Loader2
                  className="size-4 animate-spin text-foreground-subtle"
                  data-testid="plugin-settings-enabled-pending"
                  aria-label={intl.formatMessage(
                    { id: "settings.plugins.toggle.pending" },
                    {
                      plugin: resolveManagedPluginDisplay(
                        plugin,
                        storeItemById.get(plugin.id),
                        locale,
                      ).name,
                    },
                  )}
                />
              ) : null}
              <Switch
                data-testid="plugin-settings-enabled-switch"
                data-plugin-id={plugin.id}
                checked={plugin.enabled}
                disabled={togglingPluginId === plugin.id}
                aria-busy={togglingPluginId === plugin.id}
                aria-label={intl.formatMessage(
                  {
                    id: plugin.enabled
                      ? "settings.plugins.toggle.disable"
                      : "settings.plugins.toggle.enable",
                  },
                  {
                    plugin: resolveManagedPluginDisplay(
                      plugin,
                      storeItemById.get(plugin.id),
                      locale,
                    ).name,
                  },
                )}
                onCheckedChange={(enabled) => {
                  actions.onSetEnabled?.(plugin.id, enabled);
                }}
              />
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
