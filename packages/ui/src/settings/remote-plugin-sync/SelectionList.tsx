/**
 * RemotePluginSyncDialog 批次 2 拆出的 SelectionList：候选列表 + 选择/全选/反选 + 过滤行。
 * 纯受控组件：rows / selectedIds / onToggle 全部由父组件（RemotePluginSyncDialog）持有。
 * 数据形状（RemotePluginSyncRow）与展示决策（summarizeLocalPluginOptionsForDisplay）
 * 复用 ./remotePluginSyncModel.js，不另起本地拷贝。
 */
import { Cable } from "lucide-react";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  summarizeLocalPluginOptionsForDisplay,
  type RemotePluginSyncRow,
} from "./remotePluginSyncModel.js";

export function RemotePluginSyncSelectionList({
  rows,
  selectedIds,
  emptyMessageId = "settings.plugins.remoteSync.empty",
  onToggle,
}: {
  rows: readonly RemotePluginSyncRow[];
  selectedIds: ReadonlySet<string>;
  emptyMessageId?: string;
  onToggle: (pluginId: string, checked: boolean) => void;
}) {
  const { intl } = useACodeIntl();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: emptyMessageId })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => {
        const checkboxId = `remote-plugin-sync-${row.candidate.id}`;
        const labelId = `${checkboxId}-label`;
        const selected = !row.exists && selectedIds.has(row.candidate.id);
        const optionSummary = summarizeLocalPluginOptionsForDisplay(row.candidate.pluginOptions);
        return (
          <label
            key={row.candidate.id}
            htmlFor={checkboxId}
            className={`grid grid-cols-[auto_auto_minmax(0,1fr)] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base ${
              row.exists
                ? "cursor-default"
                : "cursor-pointer hover:border-border-hover hover:bg-surface-hover"
            }`}
          >
            <input
              id={checkboxId}
              type="checkbox"
              aria-labelledby={labelId}
              className="mt-1 size-4"
              checked={selected}
              disabled={row.exists}
              onChange={(event) => onToggle(row.candidate.id, event.currentTarget.checked)}
            />
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
              aria-hidden="true"
            >
              <Cable className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span id={labelId} className="font-medium text-foreground">
                  {row.candidate.name}
                </span>
                {row.candidate.version ? (
                  <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                    {row.candidate.version}
                  </span>
                ) : null}
                {row.candidate.componentTypes.map((type) => (
                  <span
                    key={type}
                    className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle"
                  >
                    {type}
                  </span>
                ))}
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {row.candidate.kind === "inline" ? "inline" : row.candidate.marketplace}
                </span>
                {row.exists ? (
                  <span className="text-ui-base text-foreground-subtlest">
                    {intl.formatMessage({ id: "settings.plugins.remoteSync.existing" })}
                  </span>
                ) : null}
              </span>
              {row.candidate.description ? (
                <span className="mt-1 block text-ui-base text-foreground-subtle">
                  {row.candidate.description}
                </span>
              ) : null}
              {row.candidate.path ? (
                <span className="mt-1 block break-all font-mono text-ui-base text-foreground-subtlest">
                  {row.candidate.path}
                </span>
              ) : null}
              {optionSummary ? (
                <span className="mt-1 block text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.plugins.remoteSync.optionsSummary" },
                    {
                      manual: String(optionSummary.manualCount),
                      syncable: String(optionSummary.syncableCount),
                    },
                  )}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
