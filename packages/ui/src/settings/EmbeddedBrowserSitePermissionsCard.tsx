import { useCallback, useEffect, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { embeddedBrowserPermissionLabelId } from "@/lib/embeddedBrowserPermissionPresentation.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 设置页「站点权限」管理面（packages/desktop/specs/embedded-browser-site-permissions.md）。
 *
 * 数据经 `IPlatformService` 的三个可选方法（get / reset / clear）读写 main 的持久表；
 * 平台方法缺席（Web、老 Host）时**整区隐藏**——管理面没有只读摆着看的道理，弹窗链同样
 * 不可用。这张卡只呈现与转发，决策语义（四档、可询问闭集）都在 main。
 */
/** 持久决策的闭集（shared 平台接口的返回值类型；index 未再导出该名，这里按结构同形局部声明）。 */
type SitePermissionDecision = "allow" | "deny";

interface SitePermissionEntry {
  origin: string;
  permission: string;
  decision: SitePermissionDecision;
}

export function EmbeddedBrowserSitePermissionsCard() {
  const { intl } = useACodeIntl();
  const platform = usePlatform();
  const format = intl.formatMessage.bind(intl);
  const available =
    typeof platform.getEmbeddedBrowserSitePermissions === "function" &&
    typeof platform.resetEmbeddedBrowserSitePermission === "function" &&
    typeof platform.clearEmbeddedBrowserSitePermissions === "function";
  const [entries, setEntries] = useState<SitePermissionEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  const reload = useCallback(async () => {
    if (!platform.getEmbeddedBrowserSitePermissions) return;
    setLoading(true);
    try {
      const result = await platform.getEmbeddedBrowserSitePermissions();
      const flattened: SitePermissionEntry[] = [];
      for (const [origin, byPermission] of Object.entries(result.permissions)) {
        for (const [permission, decision] of Object.entries(byPermission)) {
          flattened.push({ origin, permission, decision });
        }
      }
      // 稳定序：站点按字典序、同站点内按权限名——重置后的刷新不跳行。
      flattened.sort((a, b) =>
        a.origin === b.origin
          ? a.permission.localeCompare(b.permission)
          : a.origin.localeCompare(b.origin),
      );
      setEntries(flattened);
      setReadFailed(false);
    } catch (error) {
      logger.warn("[browser-settings] 读取站点权限失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setReadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    if (!available) return;
    void reload();
  }, [available, reload]);

  const handleReset = useCallback(
    async (entry: SitePermissionEntry) => {
      if (!platform.resetEmbeddedBrowserSitePermission) return;
      const key = `${entry.origin}\u0000${entry.permission}`;
      setPendingKey(key);
      try {
        const result = await platform.resetEmbeddedBrowserSitePermission(
          entry.origin,
          entry.permission,
        );
        if (result.success) {
          toast(format({ id: "browser.permission.saved" }));
          await reload();
        } else {
          toast(format({ id: "browser.permission.saveError" }));
        }
      } catch (error) {
        logger.warn("[browser-settings] 重置站点权限失败", {
          error: error instanceof Error ? error.message : String(error),
          origin: entry.origin,
          permission: entry.permission,
        });
        toast(format({ id: "browser.permission.saveError" }));
      } finally {
        setPendingKey(null);
      }
    },
    [format, platform, reload],
  );

  const handleClearAll = useCallback(async () => {
    if (!platform.clearEmbeddedBrowserSitePermissions) return;
    setPendingKey("__clear_all__");
    try {
      const result = await platform.clearEmbeddedBrowserSitePermissions();
      if (result.success) {
        toast(format({ id: "browser.permission.saved" }));
        await reload();
      } else {
        toast(format({ id: "browser.permission.saveError" }));
      }
    } catch (error) {
      logger.warn("[browser-settings] 清空站点权限失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(format({ id: "browser.permission.saveError" }));
    } finally {
      setPendingKey(null);
      setConfirmClearAll(false);
    }
  }, [format, platform, reload]);

  // 平台方法缺席（Web）→ 整区隐藏：设置页不给一个永远报错的死面板。
  if (!available) return null;

  const rows = entries ?? [];
  const header = (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="text-ui-base font-medium text-foreground">
        {format({ id: "browser.permission.settings" })}
      </span>
      {rows.length > 0 ? (
        <Button
          data-testid="browser-site-permissions-clear-all"
          disabled={pendingKey !== null}
          onClick={() => setConfirmClearAll(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          {format({ id: "browser.permission.clearAll" })}
        </Button>
      ) : null}
    </div>
  );

  return (
    <section className="space-y-3">
      {header}
      {readFailed ? (
        <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle">
          {format({ id: "browser.permission.readError" })}
        </div>
      ) : null}
      <SettingsGroupCard>
        <div data-testid="browser-site-permissions-list">
          {loading && rows.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-3 text-ui-base text-foreground-subtle">
              <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
              {format({ id: "common.loading" })}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-3 text-ui-base text-foreground-subtle">
              {format({ id: "browser.permission.empty" })}
            </div>
          ) : (
            rows.map((entry) => {
              const labelId = embeddedBrowserPermissionLabelId(entry.permission);
              const key = `${entry.origin}\u0000${entry.permission}`;
              return (
                <SettingsRow
                  control={
                    <Button
                      data-origin={entry.origin}
                      data-permission={entry.permission}
                      data-testid="browser-site-permission-reset"
                      disabled={pendingKey !== null}
                      onClick={() => void handleReset(entry)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {pendingKey === key ? (
                        <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
                      ) : null}
                      {format({ id: "browser.permission.reset" })}
                    </Button>
                  }
                  description={
                    <span className="break-all font-mono text-ui-sm">{entry.origin}</span>
                  }
                  key={key}
                  label={labelId === undefined ? entry.permission : format({ id: labelId })}
                />
              );
            })
          )}
        </div>
      </SettingsGroupCard>
      <AlertDialog open={confirmClearAll} onOpenChange={setConfirmClearAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{format({ id: "browser.permission.clearAll" })}</AlertDialogTitle>
            {/* 没有专门的确认说明键：标题（「清空全部站点权限」）自解释，不借用浏览器数据
                清理那句话（语义不同——这里不动缓存与登录态）。 */}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingKey !== null}>
              {format({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pendingKey !== null}
              onClick={(event) => {
                event.preventDefault();
                void handleClearAll();
              }}
            >
              {pendingKey === "__clear_all__" ? (
                <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
              ) : null}
              {format({ id: "browser.permission.clearAll" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
