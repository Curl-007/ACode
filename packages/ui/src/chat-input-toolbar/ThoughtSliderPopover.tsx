import type { ReactNode, RefObject } from "react";
import {
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  type ACodeConfigOption,
  type ACodeProvider,
} from "@acode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import type { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import { ThoughtSliderPanel } from "@/chat-input-toolbar/ThoughtSliderPanel.js";

export interface ThoughtSliderPopoverProps {
  composerCollapsePriority?: number;
  composerTriggerClassName?: string;
  /** 触发器 aria-label（当前档名）。 */
  currentLabel: string;
  disabled?: boolean;
  intl: ReturnType<typeof useACodeIntl>["intl"];
  onOpenChange?: (open: boolean) => void;
  /** 档位提交 = 既有 handleThoughtValueChange 写路径（不新增写路径）。 */
  onValueChange: (value: string) => void;
  open?: boolean;
  option: ACodeConfigOption;
  provider?: ACodeProvider;
  restoreFocusSelector?: string | null;
  shortcutLabel?: string;
  tooltipTitle: string;
  triggerClassName?: string;
  /** 共享触发器视觉（ThoughtLevelTriggerVisual），由主控件构造后注入。 */
  triggerContent: ReactNode;
  triggerRef: RefObject<HTMLSpanElement | null>;
}

/**
 * 思考档位滑条弹出（specs/composer-thought-slider.md）：Popover 包宿主提供的触发器
 * 视觉，PopoverContent 外壳按 ChatPromptActionMenu 先例覆写为透明无边框——浮层壳由
 * ThoughtSliderPanel 自带（bg-popover/rounded-xl/shadow-md）。开合复用宿主受控
 * open/onOpenChange（composer 的 configPickerState "thought" 槽）；档位提交走既有
 * onValueChange 写路径（草稿=下一次提交意图；运行中会话=switchModelConfig），失败时
 * 宿主保持 currentValue 不变即自然回弹，故 busy 恒 false、无独立错误面。
 * e2e 锚点（data-chat-toolbar-popover-trigger / TID trigger）与 select/cycle 模式一致。
 */
export function ThoughtSliderPopover({
  composerCollapsePriority,
  composerTriggerClassName,
  currentLabel,
  disabled,
  intl,
  onOpenChange,
  onValueChange,
  open,
  option,
  provider,
  restoreFocusSelector,
  shortcutLabel,
  tooltipTitle,
  triggerClassName,
  triggerContent,
  triggerRef,
}: ThoughtSliderPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <ControlHintTooltip title={tooltipTitle} shortcut={shortcutLabel} triggerRef={triggerRef}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            disabled={disabled}
            data-chat-toolbar-popover-trigger="true"
            data-composer-thought-control={composerCollapsePriority !== undefined || undefined}
            data-composer-collapse-priority={composerCollapsePriority}
            data-testid={TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER}
            className={cn(
              "gap-1 rounded-lg px-1.5 py-1.5 text-ui-base",
              composerTriggerClassName,
              triggerClassName,
            )}
            aria-label={currentLabel}
          >
            {triggerContent}
          </Button>
        </PopoverTrigger>
      </ControlHintTooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-auto border-0 bg-transparent p-0 shadow-none"
        onCloseAutoFocus={(event) => {
          if (!restoreFocusSelector) {
            // 与 select 分支同款：无聊天输入框可恢复时保留 Radix 默认焦点行为。
            return;
          }
          event.preventDefault();
          if (
            !shouldRestoreChatInputFocusAfterPickerClose({
              isCoarseTouchDevice: isCoarseTouchDevice(),
            })
          ) {
            return;
          }
          const input = document.querySelector<HTMLElement>(restoreFocusSelector);
          input?.focus();
        }}
      >
        <ThoughtSliderPanel
          option={option}
          provider={provider}
          intl={intl}
          onCommitLevel={onValueChange}
        />
      </PopoverContent>
    </Popover>
  );
}
