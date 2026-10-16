/**
 * 嵌入内容可编辑焦点台账（specs/embedded-content-focus-yield.md §2）。
 *
 * 唯一事实源 = 「有可编辑焦点的 webContents id 集合」。第三方内容面（可视化卡片
 * sandbox iframe、内嵌浏览器 pane 等）的容器在 renderer 侧检测焦点进出后经 IPC 上报，
 * 本模块负责：
 *
 * 1. IPC 面收窄——payload 只接受布尔（对齐参考实现的 IPC 参数布尔校验器），且拒绝
 *    嵌套 frame 代发（顶层 frame 守卫）；
 * 2. 收口不依赖 renderer 合作——上报过 true 的 webContents 在导航 / 渲染进程崩溃 /
 *    销毁时自动清出集合（录制态 resetShortcutRecordingForWebContents 的同款教训：
 *    跨进程临时状态不能指望对端发复位）；
 * 3. 聚合翻转事件——集合「空 ↔ 非空」翻转时通知订阅者（菜单 accelerator 摘挂接线
 *    用，见 spec §3 案 A），避免逐 surface 变化都触发菜单重建；
 * 4. before-input-event 让路谓词——宿主级快捷键在 main 拦截前先查
 *    hasEditableFocus(sender.id)，命中即放行按键给页面（不吃键）。
 *
 * electron 只 import type（运行时零依赖），台账与 IPC 注册均可脱离 Electron 单测。
 */
import type { IpcMain, IpcMainEvent, WebContents } from "electron";

/** Renderer → Main：嵌入第三方内容面可编辑焦点上报（布尔 payload）。 */
export const EMBEDDED_EDITABLE_FOCUS_CHANNEL = "acode:sync-embedded-editable-focus";

export interface EditableFocusLedger {
  /** 写入唯一路径：某 webContents 的嵌入内容面获得/失去可编辑焦点。 */
  setEditableFocus(webContents: WebContents, focused: boolean): void;
  /** before-input-event 让路谓词：该 webContents 当前是否有可编辑焦点。 */
  hasEditableFocus(webContentsId: number): boolean;
  /** 全局聚合：任一 webContents 有可编辑焦点（菜单 accelerator 摘挂接线用）。 */
  hasAnyEditableFocus(): boolean;
  /** 显式清除（窗口销毁清理等 main 侧收口路径）。 */
  clearEditableFocus(webContentsId: number): void;
  /** 订阅「空 ↔ 非空」聚合翻转；返回退订函数。 */
  onAggregateChange(listener: (hasAnyEditableFocus: boolean) => void): () => void;
}

/** 已挂收口监听的 webContents id（防止重复挂；destroyed 时摘除登记）。 */
export function createEditableFocusLedger(options?: {
  logger?: { debug(message: string, meta?: unknown): void };
}): EditableFocusLedger {
  const focusedIds = new Set<number>();
  const watchedIds = new Set<number>();
  const aggregateListeners = new Set<(hasAnyEditableFocus: boolean) => void>();
  const debug = options?.logger?.debug ?? (() => {});

  function notifyAggregateChange(): void {
    const hasAny = focusedIds.size > 0;
    for (const listener of aggregateListeners) {
      listener(hasAny);
    }
  }

  function removeId(webContentsId: number): boolean {
    return focusedIds.delete(webContentsId);
  }

  /**
   * 首次置 true 时挂导航/崩溃/销毁收口：导航后旧文档的焦点事实必然失效，
   * 渲染进程 gone / webContents 销毁时 renderer 不可能再发复位上报。
   */
  function attachInvalidationCleanup(webContents: WebContents): void {
    if (watchedIds.has(webContents.id)) {
      return;
    }
    watchedIds.add(webContents.id);
    const clearOnInvalidation = () => {
      clearEditableFocus(webContents.id);
    };
    webContents.on("did-navigate", clearOnInvalidation);
    webContents.on("render-process-gone", clearOnInvalidation);
    webContents.once("destroyed", () => {
      watchedIds.delete(webContents.id);
      clearEditableFocus(webContents.id);
    });
  }

  function clearEditableFocus(webContentsId: number): void {
    if (!removeId(webContentsId)) {
      return;
    }
    debug("[editable-focus] cleared", { webContentsId, hasAny: focusedIds.size > 0 });
    if (focusedIds.size === 0) {
      notifyAggregateChange();
    }
  }

  return {
    setEditableFocus(webContents, focused) {
      if (!focused) {
        clearEditableFocus(webContents.id);
        return;
      }
      if (webContents.isDestroyed()) {
        return;
      }
      attachInvalidationCleanup(webContents);
      if (focusedIds.has(webContents.id)) {
        return;
      }
      focusedIds.add(webContents.id);
      debug("[editable-focus] set", { webContentsId: webContents.id });
      if (focusedIds.size === 1) {
        notifyAggregateChange();
      }
    },
    hasEditableFocus(webContentsId) {
      return focusedIds.has(webContentsId);
    },
    hasAnyEditableFocus() {
      return focusedIds.size > 0;
    },
    clearEditableFocus,
    onAggregateChange(listener) {
      aggregateListeners.add(listener);
      return () => {
        aggregateListeners.delete(listener);
      };
    },
  };
}

/**
 * 注册上报 IPC（接线点在 main index.ts，本模块不 import ipcMain 单例以保持可测）。
 *
 * 校验器（IPC 面收窄，两拒一收）：
 * - payload 非布尔 → 丢弃 + warn（宁可漏报不可错报；renderer 侧只在变化时发 true/false）；
 * - senderFrame 存在且非顶层（parent 非 null）→ 拒绝：嵌套 iframe 不得代宿主窗口上报；
 * - 其余按 sender 的 webContents id 写台账。
 */
export function registerEmbeddedEditableFocusIpc(options: {
  ipcMain: IpcMain;
  ledger: EditableFocusLedger;
  logger: { warn(message: string, meta?: unknown): void };
}): void {
  options.ipcMain.on(EMBEDDED_EDITABLE_FOCUS_CHANNEL, (event: IpcMainEvent, payload: unknown) => {
    if (typeof payload !== "boolean") {
      options.logger.warn("[editable-focus] rejected non-boolean payload", {
        payloadType: typeof payload,
      });
      return;
    }
    const senderFrame = event.senderFrame;
    if (senderFrame !== null && senderFrame.parent !== null) {
      options.logger.warn("[editable-focus] rejected nested-frame report", {
        webContentsId: event.sender.id,
      });
      return;
    }
    options.ledger.setEditableFocus(event.sender, payload);
  });
}
