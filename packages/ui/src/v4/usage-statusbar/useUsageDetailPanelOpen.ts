import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

// 统一「用量明细」面板 open 状态管理（specs/usage-statusbar.md「Tooltip 稳定性与
// 统一明细面板」节，2026-10-19 重写）：bar 级 hover 打开 + 点击钉住 + window 级
// mousemove 位置命中测试关闭。
//
// 核心不变量（运行时复现确证，CDP 静止指针录证 repro-streaming-run2/proof-run2）：
// 流式期间 composer 高度变化会把整条 bar 在静止指针下**纵向**推移（不只是胶囊横向
// 位移），元素级 mouseleave 与 Radix Tooltip 的 trigger 命中一样会误杀面板——与
// 要修的 tooltip 闪断同机制。因此打开只认 bar mouseenter；关闭判定唯一路径 =
// window 级 mousemove 对 bar ∪ 面板的**当前 getBoundingClientRect** 做点内命中
// 测试，指针落在两者之外才启动 ~150ms 关闭宽限（宽限内回到任一 rect 取消关闭）。
// **指针静止 = 无 mousemove = 面板保持打开**（几何怎么变都不误杀）。
// 钉住（pinned）后忽略位置关闭；Esc/点击外部解除钉住并关闭（常规 Popover 语义，
// Radix onOpenChange(false) 单点收件）；监听与宽限 timer 在关闭/卸载时清理。

/** 面板关闭宽限（spec「Tooltip 稳定性与统一明细面板」节：~150ms）。 */
const PANEL_CLOSE_GRACE_MS = 150;

/** 钉住切换豁免标记：齿轮与自带 Popover 的胶囊（子代理）点击不参与统一面板钉住。 */
const PANEL_PIN_EXEMPT_SELECTOR = "[data-usage-statusbar-no-pin]";

export interface UsageDetailPanelOpenApi {
  /** 整条 bar 容器（hover 触发器 + PopoverAnchor + 命中测试 rect 来源）。 */
  barRef: RefObject<HTMLDivElement | null>;
  /** 面板内容节点（命中测试 rect 来源；指针移入面板不算离开）。 */
  panelRef: RefObject<HTMLDivElement | null>;
  /** 受控 Popover open：hover 或钉住，且与子代理点击面板互斥（绝不同开）。 */
  panelOpen: boolean;
  subagentOpen: boolean;
  handleBarMouseEnter: () => void;
  handleBarClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  handlePanelOpenChange: (next: boolean) => void;
  handleSubagentOpenChange: (next: boolean) => void;
}

export function useUsageDetailPanelOpen(): UsageDetailPanelOpenApi {
  const barRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [subagentOpen, setSubagentOpen] = useState(false);
  // 互斥不变量：统一面板与子代理点击面板绝不同开（spec 同节）。
  const panelOpen = (hoverOpen || pinned) && !subagentOpen;

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // 点内命中测试：对 bar ∪ 面板的**当前** rect 判定（rect 每次现取，流式几何推移
  // 天然免疫）；两 rect 之外才算离开。
  const isPointerOverPanelSurface = useCallback(
    (position: { clientX: number; clientY: number }) => {
      for (const element of [barRef.current, panelRef.current]) {
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (
          position.clientX >= rect.left &&
          position.clientX <= rect.right &&
          position.clientY >= rect.top &&
          position.clientY <= rect.bottom
        ) {
          return true;
        }
      }
      return false;
    },
    [],
  );

  // 位置关闭：仅面板打开且未钉住时挂 window 级 mousemove（核心不变量：指针静止 =
  // 无 mousemove = 面板保持打开——绝不使用元素级 mouseleave 关闭路径）。
  useEffect(() => {
    if (!panelOpen || pinned) return;
    const handleMouseMove = (event: MouseEvent) => {
      if (isPointerOverPanelSurface(event)) {
        clearCloseTimer();
        return;
      }
      if (closeTimerRef.current !== null) return; // 宽限已在跑，不重置
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setHoverOpen(false);
      }, PANEL_CLOSE_GRACE_MS);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      clearCloseTimer();
    };
  }, [panelOpen, pinned, isPointerOverPanelSurface, clearCloseTimer]);

  const handleBarMouseEnter = useCallback(() => {
    clearCloseTimer();
    // 子代理面板打开期间不抢开（互斥不变量；避免指针掠过 bar 把正在阅读的面板抢走）。
    if (subagentOpen) return;
    setHoverOpen(true);
  }, [clearCloseTimer, subagentOpen]);

  const handleBarClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      // 齿轮/子代理胶囊的点击归各自浮层，不参与钉住切换。
      if (target?.closest(PANEL_PIN_EXEMPT_SELECTOR)) return;
      if (subagentOpen) return;
      clearCloseTimer();
      const next = !pinned;
      setPinned(next);
      // 钉住即确保打开（即便 hover 态已被宽限关闭）。
      if (next) setHoverOpen(true);
    },
    [clearCloseTimer, pinned, subagentOpen],
  );

  // 受控 open：打开完全由 hover/pin 驱动，不接受 Radix 隐性打开路径；Esc/点击外部
  // → onOpenChange(false) → 解除钉住并关闭。
  const handlePanelOpenChange = useCallback(
    (next: boolean) => {
      if (next) return;
      clearCloseTimer();
      setPinned(false);
      setHoverOpen(false);
    },
    [clearCloseTimer],
  );

  const handleSubagentOpenChange = useCallback(
    (next: boolean) => {
      setSubagentOpen(next);
      // 互斥：打开子代理面板时关统一面板（并取消在跑的关闭宽限）。
      if (next) {
        clearCloseTimer();
        setHoverOpen(false);
        setPinned(false);
      }
    },
    [clearCloseTimer],
  );

  return {
    barRef,
    panelRef,
    panelOpen,
    subagentOpen,
    handleBarMouseEnter,
    handleBarClick,
    handlePanelOpenChange,
    handleSubagentOpenChange,
  };
}
