/* eslint-disable max-lines -- 子智能体管理页集中维护作用域列表、表单和启用状态，避免状态分散 */
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { hasExplicitModelChanged } from "@/lib/startPlanRecommendation.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Bot,
  Check,
  ListChecks,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { completeNewModelSelection } from "@acode/provider";
import {
  TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER,
  TID_SUBAGENT_ROW,
  ACODE_AGENT_PROVIDER,
  testId,
  type AgentColor,
  type AgentsCapability,
  type AgentSummary,
  type ModelSelection,
  type SubAgentConfig,
} from "@acode/shared";
import type { ModelSelectionView } from "@acode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { toast } from "@/components/ui/toast.js";
import {
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildRegistryModelSelectGroups,
} from "@/lib/modelSelectionGroups.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { parseModelPickerValue } from "@/lib/modelPickerValue.js";
import { encodeCustomModelValue } from "@/lib/acodeCustomModelValue.js";
import { SettingsResourceGroupHeader } from "@/settings/SettingsResourceGroupHeader.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  SubagentReasoningField,
} from "@/settings/SubagentReasoningField.js";
import { buildSubagentSaveConfig } from "@/settings/subagentFormSaveConfig.js";
// 子智能体批量编辑（specs/subagent-batch-edit.md）：操作条 + 分组统一设置弹层 + 纯逻辑。
// 应用写路径只走既有 service 方法（覆盖路径 / updateAgent），不新建平行写入通道。
import { SubagentModelBatchBar } from "@/settings/SubagentModelBatchBar.js";
import { SubagentModelBatchDialog } from "@/settings/SubagentModelBatchDialog.js";
import {
  buildUserAgentBatchConfig,
  createEmptyBatchResult,
  isBatchApplicableAgent,
  isSubagentSpeedInvalid,
  resolveBatchApplyTargets,
  resolveBatchWritePath,
  resolveGroupBatchCheckState,
  resolveSubagentSpeedOptionState,
  type SubagentModelBatchResult,
  type SubagentModelBatchValue,
} from "@/settings/SubagentModelBatchApply.js";
import { SubagentSpeedField, type SubagentSpeedFieldState } from "@/settings/SubagentSpeedField.js";
import { refreshLoadedSubagentsStoreForWorkspace } from "@/store/subagentsStore.js";
import {
  PluginScopeMenu,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@/settings/PluginScopeMenu.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
// helper 外迁批次 1（split-plan settings/SubagentsSection.tsx）：能力矩阵 / 工具合并 /
// 模型档位 / 表单初值纯函数 + 常量集中到 subagents/agentModel.ts，避免与本文件循环 import。
import {
  AGENT_COLORS,
  COLOR_DOT_CLASS,
  INHERIT_MODEL_VALUE,
  RISKY_TOOLS,
  TOOL_OPTIONS,
  allowsAllTools,
  createSubagentFormInitialState,
  createSubagentFormInitialStateKey,
  getBuiltInSubagentName,
  isBuiltInAgent,
  isEditableUserAgent,
  isSubagentModelAvailable,
  isSubagentThoughtLevelAvailable,
  mergeTools,
  projectSettingsSubagents,
  resolveSubagentModelLabel,
  resolveSubagentThoughtOptionState,
  resolvedSubagentThoughtLevel,
  supportsEnabledToggle,
  supportsModelOverride,
  toPersistedModel,
  toSubagentModelSelection,
  toSubagentModelValue,
} from "@/settings/subagents/agentModel.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

// 源仓新增的批量 test id 定义在 packages/shared/src/test-ids.ts；本任务限定只改
// packages/ui，这里用局部字面量保持同一 data-testid 契约（E2E 可按字面量选取）。
const TID_SUBAGENT_BATCH_TRIGGER = "subagent-batch-trigger";
const TID_SUBAGENT_BATCH_ROW_CHECKBOX = "subagent-batch-row-checkbox";
const TID_SUBAGENT_GROUP_MENU_TRIGGER = "subagent-group-menu-trigger";
const TID_SUBAGENT_BATCH_SELECT_ALL = "subagent-batch-select-all";
const TID_SUBAGENT_BATCH_GROUP_SELECT_ALL = "subagent-batch-group-select-all";

interface AgentGroups {
  builtIn: AgentSummary[];
  plugin: AgentSummary[];
  user: AgentSummary[];
}

interface SubagentsSectionProps {
  onManageModels?: () => void;
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

function FormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1.5 block text-ui-base font-medium text-foreground-subtle">
      {children}
    </label>
  );
}

function AgentColorDot({ color }: { color?: AgentColor }) {
  return (
    <span
      className={cn(
        "inline-flex size-2 shrink-0 rounded-full",
        color ? COLOR_DOT_CLASS[color] : "bg-foreground-subtlest",
      )}
      aria-hidden="true"
    />
  );
}

function AgentBadge({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-5 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border",
        className,
      )}
    >
      {children}
    </span>
  );
}

function groupAgentsByScope(agents: readonly AgentSummary[]): AgentGroups {
  const groups: AgentGroups = { builtIn: [], plugin: [], user: [] };
  for (const agent of agents) {
    if (isEditableUserAgent(agent)) {
      groups.user.push(agent);
    } else if (agent.source === "plugin") {
      groups.plugin.push(agent);
    } else {
      groups.builtIn.push(agent);
    }
  }
  return groups;
}

/** 按完整插件 ID 分组，避免同名 marketplace 的子智能体互相合并。 */
function groupPluginAgentsById(agents: readonly AgentSummary[]): Array<[string, AgentSummary[]]> {
  const groups = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    const key =
      agent.pluginId?.trim() || agent.pluginName?.trim() || agent.name.split(":", 1)[0] || "Plugin";
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function ToolCheckbox({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-surface-hover",
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-sm border transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input-border bg-input text-transparent",
          )}
        >
          <Check className="size-3.5" />
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
        {label}
      </span>
      {RISKY_TOOLS.has(label) ? (
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
      ) : null}
    </button>
  );
}

/** 批量模式行复选框：仅可批量行渲染（specs/subagent-batch-edit.md R2）。 */
function BatchRowCheckbox({
  checked,
  label,
  agentName,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  agentName: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId(TID_SUBAGENT_BATCH_ROW_CHECKBOX, agentName)}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-hover",
      )}
    >
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border transition-colors",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input-border bg-input text-transparent",
        )}
      >
        {checked ? <Check className="size-3" /> : null}
      </span>
    </button>
  );
}

/**
 * 分组头「…」批量菜单（方案 B）：统一设置模型 / 本组恢复继承默认。
 * 仅当组内存在可批量行时可用；菜单只发出意图，落盘由调用方逐行串行执行。
 */
function SubagentGroupBatchMenu({
  groupKey,
  groupName,
  overridableCount,
  disabled,
  onSetModels,
  onResetInherit,
}: {
  groupKey: string;
  groupName: string;
  overridableCount: number;
  disabled: boolean;
  onSetModels: () => void;
  onResetInherit: () => void;
}) {
  const { intl } = useACodeIntl();
  const menuDisabled = disabled || overridableCount === 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-md"
          data-testid={testId(TID_SUBAGENT_GROUP_MENU_TRIGGER, groupKey)}
          aria-label={intl.formatMessage(
            { id: "settings.subagents.batch.groupMenu.aria" },
            { group: groupName },
          )}
          disabled={menuDisabled}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={menuDisabled} onSelect={onSetModels}>
          <Sparkles aria-hidden="true" />
          {intl.formatMessage(
            { id: "settings.subagents.batch.groupMenu.setModels" },
            { count: String(overridableCount) },
          )}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={menuDisabled} onSelect={onResetInherit}>
          <Undo2 aria-hidden="true" />
          {intl.formatMessage(
            { id: "settings.subagents.batch.groupMenu.resetInherit" },
            { count: String(overridableCount) },
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 批量模式下的分组头全选/全不选复选框（三态：空选/半选/全选）。
 * 只勾选组内可批量行；组内没有可批量行时禁用。
 */
function SubagentGroupSelectAll({
  groupKey,
  groupName,
  checkState,
  disabled,
  onToggle,
}: {
  groupKey: string;
  groupName: string;
  checkState: "unchecked" | "checked" | "indeterminate";
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const { intl } = useACodeIntl();
  return (
    <label
      data-testid={testId(TID_SUBAGENT_BATCH_GROUP_SELECT_ALL, groupKey)}
      data-batch-check-state={checkState}
      className={cn(
        "flex min-w-0 select-none items-center gap-2 text-ui-base font-medium text-foreground",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        !disabled && checkState === "unchecked" && "text-foreground-subtle",
      )}
    >
      <Checkbox
        checked={
          checkState === "checked" ? true : checkState === "indeterminate" ? "indeterminate" : false
        }
        disabled={disabled}
        aria-label={intl.formatMessage(
          { id: "settings.subagents.batch.groupSelectAll.aria" },
          { group: groupName },
        )}
        onCheckedChange={(checked) => onToggle(checked === true)}
      />
      {intl.formatMessage({ id: "settings.subagents.batch.groupSelectAll.label" })}
    </label>
  );
}

function AgentListRow({
  agent,
  pluginIconItem,
  isOperating,
  modelGroups,
  modelSelectionView,
  modelSelectionLoading,
  modelSelectGroups,
  batchMode,
  batchChecked,
  batchApplying,
  onBatchCheckChange,
  onModelOverrideChange,
  onDelete,
  onEdit,
  onToggle,
}: {
  agent: AgentSummary;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
  isOperating: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  modelSelectGroups: readonly ModelSelectGroup[];
  batchMode: boolean;
  batchChecked: boolean;
  batchApplying: boolean;
  onBatchCheckChange: (agent: AgentSummary, checked: boolean) => void;
  onModelOverrideChange: (
    agent: AgentSummary,
    config: { model?: string; thoughtLevel?: string; speed?: string },
  ) => Promise<void>;
  onDelete: (agent: AgentSummary) => void;
  onEdit: (agent: AgentSummary) => void;
  onToggle: (agent: AgentSummary, enabled: boolean) => void;
}) {
  const { intl } = useACodeIntl();
  const editable = isEditableUserAgent(agent);
  const showEnabledToggle = supportsEnabledToggle(agent);
  // 批量模式下行进入选择语义：不再进编辑表单，行内写控件一并禁用，避免边选边写。
  // 批量应用期间行选择一并禁用：行点击不切换选中，复选框保留在行内但置灰。
  const checkboxVisible = batchMode && isBatchApplicableAgent(agent) && !batchApplying;
  const checkboxRendered = batchMode && isBatchApplicableAgent(agent);
  const batchCheckboxDisabled = batchApplying || !isBatchApplicableAgent(agent);
  const controlsDisabled = isOperating || batchMode;
  const rowEditable = editable && !isOperating && !batchMode;
  const hasModelOverrideControl = supportsModelOverride(agent);
  // 有覆盖控件的行由控件本身表达模型，不再重复显示模型徽标。
  const showModelBadge = !hasModelOverrideControl;
  const inheritModelLabel = intl.formatMessage({
    id: "settings.subagents.model.inherit",
  });
  const modelLabel = resolveSubagentModelLabel({
    inheritLabel: inheritModelLabel,
    modelGroups: modelSelectGroups,
    model: toSubagentModelValue(agent.modelSelection),
  });
  const toolCount = agent.tools?.length ?? 0;
  const toolsLabel = allowsAllTools(agent.tools)
    ? intl.formatMessage({ id: "settings.subagents.tools.all" })
    : intl.formatMessage({ id: "settings.subagents.toolsCount" }, { count: String(toolCount) });
  // 自建行的行内没有模型控件，档位只写在定义文件里；徽标同步展示，否则批量设置后
  // 界面看起来「没生效」。档位词条与工具栏共用 thoughtLevelLabelId，未知值原样显示。
  const thoughtLevelValue = agent.modelSelection?.options?.reasoningLevel?.trim();
  const thoughtLevelLabel = thoughtLevelValue ? thoughtLevelLabelId(thoughtLevelValue) : undefined;
  const thoughtLevelBadge = thoughtLevelLabel
    ? intl.formatMessage({ id: thoughtLevelLabel })
    : thoughtLevelValue;
  // speed 徽标与工具栏共用 chat.toolbar.speed.* 文案；未知值原样展示。
  const speedValue = agent.modelSelection?.options?.speed?.trim();
  const speedBadge =
    speedValue === "fast"
      ? intl.formatMessage({ id: "chat.toolbar.speed.fast" })
      : speedValue === "standard"
        ? intl.formatMessage({ id: "chat.toolbar.speed.standard" })
        : speedValue;
  const displayName =
    agent.source === "plugin" && agent.name.includes(":")
      ? agent.name.slice(agent.name.indexOf(":") + 1)
      : agent.name;

  return (
    <div
      data-testid={testId(TID_SUBAGENT_ROW, agent.name)}
      className={cn(
        "grid cursor-default items-center gap-3 px-4 py-3 transition-colors",
        rowEditable && "hover:bg-hover",
        batchChecked && "bg-selected",
        checkboxRendered
          ? hasModelOverrideControl
            ? "grid-cols-[auto_auto_minmax(0,1fr)] sm:grid-cols-[auto_auto_minmax(0,1fr)_auto]"
            : "grid-cols-[auto_auto_minmax(0,1fr)_auto]"
          : hasModelOverrideControl
            ? "grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto]"
            : "grid-cols-[auto_minmax(0,1fr)_auto]",
      )}
      {...settingsResourceRowInteraction(
        checkboxVisible
          ? () => onBatchCheckChange(agent, !batchChecked)
          : rowEditable
            ? () => onEdit(agent)
            : undefined,
      )}
    >
      {checkboxRendered ? (
        <BatchRowCheckbox
          checked={batchChecked}
          label={intl.formatMessage(
            { id: "settings.subagents.batch.rowToggleAria" },
            { name: agent.name },
          )}
          agentName={agent.name}
          disabled={batchCheckboxDisabled}
          onToggle={() => onBatchCheckChange(agent, !batchChecked)}
        />
      ) : null}
      <div className="relative shrink-0" aria-hidden="true">
        {pluginIconItem ? (
          <PluginStoreAvatar
            item={pluginIconItem}
            className="size-9 bg-background"
            fallbackIcon={<Bot className="size-4" />}
          />
        ) : (
          <div className="flex size-9 items-center justify-center rounded-xl bg-background text-foreground-subtle">
            <Bot className="size-4" />
          </div>
        )}
        {agent.color ? (
          // 右下角颜色点之前溢出头像容器，会让列表行视觉高度变高。
          <span className="absolute -bottom-1 -right-1 inline-flex size-3.5 items-center justify-center rounded-full border border-card bg-card p-px leading-none">
            <AgentColorDot color={agent.color} />
          </span>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{displayName}</span>
          {showModelBadge ? <AgentBadge>{modelLabel}</AgentBadge> : null}
          {showModelBadge && thoughtLevelBadge ? (
            <AgentBadge>{thoughtLevelBadge}</AgentBadge>
          ) : null}
          {showModelBadge && speedBadge ? <AgentBadge>{speedBadge}</AgentBadge> : null}
          <AgentBadge>{toolsLabel}</AgentBadge>
        </div>
        <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
          {agent.description || intl.formatMessage({ id: "settings.subagents.noDescription" })}
        </p>
      </div>

      <div
        className={cn(
          "flex items-center gap-2",
          hasModelOverrideControl
            ? "col-span-2 min-w-0 justify-end sm:col-span-1 sm:shrink-0"
            : "shrink-0",
        )}
      >
        {hasModelOverrideControl ? (
          <SubagentModelOverrideControl
            agent={agent}
            disabled={controlsDisabled}
            modelGroups={modelGroups}
            modelSelectionView={modelSelectionView}
            modelSelectionLoading={modelSelectionLoading}
            onModelOverrideChange={onModelOverrideChange}
          />
        ) : null}
        {showEnabledToggle ? (
          <Switch
            checked={agent.enabled}
            onCheckedChange={(enabled) => onToggle(agent, enabled)}
            disabled={controlsDisabled}
            aria-label={intl.formatMessage(
              { id: "settings.subagents.toggleAria" },
              { name: agent.name },
            )}
          />
        ) : null}
        <div className="flex items-center gap-1">
          {editable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              onClick={() => void onDelete(agent)}
              disabled={controlsDisabled}
              title={intl.formatMessage({ id: "common.delete" })}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 内置与插件 subagent 共用的行内 model / effort 覆盖控件，即改即存。 */
function SubagentModelOverrideControl({
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
            triggerClassName="h-8 w-fit max-w-52 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
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

function SubagentForm({
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
  const selectedColorIndex = Math.max(0, AGENT_COLORS.indexOf(color));

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

  const validate = (): boolean => {
    const trimmedName = name.trim();
    let valid = true;
    if (trimmedName.length < 3 || trimmedName.length > 50) {
      setNameError(
        intl.formatMessage(
          { id: "settings.subagents.form.validation.nameLength" },
          { min: "3", max: "50" },
        ),
      );
      valid = false;
    } else if (!/^[a-zA-Z0-9-]+$/u.test(trimmedName)) {
      setNameError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.nameCharacters",
        }),
      );
      valid = false;
    } else {
      setNameError(null);
    }
    if (!description.trim()) {
      setDescriptionError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.descriptionRequired",
        }),
      );
      valid = false;
    } else {
      setDescriptionError(null);
    }
    if (!systemPrompt.trim()) {
      setPromptError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.promptRequired",
        }),
      );
      valid = false;
    } else {
      setPromptError(null);
    }
    // 不可用模型会展示为“选择模型”，保存时也必须阻止历史值被静默写回。
    if (!isSubagentModelAvailable(modelSelectGroups, model, modelSelectionLoading)) {
      setModelError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.modelUnavailable",
        }),
      );
      valid = false;
    } else {
      setModelError(null);
    }
    if (thoughtLevelInvalid) {
      valid = false;
    }
    if (speedInvalid) {
      valid = false;
    }
    return valid;
  };

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
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,14rem)_auto_minmax(0,1fr)] md:items-start">
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.name.label" })}
          </FormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.subagents.form.name.placeholder",
            })}
          />
          {nameError ? <p className="text-ui-base text-destructive">{nameError}</p> : null}
        </div>
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
                onClick={() => setColor(option)}
              >
                <span className={cn("size-3.5 rounded-full", COLOR_DOT_CLASS[option])} />
              </button>
            ))}
          </div>
        </div>
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
              onValueChange={handleModelChange}
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
              intl={intl}
              state={thoughtLevelState}
              disabled={saving}
              labelVisibilityClassName="inline-flex min-w-0"
              onValueCommit={setThoughtLevel}
            />
            {formSpeedState.kind === "supported" || formSpeedState.kind === "unknown" ? (
              <SubagentSpeedField
                intl={intl}
                state={formSpeedState}
                value={speed}
                disabled={saving}
                labelVisibilityClassName="inline-flex min-w-0"
                onValueCommit={setSpeed}
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
      </div>

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
          onChange={(event) => setDescription(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.subagents.form.description.placeholder",
          })}
        />
        {descriptionError ? (
          <p className="text-ui-base text-destructive">{descriptionError}</p>
        ) : null}
      </div>

      <div className="space-y-2 pt-1">
        <FormFieldLabel>
          {intl.formatMessage({ id: "settings.subagents.form.tools.label" })}
        </FormFieldLabel>
        <div className="flex min-w-0 items-center gap-2">
          <Select value={inheritAllTools ? "all" : "custom"} onValueChange={handleToolsModeChange}>
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
                  onToggle={() => toggleTool(tool)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <FormFieldLabel>
          {intl.formatMessage({
            id: "settings.subagents.form.systemPrompt.label",
          })}
        </FormFieldLabel>
        <SettingsFormTextarea
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          rows={3}
          className="max-h-56 min-h-16 resize-y overflow-y-auto text-ui-base"
          placeholder={intl.formatMessage({
            id: "settings.subagents.form.systemPrompt.placeholder",
          })}
        />
        {promptError ? <p className="text-ui-base text-destructive">{promptError}</p> : null}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2.5">
        <p className="min-w-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({
            id: "settings.subagents.form.injectAgentsMd.label",
          })}
        </p>
        <Switch
          checked={injectAgentsMd}
          onCheckedChange={setInjectAgentsMd}
          aria-label={intl.formatMessage({
            id: "settings.subagents.form.injectAgentsMd.label",
          })}
        />
      </div>

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

export function SubagentsSection({ onManageModels }: SubagentsSectionProps) {
  const { intl, locale } = useACodeIntl();
  const confirmDialog = useConfirmDialog();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const localHostServices = useBaseWorkspaceServices();
  const modelSelectionRead = useModelSelectionServiceView(localHostServices.modelSelectionService);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // 非 Ready 生命周期均保留表单中的模型意图；error/unavailable 不能被误判成模型已失效。
  const modelSelectionLoading = modelSelectionRead.state.status !== "ready";
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => {
    const seen = new Set<string>();
    return (
      tabs
        .filter(isWorkspaceTab)
        .filter(isPluginScopeWorkspaceConnected)
        // Subagent Settings 只管理 Local Environment；远程配置浏览/编辑是独立产品能力。
        .filter((tab) => !tab.remoteTarget && !tab.remoteSessionId && !tab.workspaceIdentity)
        .filter((tab) => {
          const key = getPluginWorkspaceKey(tab);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
    );
  }, [tabs]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [capability, setCapability] = useState<AgentsCapability | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [operatingAgentId, setOperatingAgentId] = useState<string | null>(null);
  // 批量编辑会话状态（唯一所有者，specs/subagent-batch-edit.md）：模式开关、选中集、
  // 串行应用进度与结果。操作条/弹层不持有已确认状态，只暂存未确认目标值。
  const [batchMode, setBatchMode] = useState(false);
  const [selectedBatchIds, setSelectedBatchIds] = useState<ReadonlySet<string>>(new Set());
  const [batchApplying, setBatchApplying] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchResult, setBatchResult] = useState<SubagentModelBatchResult | null>(null);
  // 分组统一设置弹层的目标分组 key（user/builtIn/插件 id）；应用时按当前列表重算目标集，
  // 保证 buildUserAgentBatchConfig 的透传基线是最新行投影而非打开瞬间的快照。
  const [batchDialogGroupKey, setBatchDialogGroupKey] = useState<
    { kind: "user" } | { kind: "builtIn" } | { kind: "plugin"; pluginId: string } | null
  >(null);
  const [selectedScopeKey, setSelectedScopeKey] = useState("user");
  const selectedWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === selectedScopeKey,
  );
  const targetWorkspacePath = selectedWorkspace?.workspacePath ?? "";
  const targetWorkspaceIdentity = undefined;
  const { pluginManagementService, subagentsService } = localHostServices;
  const activeScope = selectedWorkspace ? "workspace" : "user";
  const latestRequestIdRef = useRef(0);
  const pluginInventoryWorkspacePath = targetWorkspacePath || workspaceTabs[0]?.workspacePath;
  const chatModelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ACODE_AGENT_PROVIDER, modelSelectionView, {
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      apiKeyLabel: intl.formatMessage({
        id: "settings.modelProvider.apiKey",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [intl, modelSelectionView]);
  const subagentModelSelectGroups = chatModelSelectGroups;
  const loadAgents = useCallback(
    async (showBlockingLoading: boolean) => {
      setLoading(showBlockingLoading);
      setRefreshing(!showBlockingLoading);
      setError(null);
      const requestId = ++latestRequestIdRef.current;
      try {
        const result = await subagentsService.list({
          workspacePath: targetWorkspacePath ?? "",
          workspaceIdentity: targetWorkspaceIdentity,
          provider: ACODE_AGENT_PROVIDER,
          mode: activeScope === "user" ? "settingsUserOnly" : "allRuntimeScopes",
        });
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        // 插件 agent 是运行时 profile 的只读投影；设置页展示它们，但仍不展示工作区级编辑入口。
        setAgents(projectSettingsSubagents(result));
        setCapability(result.capability);
        setLoading(false);
        setRefreshing(false);
      } catch (loadError) {
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setLoading(false);
        setRefreshing(false);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [subagentsService, activeScope, targetWorkspaceIdentity, targetWorkspacePath],
  );

  useEffect(() => {
    void loadAgents(true);
  }, [loadAgents]);

  useEffect(() => {
    if (!pluginInventoryWorkspacePath) return;
    let active = true;
    // 冷启动 seed 晚于文件首读，旧用户页又跳过 inventory 初始化，导致插件直到重进才出现。
    // 复用已有初始化完成事件刷新只读资源，不阻塞用户列表、不轮询，也不把项目配置带入用户页。
    void (async () => {
      try {
        await initializePlugins({
          workspacePath: pluginInventoryWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          configScope: activeScope === "user" ? "user" : undefined,
          pluginService: pluginManagementService,
        });
        if (active) await loadAgents(false);
      } catch (initializationError) {
        if (active)
          logger.warn("[subagents] 插件资源初始化失败，保留当前列表", initializationError);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    activeScope,
    initializePlugins,
    loadAgents,
    pluginInventoryWorkspacePath,
    pluginManagementService,
    targetWorkspaceIdentity,
  ]);

  const refresh = useCallback(async () => {
    await loadAgents(false);
  }, [loadAgents]);

  const refreshMentionStore = useCallback(async () => {
    await refreshLoadedSubagentsStoreForWorkspace({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      subagentsService,
    });
  }, [subagentsService, targetWorkspaceIdentity, targetWorkspacePath]);

  const handleSave = useCallback(
    async (config: SubAgentConfig) => {
      setSaving(true);
      try {
        if (editingAgent) {
          await subagentsService.updateAgent({
            agentId: editingAgent.id,
            config,
            oldFilePath: editingAgent.path,
            provider: ACODE_AGENT_PROVIDER,
            scope: editingAgent.scope === "workspace" ? "workspace" : "user",
            workspacePath: editingAgent.projectPath ?? targetWorkspacePath ?? undefined,
            workspaceIdentity: targetWorkspaceIdentity,
          });
        } else {
          await subagentsService.createAgent({
            config,
            provider: ACODE_AGENT_PROVIDER,
            scope: activeScope,
            workspacePath: targetWorkspacePath ?? undefined,
            workspaceIdentity: targetWorkspaceIdentity,
          });
        }
        setShowForm(false);
        setEditingAgent(null);
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (saveError) {
        toast(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSaving(false);
      }
    },
    [
      activeScope,
      editingAgent,
      refresh,
      refreshMentionStore,
      subagentsService,
      targetWorkspaceIdentity,
      targetWorkspacePath,
    ],
  );

  const handleDelete = useCallback(
    async (agent: AgentSummary) => {
      if (!isEditableUserAgent(agent)) {
        return;
      }
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.subagents.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.subagents.delete.description" },
          { name: agent.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        await subagentsService.deleteAgent({
          agentId: agent.id,
          filePath: agent.path,
        });
        setEditingAgent(null);
        setShowForm(false);
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (deleteError) {
        toast(deleteError instanceof Error ? deleteError.message : String(deleteError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [confirmDialog, intl, refresh, refreshMentionStore, subagentsService],
  );

  const handleToggle = useCallback(
    async (agent: AgentSummary, enabled: boolean) => {
      if (!supportsEnabledToggle(agent)) {
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        await subagentsService.setEnabled({
          agentId: agent.id,
          enabled,
        });
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (toggleError) {
        toast(toggleError instanceof Error ? toggleError.message : String(toggleError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [refresh, refreshMentionStore, subagentsService],
  );

  const handleModelOverrideChange = useCallback(
    async (
      agent: AgentSummary,
      config: { model?: string; thoughtLevel?: string; speed?: string },
    ) => {
      const agentName = getBuiltInSubagentName(agent);
      if (!agentName && agent.source !== "plugin") {
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        const modelSelection = toSubagentModelSelection(
          config.model,
          config.thoughtLevel,
          config.speed,
        );
        if (agentName) {
          await subagentsService.setBuiltInModelOverride({ agentName, modelSelection });
        } else {
          // 稳定 ID 不含插件版本；升级换目录后继续读取同一份用户 Selection 覆盖。
          await subagentsService.setPluginAgentModelOverride({ agentId: agent.id, modelSelection });
        }
      } catch (changeError) {
        toast(changeError instanceof Error ? changeError.message : String(changeError));
        setOperatingAgentId(null);
        throw changeError;
      }
      try {
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (refreshError) {
        // 持久化成功即为提交点；后续投影刷新失败只能提示，不能让控件回滚磁盘状态。
        toast(refreshError instanceof Error ? refreshError.message : String(refreshError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [refresh, refreshMentionStore, subagentsService],
  );

  const recommendBatchStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");

  const enterBatchMode = useCallback(() => {
    setBatchMode(true);
    setSelectedBatchIds(new Set());
    setBatchResult(null);
    setBatchProgress(null);
  }, []);

  const exitBatchMode = useCallback(() => {
    if (batchApplying) {
      return;
    }
    setBatchMode(false);
    setSelectedBatchIds(new Set());
    setBatchResult(null);
    setBatchProgress(null);
  }, [batchApplying]);

  const handleBatchCheckChange = useCallback(
    (agent: AgentSummary, checked: boolean) => {
      // 应用进行中禁止改选中：行点击/复选框在 UI 层已禁用，这里再兜底一次。
      if (batchApplying || !isBatchApplicableAgent(agent)) {
        return;
      }
      setSelectedBatchIds((current) => {
        const next = new Set(current);
        if (checked) {
          next.add(agent.id);
        } else {
          next.delete(agent.id);
        }
        return next;
      });
      setBatchResult(null);
    },
    [batchApplying],
  );

  // 分组全选/全不选：批量模式下勾选/取消该组全部可批量行。
  const handleBatchGroupCheck = useCallback(
    (groupAgents: readonly AgentSummary[], checked: boolean) => {
      const selectable = resolveBatchApplyTargets(groupAgents);
      if (selectable.length === 0) {
        return;
      }
      setSelectedBatchIds((current) => {
        const next = new Set(current);
        for (const target of selectable) {
          if (checked) {
            next.add(target.id);
          } else {
            next.delete(target.id);
          }
        }
        return next;
      });
      setBatchResult(null);
    },
    [],
  );

  /**
   * 批量场景下的单行落盘：内置/插件行走行内覆盖（handleModelOverrideChange），
   * 自建/工作区 agent 走 updateAgent 重写定义文件 modelSelection（其余字段原样保留）。
   * 两条路径最终都落到 refresh 投影，保持唯一已确认状态。
   * value 的 modelSelection 已是解析好的结构体（不传 picker 编码串再手写切分）；
   * 顶层的 thoughtLevel 必须显式带上，否则覆盖路径会回落到选模型时的 Registry 默认档位。
   */
  const applyBatchTarget = useCallback(
    async (agent: AgentSummary, value: SubagentModelBatchValue) => {
      if (resolveBatchWritePath(agent) === "override") {
        await handleModelOverrideChange(agent, {
          model: value.modelSelection
            ? encodeCustomModelValue(value.modelSelection.providerId, value.modelSelection.modelId)
            : undefined,
          thoughtLevel: value.thoughtLevel ?? value.modelSelection?.options?.reasoningLevel,
          speed: value.speed ?? value.modelSelection?.options?.speed,
        });
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        await subagentsService.updateAgent({
          agentId: agent.id,
          config: buildUserAgentBatchConfig(agent, value),
          oldFilePath: agent.path,
          provider: ACODE_AGENT_PROVIDER,
          scope: agent.scope === "workspace" ? "workspace" : "user",
          workspacePath: agent.projectPath ?? targetWorkspacePath ?? undefined,
          workspaceIdentity: targetWorkspaceIdentity,
        });
      } catch (changeError) {
        setOperatingAgentId(null);
        throw changeError;
      }
      try {
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (refreshError) {
        toast(refreshError instanceof Error ? refreshError.message : String(refreshError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [
      handleModelOverrideChange,
      refresh,
      refreshMentionStore,
      subagentsService,
      targetWorkspaceIdentity,
      targetWorkspacePath,
    ],
  );

  /**
   * 批量应用唯一执行点（specs/subagent-batch-edit.md R1/R4）：整批只做一次 Start Plan
   * 推荐（循环外），随后按列表顺序逐行串行落盘，每行独立成功/失败；失败行保留磁盘
   * 原值并计入结果汇总，不中断后续行。写路径统一委托 applyBatchTarget。
   */
  const applyBatchModelOverride = useCallback(
    async (targets: readonly AgentSummary[], value: SubagentModelBatchValue) => {
      if (batchApplying || targets.length === 0) {
        return;
      }
      setBatchApplying(true);
      setBatchResult(null);
      setBatchProgress({ done: 0, total: targets.length });
      const result = createEmptyBatchResult();
      let targetValue = value;
      if (value.modelSelection) {
        // modelSelection 是选模型那一刻按 Registry 补的默认档位；用户随后在操作条改的
        // thoughtLevel 只在 value 顶层。先合并再推荐/写盘，避免推荐未改写时被冲回默认。
        const thoughtLevel = value.thoughtLevel?.trim();
        const userSelection: ModelSelection = {
          ...value.modelSelection,
          options: {
            ...value.modelSelection.options,
            ...(thoughtLevel ? { reasoningLevel: thoughtLevel } : {}),
          },
        };
        const chosen = await recommendBatchStartPlan(userSelection);
        if (!chosen) {
          // 用户拒绝/关闭推荐弹窗：整批保留原值，不进入逐行循环。
          setBatchProgress(null);
          setBatchApplying(false);
          setBatchResult({
            succeeded: [],
            failed: targets.map((agent) => ({
              name: agent.name,
              message: intl.formatMessage({ id: "settings.subagents.batch.declined" }),
            })),
          });
          return;
        }
        targetValue = {
          modelSelection: chosen,
          thoughtLevel: chosen.options?.reasoningLevel,
        };
      }
      for (let index = 0; index < targets.length; index += 1) {
        const agent = targets[index];
        if (!agent) {
          continue;
        }
        setBatchProgress({ done: index, total: targets.length });
        try {
          await applyBatchTarget(agent, targetValue);
          result.succeeded.push(agent.name);
        } catch (changeError) {
          result.failed.push({
            name: agent.name,
            message: changeError instanceof Error ? changeError.message : String(changeError),
          });
        }
      }
      // 结束后必须清空进度：操作条以 progress 非空判定显示「正在应用 n/n」转圈。
      setBatchProgress(null);
      setOperatingAgentId(null);
      setBatchApplying(false);
      setBatchResult(result);
      if (result.succeeded.length > 0) {
        try {
          await Promise.all([refresh(), refreshMentionStore()]);
        } catch (refreshError) {
          // 持久化成功即为提交点；批量后的投影刷新失败只提示，不回滚磁盘状态。
          toast(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
      }
    },
    [applyBatchTarget, batchApplying, intl, recommendBatchStartPlan, refresh, refreshMentionStore],
  );

  const handleGroupBatchApply = useCallback(
    (groupAgents: readonly AgentSummary[]) => {
      const targets = resolveBatchApplyTargets(groupAgents);
      setBatchDialogGroupKey(null);
      void applyBatchModelOverride(targets, {});
    },
    [applyBatchModelOverride],
  );

  const handleEdit = useCallback((agent: AgentSummary) => {
    if (!isEditableUserAgent(agent)) {
      return;
    }
    setEditingAgent(agent);
    setShowForm(false);
  }, []);

  const canManageUserAgents =
    activeScope === "workspace"
      ? Boolean(targetWorkspacePath)
      : capability?.userScopeAvailable === true;

  const handleAddNew = useCallback(() => {
    if (!canManageUserAgents) {
      return;
    }
    setEditingAgent(null);
    setShowForm(true);
  }, [canManageUserAgents]);

  const handleCancelForm = useCallback(() => {
    setEditingAgent(null);
    setShowForm(false);
  }, []);

  const filteredAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return agents.filter((agent) => {
      if (activeScope === "user") {
        if (agent.scope === "workspace") return false;
      } else {
        if (isBuiltInAgent(agent) || agent.scope !== "workspace") return false;
        if (agent.source === "plugin" && agent.projectPath !== targetWorkspacePath) return false;
        if (
          agent.source !== "plugin" &&
          agent.projectPath &&
          agent.projectPath !== targetWorkspacePath
        )
          return false;
      }
      if (!normalizedQuery) return true;
      const haystack = [
        agent.name,
        agent.description,
        agent.modelSelection
          ? `${agent.modelSelection.providerId}/${agent.modelSelection.modelId}`
          : undefined,
        agent.path,
        agent.scope,
        agent.source,
        agent.tools?.join(" "),
        agent.disallowedTools?.join(" "),
        agent.skills?.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [activeScope, agents, query, targetWorkspacePath]);

  const groupedAgents = useMemo(() => groupAgentsByScope(filteredAgents), [filteredAgents]);
  const pluginGroups = useMemo(
    () => groupPluginAgentsById(groupedAgents.plugin),
    [groupedAgents.plugin],
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const pluginIconItemById = useMemo(
    () =>
      new Map(
        plugins.map((plugin) => [
          plugin.id,
          { name: plugin.name, listing: pluginListingById.get(plugin.id) },
        ]),
      ),
    [pluginListingById, plugins],
  );
  const filteredAgentCount =
    groupedAgents.user.length + groupedAgents.plugin.length + groupedAgents.builtIn.length;
  const currentEditingAgent = useMemo(() => {
    if (!editingAgent) {
      return null;
    }
    return agents.find((agent) => agent.id === editingAgent.id) ?? editingAgent;
  }, [agents, editingAgent]);
  const isFormView = canManageUserAgents && (showForm || currentEditingAgent !== null);

  // 批量目标集 = 当前过滤可见 ∩ 可批量行 ∩ 选中集（specs/subagent-batch-edit.md R6）。
  const batchTargets = useMemo(
    () =>
      resolveBatchApplyTargets(filteredAgents).filter((agent) => selectedBatchIds.has(agent.id)),
    [filteredAgents, selectedBatchIds],
  );
  const batchSelectableAgents = useMemo(
    () => resolveBatchApplyTargets(filteredAgents),
    [filteredAgents],
  );
  const batchApplicableCount = batchSelectableAgents.length;

  /** 全部全选/全不选：勾选/取消当前筛选结果里所有可批量行（跨分组）。 */
  const toggleBatchAll = useCallback(
    (checked: boolean) => {
      setSelectedBatchIds((current) => {
        const next = new Set(current);
        for (const agent of batchSelectableAgents) {
          if (checked) {
            next.add(agent.id);
          } else {
            next.delete(agent.id);
          }
        }
        return next;
      });
      setBatchResult(null);
    },
    [batchSelectableAgents],
  );

  // 过滤/作用域变化后裁剪选中集：选中 id 不在当前可见可批量集内即剔除。
  useEffect(() => {
    if (!batchMode) {
      return;
    }
    const visible = new Set(resolveBatchApplyTargets(filteredAgents).map((agent) => agent.id));
    setSelectedBatchIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (visible.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [batchMode, filteredAgents]);

  // 分组统一设置弹层的目标集：按 key 从当前分组投影重算（保持透传基线新鲜）。
  const batchDialogGroup = useMemo(() => {
    if (!batchDialogGroupKey) {
      return null;
    }
    const resolveGroupName = (key: NonNullable<typeof batchDialogGroupKey>): string => {
      if (key.kind === "user") {
        return intl.formatMessage({ id: "settings.subagents.group.user" });
      }
      if (key.kind === "builtIn") {
        return intl.formatMessage({ id: "settings.subagents.group.builtIn" });
      }
      const items = pluginGroups.find(([pluginId]) => pluginId === key.pluginId)?.[1] ?? [];
      const head = items[0];
      return resolvePluginDisplayName(
        {
          name: head?.pluginName ?? key.pluginId,
          listing:
            (head?.pluginId ? pluginListingById.get(head.pluginId) : undefined) ??
            resolveUniquePluginListingByName(availablePlugins, head?.pluginName ?? key.pluginId),
        },
        locale,
      );
    };
    const resolveGroupItems = (
      key: NonNullable<typeof batchDialogGroupKey>,
    ): readonly AgentSummary[] => {
      if (key.kind === "user") {
        return groupedAgents.user;
      }
      if (key.kind === "builtIn") {
        return groupedAgents.builtIn;
      }
      return pluginGroups.find(([pluginId]) => pluginId === key.pluginId)?.[1] ?? [];
    };
    return {
      groupName: resolveGroupName(batchDialogGroupKey),
      targets: resolveBatchApplyTargets(resolveGroupItems(batchDialogGroupKey)),
    };
  }, [
    availablePlugins,
    batchDialogGroupKey,
    groupedAgents,
    intl,
    locale,
    pluginGroups,
    pluginListingById,
  ]);

  if (isFormView) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={[
            {
              label:
                currentEditingAgent?.name ??
                intl.formatMessage({ id: "settings.subagents.addNew" }),
            },
          ]}
          onSectionSelect={handleCancelForm}
        />
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-ui-xl font-semibold text-foreground">
              {editingAgent
                ? intl.formatMessage({ id: "settings.subagents.edit" })
                : intl.formatMessage({ id: "settings.subagents.addNew" })}
            </h3>
            <p className="text-ui-base text-foreground-subtle">
              {editingAgent
                ? intl.formatMessage({
                    id: "settings.subagents.editDescription",
                  })
                : intl.formatMessage({
                    id: "settings.subagents.addDescription",
                  })}
            </p>
          </div>

          <SubagentForm
            initial={currentEditingAgent ?? undefined}
            modelSelectionView={modelSelectionView}
            modelSelectionLoading={modelSelectionLoading}
            modelSelectGroups={subagentModelSelectGroups}
            onManageModels={onManageModels}
            saving={saving}
            onCancel={handleCancelForm}
            onDelete={handleDelete}
            onSave={handleSave}
            scopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
          />
        </div>
      </div>
    );
  }

  const renderAgentList = (items: AgentSummary[]) => (
    <div className="overflow-hidden rounded-xl bg-surface">
      {items.map((agent, index) => (
        <div key={agent.id}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          <AgentListRow
            agent={agent}
            pluginIconItem={
              agent.pluginId
                ? pluginIconItemById.get(agent.pluginId)
                : agent.pluginName
                  ? {
                      name: agent.pluginName,
                      listing: resolveUniquePluginListingByName(availablePlugins, agent.pluginName),
                    }
                  : undefined
            }
            isOperating={operatingAgentId === agent.id || refreshing}
            modelGroups={chatModelSelectGroups}
            modelSelectionView={modelSelectionView}
            modelSelectionLoading={modelSelectionLoading}
            modelSelectGroups={subagentModelSelectGroups}
            batchMode={batchMode}
            batchChecked={batchMode && selectedBatchIds.has(agent.id)}
            batchApplying={batchApplying}
            onBatchCheckChange={handleBatchCheckChange}
            onModelOverrideChange={handleModelOverrideChange}
            onDelete={handleDelete}
            onEdit={handleEdit}
            onToggle={handleToggle}
          />
        </div>
      ))}
    </div>
  );

  /**
   * 分组头行：批量模式渲染三态「全选本组」；普通模式渲染「…」批量菜单
   * （统一设置模型 / 本组恢复继承默认，specs/subagent-batch-edit.md R1）。
   */
  const renderGroupHead = (
    groupAgents: readonly AgentSummary[],
    groupKey: string,
    groupName: string,
    dialogKey: { kind: "user" } | { kind: "builtIn" } | { kind: "plugin"; pluginId: string },
    header: ReactNode,
    actions?: ReactNode,
  ) => {
    const check = batchMode ? resolveGroupBatchCheckState(groupAgents, selectedBatchIds) : null;
    const overridableCount = resolveBatchApplyTargets(groupAgents).length;
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {check ? (
            <SubagentGroupSelectAll
              groupKey={groupKey}
              groupName={groupName}
              checkState={check.state}
              disabled={batchApplying || check.selectable.length === 0}
              onToggle={(checked) => handleBatchGroupCheck(groupAgents, checked)}
            />
          ) : null}
          {header}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!batchMode ? (
            <SubagentGroupBatchMenu
              groupKey={groupKey}
              groupName={groupName}
              overridableCount={overridableCount}
              disabled={batchApplying}
              onSetModels={() => setBatchDialogGroupKey(dialogKey)}
              onResetInherit={() => handleGroupBatchApply(groupAgents)}
            />
          ) : null}
          {actions}
        </div>
      </div>
    );
  };

  const hasSearchResultEmpty = Boolean(query.trim()) && filteredAgentCount === 0;
  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            align="start"
            selectedScopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground">
            <span>{intl.formatMessage({ id: "settings.subagents.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{filteredAgentCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.subagents.searchPlaceholder",
          })}
        />
        {batchMode ? (
          <label
            data-testid={TID_SUBAGENT_BATCH_SELECT_ALL}
            className={cn(
              "flex select-none items-center gap-2 text-ui-base text-foreground",
              (batchApplying || batchSelectableAgents.length === 0) &&
                "cursor-not-allowed opacity-60",
            )}
          >
            <Checkbox
              checked={
                batchTargets.length === 0
                  ? false
                  : batchTargets.length === batchSelectableAgents.length
                    ? true
                    : "indeterminate"
              }
              disabled={batchApplying || batchSelectableAgents.length === 0}
              aria-label={intl.formatMessage({ id: "settings.subagents.batch.selectAll.label" })}
              onCheckedChange={(checked) => toggleBatchAll(checked === true)}
            />
            {intl.formatMessage({ id: "settings.subagents.batch.selectAll.label" })}
          </label>
        ) : null}
        {batchMode ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={exitBatchMode}
            disabled={batchApplying}
          >
            <X data-icon="inline-start" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.subagents.batch.bar.exit" })}
          </Button>
        ) : batchApplicableCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_SUBAGENT_BATCH_TRIGGER}
            onClick={enterBatchMode}
            disabled={loading || batchApplying}
          >
            <ListChecks data-icon="inline-start" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.subagents.batch.entry" })}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {modelSelectionRead.state.status === "error" ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          <span>{intl.formatMessage({ id: "settings.subagents.modelLoadFailed" })}</span>
          <Button type="button" variant="ghost" size="sm" onClick={modelSelectionRead.reload}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}

      {capability && !capability.userScopeAvailable ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: "settings.subagents.userScopeDesktopOnly",
          })}
        </div>
      ) : null}

      {loading ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.subagents.empty" })} />
      ) : (
        <div className="space-y-6">
          <section
            className={query.trim() && groupedAgents.user.length === 0 ? "hidden" : "space-y-4"}
          >
            {renderGroupHead(
              groupedAgents.user,
              "user",
              intl.formatMessage({ id: "settings.subagents.group.user" }),
              { kind: "user" },
              <SettingsResourceGroupHeader
                count={groupedAgents.user.length}
                title={intl.formatMessage({
                  id: "settings.subagents.group.user",
                })}
              />,
              <SettingsResourceHeaderActions
                onRefresh={() => void Promise.all([refresh(), refreshMentionStore()])}
                onNew={batchMode ? undefined : canManageUserAgents ? handleAddNew : undefined}
                refreshing={refreshing}
              />,
            )}
            {groupedAgents.user.length > 0 ? (
              renderAgentList(groupedAgents.user)
            ) : (
              <PluginInstallEmptyState
                title={intl.formatMessage({ id: "settings.subagents.empty" })}
                description={intl.formatMessage({
                  id: "settings.subagents.addDescription",
                })}
                actions={
                  canManageUserAgents ? (
                    <Button type="button" variant="default" size="lg" onClick={handleAddNew}>
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({ id: "settings.create.action" })}
                    </Button>
                  ) : null
                }
              />
            )}
          </section>
          {pluginGroups.map(([pluginId, items]) => {
            const groupName = resolvePluginDisplayName(
              {
                name: items[0]?.pluginName ?? pluginId,
                listing:
                  (items[0]?.pluginId ? pluginListingById.get(items[0].pluginId) : undefined) ??
                  resolveUniquePluginListingByName(
                    availablePlugins,
                    items[0]?.pluginName ?? pluginId,
                  ),
              },
              locale,
            );
            return (
              <section key={pluginId} className="space-y-4">
                {renderGroupHead(
                  items,
                  `plugin:${pluginId}`,
                  groupName,
                  { kind: "plugin", pluginId },
                  <SettingsResourceGroupHeader count={items.length} title={groupName} />,
                )}
                {renderAgentList(items)}
              </section>
            );
          })}
          {groupedAgents.builtIn.length > 0 ? (
            <section className="space-y-4">
              {renderGroupHead(
                groupedAgents.builtIn,
                "builtIn",
                intl.formatMessage({ id: "settings.subagents.group.builtIn" }),
                { kind: "builtIn" },
                <SettingsResourceGroupHeader
                  count={groupedAgents.builtIn.length}
                  title={intl.formatMessage({
                    id: "settings.subagents.group.builtIn",
                  })}
                />,
              )}
              {renderAgentList(groupedAgents.builtIn)}
            </section>
          ) : null}
        </div>
      )}

      {batchMode ? (
        <SubagentModelBatchBar
          selectedCount={batchTargets.length}
          applying={batchApplying}
          progress={batchProgress}
          result={batchResult}
          disabled={loading || refreshing}
          modelGroups={chatModelSelectGroups}
          modelSelectionView={modelSelectionView}
          modelSelectionLoading={modelSelectionLoading}
          onValueChange={() => setBatchResult(null)}
          onApply={(value) => void applyBatchModelOverride(batchTargets, value)}
          onExit={exitBatchMode}
        />
      ) : null}

      {batchDialogGroup && batchDialogGroup.targets.length > 0 ? (
        <SubagentModelBatchDialog
          open
          groupName={batchDialogGroup.groupName}
          targetCount={batchDialogGroup.targets.length}
          disabled={batchApplying}
          modelGroups={chatModelSelectGroups}
          modelSelectionView={modelSelectionView}
          modelSelectionLoading={modelSelectionLoading}
          onOpenChange={(open) => {
            if (!open) {
              setBatchDialogGroupKey(null);
            }
          }}
          onApply={(value) => {
            const targets = batchDialogGroup.targets;
            setBatchDialogGroupKey(null);
            void applyBatchModelOverride(targets, value);
          }}
        />
      ) : null}
    </div>
  );
}
