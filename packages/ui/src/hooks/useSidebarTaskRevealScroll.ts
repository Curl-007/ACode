import { useEffect, type RefObject } from "react";
import {
  useSidebarTaskRevealStore,
  type SidebarTaskRevealRequest,
} from "@/store/sidebarTaskRevealStore.js";

/** 高亮脉冲 class，与 styles.css 中 sidebar-task-reveal-highlight 关键帧配对（specs/sidebar-task-reveal.md R3）。 */
export const SIDEBAR_TASK_REVEAL_HIGHLIGHT_CLASS = "sidebar-task-reveal-highlight";
/** 请求最长等待行出现的时限；超时静默放弃，避免收起的 group 日后被展开时突兀跳滚（spec R2）。 */
export const SIDEBAR_TASK_REVEAL_REQUEST_TIMEOUT_MS = 15_000;
/** 高亮动画（1.2s）加余量的兜底清理时限；reduced-motion 下 animationend 不触发也保证移除 class。 */
const SIDEBAR_TASK_REVEAL_HIGHLIGHT_RESET_MS = 2_000;

export function computeRevealScrollTop(params: {
  scrollTop: number;
  containerTop: number;
  containerClientHeight: number;
  rowTop: number;
  rowHeight: number;
}): number {
  const { scrollTop, containerTop, containerClientHeight, rowTop, rowHeight } = params;
  return Math.max(0, scrollTop + rowTop - containerTop - (containerClientHeight - rowHeight) / 2);
}

export function isRowFullyVisible(params: {
  containerTop: number;
  containerBottom: number;
  rowTop: number;
  rowBottom: number;
}): boolean {
  return params.rowTop >= params.containerTop && params.rowBottom <= params.containerBottom;
}

function applyRevealHighlight(row: HTMLElement) {
  // 连续两次定位同一行时先移除再强制 reflow，让动画从头重播。
  row.classList.remove(SIDEBAR_TASK_REVEAL_HIGHLIGHT_CLASS);
  void row.offsetWidth;
  row.classList.add(SIDEBAR_TASK_REVEAL_HIGHLIGHT_CLASS);
  const removeHighlight = () => {
    row.classList.remove(SIDEBAR_TASK_REVEAL_HIGHLIGHT_CLASS);
  };
  row.addEventListener("animationend", removeHighlight, { once: true });
  window.setTimeout(removeHighlight, SIDEBAR_TASK_REVEAL_HIGHLIGHT_RESET_MS);
}

export function useSidebarTaskRevealScroll(
  containerRef: RefObject<HTMLDivElement | null>,
  request: SidebarTaskRevealRequest | null,
  visible: boolean,
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !request || !visible) return;
    const itemKey = `${request.workspaceKey}:${request.taskId}`;
    const groupedKey = encodeURIComponent(`${request.workspaceKey}\u0000${request.taskId}`);
    let frame: number | null = null;
    const reveal = () => {
      frame = null;
      if (useSidebarTaskRevealStore.getState().pendingRequest?.requestId !== request.requestId) {
        return;
      }
      const row = Array.from(
        container.querySelectorAll<HTMLElement>("[data-task-item-key], [data-grouped-task-key]"),
      ).find(
        (element) =>
          element.dataset.taskItemKey === itemKey || element.dataset.groupedTaskKey === groupedKey,
      );
      if (!row || row.closest('[aria-hidden="true"]')) return;
      const groupContent = row.closest<HTMLElement>("[data-grouped-group-content-id]");
      if (groupContent?.getAnimations().some((animation) => animation.playState === "running")) {
        return;
      }
      const bounds = row.getBoundingClientRect();
      if (bounds.height === 0) return;
      const containerBounds = container.getBoundingClientRect();
      // 行已完整可见（侧栏行点击的常态）就不滚动，避免点击引发跳动；只有行不完整
      // 在视口内（通知/深链/运行历史打开视口外的会话）才滚动，且只滚侧栏容器，
      // 避免 scrollIntoView 连带移动会话区和页面（specs/sidebar-task-reveal.md R2）。
      if (
        !isRowFullyVisible({
          containerTop: containerBounds.top,
          containerBottom: containerBounds.bottom,
          rowTop: bounds.top,
          rowBottom: bounds.bottom,
        })
      ) {
        container.scrollTo({
          top: computeRevealScrollTop({
            scrollTop: container.scrollTop,
            containerTop: containerBounds.top,
            containerClientHeight: container.clientHeight,
            rowTop: bounds.top,
            rowHeight: bounds.height,
          }),
          behavior: "auto",
        });
      }
      applyRevealHighlight(row);
      useSidebarTaskRevealStore.getState().consumeRequest(request.requestId);
    };
    const scheduleReveal = () => {
      if (frame === null) frame = window.requestAnimationFrame(reveal);
    };
    const observer = new MutationObserver(scheduleReveal);
    observer.observe(container, { childList: true, subtree: true, attributes: true });
    container.addEventListener("transitionend", scheduleReveal);
    scheduleReveal();
    // 请求有界：行迟迟不出现（列表未加载 / group 收起 / 虚拟化窗口外）时静默过期，
    // 不让 MutationObserver 在流式期间无限重试，也不留「日后突然跳滚」的隐患。
    const expiryTimer = window.setTimeout(() => {
      useSidebarTaskRevealStore.getState().consumeRequest(request.requestId);
    }, SIDEBAR_TASK_REVEAL_REQUEST_TIMEOUT_MS);
    return () => {
      observer.disconnect();
      container.removeEventListener("transitionend", scheduleReveal);
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.clearTimeout(expiryTimer);
    };
  }, [containerRef, request, visible]);
}
