/**
 * AnimatedSidePanePanel 的 tab 条状态机（批次 7 外迁）。
 *
 * 收口原主组件里与 tab 条相关的全部 state / ref / effect：
 * - 溢出判定（`resolveSidePaneTabsOverflow`，含 RAF 合并与 ResizeObserver 反馈环规避）；
 * - 两侧渐变 mask（与实际 scrollLeft 绑定，只在仍可滚动的一侧显示）；
 * - active tab 滚入视区（按真实 DOM 宽度，而非固定估算）；
 * - 收起/展开时的内容宽度锁定（收起前锁住像素宽度，避免先重排版再淡出）；
 * - tab 拖拽态（DnD 的 start/end/cancel）。
 *
 * **不含 pane 分发**：20 类 pane 的 props 边界尚未定义，按批次 7 纪律留在主文件
 * （登记为批次 8 候选）。本 hook 只依赖 `visibleTabs` / `visibleActiveTabId` / `isVisible`
 * 三个外部输入，与 pane 渲染无耦合。
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { SIDE_PANE_DEFAULT_EXPANDED_RATIO, resolveSidePaneTabsOverflow } from "@/app-shell/sidePaneLayout.js";
import type { WorkspaceSidePaneState } from "@/lib/workspaceSidePane.js";

const SIDE_PANE_CONTENT_WIDTH_LOCK_DURATION_MS = 200;

export type TabsScrollMaskEdges = {
  left: boolean;
  right: boolean;
};

const EMPTY_TABS_SCROLL_MASK_EDGES: TabsScrollMaskEdges = {
  left: false,
  right: false,
};

/**
 * 两侧渐变 mask 的判定（纯函数，批次 7 从 effect 体内抽出以便单测）。
 *
 * tabs 溢出时不能两侧一直显示渐变：滚动到起点/终点也像还能继续滚。因此 mask 与
 * 实际 `scrollLeft` 绑定，只提示仍可继续滚动的一侧。1px 容差吸收亚像素滚动。
 */
export function resolveTabsScrollMaskEdges(input: {
  isOverflowing: boolean;
  scrollLeft: number;
  maxScrollLeft: number;
}): TabsScrollMaskEdges {
  if (!input.isOverflowing) {
    return EMPTY_TABS_SCROLL_MASK_EDGES;
  }
  return {
    left: input.scrollLeft > 1,
    right: input.scrollLeft < input.maxScrollLeft - 1,
  };
}

/**
 * 收起/展开时的内容锁宽（纯函数）。
 *
 * - 收起：锁住当前像素宽度（`> 0` 才锁），避免内部 Tabs/Git/Browser 先重排版再淡出；
 * - 首次展开：没有「上一次收起前宽度」可复用，用 PanelGroup 真实像素宽度 × 默认展开比例
 *   换算一个接近最终态的锁宽；200ms 过渡后由调用方解除。
 * - 非 0 且非有限的分组宽度一律视为不可用（返回 null，交回自适应布局）。
 */
export function resolveLockedContentWidthPx(input: {
  direction: "collapse" | "expand";
  currentPanelWidthPx: number;
  panelGroupWidthPx: number;
  previousLockedWidthPx: number | null;
  defaultExpandedRatio: number;
}): number | null {
  if (input.direction === "collapse") {
    return input.currentPanelWidthPx > 0 ? input.currentPanelWidthPx : null;
  }
  if (input.previousLockedWidthPx !== null) {
    return input.previousLockedWidthPx;
  }
  const groupWidth = Math.round(input.panelGroupWidthPx);
  if (!Number.isFinite(groupWidth) || groupWidth <= 0) {
    return null;
  }
  return Math.round(groupWidth * input.defaultExpandedRatio);
}

export interface SidePaneTabStripInput {
  isVisible: boolean;
  shouldMountContent: boolean;
  visibleTabs: WorkspaceSidePaneState["tabs"];
  visibleActiveTabId: string;
  panelElementRef: RefObject<HTMLDivElement | null>;
  onReorderTab: (activeTabId: string, overTabId: string) => void;
}

export interface SidePaneTabStrip {
  draggingTabId: string | null;
  handleTabDragStart: (event: DragStartEvent) => void;
  handleTabDragEnd: (event: DragEndEvent) => void;
  handleTabDragCancel: () => void;
  hasRenderedSidePane: boolean;
  isAddMenuOpen: boolean;
  isTabsOverflowing: boolean;
  lockedContentStyle: CSSProperties | undefined;
  setIsAddMenuOpen: (open: boolean) => void;
  tabsScrollContentRef: RefObject<HTMLDivElement | null>;
  tabsScrollMaskEdges: TabsScrollMaskEdges;
  tabsScrollViewportRef: RefObject<HTMLDivElement | null>;
}

export function useSidePaneTabStrip({
  isVisible,
  shouldMountContent,
  visibleTabs,
  visibleActiveTabId,
  panelElementRef,
  onReorderTab,
}: SidePaneTabStripInput): SidePaneTabStrip {
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const tabsScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tabsScrollContentRef = useRef<HTMLDivElement | null>(null);
  const [lockedContentWidthPx, setLockedContentWidthPx] = useState<number | null>(null);
  const [hasRenderedSidePane, setHasRenderedSidePane] = useState(shouldMountContent);
  const [isTabsOverflowing, setIsTabsOverflowing] = useState(false);
  const [tabsScrollMaskEdges, setTabsScrollMaskEdges] = useState<TabsScrollMaskEdges>({
    left: false,
    right: false,
  });
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const widthUnlockTimerRef = useRef<number | null>(null);
  const previousIsVisibleRef = useRef(isVisible);

  useEffect(() => {
    if (shouldMountContent) {
      // side pane 收起动画原本依赖外层 panel 的 opacity/flex-grow 过渡，
      // 但这里之前把内容写成 `isVisible && sidePaneState ? ... : null`，
      // 一收起就会先把 Tabs/Git/Browser 整块卸载，动画还没走完内容就没了。
      // 改成首次打开后保持挂载，后续收起只隐藏不卸载，这样动画和内部状态都能一起保留。
      setHasRenderedSidePane(true);
    }
  }, [shouldMountContent]);

  const readPanelGroupWidthPx = () =>
    Math.round(panelElementRef.current?.parentElement?.getBoundingClientRect().width ?? 0);

  useEffect(() => {
    const previousIsVisible = previousIsVisibleRef.current;
    previousIsVisibleRef.current = isVisible;

    if (widthUnlockTimerRef.current !== null) {
      window.clearTimeout(widthUnlockTimerRef.current);
      widthUnlockTimerRef.current = null;
    }

    if (previousIsVisible && !isVisible) {
      const currentPanelWidthPx = Math.round(
        panelElementRef.current?.getBoundingClientRect().width ?? 0,
      );
      // side pane 收起时内容层会跟着外层 panel 一起参与过渡，
      // 这里在收起前锁住当前像素宽度，避免内部 Tabs/Git/Browser 先重新排版后再淡出。
      setLockedContentWidthPx(
        resolveLockedContentWidthPx({
          direction: "collapse",
          currentPanelWidthPx,
          panelGroupWidthPx: 0,
          previousLockedWidthPx: null,
          defaultExpandedRatio: SIDE_PANE_DEFAULT_EXPANDED_RATIO,
        }),
      );
      return;
    }

    if (!previousIsVisible && isVisible) {
      // 首次展开没有“上一次收起前宽度”可复用，内容会先以 0 宽度参与布局再被撑开。
      // 这里用 PanelGroup 的真实像素宽度换算默认展开宽度，先给内容层一个接近最终态的锁宽；
      // 等 200ms 过渡结束后再移除固定宽度，恢复成普通自适应布局。
      setLockedContentWidthPx((currentWidthPx) =>
        resolveLockedContentWidthPx({
          direction: "expand",
          currentPanelWidthPx: 0,
          panelGroupWidthPx: readPanelGroupWidthPx(),
          previousLockedWidthPx: currentWidthPx,
          defaultExpandedRatio: SIDE_PANE_DEFAULT_EXPANDED_RATIO,
        }),
      );
      widthUnlockTimerRef.current = window.setTimeout(() => {
        setLockedContentWidthPx(null);
        widthUnlockTimerRef.current = null;
      }, SIDE_PANE_CONTENT_WIDTH_LOCK_DURATION_MS);
    }
  }, [isVisible, panelElementRef]);

  useEffect(() => {
    return () => {
      if (widthUnlockTimerRef.current !== null) {
        window.clearTimeout(widthUnlockTimerRef.current);
      }
    };
  }, []);

  const lockedContentStyle: CSSProperties | undefined =
    lockedContentWidthPx !== null
      ? {
          width: `${lockedContentWidthPx}px`,
        }
      : undefined;

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    if (!viewport || !content) {
      setIsTabsOverflowing(false);
      // sidePaneState 为空或内容尚未挂载时 refs 会持续为空。
      // 这里不能每次写入新的 mask 对象，否则 effect 会在空 tabs 阶段反复触发更新。
      setTabsScrollMaskEdges((current) =>
        current.left || current.right ? EMPTY_TABS_SCROLL_MASK_EDGES : current,
      );
      return;
    }

    const updateOverflowState = () => {
      const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const addButton = viewport.parentElement?.querySelector<HTMLElement>(
        "[data-side-pane-add-tab-trigger]",
      );
      const addButtonWidth = addButton?.getBoundingClientRect().width ?? 0;
      // 旧判定直接读取 content.scrollWidth，但 overflow 状态本身会把新增按钮
      // 移进/移出 content 并改变 viewport 宽度，临界区会形成 ResizeObserver 反馈环。
      // 这里统一还原“新增按钮位于 tabs 末尾”的假想布局，只用稳定的最小宽度预算判定。
      const isOverflowing = resolveSidePaneTabsOverflow({
        addButtonInside: Boolean(addButton && content.contains(addButton)),
        addButtonWidth,
        tabCount: visibleTabs.length,
        viewportWidth: viewport.clientWidth,
      });
      // 新增按钮在 tabs 尚可等宽收缩时跟随末尾，只有达到 60px 下限仍溢出后才固定到右侧。
      setIsTabsOverflowing(isOverflowing);
      // tabs 溢出时不能两侧一直显示渐变 mask：滚动到起点/终点也像还能继续滚。
      // 这里把 mask 和实际 scrollLeft 绑定，只提示仍可继续滚动的一侧。
      setTabsScrollMaskEdges((current) => {
        const next = resolveTabsScrollMaskEdges({
          isOverflowing,
          scrollLeft: viewport.scrollLeft,
          maxScrollLeft,
        });

        if (current.left === next.left && current.right === next.right) {
          return current;
        }

        return next;
      });
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateOverflowState;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateOverflowState();
    viewport.addEventListener("scroll", updateOverflowState, {
      passive: true,
    });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateOverflowState);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateOverflowState;
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", updateOverflowState);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [visibleTabs]);

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    if (!visibleActiveTabId || !viewport || !content) {
      return;
    }

    let frameId: number | null = requestAnimationFrame(() => {
      frameId = null;
      const activeTab = Array.from(
        content.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
      ).find((element) => element.dataset.sidePaneTabId === visibleActiveTabId);

      if (!activeTab) {
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const activeTabRect = activeTab.getBoundingClientRect();
      const leftOverflow = activeTabRect.left - viewportRect.left;
      const rightOverflow = activeTabRect.right - viewportRect.right;

      if (leftOverflow < 0) {
        // 从外部激活 tab（例如打开文件或切回旧 Browser）时，
        // active tab 可能已经被横向滚动区域遮住。这里按真实 DOM 宽度滚回可视区，
        // 避免使用固定宽度估算导致长标题 / favicon tab 对不齐。
        viewport.scrollBy({ left: leftOverflow, behavior: "smooth" });
        return;
      }

      if (rightOverflow > 0) {
        viewport.scrollBy({ left: rightOverflow, behavior: "smooth" });
      }
    });

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [visibleActiveTabId, visibleTabs]);

  const handleTabDragStart = (event: DragStartEvent) => {
    setDraggingTabId(String(event.active.id));
  };

  const handleTabDragEnd = (event: DragEndEvent) => {
    setDraggingTabId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    onReorderTab(String(active.id), String(over.id));
  };

  const handleTabDragCancel = () => {
    setDraggingTabId(null);
  };

  return {
    draggingTabId,
    handleTabDragStart,
    handleTabDragEnd,
    handleTabDragCancel,
    hasRenderedSidePane,
    isAddMenuOpen,
    isTabsOverflowing,
    lockedContentStyle,
    setIsAddMenuOpen,
    tabsScrollContentRef,
    tabsScrollMaskEdges,
    tabsScrollViewportRef,
  };
}
