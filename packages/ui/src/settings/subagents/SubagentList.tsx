/**
 * 子智能体设置页的列表选择态组件族（split-plan settings/SubagentsSection.tsx 批次 2）。
 *
 * 从 `settings/SubagentsSection.tsx` 行 315–857 **逐字迁移**的 3 个组件：
 *   - `SubagentGroupBatchMenu`：分组头「…」批量菜单（统一设置模型 / 本组恢复继承默认）；
 *   - `SubagentGroupSelectAll`：批量模式下的分组头三态全选/全不选；
 *   - `AgentListRow`：单个 agent 的列表行（含行内只读摘要徽标、批量复选框、启停开关、
 *     删除按钮、模型覆盖控件插槽）。
 *
 * `SubagentModelOverrideControl` 因行数约束（split-plan 「新模块 <400 行」）单独成文件
 * `./SubagentModelOverrideControl.tsx`；`AgentListRow` 内部仍消费它，本模块保持 re-export
 * 路径不变（调用方可以只从 SubagentList 一处取齐所有列表组件）。
 *
 * 本模块的组件全部**受控**：state 不落地，全部由 props 透传；写操作（onToggle /
 * onDelete / onEdit / onModelOverrideChange / onBatchCheckChange / onSetModels /
 * onResetInherit）由调用方（主组件 `SubagentsSection`）持有并落盘。
 *
 * 批量 test id 字面量（`subagent-batch-trigger` / `subagent-batch-row-checkbox` /
 * `subagent-group-menu-trigger` / `subagent-batch-select-all` / `subagent-batch-group-select-all`）
 * 与 `packages/shared/src/test-ids.ts` 保持同一契约（源仓 test-ids 属 packages/shared，
 * 本包用字面量保持同一 data-testid 契约，见 SubagentsSection.tsx 头注）。
 *
 * 行为不变量（接缝内测试见 packages/ui/test/subagentSections.test.ts 的结构守护部分；
 * 行为验证属 jsdom/E2E 债，split-plan 「每批拆分的固定验收」第 4 条登记口径）：
 *  - 批量模式下行进入选择语义（`checkboxVisible`/`rowEditable` 分流）；
 *  - 批量应用期间行选择与行内控件一并禁用（`batchApplying` 置灰）；
 *  - 模型覆盖控件触发器在「继承」与「已失效」分支文案互不串扰；
 *  - 分组三态勾选只勾选组内可批量行。
 */
import { Bot, MoreHorizontal, Sparkles, Trash2, Undo2 } from "lucide-react";
import {
  TID_SUBAGENT_ROW,
  testId,
  type AgentSummary,
} from "@acode/shared";
import type { ModelSelectionView } from "@acode/services";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { cn } from "@/components/lib/utils.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { isBatchApplicableAgent } from "@/settings/SubagentModelBatchApply.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import {
  allowsAllTools,
  isEditableUserAgent,
  resolveSubagentModelLabel,
  supportsEnabledToggle,
  supportsModelOverride,
  toSubagentModelValue,
} from "@/settings/subagents/agentModel.js";
import { AgentBadge, AgentColorDot, BatchRowCheckbox } from "@/settings/subagents/primitives.js";
// 行内模型覆盖控件单独成文件（行数约束），AgentListRow 内部仍消费它。
import { SubagentModelOverrideControl } from "@/settings/subagents/SubagentModelOverrideControl.js";

// 批量 test id 字面量：与 packages/shared/src/test-ids.ts 保持同一契约。
const TID_SUBAGENT_GROUP_MENU_TRIGGER = "subagent-group-menu-trigger";
const TID_SUBAGENT_BATCH_GROUP_SELECT_ALL = "subagent-batch-group-select-all";

/**
 * 分组头「…」批量菜单（方案 B）：统一设置模型 / 本组恢复继承默认。
 * 仅当组内存在可批量行时可用；菜单只发出意图，落盘由调用方逐行串行执行。
 */
export function SubagentGroupBatchMenu({
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
export function SubagentGroupSelectAll({
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

export function AgentListRow({
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