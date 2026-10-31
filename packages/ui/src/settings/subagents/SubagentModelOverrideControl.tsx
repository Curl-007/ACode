/**
 * 内置与插件 subagent 共用的行内 model / effort 覆盖控件（即改即存）。
 *
 * 从 `settings/SubagentsSection.tsx` 行 617–857 **逐字迁移**（split-plan 批次 2 一部分）。
 * 独立成文件是为了让 `SubagentList.tsx` 满足 split-plan 「新模块 <400 行」的验收口径——
 * 本控件带 useStartPlanRecommendation + persistConfig 回滚语义，与列表行的
 * 批量/启停/删除决策相互独立，单行 246 行自成闭环。
 *
 * 行为不变量（接缝内测试见 packages/ui/test/subagentSections.test.ts）：
 *  - 触发器文案三分支：继承 → 已失效（"选择模型"）→ 当前模型；
 *  - 即改即存失败回滚到 previousConfig，不污染磁盘；
 *  - 显式改 model 时经 Start Plan 推荐门，用户拒绝则不写盘。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { completeNewModelSelection } from "@acode/provider";
import {
  TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER,
  testId,
  type AgentSummary,
} from "@acode/shared";
import type { ModelSelectionView } from "@acode/services";
import {
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { parseModelPickerValue } from "@/lib/modelPickerValue.js";
import { SubagentReasoningField } from "@/settings/SubagentReasoningField.js";
import {
  isSubagentSpeedInvalid,
  resolveSubagentSpeedOptionState,
} from "@/settings/SubagentModelBatchApply.js";
import {
  SubagentSpeedField,
  type SubagentSpeedFieldState,
} from "@/settings/SubagentSpeedField.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import {
  INHERIT_MODEL_VALUE,
  isSubagentModelAvailable,
  isSubagentThoughtLevelAvailable,
  resolveSubagentModelLabel,
  resolveSubagentThoughtOptionState,
  resolvedSubagentThoughtLevel,
  toSubagentModelSelection,
  toSubagentModelValue,
} from "@/settings/subagents/agentModel.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

export function SubagentModelOverrideControl({
  agent,
  disabled,
  modelGroups,
  modelSelectionView,
  modelSelectionLoading,
  onModelOverrideChange,
}: {
  agent: AgentSummary;
  disabled: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  onModelOverrideChange: (
    agent: AgentSummary,
    config: { model?: string; thoughtLevel?: string; speed?: string },
  ) => Promise<void>;
}) {
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");
  const { intl } = useACodeIntl();
  const [pending, setPending] = useState(false);
  const [config, setConfig] = useState<{
    model?: string;
    thoughtLevel?: string;
    speed?: string;
  }>(() => ({
    model: agent.modelSelectionOverride
      ? toSubagentModelValue(agent.modelSelectionOverride)
      : undefined,
    thoughtLevel: agent.modelSelectionOverride?.options?.reasoningLevel,
    speed: agent.modelSelectionOverride?.options?.speed,
  }));
  const defaultLabel = intl.formatMessage({
    id: "settings.subagents.model.defaultMain",
  });
  const selectModelLabel = intl.formatMessage({
    id: "settings.subagents.model.select",
  });
  const value = config.model ?? INHERIT_MODEL_VALUE;
  const modelAvailable = isSubagentModelAvailable(modelGroups, value, modelSelectionLoading);
  const thoughtLevelState = resolveSubagentThoughtOptionState({
    model: value,
    modelAvailable,
    modelSelectionView,
    modelSelectionLoading,
    thoughtLevel: config.thoughtLevel,
  });
  const thoughtLevelInvalid = Boolean(
    config.thoughtLevel &&
    modelAvailable &&
    !isSubagentThoughtLevelAvailable(thoughtLevelState, config.thoughtLevel),
  );
  const speedState: SubagentSpeedFieldState = useMemo(
    () =>
      resolveSubagentSpeedOptionState({
        modelSelectionView,
        modelSelection: config.model ? parseModelPickerValue(config.model) : undefined,
        modelSelectionLoading,
      }),
    [config.model, modelSelectionLoading, modelSelectionView],
  );
  const speedInvalid = isSubagentSpeedInvalid(speedState, config.speed);
  // Coding Plan 连接切换后，Builtin 的旧模型可能不再属于当前候选；仅隐藏 reasoning
  // 会让用户误以为模型仍有效，因此触发器改用“选择模型”提示，候选列表仍只展示当前连接。
  const triggerLabel =
    value === INHERIT_MODEL_VALUE
      ? defaultLabel
      : !modelAvailable
        ? selectModelLabel
        : resolveSubagentModelLabel({
            inheritLabel: defaultLabel,
            modelGroups,
            model: value,
          });
  useEffect(() => {
    setConfig({
      model: agent.modelSelectionOverride
        ? toSubagentModelValue(agent.modelSelectionOverride)
        : undefined,
      thoughtLevel: agent.modelSelectionOverride?.options?.reasoningLevel,
      speed: agent.modelSelectionOverride?.options?.speed,
    });
  }, [agent.modelSelectionOverride]);

  const persistConfig = useCallback(
    async (nextConfig: { model?: string; thoughtLevel?: string; speed?: string }) => {
      if (pending) {
        return;
      }
      const previousConfig = config;
      setConfig(nextConfig);
      setPending(true);
      try {
        let selectedConfig = nextConfig;
        if (nextConfig.model && nextConfig.model !== config.model) {
          const selection = toSubagentModelSelection(
            nextConfig.model,
            nextConfig.thoughtLevel,
            nextConfig.speed,
          );
          const chosen = selection ? await recommendStartPlan(selection) : null;
          if (!chosen) {
            setConfig(previousConfig);
            return;
          }
          selectedConfig = {
            model: toSubagentModelValue(chosen),
            thoughtLevel: chosen.options?.reasoningLevel,
            speed: chosen.options?.speed,
          };
        }
        await onModelOverrideChange(agent, selectedConfig);
        setConfig(selectedConfig);
      } catch {
        setConfig(previousConfig);
      } finally {
        setPending(false);
      }
    },
    [agent, config, onModelOverrideChange, pending, recommendStartPlan],
  );
  const handleValueChange = useCallback(
    (nextValue: string) => {
      const nextModel = nextValue === INHERIT_MODEL_VALUE ? undefined : nextValue;
      if (nextModel === config.model) {
        return;
      }
      const nextModelAvailable = isSubagentModelAvailable(
        modelGroups,
        nextValue,
        modelSelectionLoading,
      );
      const completed =
        nextModel && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(nextModel))
          : undefined;
      const nextThoughtState = resolveSubagentThoughtOptionState({
        model: nextValue,
        modelAvailable: nextModelAvailable,
        modelSelectionView,
        modelSelectionLoading,
        thoughtLevel: completed?.options?.reasoningLevel,
      });
      // 控件会展示 Registry 的正常默认档位，持久化必须保存同一个值，
      // 不能让界面有值而执行 Selection 缺少 reasoningLevel / speed。
      void persistConfig({
        model: nextModel,
        thoughtLevel: resolvedSubagentThoughtLevel(nextThoughtState),
        speed: completed?.options?.speed,
      });
    },
    [config.model, modelGroups, modelSelectionLoading, modelSelectionView, persistConfig],
  );
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "subagent-model:built-in-default",
        label: defaultLabel,
        onSelect: () => handleValueChange(INHERIT_MODEL_VALUE),
        selected: value === INHERIT_MODEL_VALUE,
      },
    ],
    [defaultLabel, handleValueChange, value],
  );

  return (
    <div className="flex min-w-0 max-w-full flex-col items-end gap-1">
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        <span
          data-testid={testId(TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, agent.name)}
          data-model-current-value={value}
          className="inline-flex min-w-0"
        >
          <ModelConfigSelect
            modelGroups={modelGroups}
            normalizedValue={value}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={handleValueChange}
            footerActions={footerActions}
            manageModelsLabel={intl.formatMessage({
              id: "chat.toolbar.model.manageModels",
            })}
            contentSide="top"
            contentAlign="end"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-8 w-fit max-w-52 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input"
            triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            disabled={disabled || pending}
          />
        </span>
        <SubagentReasoningField
          intl={intl}
          state={thoughtLevelState}
          disabled={disabled || pending}
          labelVisibilityClassName="hidden sm:inline-flex"
          onValueCommit={(thoughtLevel) => {
            if (thoughtLevel === config.thoughtLevel) {
              return;
            }
            void persistConfig({ model: config.model, thoughtLevel, speed: config.speed });
          }}
        />
        {speedState.kind === "supported" || speedState.kind === "unknown" ? (
          <SubagentSpeedField
            intl={intl}
            state={speedState}
            value={config.speed}
            disabled={disabled || pending}
            labelVisibilityClassName="hidden sm:inline-flex"
            onValueCommit={(nextSpeed) => {
              if (nextSpeed === config.speed) {
                return;
              }
              void persistConfig({
                model: config.model,
                thoughtLevel: config.thoughtLevel,
                speed: nextSpeed,
              });
            }}
          />
        ) : null}
      </div>
      {thoughtLevelInvalid ? (
        <span className="text-ui-sm text-destructive">
          {intl.formatMessage({
            id: "settings.subagents.form.validation.thoughtLevelUnavailable",
          })}
        </span>
      ) : null}
      {speedInvalid ? (
        <span className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "settings.subagents.form.validation.speedUnavailable" })}
        </span>
      ) : null}
    </div>
  );
}
