import { useState } from "react";
import { CircleIcon } from "lucide-react";
import { DEFAULT_TOOL_SEARCH_APP_MODE, type ToolSearchAppMode } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/**
 * 设置页「工具按需检索」三档（自动 / 本地 / 关）——ToolSearch/DeferredToolCall 的
 * 本机产品开关（apps/acode-cli/specs/tool-search.md R1/R11）。
 *
 * 与 ScriptWorkflowSection 同款**本机设置即真相**形态：选中态唯一来源是 props 传入
 * 的落盘值（AppSettings.toolSearchMode，归一化后缺席落缺省档 off），没有 Host 快照
 * store、没有远端/环境变量折叠。写入经 updateSharedSettings 落盘，档位在**下一次
 * 会话创建/冷恢复**时经 services 折叠出口（resolveToolSearchModeFromSettings）→
 * v4 createSession 信封物化进 AgentRuntimeConfig.toolSearchMode（R3：存活 runtime
 * 不变，无会话中途改档通道）。
 *
 * App 面只有三值：native 是 CLI `--toolsearch-mode` 独有的第四档（波 1 未实装），
 * 刻意不进设置 UI——供应商原生 ToolSearch 支持不完整，不给用户一个会报错的选项。
 */
const TOOL_SEARCH_OPTIONS: ReadonlyArray<{
  descriptionId: string;
  labelId: string;
  mode: ToolSearchAppMode;
}> = [
  {
    mode: "auto",
    labelId: "settings.toolSearch.option.auto",
    descriptionId: "settings.toolSearch.option.auto.description",
  },
  {
    mode: "local",
    labelId: "settings.toolSearch.option.local",
    descriptionId: "settings.toolSearch.option.local.description",
  },
  {
    mode: "off",
    labelId: "settings.toolSearch.option.off",
    descriptionId: "settings.toolSearch.option.off.description",
  },
];

export function ToolSearchSection({
  mode,
  onSelect,
}: {
  /**
   * 当前落盘档位（已由调用方归一化；undefined 按缺省档 off 回显）。
   * 选中态唯一来源，组件不持有副本、不自行折叠 enabled。
   */
  mode?: ToolSearchAppMode | null;
  /** 用户改选三档时的落盘动作（Promise 拒绝即显示 saveError）。缺席 ⇒ 三档不可点。 */
  onSelect?: (mode: ToolSearchAppMode) => Promise<void>;
}) {
  const { intl } = useACodeIntl();
  const [saveError, setSaveError] = useState(false);
  const currentMode = mode ?? DEFAULT_TOOL_SEARCH_APP_MODE;

  return (
    <div className="space-y-3">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.toolSearch.description" })}
      </p>
      <SettingsGroupCard>
        <div
          className="flex flex-col gap-2 p-1"
          data-testid="settings-tool-search-options"
          role="radiogroup"
          aria-label={intl.formatMessage({ id: "settings.toolSearch.title" })}
        >
          {TOOL_SEARCH_OPTIONS.map(({ descriptionId, labelId, mode: optionMode }) => {
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
                  logger.warn("[tool-search] 设置保存失败", {
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
                data-testid="settings-tool-search-option"
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
                    {optionMode === DEFAULT_TOOL_SEARCH_APP_MODE ? (
                      <span className="rounded-full bg-surface px-1.5 py-px text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({ id: "settings.toolSearch.defaultTag" })}
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
      {/* 实验性说明常驻底部（spec R11）：不随选中档折叠——三档共用同一段风险提示。 */}
      <p
        className="text-ui-base text-foreground-subtle"
        data-testid="settings-tool-search-experimental-note"
      >
        {intl.formatMessage({ id: "settings.toolSearch.experimentalNote" })}
      </p>
      {saveError ? (
        <p className="text-ui-base text-destructive" role="alert">
          {intl.formatMessage({ id: "settings.toolSearch.saveError" })}
        </p>
      ) : null}
    </div>
  );
}
