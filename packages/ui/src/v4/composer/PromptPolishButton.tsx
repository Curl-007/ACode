import { Fragment, useEffect } from "react";
import { CheckIcon, LoaderIcon, Sparkles, Undo2 } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { decodeCustomModelValue } from "@/lib/acodeCustomModelValue.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import type { UsePromptPolishResult } from "@/v4/composer/usePromptPolish.js";

export interface PromptPolishButtonProps {
  /** usePromptPolish 的返回面；按钮只做三态呈现与事件转发，不持有润色状态。 */
  polish: UsePromptPolishResult;
  /** 模型目录分组（ModelConfigSelect 同源 modelSelectGroups），右键按 provider 分组选润色模型。 */
  modelGroups: readonly ModelSelectGroup[];
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
}

/**
 * 提示词一键润色按钮（specs/prompt-polish.md 产品规则 1）——三态：待机 / 润色中 /
 * 可还原。左键 = 润色（润色中再点 = 取消；可还原态再点 = 还原）；右键 = ContextMenu
 * 按 provider 分组选模型，选中即持久化 + 本次 explicit 覆盖（hook.selectModel）。
 * inert-until-wired：V4ComposerToolbar 挂载与草稿快照接线由编排者完成。
 */
export function PromptPolishButton({
  polish,
  modelGroups,
  disabled = false,
  disabledReason,
  className,
}: PromptPolishButtonProps) {
  const { intl } = useACodeIntl();
  const { status, canPolish, canRestore, error } = polish;

  // 用户编辑草稿后 canRestore 翻假：呈现与点击语义都回到待机态，内部 status 由
  // 下一次 restore()/polish() 守卫收敛。
  const effectiveStatus = status === "polishing" ? "polishing" : canRestore ? "restorable" : "idle";

  const titleText =
    effectiveStatus === "polishing"
      ? intl.formatMessage({ id: "chat.promptEnhance.cancel" })
      : effectiveStatus === "restorable"
        ? intl.formatMessage({ id: "chat.promptPolish.restore" })
        : intl.formatMessage({ id: "chat.promptEnhance.title" });
  const descriptionText =
    effectiveStatus === "polishing"
      ? intl.formatMessage({ id: "chat.promptEnhance.cancelDescription" })
      : effectiveStatus === "restorable"
        ? undefined
        : intl.formatMessage({ id: "chat.promptEnhance.description" });

  // 失败/取消/过期回执统一走 toast（不动草稿的事实由 hook 保证）。
  useEffect(() => {
    if (!error) return;
    const message =
      error.kind === "failed"
        ? error.message
          ? intl.formatMessage({ id: "chat.promptEnhance.errorWithDetail" }, { error: error.message })
          : intl.formatMessage({ id: "chat.promptEnhance.error" })
        : error.kind === "no-model"
          ? intl.formatMessage({ id: "chat.promptEnhance.unsupported" })
          : error.kind === "empty-draft"
            ? intl.formatMessage({ id: "chat.promptEnhance.empty" })
            : error.kind === "cancelled"
              ? intl.formatMessage({ id: "chat.promptEnhance.cancelled" })
              : intl.formatMessage({ id: "chat.promptPolish.staleDraft" });
    toast(message, {
      variant: error.kind === "failed" || error.kind === "no-model" ? "warning" : "info",
      dedupeKey: "prompt-polish",
    });
    polish.dismissError();
  }, [error, intl, polish]);

  const handleClick = () => {
    if (effectiveStatus === "polishing") {
      polish.cancel();
      return;
    }
    if (effectiveStatus === "restorable") {
      polish.restore();
      return;
    }
    polish.polish();
  };

  // 空/纯空白草稿禁用（spec 产品规则 5）；工具级 disabled 由调用方给原因。
  const buttonDisabled = disabled || (effectiveStatus === "idle" && !canPolish);
  const tooltipTitle =
    disabledReason ??
    (buttonDisabled && !disabled
      ? intl.formatMessage({ id: "chat.promptEnhance.empty" })
      : titleText);

  return (
    <ContextMenu>
      <ControlHintTooltip title={tooltipTitle} description={descriptionText}>
        <ContextMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className={cn("gap-1 rounded-lg text-ui-base", className)}
            disabled={buttonDisabled}
            aria-label={titleText}
            data-prompt-polish-button="true"
            data-prompt-polish-state={effectiveStatus}
            onClick={handleClick}
          >
            {effectiveStatus === "polishing" ? (
              <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none [[data-acode-reduce-motion=reduce]_&]:animate-none" />
            ) : effectiveStatus === "restorable" ? (
              <Undo2 className="size-4" />
            ) : (
              <Sparkles className="size-4" />
            )}
          </Button>
        </ContextMenuTrigger>
      </ControlHintTooltip>
      <ContextMenuContent className="max-h-80 min-w-52 overflow-y-auto">
        <div className="px-2 py-1 text-ui-sm font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "chat.promptPolish.selectModel" })}
        </div>
        {modelGroups.length === 0 ? (
          <div className="px-2 py-1 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.promptEnhance.unsupported" })}
          </div>
        ) : null}
        {modelGroups.map((group, groupIndex) => (
          <Fragment key={group.key}>
            {groupIndex > 0 ? <ContextMenuSeparator /> : null}
            <div className="px-2 py-1 text-ui-xs text-foreground-subtlest">{group.label}</div>
            {group.items.map((item) => {
              const decoded = decodeCustomModelValue(item.value);
              const selected =
                decoded !== null &&
                polish.resolvedModel?.providerId === decoded.providerId &&
                polish.resolvedModel?.modelId === (decoded.modelName ?? "");
              return (
                <ContextMenuItem
                  key={item.key}
                  disabled={!decoded?.modelName}
                  onSelect={() => {
                    if (!decoded?.modelName) return;
                    polish.selectModel({
                      providerId: decoded.providerId,
                      modelId: decoded.modelName,
                    });
                  }}
                >
                  {selected ? (
                    <CheckIcon className="size-3.5 shrink-0 text-foreground" />
                  ) : (
                    <span className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">{item.name}</span>
                </ContextMenuItem>
              );
            })}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
