/**
 * 子智能体表单的能力字段子组件（split-plan settings/SubagentsSection.tsx 批次 2 辅助拆分）。
 *
 * 从 `SubagentFormFields.tsx`（409 物理行，超 oxlint max-lines 400）按职责拆出：
 * 能力字段 = 模型 / 工具 / 系统提示 / injectAgentsMd，描述「这个 agent 能做什么」；
 * 身份字段（作用域/名称/颜色/描述）见同目录 `SubagentFormIdentityFields.tsx`。
 *
 * 全部受控：value 经 props 透传，onChange 经回调上抛；不持有内部 state、不读 store。
 * i18n 词条由调用方（SubagentForm）经 intl 适配器透传，本模块不直接消费 hooks。
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import {
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SubagentReasoningField } from "@/settings/SubagentReasoningField.js";
import {
  SubagentSpeedField,
  type SubagentSpeedFieldState,
} from "@/settings/SubagentSpeedField.js";
import {
  TOOL_OPTIONS,
  type SubagentThoughtOptionState,
} from "@/settings/subagents/agentModel.js";
import { FormFieldLabel, ToolCheckbox } from "@/settings/subagents/primitives.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

/** useACodeIntl() 的 intl 形状——字段子组件不直接消费 hook，由父组件透传。 */
interface IntlLike {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
}

export function SubagentFormModelField({
  intl,
  model,
  modelTriggerLabel,
  modelSelectGroups,
  onManageModels,
  onModelChange,
  footerActions,
  thoughtLevelState,
  onThoughtLevelCommit,
  formSpeedState,
  speed,
  onSpeedCommit,
  saving,
  modelError,
  thoughtLevelInvalid,
  speedInvalid,
}: {
  intl: IntlLike;
  model: string;
  modelTriggerLabel: string;
  modelSelectGroups: readonly ModelSelectGroup[];
  onManageModels?: () => void;
  onModelChange: (next: string) => void;
  footerActions: ModelSelectFooterAction[];
  thoughtLevelState: SubagentThoughtOptionState;
  onThoughtLevelCommit: (next: string) => void;
  formSpeedState: SubagentSpeedFieldState;
  speed: string | undefined;
  onSpeedCommit: (next: string) => void;
  saving: boolean;
  modelError: string | null;
  thoughtLevelInvalid: boolean;
  speedInvalid: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <FormFieldLabel>
        {intl.formatMessage({ id: "settings.subagents.form.model.label" })}
      </FormFieldLabel>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ModelConfigSelect
          modelGroups={modelSelectGroups}
          normalizedValue={model}
          triggerLabel={modelTriggerLabel}
          showManageModelsAction={Boolean(onManageModels)}
          lockReasonMessage=""
          isItemLocked={MODEL_ITEM_NEVER_LOCKED}
          onValueChange={onModelChange}
          footerActions={footerActions}
          manageModelsLabel={intl.formatMessage({
            id: "chat.toolbar.model.manageModels",
          })}
          onManageModels={onManageModels}
          // 聊天工具栏的模型菜单默认向上弹；Subagents add/edit 表单位于设置页正文，
          // 菜单项应贴着按钮下方展开，避免覆盖上面的表单字段。
          contentSide="bottom"
          focusSelectorOnClose={null}
          labelVisibilityClassName="inline-flex min-w-0"
          triggerClassName="h-8 w-fit max-w-full min-w-0 justify-between rounded-lg border border-input-border bg-input bg-clip-border px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
          triggerLabelClassName="inline-flex min-w-0 truncate text-left"
        />
        <SubagentReasoningField
          intl={intl as never}
          state={thoughtLevelState}
          disabled={saving}
          labelVisibilityClassName="inline-flex min-w-0"
          onValueCommit={onThoughtLevelCommit}
        />
        {formSpeedState.kind === "supported" || formSpeedState.kind === "unknown" ? (
          <SubagentSpeedField
            intl={intl as never}
            state={formSpeedState}
            value={speed}
            disabled={saving}
            labelVisibilityClassName="inline-flex min-w-0"
            onValueCommit={onSpeedCommit}
          />
        ) : null}
      </div>
      {modelError ? <p className="text-ui-base text-destructive">{modelError}</p> : null}
      {thoughtLevelInvalid ? (
        <p className="text-ui-base text-destructive">
          {intl.formatMessage({
            id: "settings.subagents.form.validation.thoughtLevelUnavailable",
          })}
        </p>
      ) : null}
      {speedInvalid ? (
        <p className="text-ui-base text-destructive">
          {intl.formatMessage({
            id: "settings.subagents.form.validation.speedUnavailable",
          })}
        </p>
      ) : null}
    </div>
  );
}


export function SubagentFormToolsField({
  intl,
  inheritAllTools,
  selectedTools,
  onToolsModeChange,
  onToggleTool,
}: {
  intl: IntlLike;
  inheritAllTools: boolean;
  selectedTools: readonly string[];
  onToolsModeChange: (value: string) => void;
  onToggleTool: (tool: string) => void;
}) {
  return (
    <div className="space-y-2 pt-1">
      <FormFieldLabel>
        {intl.formatMessage({ id: "settings.subagents.form.tools.label" })}
      </FormFieldLabel>
      <div className="flex min-w-0 items-center gap-2">
        <Select value={inheritAllTools ? "all" : "custom"} onValueChange={onToolsModeChange}>
          <SelectTrigger size="lg" className="w-fit justify-between">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {intl.formatMessage({
                id: "settings.subagents.form.tools.mode.all",
              })}
            </SelectItem>
            <SelectItem value="custom">
              {intl.formatMessage({
                id: "settings.subagents.form.tools.mode.custom",
              })}
            </SelectItem>
          </SelectContent>
        </Select>
        <span className="min-w-0 text-ui-base font-normal text-foreground-subtle">
          {intl.formatMessage({
            id: "settings.subagents.form.tools.card.title",
          })}
        </span>
      </div>
      {inheritAllTools ? null : (
        <div className="rounded-lg border border-border bg-card p-1">
          <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
            {TOOL_OPTIONS.map((tool) => (
              <ToolCheckbox
                key={tool}
                checked={selectedTools.includes(tool)}
                disabled={false}
                label={tool}
                onToggle={() => onToggleTool(tool)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


export function SubagentFormSystemPromptField({
  intl,
  systemPrompt,
  promptError,
  onSystemPromptChange,
}: {
  intl: IntlLike;
  systemPrompt: string;
  promptError: string | null;
  onSystemPromptChange: (next: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <FormFieldLabel>
        {intl.formatMessage({
          id: "settings.subagents.form.systemPrompt.label",
        })}
      </FormFieldLabel>
      <SettingsFormTextarea
        value={systemPrompt}
        onChange={(event) => onSystemPromptChange(event.target.value)}
        rows={3}
        className="max-h-56 min-h-16 resize-y overflow-y-auto text-ui-base"
        placeholder={intl.formatMessage({
          id: "settings.subagents.form.systemPrompt.placeholder",
        })}
      />
      {promptError ? <p className="text-ui-base text-destructive">{promptError}</p> : null}
    </div>
  );
}


export function SubagentFormInjectAgentsMdRow({
  intl,
  injectAgentsMd,
  onInjectAgentsMdChange,
}: {
  intl: IntlLike;
  injectAgentsMd: boolean;
  onInjectAgentsMdChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="min-w-0 text-ui-base font-medium text-foreground">
        {intl.formatMessage({
          id: "settings.subagents.form.injectAgentsMd.label",
        })}
      </p>
      <Switch
        checked={injectAgentsMd}
        onCheckedChange={onInjectAgentsMdChange}
        aria-label={intl.formatMessage({
          id: "settings.subagents.form.injectAgentsMd.label",
        })}
      />
    </div>
  );
}
