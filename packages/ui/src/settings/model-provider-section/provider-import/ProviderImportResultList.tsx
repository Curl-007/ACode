import type { ProviderImportResult, ProviderImportWarning } from "@acode/services";
import { Badge } from "@/components/ui/badge.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { providerImportWarningMessageId } from "./providerImportModel.js";

/**
 * 结果反馈分级（R8 / EI-98~101）：
 * - 逐项 imported/skipped 走对话框内列表（附原因），不做逐条 toast；
 * - 来源 warning 作为对话框内**一处**可展开告警区（聚合展示）；
 * - 空态（无任何来源）在对话框「来源」步由空态说明承载，不在此重复。
 */
export function ProviderImportResultList({ result }: { result: ProviderImportResult | null }) {
  const { intl } = useACodeIntl();
  if (!result?.ok) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.import.result.empty" })}
      </div>
    );
  }
  const rows = [
    ...result.imported.map((item) => ({
      key: `imported:${item.id}`,
      name: item.name,
      detail: item.modelIds.join(", "),
      imported: true,
      reason: null as string | null,
    })),
    ...result.skipped.map((item) => ({
      key: `skipped:${item.id}`,
      name: item.name,
      detail: "",
      imported: false,
      reason: item.reason,
    })),
  ];
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-surface px-3 py-2 text-ui-xs text-foreground-subtle">
        <span className="inline-flex items-baseline gap-1.5">
          <span className="font-mono text-ui-base font-medium text-foreground">
            {result.imported.length}
          </span>
          {intl.formatMessage({ id: "settings.modelProvider.import.result.imported" })}
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <span className="font-mono text-ui-base font-medium text-foreground">
            {result.skipped.length}
          </span>
          {intl.formatMessage({ id: "settings.modelProvider.import.result.skipped" })}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-input-border bg-input">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex min-w-0 items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0"
          >
            <Badge
              variant="outline"
              className={
                row.imported
                  ? "h-5 shrink-0 border-success/40 bg-success/10 px-1.5 text-ui-xs font-normal"
                  : "h-5 shrink-0 border-warning/40 bg-warning/10 px-1.5 text-ui-xs font-normal"
              }
            >
              {intl.formatMessage({
                id: row.imported
                  ? "settings.modelProvider.import.result.imported"
                  : "settings.modelProvider.import.result.skipped",
              })}
            </Badge>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui-base text-foreground">{row.name}</span>
              {row.detail ? (
                <span className="block truncate font-mono text-ui-xs text-foreground-subtle">
                  {row.detail}
                </span>
              ) : null}
            </span>
            {row.reason ? (
              <span className="shrink-0 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: `settings.modelProvider.import.skipReason.${row.reason}` })}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 来源 warning 聚合告警区（可展开；不逐条 toast）。 */
export function ProviderImportWarningSection({
  warnings,
}: {
  warnings: readonly ProviderImportWarning[];
}) {
  const { intl } = useACodeIntl();
  if (warnings.length === 0) return null;
  return (
    <details className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-xs text-foreground">
      <summary className="cursor-pointer select-none font-medium">
        {intl.formatMessage(
          { id: "settings.modelProvider.import.warnings.title" },
          { count: warnings.length },
        )}
      </summary>
      <ul className="mt-2 flex flex-col gap-1">
        {warnings.map((warning, index) => (
          <li key={`${warning.code}:${index}`} className="break-all">
            {intl.formatMessage(
              { id: providerImportWarningMessageId(warning.code) },
              warning.params as Record<string, string | number>,
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}