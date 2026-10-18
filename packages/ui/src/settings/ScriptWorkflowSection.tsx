import { useState } from "react";
import { CircleIcon } from "lucide-react";
import { DEFAULT_SCRIPT_WORKFLOW_MODE, type ScriptWorkflowMode } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/**
 * 设置页「脚本工作流」三档（停用 / 按需 / 始终可用）——RunWorkflow（/ultracode 编排系统）
 * 的本机产品开关（apps/acode-cli/specs/script-workflow-management-surface.md §5 行 4）。
 *
 * **比 dwf 卡片简单**：本机设置即真相——选中态唯一来源是 props 传入的落盘值
 * （AppSettings.scriptWorkflowMode，归一化后缺席落缺省档），没有 Host 快照 store、
 * 没有远端/环境变量折叠。写入经 settingService.update 落盘，档位在**下一次会话创建**
 * 时经 services 折叠出口 → v4 createSession 信封生效（§8.1：无会话中途改档）。
 *
 * 挂载点：dynamicWorkflow 分区页内、DynamicWorkflowSection 之下（spec §7.3 方案 C——
 * 不新增设置侧栏分区，同页两卡检索路径唯一）。
 */
const SCRIPT_WORKFLOW_OPTIONS: ReadonlyArray<{
  descriptionId: string;
  labelId: string;
  mode: ScriptWorkflowMode;
}> = [
  {
    mode: "disabled",
    labelId: "settings.scriptWorkflow.option.disabled",
    descriptionId: "settings.scriptWorkflow.option.disabled.description",
  },
  {
    mode: "onDemand",
    labelId: "settings.scriptWorkflow.option.onDemand",
    descriptionId: "settings.scriptWorkflow.option.onDemand.description",
  },
  {
    mode: "alwaysOn",
    labelId: "settings.scriptWorkflow.option.alwaysOn",
    descriptionId: "settings.scriptWorkflow.option.alwaysOn.description",
  },
];

export function ScriptWorkflowSection({
  mode,
  onSelect,
}: {
  /**
   * 当前落盘档位（已由调用方归一化；undefined 按缺省档 onDemand 回显）。
   * 选中态唯一来源，组件不持有副本、不自行折叠 enabled。
   */
  mode?: ScriptWorkflowMode | null;
  /** 用户改选三档时的落盘动作（Promise 拒绝即显示 saveError）。缺席 ⇒ 三档不可点。 */
  onSelect?: (mode: ScriptWorkflowMode) => Promise<void>;
}) {
  const { intl } = useACodeIntl();
  const [saveError, setSaveError] = useState(false);
  const currentMode = mode ?? DEFAULT_SCRIPT_WORKFLOW_MODE;

  return (
    <div className="space-y-3">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.scriptWorkflow.description" })}
      </p>
      <SettingsGroupCard>
        <div
          className="flex flex-col gap-2 p-1"
          data-testid="settings-script-workflow-options"
          role="radiogroup"
          aria-label={intl.formatMessage({ id: "settings.scriptWorkflow.title" })}
        >
          {SCRIPT_WORKFLOW_OPTIONS.map(({ descriptionId, labelId, mode: optionMode }) => {
            const selected = currentMode === optionMode;
            const label = intl.formatMessage({ id: labelId });
            const handleClick = () => {
              if (onSelect === undefined || selected) return;
              setSaveError(false);
              onSelect(optionMode)
                .then(() => setSaveError(false))
                .catch((error) => {
                  // 保存失败只报状态，不改选中态：落盘值没变，UI 不能先假装变了。
                  setSaveError(true);
                  logger.warn("[script-workflow] 设置保存失败", {
                    error: error instanceof Error ? error.message : String(error),
                    mode: optionMode,
                  });
                });
            };
            return (
              <button
                aria-checked={selected}
                aria-label={label}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                  onSelect === undefined
                    ? "cursor-default"
                    : selected
                      ? "cursor-default bg-selected"
                      : "cursor-pointer hover:bg-hover",
                )}
                data-mode={optionMode}
                data-selected={selected ? "true" : undefined}
                data-testid="settings-script-workflow-option"
                disabled={onSelect === undefined}
                key={optionMode}
                onClick={handleClick}
                role="radio"
                type="button"
              >
                <CircleIcon
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-4 shrink-0 border",
                    selected
                      ? "border-primary fill-primary text-primary"
                      : "border-border text-transparent",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-ui-base font-medium text-foreground">{label}</span>
                    {optionMode === DEFAULT_SCRIPT_WORKFLOW_MODE ? (
                      <span className="rounded-full bg-surface px-1.5 py-px text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({ id: "settings.scriptWorkflow.defaultTag" })}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-ui-base leading-4 text-foreground-subtle">
                    {intl.formatMessage({ id: descriptionId })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </SettingsGroupCard>
      {saveError ? (
        <p className="text-ui-base text-destructive" role="alert">
          {intl.formatMessage({ id: "settings.scriptWorkflow.saveError" })}
        </p>
      ) : null}
    </div>
  );
}
