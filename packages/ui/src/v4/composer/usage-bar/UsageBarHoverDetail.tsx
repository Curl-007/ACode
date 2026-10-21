/**
 * 用量状态栏各段与回答末尾速率行共用的明细浮层（apps/acode-cli/specs/usage-statusbar-port.md §2.2/§6.1）。
 *
 * 不变量（硬验收）：
 * 1. 悬停或点按段打开明细；点按 = 钉住，鼠标移开仍保留；再次点按 / 点浮层外 / Esc 关闭。
 * 2. 指针静止 = 明细常驻：流式期间值 tick、脉冲点、段插入/消失、整条 bar 纵向推移补发的
 *    pointerleave/pointerenter 不作关闭依据。本组件**不监听** pointerleave/relatedTarget。
 * 3. 关闭只认两条真实指针路径：window `mousemove` 命中测试落在整条 bar 当前 rect 之外；
 *    Popover 主动关闭（Esc/外部点击）。
 * 4. 同一时刻只允许一个明细展开（含钉住的）：`detailGroup` 由状态栏持有，谁最后展开谁生效。
 *
 * 目标旧实现用 Radix HoverCard；本移植按 spec §6.3 禁止其 hover 生命周期，改为受控 Popover
 * ＋自管打开/关闭判据（锚在段上，不随鼠标移动）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { isDetailVisible, type UsageBarDetailGroup } from "./usageBarDetailGroup.js";

export type { UsageBarDetailGroup };

function isPointerInsideBar(element: Element | null, event: MouseEvent): boolean {
  const bar = element?.closest('[data-testid="v4-composer-usage-bar"], [data-usage-bar-root]');
  const target = bar ?? element;
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  const { clientX, clientY } = event;
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
}

export function UsageBarHoverDetail({
  children,
  content,
  className,
  detailId,
  detailGroup,
}: {
  children: ReactNode;
  /**
   * 明细内容；传函数时拿到当前「是否钉住」，供按需查询的分组（子代理面板的已结束明细）
   * 决定要不要发起请求——悬停打开不查询，点按钉住后才查。
   */
  content: ReactNode | ((state: { pinned: boolean }) => ReactNode);
  className?: string;
  /** 互斥组内的成员 id（与 detailGroup 成对出现）。 */
  detailId?: string;
  /** 互斥组；不传则本实例独立展开（同一时刻可以与别人同时开）。 */
  detailGroup?: UsageBarDetailGroup;
}) {
  const [open, setOpen] = useState(false);
  // 点击固定：鼠标点一下段即钉住明细，移开也不关；再点一次或点浮层外才关。
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const grouped = detailGroup !== undefined && detailId !== undefined;
  const isActive = !grouped || detailGroup.activeId === detailId;

  // 组里别人接手时，本实例（含已钉住的）立即收起：钉住只是「鼠标移开也保留」，
  // 不包括「别的段打开时仍然保留」。
  useEffect(() => {
    if (isActive) return;
    setOpen(false);
    setPinned(false);
  }, [isActive]);

  // 关闭路径 ①：window mousemove 命中测试落在整条 bar rect 之外（非钉住态）。
  useEffect(() => {
    if (!open || pinned) return;
    if (typeof window === "undefined") return;
    const onMouseMove = (event: MouseEvent) => {
      if (isPointerInsideBar(triggerRef.current, event)) return;
      setOpen(false);
      if (grouped) detailGroup.deactivate(detailId);
    };
    window.addEventListener("mousemove", onMouseMove);
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, [open, pinned, grouped, detailGroup, detailId]);

  const visible = grouped
    ? isDetailVisible({ activeId: detailGroup.activeId }, detailId, { open, pinned })
    : open || pinned;
  const claim = () => {
    if (grouped) detailGroup.activate(detailId);
  };
  const release = () => {
    if (grouped) detailGroup.deactivate(detailId);
  };
  const togglePin = () => {
    const nextPinned = !pinned;
    setPinned(nextPinned);
    setOpen(false);
    if (nextPinned) claim();
    else release();
  };

  return (
    <Popover
      open={visible}
      onOpenChange={(next) => {
        // 关闭路径 ②：Popover 主动关闭（Esc / 外部点击）。钉住状态下由这里显式解除钉住。
        if (next) {
          claim();
          setOpen(true);
          return;
        }
        setOpen(false);
        setPinned(false);
        release();
      }}
    >
      <PopoverTrigger asChild>
        <span
          ref={triggerRef}
          className="inline-flex min-w-0"
          onPointerEnter={() => {
            // 开 = 段 pointerenter。没有 pointerleave 关闭路径。
            claim();
            setOpen(true);
          }}
        >
          {/*
            钉住切换挂在内层并阻断冒泡：Radix Trigger 的默认 click 会再 toggle 一次 open，
            与「点按 = 钉住」叠加会把钉住立刻解除。阻断后点击只走本组件的钉住状态机。
          */}
          <span
            className="inline-flex min-w-0"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              togglePin();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                togglePin();
              } else if (event.key === "Escape") {
                setPinned(false);
                setOpen(false);
                release();
              }
            }}
          >
            {children}
          </span>
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className={cn("w-auto max-w-[min(28rem,calc(100vw-1rem))] p-3 text-ui-sm", className)}
        onEscapeKeyDown={() => {
          setPinned(false);
          setOpen(false);
          release();
        }}
      >
        {typeof content === "function" ? content({ pinned }) : content}
      </PopoverContent>
    </Popover>
  );
}
