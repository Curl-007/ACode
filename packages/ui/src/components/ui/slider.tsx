"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "../lib/utils.js";

// 聚合依赖 radix-ui 已导出 Slider（仓内此前无封装）。样式跟随 components/ui 既有
// 封装惯例（switch.tsx/popover.tsx）：主题全部走 CSS tokens，动画同时尊重
// prefers-reduced-motion 媒体查询与根节点 data-acode-reduce-motion 属性两个闸。
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbClassName,
  thumbAriaLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Radix 把 role="slider" 挂在 Thumb 上，可访问名必须给 Thumb；单值滑条共用一个标签。 */
  thumbAriaLabel?: string;
  thumbClassName?: string;
}) {
  // 未受控/受控值都归一成数组，只为推断 Thumb 数量（Radix 要求每个值一个 Thumb）。
  const thumbCount = React.useMemo(() => {
    if (Array.isArray(value)) return Math.max(1, value.length);
    if (Array.isArray(defaultValue)) return Math.max(1, defaultValue.length);
    return 1;
  }, [value, defaultValue]);

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary"
      >
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          data-slot="slider-thumb"
          aria-label={thumbAriaLabel}
          className={cn(
            "block size-4 shrink-0 rounded-full border border-primary/50 bg-background shadow-sm",
            "transition-[color,box-shadow] motion-reduce:transition-none [[data-acode-reduce-motion=reduce]_&]:transition-none",
            "focus-visible:ring-2 focus-visible:ring-input-border-focused/40 focus-visible:outline-none",
            "disabled:pointer-events-none disabled:opacity-50",
            thumbClassName,
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
