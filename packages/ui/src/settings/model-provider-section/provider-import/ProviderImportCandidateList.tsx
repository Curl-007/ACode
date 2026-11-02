import type { ProviderImportCandidateView } from "@acode/services";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { resolveProviderConnectionApiFormatDisplayLabel } from "@/settings/model-provider-section/ProviderApiFormatSelect.js";
import {
  buildProviderImportCandidateRows,
  type ProviderImportCandidateRow,
} from "./providerImportModel.js";

/**
 * 候选预览列表（R8）：每行 = 名称 + 来源标签 + 协议（三值同款文案）+ baseUrl（Q6 展示）+
 * key 状态（apiKeyHint 或未检测到 Key）+ 模型数；重复项显示徽标且 existing 默认不勾。
 * 行数据来自 `buildProviderImportCandidateRows` 的白名单投影（不携带任何未列字段）。
 */
export function ProviderImportCandidateList({
  candidates,
  selectedCandidateIds,
  disabled,
  onToggleCandidate,
  onSelectAll,
  onClearAll,
}: {
  candidates: readonly ProviderImportCandidateView[];
  selectedCandidateIds: readonly string[];
  disabled: boolean;
  onToggleCandidate: (candidateId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const { intl } = useACodeIntl();
  const rows = buildProviderImportCandidateRows(candidates);
  const selected = new Set(selectedCandidateIds);
  const selectableCount = rows.filter((row) => row.selectable).length;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.modelProvider.import.preview.summary" },
            { count: rows.length },
          )}
        </span>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="rounded-md"
            disabled={disabled || selectableCount === 0}
            onClick={onSelectAll}
          >
            {intl.formatMessage({ id: "settings.modelProvider.import.preview.selectAll" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="rounded-md"
            disabled={disabled}
            onClick={onClearAll}
          >
            {intl.formatMessage({ id: "settings.modelProvider.import.preview.clearAll" })}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-input-border bg-input">
        {rows.map((row) => (
          <ProviderImportCandidateRowItem
            key={row.id}
            row={row}
            checked={selected.has(row.id)}
            disabled={disabled}
            onToggle={onToggleCandidate}
          />
        ))}
      </div>
      <div className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage(
          { id: "settings.modelProvider.import.preview.selectionCount" },
          { selected: selected.size, total: rows.length },
        )}
      </div>
    </div>
  );
}

function ProviderImportCandidateRowItem({
  row,
  checked,
  disabled,
  onToggle,
}: {
  row: ProviderImportCandidateRow;
  checked: boolean;
  disabled: boolean;
  onToggle: (candidateId: string, checked: boolean) => void;
}) {
  const { intl } = useACodeIntl();
  return (
    <label
      className={cn(
        "flex items-start gap-3 border-b border-border px-3 py-2 text-ui-base last:border-b-0",
        disabled ? "opacity-60" : "cursor-pointer",
      )}
    >
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onToggle(row.id, next === true)}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-medium text-foreground">{row.name}</span>
          {row.isCurrent ? (
            <Badge
              variant="outline"
              className="h-5 border-border bg-surface px-1.5 text-ui-xs font-normal text-foreground-subtle"
            >
              {intl.formatMessage({ id: "settings.modelProvider.import.preview.current" })}
            </Badge>
          ) : null}
          {row.duplicate ? (
            <Badge
              variant="outline"
              className="h-5 border-warning/40 bg-warning/10 px-1.5 text-ui-xs font-normal text-foreground"
            >
              {intl.formatMessage({
                id:
                  row.duplicate === "existing"
                    ? "settings.modelProvider.import.preview.duplicateExisting"
                    : "settings.modelProvider.import.preview.duplicateCandidate",
              })}
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 block text-ui-xs text-foreground-subtle">
          {row.sourceLabel}
          {" · "}
          {resolveProviderConnectionApiFormatDisplayLabel(intl, row.api)}
          {" · "}
          {intl.formatMessage(
            { id: "settings.modelProvider.import.preview.modelCount" },
            { count: row.modelCount },
          )}
        </span>
        {row.duplicateOf ? (
          <span className="mt-0.5 block text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              {
                id:
                  row.duplicate === "existing"
                    ? "settings.modelProvider.import.preview.duplicateExistingReason"
                    : "settings.modelProvider.import.preview.duplicateCandidateReason",
              },
              { name: row.duplicateOf },
            )}
          </span>
        ) : null}
        {row.baseUrl ? (
          <span className="mt-0.5 block break-all font-mono text-ui-xs text-foreground-subtle">
            {row.baseUrl}
          </span>
        ) : null}
        {row.modelPreview ? (
          <span className="mt-0.5 block truncate font-mono text-ui-xs text-foreground-subtlest">
            {row.modelPreview}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-right text-ui-xs text-foreground-subtle">
        {row.hasApiKey && row.apiKeyHint
          ? intl.formatMessage(
              { id: "settings.modelProvider.import.preview.keyPresent" },
              { hint: row.apiKeyHint },
            )
          : intl.formatMessage({ id: "settings.modelProvider.import.preview.keyMissing" })}
      </span>
    </label>
  );
}