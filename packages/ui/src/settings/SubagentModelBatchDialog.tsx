import { useCallback, useMemo, useState } from "react";
import { TID_SUBAGENT_BATCH_DIALOG } from "@acode/shared";
import type { ModelSelectionView } from "@acode/services";
import { completeNewModelSelection } from "@acode/provider";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  SubagentReasoningField,
  type SubagentReasoningFieldState,
} from "@/settings/SubagentReasoningField.js";
import { SubagentSpeedField, type SubagentSpeedFieldState } from "@/settings/SubagentSpeedField.js";
import { parseModelPickerValue } from "@/lib/acodeSessionProjection.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import {
  isBatchValueInherit,
  resolveSubagentSpeedOptionState,
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
 * 方案 B：分组「统一设置模型」弹层。模型与推理档位控件复用行内覆盖控件同款
 * （ModelConfigSelect + SubagentReasoningField），确认后由调用方逐行落盘；
 * 弹层本身不持有已确认状态，只暂存目标值。
 */
export function SubagentModelBatchDialog({
  open,
  groupName,
  targetCount,
  disabled,
  modelGroups,
  modelSelectionView,
  modelSelectionLoading,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  groupName: string;
  targetCount: number;
  disabled: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (value: SubagentModelBatchValue) => void;
}) {
  const { intl } = useZCodeIntl();
  const inheritLabel = intl.formatMessage({ id: "settings.subagents.model.inherit" });
  const selectModelLabel = intl.formatMessage({ id: "settings.subagents.model.select" });
  const [model, setModel] = useState<string | undefined>(undefined);
  const [thoughtLevel, setThoughtLevel] = useState<string | undefined>(undefined);
  const [speed, setSpeed] = useState<string | undefined>(undefined);
  const [selection, setSelection] = useState<SubagentModelBatchValue["modelSelection"]>(undefined);

  const value = model ?? INHERIT_MODEL_VALUE;
  const modelAvailable = isBatchModelAvailable(modelGroups, model, modelSelectionLoading);

  // 弹层内的档位判定与行内控件共享同一套 Registry 投影逻辑：模型未指定或不可用时
  // 不出现档位控件，避免把继承默认当成可配置档位的模型。
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
      // 换模型后旧档位失效；未显式选择时沿用 Registry 默认档位与默认 speed，
      // 与行内控件一致。completeNewModelSelection 会同时补齐两个维度。
      // 目标值在弹层内解析成 ModelSelection 结构体，调用方不再做字符串往返，
      // 避免 custom: 编码串被手写切分后双重编码落盘。
      let nextThoughtLevel: string | undefined;
      let nextSpeed: string | undefined;
      let nextSelection: SubagentModelBatchValue["modelSelection"];
      if (nextModel && modelSelectionView) {
        const completed = completeNewModelSelection(
          modelSelectionView,
          parseModelPickerValue(nextModel),
        );
        nextSelection = completed ?? undefined;
        nextThoughtLevel = completed?.options?.reasoningLevel;
        nextSpeed = completed?.options?.speed;
      }
      setSelection(nextSelection);
      setThoughtLevel(nextThoughtLevel);
      setSpeed(nextSpeed);
    },
    [model, modelSelectionView],
  );

  const speedState: SubagentSpeedFieldState = useMemo(
    () =>
      resolveSubagentSpeedOptionState({
        modelSelectionView,
        modelSelection: selection,
        modelSelectionLoading,
      }),
    [modelSelectionLoading, modelSelectionView, selection],
  );
  // 目标模型带 speed spec 时 speed 必选，否则运行时派发报 speed-missing。
  const speedRequired = speedState.kind === "supported" && !speed;

  const handleApply = useCallback(() => {
    if (isBatchValueInherit({ modelSelection: selection, thoughtLevel, speed })) {
      onApply({});
      return;
    }
    if (!modelAvailable || speedRequired) {
      return;
    }
    onApply({ modelSelection: selection, thoughtLevel, speed });
  }, [selection, modelAvailable, onApply, speed, speedRequired, thoughtLevel]);

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

  const confirmDisabled = disabled || (!modelAvailable && Boolean(model?.trim())) || speedRequired;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={TID_SUBAGENT_BATCH_DIALOG} className="sm:max-w-md">
        <DialogHeader className="gap-2">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.subagents.batch.dialog.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.subagents.batch.dialog.scope" },
              { group: groupName, count: String(targetCount) },
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "settings.subagents.form.model.label" })}
            </label>
            <ModelConfigSelect
              modelGroups={modelGroups}
              normalizedValue={value}
              triggerLabel={
                value === INHERIT_MODEL_VALUE
                  ? inheritLabel
                  : modelAvailable
                    ? resolveTriggerLabel(modelGroups, value)
                    : selectModelLabel
              }
              showManageModelsAction={false}
              lockReasonMessage=""
              isItemLocked={MODEL_ITEM_NEVER_LOCKED}
              onValueChange={handleModelValueChange}
              footerActions={footerActions}
              disabled={disabled}
              contentSide="bottom"
              contentAlign="start"
              // 弹层不在 composer 容器内，labelVisibilityClassName 缺省会落到
              // "hidden @xl/composer:inline-flex"——这里不传等于标签永远 display:none，
              // 选完模型触发器上只剩箭头。显式传 inline-flex 修复。
              labelVisibilityClassName="inline-flex min-w-0"
              triggerClassName="h-8 w-full justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
              triggerLabelClassName="inline-flex min-w-0 text-left [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
            />
          </div>
          {thoughtState.kind === "not-applicable" || thoughtState.kind === "unsupported" ? null : (
            <div className="flex flex-col gap-1.5">
              <label className="text-ui-base font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.subagents.batch.dialog.thoughtLevel" })}
              </label>
              <SubagentReasoningField
                intl={intl}
                state={thoughtState}
                disabled={disabled}
                labelVisibilityClassName="inline-flex"
                onValueCommit={(nextLevel) => setThoughtLevel(nextLevel)}
              />
            </div>
          )}
          {thoughtState.kind === "unsupported" && model ? (
            <p className="text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "settings.subagents.reasoningUnavailable" })}
            </p>
          ) : null}
          {speedState.kind === "supported" || speedState.kind === "unknown" ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-ui-base font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.subagents.batch.dialog.speed" })}
              </label>
              <SubagentSpeedField
                intl={intl}
                state={speedState}
                value={speed}
                disabled={disabled}
                labelVisibilityClassName="inline-flex"
                onValueCommit={(nextSpeed) => setSpeed(nextSpeed)}
              />
            </div>
          ) : null}
          {speedRequired ? (
            <p className="text-ui-sm text-warning">
              {intl.formatMessage({ id: "settings.subagents.batch.speedRequired" })}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => onOpenChange(false)}
            disabled={disabled}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="default"
            size="lg"
            onClick={handleApply}
            disabled={confirmDisabled}
          >
            {intl.formatMessage({ id: "common.apply" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function resolveTriggerLabel(modelGroups: readonly ModelSelectGroup[], value: string): string {
  for (const group of modelGroups) {
    const item = group.items.find((entry) => entry.value === value);
    if (item) {
      return item.name;
    }
  }
  return value;
}
