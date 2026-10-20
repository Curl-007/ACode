import type { BrowserWindow } from "electron";

/**
 * per-window dispatcher（specs/ipc-registration-factory.md R5.2）：WeakMap 按窗口句柄
 * 隔离的 per-window 状态分发器。上游 eipc「dispatcher 按窗口句柄 WeakMap 隔离」的
 * ACode 形态：需要 per-window 状态的域在 handler 内经 context.window 取用，工厂不强制。
 *
 * 从 platformIpcRegistry.ts 拆出的姊妹模块（max-file-lines 400 行门禁）：本文件只依赖
 * electron 的类型面（import type，运行时零 electron 依赖，纯 Node 可单测），API 经
 * platformIpcRegistry 入口 re-export，调用面保持单一入口。
 *
 * 生命周期：首次 forWindow 创建实例并挂 closed 监听（关窗即 dispose + 出表，WeakMap
 * 不阻 GC）；disposeWindow 供显式拆除。
 */
export interface PerWindowDispatcher<T> {
  forWindow(window: BrowserWindow): T;
  disposeWindow(window: BrowserWindow): void;
}

export function createPerWindowDispatcher<T>(options: {
  create: (window: BrowserWindow) => T;
  dispose?: (value: T, window: BrowserWindow) => void;
}): PerWindowDispatcher<T> {
  const values = new WeakMap<BrowserWindow, T>();
  const closers = new WeakMap<BrowserWindow, () => void>();

  const teardown = (window: BrowserWindow): void => {
    const hadValue = values.has(window);
    const value = values.get(window) as T | undefined;
    const closer = closers.get(window);
    values.delete(window);
    closers.delete(window);
    if (closer) window.removeListener("closed", closer);
    if (hadValue) options.dispose?.(value as T, window);
  };

  return {
    forWindow(window: BrowserWindow): T {
      if (values.has(window)) return values.get(window) as T;
      const created = options.create(window);
      const closer = (): void => teardown(window);
      values.set(window, created);
      closers.set(window, closer);
      window.once("closed", closer);
      return created;
    },
    disposeWindow(window: BrowserWindow): void {
      teardown(window);
    },
  };
}
