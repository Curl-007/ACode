/**
 * RemotePluginSyncDialog 批次 2 拆出的 ResultList：同步结果展示（成功/失败/跳过/停止）。
 * 每条目使用 (pluginId, directoryName, status) 三元组作为 React key，重名候选不冲突。
 * 状态徽章复用 ./ProgressList.js 的 RemotePluginSyncStatusBadge，避免双份实现漂移。
 */
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { RemotePluginSyncRunResult } from "./remotePluginSyncModel.js";
import { RemotePluginSyncStatusBadge } from "./ProgressList.js";

export function RemotePluginSyncResultList({ result }: { result: RemotePluginSyncRunResult | null }) {
  const { intl } = useACodeIntl();
  const items = result?.results ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div
            key={`${item.pluginId}-${item.directoryName}-${item.status}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">{item.name}</div>
              {item.error ? (
                <div className="mt-0.5 break-words text-ui-base text-destructive">{item.error}</div>
              ) : item.path ? (
                <div className="mt-0.5 truncate font-mono text-ui-xs text-foreground-subtlest">
                  {item.path}
                </div>
              ) : null}
            </div>
            <RemotePluginSyncStatusBadge status={item.status} />
          </div>
        ))}
      </div>
    </div>
  );
}
