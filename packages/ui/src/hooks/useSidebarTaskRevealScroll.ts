import { useEffect, type RefObject } from "react";
import {
  useSidebarTaskRevealStore,
  type SidebarTaskRevealRequest,
} from "@/store/sidebarTaskRevealStore.js";

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
      // 只滚动侧栏容器，避免 scrollIntoView 连带移动会话区和页面。
      container.scrollTo({
        top: Math.max(
          0,
          container.scrollTop +
            bounds.top -
            container.getBoundingClientRect().top -
            (container.clientHeight - bounds.height) / 2,
        ),
        behavior: "auto",
      });
      useSidebarTaskRevealStore.getState().consumeRequest(request.requestId);
    };
    const scheduleReveal = () => {
      if (frame === null) frame = window.requestAnimationFrame(reveal);
    };
    const observer = new MutationObserver(scheduleReveal);
    observer.observe(container, { childList: true, subtree: true, attributes: true });
    container.addEventListener("transitionend", scheduleReveal);
    scheduleReveal();
    return () => {
      observer.disconnect();
      container.removeEventListener("transitionend", scheduleReveal);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [containerRef, request, visible]);
}
