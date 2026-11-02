import { Loader2, RefreshCw } from "lucide-react";
import type { ProviderImportServicePort } from "@acode/services";
import { TID_MODEL_PROVIDER_IMPORT_DIALOG } from "@acode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderImportCandidateList } from "./provider-import/ProviderImportCandidateList.js";
import {
  ProviderImportResultList,
  ProviderImportWarningSection,
} from "./provider-import/ProviderImportResultList.js";
import { ProviderImportSourcePicker } from "./provider-import/ProviderImportSourcePicker.js";
import { providerImportErrorMessageId } from "./provider-import/providerImportModel.js";
import { useProviderImportState } from "./provider-import/useProviderImportState.js";

/**
 * Provider 配置导入向导（docs/specs/provider-config-import.md R8）。
 * 步骤：sources（来源勾选，默认全选）→ scanning → preview（预览 + 去重 + 勾选）
 *      → importing → result（逐项结果 + 来源告警聚合）。
 * 服务经 `useServices().providerSettingsService`（hooks 纪律）；向导态是组件局部态（不进 store）。
 */
export function ProviderImportDialog({
  open,
  onOpenChange,
  onImported,
  service: serviceOverride,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void> | void;
  /** 仅测试注入；生产走 useServices()。 */
  service?: ProviderImportServicePort;
}) {
  const { intl } = useACodeIntl();
  const { providerSettingsService } = useServices();
  const service = serviceOverride ?? providerSettingsService;
  const state = useProviderImportState({ open, service, onImported });
  const importCount = state.selectedCandidateIds.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_MODEL_PROVIDER_IMPORT_DIALOG}
        className="max-h-[min(40rem,calc(100vh-4rem))] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-clip"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate">
            {intl.formatMessage({ id: "settings.modelProvider.import.title" })}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3">
          {state.step === "sources" ? (
            <ProviderImportSourcePicker
              selectedSources={state.selectedSources}
              disabled={state.busy}
              onSourceSelected={state.setSourceSelected}
              onSelectAll={state.selectAllSources}
              onClearAll={state.clearAllSources}
            />
          ) : null}

          {state.step === "scanning" || state.step === "importing" ? (
            <div className="flex min-h-32 items-center justify-center gap-2 text-ui-base text-foreground-subtle">
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              {intl.formatMessage({
                id:
                  state.step === "scanning"
                    ? "settings.modelProvider.import.scanning"
                    : "settings.modelProvider.import.importing",
              })}
            </div>
          ) : null}

          {state.step === "preview" ? (
            <>
              <ProviderImportCandidateList
                candidates={state.candidates}
                selectedCandidateIds={state.selectedCandidateIds}
                disabled={state.busy}
                onToggleCandidate={state.toggleCandidate}
                onSelectAll={state.selectAllCandidates}
                onClearAll={state.clearAllCandidates}
              />
              <ProviderImportWarningSection warnings={state.warnings} />
            </>
          ) : null}

          {state.step === "result" ? (
            <>
              <ProviderImportResultList result={state.importResult} />
              <ProviderImportWarningSection warnings={state.warnings} />
            </>
          ) : null}

          {state.step === "sources" && state.hasScanned && state.errorCode === null ? (
            // 「未发现任何来源」不是错误：空态给出各来源路径说明与「重新扫描」出路（R8）。
            <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.import.empty" })}
            </div>
          ) : null}

          {state.errorCode && state.step !== "result" ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
              <span className="min-w-0">
                {intl.formatMessage({ id: providerImportErrorMessageId(state.errorCode) })}
              </span>
              {state.rescanRequired ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0 rounded-md"
                  disabled={state.busy || state.selectedSources.length === 0}
                  onClick={() => void state.rescan()}
                >
                  <RefreshCw className="size-3" aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.modelProvider.import.rescan" })}
                </Button>
              ) : null}
            </div>
          ) : null}

          {state.missingCandidateId ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.import.error.candidateMissingNote" })}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          {/* Q5 环境语义：远端 workspace 时「本机」是服务所在主机，须显式说明。 */}
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.import.hostNote" })}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({
                id:
                  state.step === "result"
                    ? "settings.modelProvider.import.finish"
                    : "settings.modelProvider.import.cancel",
              })}
            </Button>
            {state.step === "sources" ? (
              <Button
                type="button"
                className="rounded-lg"
                disabled={state.busy || state.selectedSources.length === 0}
                onClick={() => void state.startScan()}
              >
                {intl.formatMessage({
                  id: state.hasScanned
                    ? "settings.modelProvider.import.rescan"
                    : "settings.modelProvider.import.scan",
                })}
              </Button>
            ) : null}
            {state.step === "preview" ? (
              <Button
                type="button"
                className="rounded-lg"
                disabled={state.busy || importCount === 0}
                onClick={() => void state.submitImport()}
              >
                {intl.formatMessage(
                  { id: "settings.modelProvider.import.confirm" },
                  { count: importCount },
                )}
              </Button>
            ) : null}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}