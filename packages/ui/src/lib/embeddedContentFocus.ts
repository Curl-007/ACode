/**
 * 嵌入第三方内容面的可编辑焦点追踪（spec: packages/desktop/specs/embedded-content-focus-yield.md §1）。
 *
 * 可视化卡片 sandbox iframe、内嵌浏览器 pane 等第三方内容面对宿主是键盘黑洞：
 * 焦点进去之后按键不再派发给宿主 document，但窗口级的应用菜单 accelerator 仍会
 * 先于页面吃键（Ctrl+N 直接触发宿主命令）。容器组件用本模块追踪焦点进出，
 * 变化才上报 main 台账，main 据此摘挂冲突 accelerator / 放行 before-input-event。
 *
 * 判定纪律：
 * - 跨源 iframe / webview guest 内部无法穿透，**保守视为可编辑**——焦点落在
 *   IFRAME/FRAME/EMBED/OBJECT/WEBVIEW 元素上即算（误让路代价远小于误吃键）；
 * - activeElement 解析穿透 shadowRoot 链（焦点可能在 shadow DOM 内的输入框上，
 *   此时 document.activeElement 是宿主元素，contains 判定用外层、可编辑判定穿透内层）；
 * - 变化才上报 + trailing 去抖（非每帧/每键）；多 surface 并存时依赖 DOM 事件序
 *   （focusout 先于 focusin）+ 相同去抖延时保证 main 收到的布尔序列终值正确；
 * - 不监听 window blur：窗口失焦时 activeElement 不变，误报 false 后焦点回窗
 *   不会再触发 focusin，会产生「iframe 有焦点但台账为 false」的假阴性。
 */
import { logger } from "@/logger.js";

/** 可编辑 / 嵌入内容面判定集（tagName 闭集，保守方向）。 */
const EMBEDDED_EDITABLE_FOCUS_TAGS: ReadonlySet<string> = new Set([
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "IFRAME",
  "FRAME",
  "EMBED",
  "OBJECT",
  // Electron <webview> guest 对宿主 DOM 不透明，与 IFRAME 同理保守视为可编辑；
  // 宿主 activeElement 可能落在 WEBVIEW 自定义元素或其内部 OBJECT 上，两者都在集内。
  "WEBVIEW",
]);

/** 沿 shadowRoot.activeElement 链解析真实焦点元素（跨源 iframe 内部不可穿透，停在元素本身）。 */
export function resolveDeepActiveElement(element: Element | null): Element | null {
  let current = element;
  while (current?.shadowRoot?.activeElement) {
    current = current.shadowRoot.activeElement;
  }
  return current;
}

/** 焦点元素是否属于「可编辑焦点」判定集（含 shadowRoot 穿透与嵌入面保守判定）。 */
export function isEmbeddedEditableFocusTarget(element: Element | null): boolean {
  const target = resolveDeepActiveElement(element);
  if (!target) {
    return false;
  }
  if (EMBEDDED_EDITABLE_FOCUS_TAGS.has(target.tagName)) {
    return true;
  }
  // 真实 DOM 里只有 HTMLElement 才有 isContentEditable，结构判定与 instanceof 等价，
  // 且无 DOM 环境（node 单测）不炸——对齐 bindings.ts isEditableShortcutEventTarget 的可测性纪律。
  return (target as Partial<HTMLElement>).isContentEditable === true;
}

/** 上报桥（桌面侧可选方法）的结构收窄：IPlatformService 增补见 spec 接线需求清单。 */
interface EmbeddedEditableFocusBridge {
  syncEmbeddedEditableFocus?(focused: boolean): void;
}

/**
 * 把可编辑焦点变化上报给宿主（桌面 main 台账）。
 * platform 上没有该方法（Web / 静态回放 / 桥未接线）时静默 no-op——追踪本身无副作用，
 * 让路能力随桥接线自动生效。通道常量约定 acode:sync-embedded-editable-focus。
 */
export function reportEmbeddedEditableFocus(platform: unknown, focused: boolean): void {
  const bridge = platform as EmbeddedEditableFocusBridge | null;
  if (typeof bridge?.syncEmbeddedEditableFocus !== "function") {
    return;
  }
  logger.debug("[embedded-focus] editable focus changed", { focused });
  bridge.syncEmbeddedEditableFocus(focused);
}

export interface EmbeddedContentFocusTracker {
  /** 立即重算一次焦点状态（供外部在已知焦点可能变化的时机补触发）。 */
  sync(): void;
  /** 摘监听 + 清定时器；若此前上报过 true，同步补报 false（surface 不再主张焦点）。 */
  dispose(): void;
}

const DEFAULT_REPORT_DEBOUNCE_MS = 150;

/**
 * 为单个第三方内容面容器创建焦点追踪器。
 *
 * 容器上委托 focusin/focusout（capture）+ keydown（capture，兜住程序化焦点移动），
 * 创建时立即同步一次。per-tracker 记住 lastReported，只在变化时经去抖上报；
 * 去抖窗口内翻回原值则取消（稳态零 IPC）。
 */
export function createEmbeddedContentFocusTracker(options: {
  /** 包裹第三方内容面的容器（委托监听根）。 */
  root: HTMLElement;
  /** 变化上报回调（已去抖收敛）。 */
  report(focused: boolean): void;
  /** trailing 去抖毫秒数，默认 150ms。 */
  debounceMs?: number;
  /** 可注入定时器（单测用）；缺省 setTimeout/clearTimeout。 */
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  /** 可注入 activeElement 读取（单测用）；缺省 root.ownerDocument ?? document。 */
  getActiveElement?: () => Element | null;
}): EmbeddedContentFocusTracker {
  const debounceMs = options.debounceMs ?? DEFAULT_REPORT_DEBOUNCE_MS;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer));
  const getActiveElement =
    options.getActiveElement ?? (() => (options.root.ownerDocument ?? document).activeElement);

  // main 台账对新 surface 的缺省事实是 false；lastReported 从 false 起步，
  // 挂载时焦点恰在容器内（虚拟列表复挂载）才会触发首个 true 上报。
  let lastReported = false;
  let pending: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function cancelPending(): void {
    if (timer !== null) {
      cancelSchedule(timer);
      timer = null;
    }
    pending = null;
  }

  function flush(): void {
    timer = null;
    if (disposed || pending === null || pending === lastReported) {
      pending = null;
      return;
    }
    lastReported = pending;
    pending = null;
    options.report(lastReported);
  }

  function sync(): void {
    if (disposed) {
      return;
    }
    const active = getActiveElement();
    // 容器包含性用未穿透的外层 activeElement 判定（shadow 内层不在 light DOM 树上，
    // Node.contains 不跨 shadow 边界）；可编辑判定内部再做 shadowRoot 穿透。
    const focused =
      active !== null && options.root.contains(active) && isEmbeddedEditableFocusTarget(active);
    if (focused === lastReported) {
      // 回到已上报值：取消在途的中间态，稳态零 IPC。
      cancelPending();
      return;
    }
    if (focused === pending) {
      return;
    }
    if (timer !== null) {
      cancelSchedule(timer);
    }
    pending = focused;
    timer = schedule(flush, debounceMs);
  }

  const handleFocusEvent = () => sync();
  const listenTypes = ["focusin", "focusout", "keydown"] as const;
  for (const type of listenTypes) {
    options.root.addEventListener(type, handleFocusEvent, true);
  }
  sync();

  return {
    sync,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const type of listenTypes) {
        options.root.removeEventListener(type, handleFocusEvent, true);
      }
      cancelPending();
      if (lastReported) {
        // 终态补报同步发出：surface 卸载后不能再依赖去抖定时器。
        lastReported = false;
        options.report(false);
      }
    },
  };
}
