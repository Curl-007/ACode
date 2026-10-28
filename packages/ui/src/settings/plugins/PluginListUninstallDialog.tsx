/**
 * PluginList 详情/列表两分支共用的卸载确认弹窗（受控组件）。
 * 批次 4 helper 外迁（2026-10-28）：自 settings/PluginsSection.tsx 逐字迁移——该 JSX 在
 * 原 PluginList 的详情分支与列表分支各出现一次（逐字重复），收口为单叶消除重复；
 * props 显式传入，JSX 未改一字。
 */
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import {
  resolvePluginDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import type { PluginUninstallController } from "@/settings/usePluginUninstall.js";

export function PluginListUninstallDialog({
  uninstall,
  storeItemById,
  locale,
}: {
  uninstall: PluginUninstallController;
  storeItemById: ReadonlyMap<string, StorePluginItem>;
  locale: string;
}) {
  return (
    <PluginUninstallConfirmDialog
      open={uninstall.pendingPlugin !== null}
      pluginName={
        uninstall.pendingPlugin
          ? resolvePluginDisplayName(
              storeItemById.get(uninstall.pendingPlugin.id) ?? {
                name: uninstall.pendingPlugin.name,
              },
              locale,
            )
          : ""
      }
      pending={uninstall.uninstalling}
      onCancel={uninstall.cancelUninstall}
      onConfirm={() => void uninstall.confirmUninstall()}
    />
  );
}
