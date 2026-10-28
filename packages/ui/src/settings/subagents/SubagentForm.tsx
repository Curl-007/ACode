/**
 * 子智能体表单草稿态组件（split-plan settings/SubagentsSection.tsx 批次 2）。
 *
 * 从 `settings/SubagentsSection.tsx` 行 859–1368 **逐字迁移**的 state 与提交逻辑；
 * return 的 JSX 字段块进一步抽到同目录 `SubagentFormFields.tsx`（7 个纯受控字段
 * 子组件），以满足 split-plan 「每批拆分的固定验收」第 5 条「新模块自身必须
 * <400 行（max-lines，skipBlankLines+skipComments）」。
 *
 * 持有编辑中 agent 的全部表单草稿 state（name/description/color/model/thoughtLevel/
 * speed/injectAgentsMd/inheritAllTools/selectedTools/systemPrompt + 4 个 error state）。
 *
 * 关键回灌语义（**必须保留**）：保存/刷新后表单组件可能复用旧实例；
 * `previousInitialFormStateKeyRef` + `createSubagentFormInitialStateKey` 守卫按
 * 最新 agent 快照回灌字段，否则已写入 Markdown 的 model 会继续停留在本地 inherit 状态。
 *
 * 受控边界：
 *  - `onSave` 是唯一提交出口，落盘载荷由 `buildSubagentSaveConfig` 构造
 *    （含声明键批②六键从 initial 快照的透传）；
 *  - 不持有 list/operating 状态，全部经 props 透传；
 *  - 模型档位 / 工具合并 / 表单初值等纯决策走 `agentModel.ts` 单一来源。
 *
 * 行为不变量（接缝内测试见 packages/ui/test/subagentSections.test.ts 的结构守护部分；
 * 行为验证属 jsdom/E2E 债，split-plan 「每批拆分的固定验收」第 4 条登记口径）：
 *  - `initialFormStateKey` 变化时按 `createSubagentFormInitialState(initial)` 回灌
 *    全部本地 state 并清空 4 个 error；
 *  - 名称 3–50 字符 + `[a-zA-Z0-9-]+` 校验、description/systemPrompt 必填、
 *    失效模型/不可用档位/不可用速度 阻止保存；
 *  - `inheritAllTools` 关闭时 `selectedTools` 默认填全 `TOOL_OPTIONS`；
 *  - 显式改 model 时经 `hasExplicitModelChanged` 触发 Start Plan 推荐弹窗。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { completeNewModelSelection } from "@acode/provider";
import type { AgentColor, AgentSummary, SubAgentConfig } from "@acode/shared";
import type { ModelSelectionView } from "@acode/services";
import { Button } from "@/components/ui/button.js";
import {
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { hasExplicitModelChanged } from "@/lib/startPlanRecommendation.js";
import { parseModelPickerValue } from "@/lib/modelPickerValue.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import {
  isSubagentSpeedInvalid,
  resolveSubagentSpeedOptionState,
} from "@/settings/SubagentModelBatchApply.js";
import type { SubagentSpeedFieldState } from "@/settings/SubagentSpeedField.js";
import { buildSubagentSaveConfig } from "@/settings/subagentFormSaveConfig.js";
import { validateSubagentFormFields } from "@/settings/subagents/subagentFormValidate.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  INHERIT_MODEL_VALUE,
  TOOL_OPTIONS,
  createSubagentFormInitialState,
  createSubagentFormInitialStateKey,
  isSubagentModelAvailable,
  isSubagentThoughtLevelAvailable,
  mergeTools,
  resolveSubagentModelLabel,
  resolveSubagentThoughtOptionState,
  toPersistedModel,
  toSubagentModelSelection,
} from "@/settings/subagents/agentModel.js";
import {
  SubagentFormColorField,
  SubagentFormDescriptionField,
  SubagentFormNameField,
  SubagentFormScopeRow,
} from "@/settings/subagents/SubagentFormIdentityFields.js";
import {
  SubagentFormInjectAgentsMdRow,
  SubagentFormModelField,
  SubagentFormSystemPromptField,
  SubagentFormToolsField,
} from "@/settings/subagents/SubagentFormCapabilityFields.js";

export function SubagentForm({
  initial,
  modelSelectionView,
  modelSelectionLoading,
  modelSelectGroups,
  onManageModels,
  saving,
  onCancel,
  onDelete,
  onSave,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
}: {
  initial?: AgentSummary;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  modelSelectGroups: readonly ModelSelectGroup[];
  onManageModels?: () => void;
  saving: boolean;
  onCancel: () => void;
  onDelete?: (agent: AgentSummary) => void;
  onSave: (config: SubAgentConfig) => Promise<void>;
  scopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  onScopeKeyChange: (scopeKey: string) => void;
}) {
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");
  const { intl } = useACodeIntl();
  const initialFormStateKey = createSubagentFormInitialStateKey(initial);
  const initialFormState = useMemo(
    () => createSubagentFormInitialState(initial),
    [initial, initialFormStateKey],
  );
  const previousInitialFormStateKeyRef = useRef(initialFormStateKey);
  const [name, setName] = useState(initialFormState.name);
  const [description, setDescription] = useState(initialFormState.description);
  const [color, setColor] = useState<AgentColor>(initialFormState.color);
  const [model, setModel] = useState(initialFormState.model);
  const [thoughtLevel, setThoughtLevel] = useState(initialFormState.thoughtLevel);
  const [speed, setSpeed] = useState(initialFormState.speed);
  const [injectAgentsMd, setInjectAgentsMd] = useState(initialFormState.injectAgentsMd);
  const [inheritAllTools, setInheritAllTools] = useState(initialFormState.inheritAllTools);
  const [selectedTools, setSelectedTools] = useState<string[]>(initialFormState.selectedTools);
  const [systemPrompt, setSystemPrompt] = useState(initialFormState.systemPrompt);
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const inheritModelLabel = intl.formatMessage({
    id: "settings.subagents.model.inherit",
  });
  const handleModelChange = useCallback(
    (nextModel: string) => {
      if (nextModel === model) {
        return;
      }
      setModel(nextModel);
      const identity = toPersistedModel(nextModel);
      const selected =
        identity && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(identity))
          : undefined;
      setThoughtLevel(selected?.options?.reasoningLevel ?? "");
      setSpeed(selected?.options?.speed ?? "");
      setModelError(null);
    },
    [model, modelSelectionView],
  );
  const persistedModel = toPersistedModel(model);
  const modelAvailable = isSubagentModelAvailable(modelSelectGroups, model, modelSelectionLoading);
  // 候选已明确失效时仍展示原型号会误导用户；只改触发器文案，不清空草稿或补回候选。
  // 非 ready 阶段由可用性函数保留原意图，不能把读取失败当成模型被删除。
  const modelTriggerLabel = modelAvailable
    ? resolveSubagentModelLabel({
        inheritLabel: inheritModelLabel,
        modelGroups: modelSelectGroups,
        model,
      })
    : intl.formatMessage({ id: "settings.subagents.model.select" });
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "subagent-model:inherit",
        label: inheritModelLabel,
        onSelect: () => handleModelChange(INHERIT_MODEL_VALUE),
        selected: model === INHERIT_MODEL_VALUE,
      },
    ],
    [handleModelChange, inheritModelLabel, model],
  );
  const thoughtLevelState = resolveSubagentThoughtOptionState({
    model,
    modelAvailable,
    modelSelectionView,
    modelSelectionLoading,
    thoughtLevel,
  });
  const thoughtLevelInvalid = Boolean(
    persistedModel &&
    thoughtLevel &&
    modelAvailable &&
    !isSubagentThoughtLevelAvailable(thoughtLevelState, thoughtLevel),
  );
  const formSpeedState: SubagentSpeedFieldState = useMemo(
    () =>
      resolveSubagentSpeedOptionState({
        modelSelectionView,
        modelSelection: persistedModel ? parseModelPickerValue(persistedModel) : undefined,
        modelSelectionLoading,
      }),
    [modelSelectionLoading, modelSelectionView, persistedModel],
  );
  const speedInvalid = isSubagentSpeedInvalid(formSpeedState, speed);
  const trimmedName = name.trim();
  const canSave = Boolean(
    trimmedName.length >= 3 &&
    trimmedName.length <= 50 &&
    /^[a-zA-Z0-9-]+$/u.test(trimmedName) &&
    description.trim() &&
    systemPrompt.trim() &&
    modelAvailable &&
    !thoughtLevelInvalid &&
    !speedInvalid,
  );

  useEffect(() => {
    if (previousInitialFormStateKeyRef.current === initialFormStateKey) {
      return;
    }
    previousInitialFormStateKeyRef.current = initialFormStateKey;
    const nextInitialState = createSubagentFormInitialState(initial);

    // 保存/刷新后表单组件可能复用旧实例；必须按最新 agent 快照回灌字段，
    // 否则已写入 Markdown 的 model 会继续停留在本地 inherit 状态。
    setName(nextInitialState.name);
    setDescription(nextInitialState.description);
    setColor(nextInitialState.color);
    setModel(nextInitialState.model);
    setThoughtLevel(nextInitialState.thoughtLevel);
    setSpeed(nextInitialState.speed);
    setInjectAgentsMd(nextInitialState.injectAgentsMd);
    setInheritAllTools(nextInitialState.inheritAllTools);
    setSelectedTools(nextInitialState.selectedTools);
    setSystemPrompt(nextInitialState.systemPrompt);
    setNameError(null);
    setDescriptionError(null);
    setPromptError(null);
    setModelError(null);
  }, [initial, initialFormStateKey]);

  const validate = (): boolean =>
    validateSubagentFormFields(
      {
        name,
        description,
        systemPrompt,
        modelAvailable: isSubagentModelAvailable(
          modelSelectGroups,
          model,
          modelSelectionLoading,
        ),
        thoughtLevelInvalid,
        speedInvalid,
      },
      { setNameError, setDescriptionError, setPromptError, setModelError },
      intl,
    );

  const toggleTool = (tool: string) => {
    setInheritAllTools(false);
    setSelectedTools((current) =>
      current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool],
    );
  };

  const handleToolsModeChange = (value: string) => {
    const nextInheritAllTools = value === "all";
    setInheritAllTools(nextInheritAllTools);
    if (!nextInheritAllTools && selectedTools.length === 0) {
      setSelectedTools([...TOOL_OPTIONS]);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    let selection = toSubagentModelSelection(persistedModel, thoughtLevel, speed);
    if (hasExplicitModelChanged(initial?.modelSelection, selection)) {
      const chosen = await recommendStartPlan(selection);
      if (!chosen) return;
      selection = chosen;
    }
    // 保存载荷构造抽到 subagentFormSaveConfig.ts 纯函数（含声明键批②六键从
    // initial 快照的透传，断言测试钉住 GUI 往返不丢键）；此处只传表单值与归一结果。
    await onSave(
      buildSubagentSaveConfig({
        initial,
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        color,
        injectAgentsMd,
        modelSelection: selection,
        tools: inheritAllTools
          ? undefined
          : mergeTools(selectedTools, initialFormState.preservedTools),
      }),
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-border p-4">
      <SubagentFormScopeRow
        intl={intl}
        initial={initial}
        scopeKey={scopeKey}
        workspaceTabs={workspaceTabs}
        onScopeKeyChange={onScopeKeyChange}
      />
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,14rem)_auto_minmax(0,1fr)] md:items-start">
        <SubagentFormNameField
          intl={intl}
          name={name}
          nameError={nameError}
          onNameChange={setName}
        />
        <SubagentFormColorField intl={intl} color={color} onColorChange={setColor} />
        <SubagentFormModelField
          intl={intl}
          model={model}
          modelTriggerLabel={modelTriggerLabel}
          modelSelectGroups={modelSelectGroups}
          onManageModels={onManageModels}
          onModelChange={handleModelChange}
          footerActions={footerActions}
          thoughtLevelState={thoughtLevelState}
          onThoughtLevelCommit={setThoughtLevel}
          formSpeedState={formSpeedState}
          speed={speed}
          onSpeedCommit={setSpeed}
          saving={saving}
          modelError={modelError}
          thoughtLevelInvalid={thoughtLevelInvalid}
          speedInvalid={speedInvalid}
        />
      </div>
      <SubagentFormDescriptionField
        intl={intl}
        description={description}
        descriptionError={descriptionError}
        onDescriptionChange={setDescription}
      />
      <SubagentFormToolsField
        intl={intl}
        inheritAllTools={inheritAllTools}
        selectedTools={selectedTools}
        onToolsModeChange={handleToolsModeChange}
        onToggleTool={toggleTool}
      />
      <SubagentFormSystemPromptField
        intl={intl}
        systemPrompt={systemPrompt}
        promptError={promptError}
        onSystemPromptChange={setSystemPrompt}
      />
      <SubagentFormInjectAgentsMdRow
        intl={intl}
        injectAgentsMd={injectAgentsMd}
        onInjectAgentsMdChange={setInjectAgentsMd}
      />
      <SettingsFormActions
        leadingAction={
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button type="submit" variant="default" size="lg" disabled={!canSave || saving}>
          {saving
            ? intl.formatMessage({ id: "common.saving" })
            : intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={saving}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </form>
  );
}
