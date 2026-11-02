import type { ProviderImportSource } from "@acode/services";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { PROVIDER_IMPORT_SOURCE_PRESENTATIONS } from "./providerImportModel.js";

/** 来源勾选（R8）：默认全选，每条显示来源名与静态 `~` 路径标签（实际路径由 host 定位）。 */
export function ProviderImportSourcePicker({
  selectedSources,
  disabled,
  onSourceSelected,
  onSelectAll,
  onClearAll,
}: {
  selectedSources: readonly ProviderImportSource[];
  disabled: boolean;
  onSourceSelected: (source: ProviderImportSource, checked: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const { intl } = useACodeIntl();
  const selected = new Set(selectedSources);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.import.source.label" })}
        </span>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="rounded-md"
            disabled={disabled}
            onClick={onSelectAll}
          >
            {intl.formatMessage({ id: "settings.modelProvider.import.source.selectAll" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="rounded-md"
            disabled={disabled}
            onClick={onClearAll}
          >
            {intl.formatMessage({ id: "settings.modelProvider.import.source.clearAll" })}
          </Button>
        </div>
      </div>
      <div className="rounded-lg border border-input-border bg-input">
        {PROVIDER_IMPORT_SOURCE_PRESENTATIONS.map((presentation) => (
          <label
            key={presentation.source}
            className="flex cursor-pointer items-center gap-3 px-3 py-2 text-ui-base"
          >
            <Checkbox
              checked={selected.has(presentation.source)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onSourceSelected(presentation.source, checked === true)
              }
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground">
                {intl.formatMessage({ id: presentation.labelId })}
              </span>
              <span className="block truncate font-mono text-ui-xs text-foreground-subtle">
                {presentation.pathLabel}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}