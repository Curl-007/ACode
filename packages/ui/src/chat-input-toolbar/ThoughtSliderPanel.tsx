import { useEffect, useState, type KeyboardEvent } from "react";
import type { ACodeConfigOption, ACodeProvider } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { Slider } from "@/components/ui/slider.js";
import type { useACodeIntl } from "@/i18n/IntlProvider.js";
import { getThoughtLevelLabel } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import {
  canRenderThoughtSlider,
  getThoughtSliderLevels,
  resolveThoughtKeyboardLevelIndex,
  resolveThoughtSliderCommitValue,
  resolveThoughtSliderPosition,
  snapThoughtSliderPosition,
  THOUGHT_SLIDER_DRAG_STEP,
} from "@/chat-input-toolbar/thoughtSliderModel.js";

export interface ThoughtSliderPanelProps {
  /** 当前模型的档位事实源（与 ThoughtLevelCycleControl 同源，声明序即轨道序）。 */
  option: ACodeConfigOption;
  provider?: ACodeProvider;
  intl: ReturnType<typeof useACodeIntl>["intl"];
  /** 提交中：降透明度并禁用滑条，防重复提交。 */
  busy?: boolean;
  /** 提交失败的回执文案；档位回弹由调用方保持 currentValue 不变自然呈现。 */
  errorMessage?: string | null;
  className?: string;
  /** 松手吸附/键盘切档后的档位提交；与既有 handleThoughtValueChange 写路径对接。 */
  onCommitLevel: (value: string) => void;
}

/**
 * 思考强度滑条面板（specs/composer-thought-slider.md）——纯 props 展示件：
 * 面板开合、档位事实源与提交链全部由 v4 wiring 层持有；本组件不订阅 store。
 * 自带浮层壳（bg-popover/rounded-xl/shadow-md，DESIGN.md §Menus, Popovers, Dialogs）；
 * 挂载进 PopoverContent 时按 ChatPromptActionMenu 先例把外壳类覆写为透明无边框。
 * 无档位/单档位固定时返回 null，不占空间。
 */
export function ThoughtSliderPanel({
  option,
  provider,
  intl,
  busy = false,
  errorMessage = null,
  className,
  onCommitLevel,
}: ThoughtSliderPanelProps) {
  const levels = getThoughtSliderLevels(option);
  const entries = option.type === "select" ? (option.options ?? []) : [];
  const committed = resolveThoughtSliderPosition(levels, option.currentValue);
  // 拖动中的连续浮点位置；null = 未在拖动，轨道跟随已提交档位。
  const [dragPosition, setDragPosition] = useState<number | null>(null);

  // 外部档位变化（含失败回弹）后丢弃拖动残影，轨道回到提交事实。
  useEffect(() => {
    setDragPosition(null);
  }, [committed.position, committed.matched]);

  if (!canRenderThoughtSlider(option)) {
    return null;
  }

  const activePosition = dragPosition ?? committed.position;
  const previewIndex = snapThoughtSliderPosition(levels, activePosition);
  const previewEntry = entries[previewIndex];
  const title = intl.formatMessage({ id: "chat.toolbar.thoughtLevel.sliderTitle" });
  const currentLabel =
    previewEntry && (committed.matched || dragPosition !== null)
      ? getThoughtLevelLabel(intl, provider, option, previewEntry)
      : intl.formatMessage({ id: "chat.toolbar.thoughtLevel.placeholder" });

  const commitValue = (value: string | null) => {
    if (value === null || (committed.matched && value === String(option.currentValue))) {
      return;
    }
    onCommitLevel(value);
  };

  // 键盘整档切档以 capture 拦截：Radix 原生键盘按 step 移动，而拖动用的是连续小数
  // step；拦截后 ←→/Home/End 语义与原生一致（每次一档、首尾 clamp）。
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    const baseIndex = snapThoughtSliderPosition(levels, committed.position);
    const nextIndex = resolveThoughtKeyboardLevelIndex(event.key, baseIndex, levels.length);
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDragPosition(null);
    commitValue(levels[nextIndex] ?? null);
  };

  return (
    <div
      data-thought-slider="true"
      data-thought-slider-value={String(option.currentValue ?? "")}
      data-thought-slider-levels={levels.join(",")}
      data-busy={busy || undefined}
      className={cn(
        "w-[min(240px,calc(100vw-24px))] rounded-xl border border-popover-border bg-popover p-3 text-popover-foreground shadow-md",
        busy && "opacity-60",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm font-medium text-foreground">{title}</span>
        <span
          data-thought-slider-current-label
          className="max-w-[60%] truncate rounded-full bg-secondary px-2 py-0.5 text-ui-xs font-medium text-foreground"
        >
          {currentLabel}
        </span>
      </div>
      <Slider
        className={cn(
          "mt-3 w-full [&_[data-slot=slider-range]]:bg-success",
          busy && "pointer-events-none",
        )}
        min={0}
        max={levels.length - 1}
        step={THOUGHT_SLIDER_DRAG_STEP}
        value={[activePosition]}
        disabled={busy}
        thumbAriaLabel={title}
        onKeyDownCapture={handleKeyDownCapture}
        onValueChange={(values) => {
          setDragPosition(values[0] ?? 0);
        }}
        onValueCommit={(values) => {
          const position = values[0] ?? activePosition;
          setDragPosition(null);
          commitValue(resolveThoughtSliderCommitValue(levels, position));
        }}
      />
      {errorMessage ? (
        <p
          data-thought-slider-error
          role="alert"
          className="mt-2 text-ui-xs text-destructive"
        >
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
