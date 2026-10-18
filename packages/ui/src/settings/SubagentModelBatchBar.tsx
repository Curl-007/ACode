import { useCallback, useMemo, useState } from "react";
import { Loader2, ListChecks, X } from "lucide-react";
import {
  TID_SUBAGENT_BATCH_APPLY,
  TID_SUBAGENT_BATCH_BAR,
  TID_SUBAGENT_BATCH_MODEL_TRIGGER,
} from "@acode/shared";
import type { ModelSelectionView } from "@acode/services";
import { completeNewModelSelection } from "@acode/provider";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  SubagentReasoningField,
  type SubagentReasoningFieldState,
} from "@/settings/SubagentReasoningField.js";
import { parseModelPickerValue } from "@/lib/acodeSessionProjection.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { resolveModelDisplayName } from "@/lib/modelSelectionGroups.js";
import {
  describeBatchResult,
  isBatchValueInherit,
  type SubagentModelBatchResult,
  type SubagentModelBatchValue,
} from "@/settings/SubagentModelBatchApply.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;
const INHERIT_MODEL_VALUE = "inherit";

function isBatchModelAvailable(
  modelGroups: readonly ModelSelectGroup[],
  model: string | undefined,
  modelSelectionLoading: boolean,
): boolean {
  const trimmed = model?.trim();
  if (!trimmed) return true;
  if (modelSelectionLoading) return true;
  return modelGroups.some((group) => group.items.some((item) => item.value === trimmed));
}

/**
 * 方案 A：批量模式吸底操作条。已选计数 + 批量目标值控件 + 应用/退出；
 * 应用语义（逐行串行、失败行保留原值）由 SubagentsSection 的 apply 回调执行，
 * 操作条只负责目标值暂存与进度/结果展示，不持有已确认状态。
 */
export function SubagentModelBatchBar({
  selectedCount,
  applying,
  progress,
  result,
  disabled,
  modelGroups,
  modelSelectionView,
  modelSelectionLoading,
  onValueChange,
  onApply,
  onExit,
}: {
  selectedCount: number;
  applying: boolean;
  progress: { done: number; total: number } | null;
  result: SubagentModelBatchResult | null;
  disabled: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  onValueChange: (value: SubagentModelBatchValue) => void;
  onApply: (value: SubagentModelBatchValue) => void;
  onExit: () => void;
}) {
  const { intl } = useACodeIntl();
  const inheritLabel = intl.formatMessage({ id: "settings.subagents.model.inherit" });
  const selectModelLabel = intl.formatMessage({ id: "settings.subagents.model.select" });
  const [model, setModel] = useState<string | undefined>(undefined);
  const [thoughtLevel, setThoughtLevel] = useState<string | undefined>(undefined);
  const [selection, setSelection] = useState<SubagentModelBatchValue["modelSelection"]>(undefined);

  const value = model ?? INHERIT_MODEL_VALUE;
  const modelAvailable = isBatchModelAvailable(modelGroups, model, modelSelectionLoading);
  const applyDisabled =
    disabled || applying || selectedCount === 0 || (!modelAvailable && Boolean(model?.trim()));

  const thoughtState: SubagentReasoningFieldState = useMemo(() => {
    const trimmed = model?.trim();
    if (!trimmed || !modelAvailable || trimmed === INHERIT_MODEL_VALUE) {
      return { kind: "not-applicable" };
    }
    const selection = parseModelPickerValue(trimmed);
    const metadataOption = modelSelectionView
      ? resolveModelThoughtOption({
          modelSelectionView,
          providerId: selection.providerId,
          modelId: selection.modelId,
          currentValue: thoughtLevel,
        })
      : null;
    if (metadataOption) {
      return { kind: "supported", option: metadataOption };
    }
    if (modelSelectionLoading) {
      return { kind: "unknown", status: "loading" };
    }
    return { kind: "unsupported" };
  }, [model, modelAvailable, modelSelectionLoading, modelSelectionView, thoughtLevel]);

  const handleModelValueChange = useCallback(
    (nextValue: string) => {
      const nextModel = nextValue === INHERIT_MODEL_VALUE ? undefined : nextValue;
      if (nextModel === model) {
        return;
      }
      setModel(nextModel);
      // 目标值在组件内直接解析成 ModelSelection 结构体，调用方不再做字符串往返，
      // 避免 custom: 编码串被手写切分后双重编码落盘。
      // completeNewModelSelection 会按 Registry 补默认推理档位。
      let nextThoughtLevel: string | undefined;
      let nextSelection: SubagentModelBatchValue["modelSelection"];
      if (nextModel && modelSelectionView) {
        const completed = completeNewModelSelection(
          modelSelectionView,
          parseModelPickerValue(nextModel),
        );
        nextSelection = completed ?? undefined;
        nextThoughtLevel = completed?.options?.reasoningLevel;
      }
      setSelection(nextSelection);
      setThoughtLevel(nextThoughtLevel);
      onValueChange({
        modelSelection: nextSelection,
        thoughtLevel: nextThoughtLevel,
      });
    },
    [model, modelSelectionView, onValueChange],
  );

  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "subagent-model:batch-inherit",
        label: inheritLabel,
        onSelect: () => handleModelValueChange(INHERIT_MODEL_VALUE),
        selected: value === INHERIT_MODEL_VALUE,
      },
    ],
    [handleModelValueChange, inheritLabel, value],
  );

  const triggerLabel =
    value === INHERIT_MODEL_VALUE
      ? inheritLabel
      : !modelAvailable
        ? selectModelLabel
        : (resolveModelDisplayName(modelGroups, value) ?? value);

  const resultSummary = result ? describeBatchResult(result) : null;

  return (
    <div
      data-testid={TID_SUBAGENT_BATCH_BAR}
      className="sticky bottom-0 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-card-border bg-card px-4 py-3 shadow-lg"
    >
      <span className="flex items-center gap-2 text-ui-base text-foreground">
        <ListChecks className="size-4 text-foreground-subtle" aria-hidden="true" />
        {intl.formatMessage(
          { id: "settings.subagents.batch.bar.selected" },
          { count: String(selectedCount) },
        )}
      </span>
      <span className="h-4 w-px bg-border" aria-hidden="true" />
      <span data-testid={TID_SUBAGENT_BATCH_MODEL_TRIGGER} className="inline-flex min-w-0">
        <ModelConfigSelect
          modelGroups={modelGroups}
          normalizedValue={value}
          triggerLabel={triggerLabel}
          showManageModelsAction={false}
          lockReasonMessage=""
          isItemLocked={MODEL_ITEM_NEVER_LOCKED}
          onValueChange={handleModelValueChange}
          footerActions={footerActions}
          disabled={disabled || applying}
          contentSide="top"
          contentAlign="start"
          focusSelectorOnClose={null}
          labelVisibilityClassName="inline-flex min-w-0"
          triggerClassName="h-8 w-fit max-w-full min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
          triggerLabelClassName="inline-flex min-w-0 text-left [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
        />
      </span>
      {thoughtState.kind === "supported" || thoughtState.kind === "unknown" ? (
        <SubagentReasoningField
          intl={intl}
          state={thoughtState}
          disabled={disabled || applying}
          labelVisibilityClassName="hidden sm:inline-flex"
          onValueCommit={(nextLevel) => {
            setThoughtLevel(nextLevel);
            onValueChange({ modelSelection: selection, thoughtLevel: nextLevel });
          }}
        />
      ) : null}
      {progress ? (
        <span className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          {intl.formatMessage(
            { id: "settings.subagents.batch.bar.progress" },
            { done: String(progress.done), total: String(progress.total) },
          )}
        </span>
      ) : null}
      {resultSummary && !applying ? (
        <span className="flex min-w-0 flex-col text-ui-sm">
          {resultSummary.failedCount > 0 ? (
            <>
              <span className="text-foreground">
                {intl.formatMessage(
                  { id: "settings.subagents.batch.result.partial" },
                  {
                    succeeded: String(resultSummary.succeededCount),
                    failed: String(resultSummary.failedCount),
                  },
                )}
              </span>
              <span className="truncate text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.subagents.batch.result.failedNames" },
                  {
                    names: resultSummary.failedNames.join(
                      intl.formatMessage({ id: "common.listSeparator" }),
                    ),
                  },
                )}
              </span>
            </>
          ) : (
            <span className="text-foreground">
              {intl.formatMessage(
                { id: "settings.subagents.batch.result.success" },
                { count: String(resultSummary.succeededCount) },
              )}
            </span>
          )}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={
            disabled ||
            applying ||
            selectedCount === 0 ||
            isBatchValueInherit({ modelSelection: selection, thoughtLevel })
          }
          onClick={() => {
            setModel(undefined);
            setSelection(undefined);
            setThoughtLevel(undefined);
            onValueChange({});
            onApply({});
          }}
        >
          {intl.formatMessage({ id: "settings.subagents.batch.bar.setInherit" })}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          data-testid={TID_SUBAGENT_BATCH_APPLY}
          disabled={applyDisabled}
          onClick={() => onApply({ modelSelection: selection, thoughtLevel })}
        >
          {applying ? (
            <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden="true" />
          ) : null}
          {intl.formatMessage({ id: "settings.subagents.batch.bar.apply" })}
        </Button>
        <ControlHintTooltip title={intl.formatMessage({ id: "settings.subagents.batch.bar.exit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "settings.subagents.batch.bar.exit" })}
            disabled={applying}
            onClick={onExit}
          >
            <X aria-hidden="true" />
          </Button>
        </ControlHintTooltip>
      </span>
    </div>
  );
}
