/**
 * 子智能体表单的身份字段子组件（split-plan settings/SubagentsSection.tsx 批次 2 辅助拆分）。
 *
 * 从 `SubagentFormFields.tsx`（409 物理行，超 oxlint max-lines 400）按职责拆出：
 * 身份字段 = 作用域 / 名称 / 颜色 / 描述，描述「这个 agent 是谁」；
 * 能力字段（模型/工具/系统提示/injectAgentsMd）见同目录 `SubagentFormCapabilityFields.tsx`。
 *
 * 全部受控：value 经 props 透传，onChange 经回调上抛；不持有内部 state、不读 store。
 * i18n 词条由调用方（SubagentForm）经 intl 适配器透传，本模块不直接消费 hooks。
 */
import type { AgentColor } from "@acode/shared";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  AGENT_COLORS,
  COLOR_DOT_CLASS,
} from "@/settings/subagents/agentModel.js";
import { FormFieldLabel } from "@/settings/subagents/primitives.js";

/** useACodeIntl() 的 intl 形状——字段子组件不直接消费 hook，由父组件透传。 */
interface IntlLike {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
}

export function SubagentFormScopeRow({
  intl,
  initial,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
}: {
  intl: IntlLike;
  initial: unknown;
  scopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  onScopeKeyChange: (scopeKey: string) => void;
}) {
  return (
    <div className="flex justify-end">
      <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <span className="shrink-0 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.scope.label" })}
        </span>
        <PluginScopeMenu
          align="end"
          disabled={Boolean(initial)}
          selectedScopeKey={scopeKey}
          workspaceTabs={workspaceTabs}
          onScopeKeyChange={onScopeKeyChange}
        />
      </label>
    </div>
  );
}


export function SubagentFormNameField({
  intl,
  name,
  nameError,
  onNameChange,
}: {
  intl: IntlLike;
  name: string;
  nameError: string | null;
  onNameChange: (next: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <FormFieldLabel>{intl.formatMessage({ id: "settings.subagents.form.name.label" })}</FormFieldLabel>
      <Input
        type="text"
        size="lg"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder={intl.formatMessage({
          id: "settings.subagents.form.name.placeholder",
        })}
      />
      {nameError ? <p className="text-ui-base text-destructive">{nameError}</p> : null}
    </div>
  );
}


export function SubagentFormColorField({
  intl,
  color,
  onColorChange,
}: {
  intl: IntlLike;
  color: AgentColor;
  onColorChange: (next: AgentColor) => void;
}) {
  const selectedColorIndex = Math.max(0, AGENT_COLORS.indexOf(color));
  return (
    <div className="space-y-1.5">
      <FormFieldLabel>
        {intl.formatMessage({ id: "settings.subagents.form.color.label" })}
      </FormFieldLabel>
      <div
        role="radiogroup"
        className="relative inline-grid w-56 grid-cols-8 rounded-lg border border-input-border bg-input p-1"
      >
        <span
          className="pointer-events-none absolute top-1 size-6 rounded-full border border-border-hover bg-surface shadow-xs transition-[left]"
          style={{
            left: `calc(0.25rem + ((100% - 0.5rem) / ${AGENT_COLORS.length}) * ${selectedColorIndex})`,
          }}
          aria-hidden="true"
        />
        {AGENT_COLORS.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={color === option}
            aria-label={intl.formatMessage({
              id: `settings.subagents.color.${option}`,
            })}
            className="relative z-10 flex size-6 items-center justify-center rounded-full outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onColorChange(option)}
          >
            <span className={cn("size-3.5 rounded-full", COLOR_DOT_CLASS[option])} />
          </button>
        ))}
      </div>
    </div>
  );
}


export function SubagentFormDescriptionField({
  intl,
  description,
  descriptionError,
  onDescriptionChange,
}: {
  intl: IntlLike;
  description: string;
  descriptionError: string | null;
  onDescriptionChange: (next: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <FormFieldLabel>
        {intl.formatMessage({
          id: "settings.subagents.form.description.label",
        })}
      </FormFieldLabel>
      <Input
        type="text"
        size="lg"
        value={description}
        onChange={(event) => onDescriptionChange(event.target.value)}
        placeholder={intl.formatMessage({
          id: "settings.subagents.form.description.placeholder",
        })}
      />
      {descriptionError ? (
        <p className="text-ui-base text-destructive">{descriptionError}</p>
      ) : null}
    </div>
  );
}

