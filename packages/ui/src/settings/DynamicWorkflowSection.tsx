import { useState } from "react";
import { CircleIcon } from "lucide-react";
import type { DynamicWorkflowMode } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/**
 * 设置页「动态工作流」三档（禁用 / 按需 / 始终）。
 *
 * **对齐 Host 决策链，不另造状态**（packages/shared/specs/dynamic-workflow-availability.md）：
 * 选中态唯一来源是 `dynamicWorkflowAvailabilityStore` 缓存的 Host 判定快照
 * （`config.mode`，`source` 区分远端裁决 / 本地覆盖 / 缺省），本组件不持有一份模式副本、
 * 不自行折叠 `enabled`。loading 期间（一个 app 会话只取一次）三档都不选中。
 *
 * **写入面的现实**：Host 决策的本地输入是 `ACODE_DYNAMIC_WORKFLOW_MODE` 环境变量，唯一写者是
 * desktop main 的 `desktopRuntimeEnv.ts`（三档构建语义，见 spec「事件顺序」），renderer 没有直达
 * 通路；`AppSettings` 也没有对应字段可 `settingService.update`。因此本组件把选择动作做成
 * `onSelect` 注入点：宿主给出回调（未来的接线：AppSettings 加 `dynamicWorkflowMode` 字段 +
 * desktop 在 fork Host 前读取写 env）时三档可点；回调缺席时整区是 Host 判定的**呈现**，
 * 不假装能存。
 */
const DYNAMIC_WORKFLOW_OPTIONS: ReadonlyArray<{
  descriptionId: string;
  labelId: string;
  mode: DynamicWorkflowMode;
}> = [
  {
    mode: "disabled",
    labelId: "settings.dynamicWorkflow.option.disabled",
    descriptionId: "settings.dynamicWorkflow.option.disabled.description",
  },
  {
    mode: "onDemand",
    labelId: "settings.dynamicWorkflow.option.onDemand",
    descriptionId: "settings.dynamicWorkflow.option.onDemand.description",
  },
  {
    mode: "alwaysOn",
    labelId: "settings.dynamicWorkflow.option.alwaysOn",
    descriptionId: "settings.dynamicWorkflow.option.alwaysOn.description",
  },
];

export function DynamicWorkflowSection({
  onSelect,
}: {
  /**
   * 用户改选三档时的落盘动作（返回的 Promise 拒绝即显示 saveError）。缺席 ⇒ 三档不可点，
   * 分区退化为 Host 决策链的只读呈现——不渲染假开关。
   */
  onSelect?: (mode: DynamicWorkflowMode) => Promise<void>;
}) {
  const { intl } = useACodeIntl();
  const { status, config } = useDynamicWorkflowAvailability();
  const [saveError, setSaveError] = useState(false);
  const currentMode = status === "ready" ? (config?.mode ?? null) : null;

  return (
    <div className="space-y-3">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.dynamicWorkflow.description" })}
      </p>
      <SettingsGroupCard>
        <div
          className="flex flex-col gap-2 p-1"
          data-testid="settings-dynamic-workflow-options"
          role="radiogroup"
          aria-label={intl.formatMessage({ id: "settings.dynamicWorkflow.title" })}
        >
          {DYNAMIC_WORKFLOW_OPTIONS.map(({ descriptionId, labelId, mode }) => {
            const selected = currentMode === mode;
            const label = intl.formatMessage({ id: labelId });
            const handleClick = () => {
              if (onSelect === undefined || selected) return;
              setSaveError(false);
              onSelect(mode)
                .then(() => setSaveError(false))
                .catch((error) => {
                  // 保存失败只报状态，不改选中态：Host 判定没变，UI 不能先假装变了。
                  setSaveError(true);
                  logger.warn("[dynamic-workflow] 设置保存失败", {
                    error: error instanceof Error ? error.message : String(error),
                    mode,
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
                data-mode={mode}
                data-selected={selected ? "true" : undefined}
                data-testid="settings-dynamic-workflow-option"
                disabled={onSelect === undefined}
                key={mode}
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
                    {/* 预置文案把「默认」钉在 onDemand 档的描述里（en/zh 同），徽标跟它对齐。 */}
                    {mode === "onDemand" ? (
                      <span className="rounded-full bg-surface px-1.5 py-px text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({ id: "settings.dynamicWorkflow.defaultTag" })}
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
          {intl.formatMessage({ id: "settings.dynamicWorkflow.saveError" })}
        </p>
      ) : null}
    </div>
  );
}
