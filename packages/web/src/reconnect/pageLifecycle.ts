/**
 * bfcache / 真卸载的页面生命周期接线（specs/web-reconnect.md R5.5）。
 *
 * 根因（2026-10-26 review §2）：入口曾 `window.addEventListener("pagehide", () => controller.cancel(),
 * { once: true })`。`pagehide` 不只在真卸载时触发，也在 **bfcache 进入**（往返缓存，手机 Safari/Chrome 的
 * 主导后台机制）时触发；而 `cancel()` 是终态，`start()` 此后永久 no-op，且 `{ once: true }` 移除监听器、
 * 无 `pageshow` 重新武装。结果：手机切后台→回前台的 bfcache 往返后，socket 若在后台被回收，
 * `onClose → start()` 什么都不做 = 死界面（R2-05 症状复发）。
 *
 * 修复：按 `event.persisted` 分派——
 *   - pagehide + persisted=true  → `pause()`（非终态，冻结退避循环，回前台可 resume）
 *   - pagehide + persisted=false → `cancel()`（真卸载，终态，清挂起 timer 防泄漏）
 *   - pageshow + persisted=true  → `resume()`（bfcache 恢复，唤醒循环；后台 socket 被回收的 close
 *                                   若已触发 start()，resume 后照常推进重连）
 *   - pageshow + persisted=false → 无操作（普通首次加载，循环尚未进入冻结态）
 * 监听器成对常驻（不用 `{ once: true }`：once 会在首次 bfcache 进入即移除，导致后续真卸载无清理、泄漏 timer）。
 *
 * 抽成独立可测函数：controller 由 getter 提供（入口的 controller 是可变的，换代后要拿到最新的），
 * target 可注入（测试用假 event target），不依赖真实 window/浏览器事件。
 */

/** pagehide/pageshow 事件的最小结构面（只用到 persisted）——测试可注入假事件。 */
export interface PageTransitionEventLike {
  readonly persisted: boolean;
}

/** addEventListener/removeEventListener 的最小结构面——测试可注入假 target。 */
export interface PageLifecycleTarget {
  addEventListener(type: string, listener: (event: PageTransitionEventLike) => void): void;
  removeEventListener(type: string, listener: (event: PageTransitionEventLike) => void): void;
}

/** 生命周期驱动的重连控制器面（只用到 pause/cancel/resume）。 */
export interface PageLifecycleController {
  pause(): void;
  cancel(): void;
  resume(): void;
}

/**
 * 把 bfcache/卸载生命周期接到重连控制器上。
 *
 * @param getController 返回当前控制器（入口的 controller 可换代，故用 getter 每次取最新）；返回 null 时忽略事件。
 * @param target 事件源（生产为 window）。
 * @returns detach 函数：移除两个监听器（卸载/HMR 清理用）。
 */
export function attachWebReconnectPageLifecycle(
  getController: () => PageLifecycleController | null,
  target: PageLifecycleTarget,
): () => void {
  const handlePageHide = (event: PageTransitionEventLike): void => {
    const controller = getController();
    if (!controller) {
      return;
    }
    if (event.persisted) {
      // bfcache 进入：非终态暂停。若误 cancel()，start() 将永久 no-op → 手机死界面。
      controller.pause();
    } else {
      // 真卸载：终态取消，清挂起 timer，防定时器泄漏。
      controller.cancel();
    }
  };
  const handlePageShow = (event: PageTransitionEventLike): void => {
    if (!event.persisted) {
      return; // 普通首次加载：循环未进入冻结态，无需 resume。
    }
    getController()?.resume();
  };
  target.addEventListener("pagehide", handlePageHide);
  target.addEventListener("pageshow", handlePageShow);
  return () => {
    target.removeEventListener("pagehide", handlePageHide);
    target.removeEventListener("pageshow", handlePageShow);
  };
}
