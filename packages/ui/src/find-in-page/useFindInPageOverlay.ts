/**
 * 页内查找栏编排 hook（specs: packages/desktop/specs/find-in-page.md 一期）。
 *
 * 职责：平台桥探测（Web 端桥缺席即整个查找面静默停用）、250ms 防抖增量搜索、
 * latest-wins 序号闸（等价 switchMap 竞态语义，原生实现不引入 RxJS）、
 * F3/Shift+F3/Escape 的 window capture 分发、焦点编排三方规则
 * （打开即聚焦 / 100ms 重聚焦但用户主动 blur 过不抢 / 距上次击键 >400ms 才 select() /
 * 关闭后焦点还给触发处）。呈现由 FindInPageOverlay.tsx 负责。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from "react";
import type { FindInPageResult } from "@acode/shared";
import { logger } from "@/logger.js";
import { isShortcutRecordingActive } from "@/shortcuts/bindings.js";
import { matchFindInPageBinding } from "@/shortcuts/findInPageBindings.js";
import {
  FIND_IN_PAGE_DEBOUNCE_MS,
  FIND_IN_PAGE_REFOCUS_DELAY_MS,
  isFindInPageCloseEscape,
  meetsFindInPageThreshold,
  shouldSelectOnProgrammaticFocus,
} from "./findInPageModel.js";

/**
 * 平台桥局部结构类型（EmbeddedBrowserPermissionPromptHost 先例）：window.acode 的完整
 * 类型声明在 desktop renderer 侧，ui 包单独 typecheck 拿不到——只声明本 feature 消费的
 * 四个成员，缺任一即视为平台不支持（Web 端），静默不启用查找。
 */
interface FindInPageBridge {
  findInPage?: (request: {
    text: string;
    findNext: boolean;
    forward?: boolean;
  }) => Promise<FindInPageResult | null>;
  stopFindInPage?: () => Promise<void>;
  endFindInPageSession?: () => Promise<void>;
  onOpenFindInPage?: (callback: () => void) => () => void;
}

type FindInPageBridgeWindow = Window & { acode?: FindInPageBridge };

const EMPTY_FIND_RESULT: FindInPageResult = { activeIndex: 0, total: 0 };

function resolveFindInPageBridge(): FindInPageBridge | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const bridge = (window as FindInPageBridgeWindow).acode;
  return typeof bridge?.findInPage === "function" &&
    typeof bridge.stopFindInPage === "function" &&
    typeof bridge.endFindInPageSession === "function" &&
    typeof bridge.onOpenFindInPage === "function"
    ? bridge
    : undefined;
}

export interface FindInPageOverlayController {
  /** 平台桥是否在场（Web 端恒 false，组件渲染 null，保留浏览器原生 Ctrl+F）。 */
  supported: boolean;
  open: boolean;
  query: string;
  /** 本轮查找结果；null = 新查询的结果尚未回来（计数隐藏）。 */
  result: FindInPageResult | null;
  inputRef: RefObject<HTMLInputElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  onQueryChange(value: string): void;
  onInputBlur(event: ReactFocusEvent<HTMLInputElement>): void;
  onContainerMouseDown(event: ReactMouseEvent<HTMLDivElement>): void;
  /** 步进：forward=true 下一处 / false 上一处（findNext:false 重搜一轮）。 */
  step(forward: boolean): void;
  close(): void;
}

export function useFindInPageOverlay(): FindInPageOverlayController {
  const bridge = useMemo(() => resolveFindInPageBridge(), []);
  const supported = bridge !== undefined;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<FindInPageResult | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** latest-wins 序号闸：只接受最新一轮的结果，旧轮晚到直接丢弃。 */
  const seqRef = useRef(0);
  /** 上次击键时刻（performance.now()）——程序性聚焦的 400ms select() 闸。 */
  const lastKeyAtRef = useRef(0);
  /** 用户主动把焦点移出输入框；窗口重获焦点后的重聚焦不抢回。 */
  const userBlurRef = useRef(false);
  /** 打开时的焦点触发处，关闭后归还。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);
  openRef.current = open;
  const queryRef = useRef("");
  queryRef.current = query;

  const focusInputProgrammatically = useCallback(() => {
    userBlurRef.current = false;
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    // 程序性聚焦时距上次击键 >400ms 才 select()——不打断正在进行的输入。
    if (shouldSelectOnProgrammaticFocus(lastKeyAtRef.current, performance.now())) {
      input.select();
    }
  }, []);

  const openBar = useCallback(() => {
    if (openRef.current) {
      // 已开时重复触发（菜单再点/F3）= 显式聚焦意图：复位 blur 标志并聚焦。
      focusInputProgrammatically();
      return;
    }
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    userBlurRef.current = false;
    setOpen(true);
  }, [focusInputProgrammatically]);

  const close = useCallback(() => {
    if (!openRef.current) {
      return;
    }
    seqRef.current += 1; // 作废在途查找结果
    setOpen(false);
    setQuery("");
    setResult(null);
    bridge?.endFindInPageSession?.().catch((error: unknown) => {
      logger.warn("[find-in-page] 结束会话失败", error);
    });
    // 关闭后焦点还给触发处；元素已离文档则不抢（浏览器自然回落 body）。
    const restoreTarget = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restoreTarget?.isConnected) {
      restoreTarget.focus();
    }
  }, [bridge]);

  const dispatchFind = useCallback(
    async (text: string, options: { findNext: boolean; forward?: boolean }) => {
      if (!bridge) {
        return;
      }
      const seq = ++seqRef.current;
      try {
        const found = await bridge.findInPage?.({ text, ...options });
        if (seq !== seqRef.current) {
          return; // latest-wins：过期轮次丢弃
        }
        // main 侧未过阈值/目标不可用返回 null，按无匹配收口。
        setResult(found ?? EMPTY_FIND_RESULT);
      } catch (error) {
        if (seq !== seqRef.current) {
          return;
        }
        logger.warn("[find-in-page] 查找请求失败", error);
        setResult(EMPTY_FIND_RESULT);
      }
    },
    [bridge],
  );

  const step = useCallback(
    (forward: boolean) => {
      const current = queryRef.current;
      if (!meetsFindInPageThreshold(current)) {
        return;
      }
      void dispatchFind(current, { findNext: false, forward });
    },
    [dispatchFind],
  );

  const stepRef = useRef(step);
  stepRef.current = step;
  const closeRef = useRef(close);
  closeRef.current = close;
  const openBarRef = useRef(openBar);
  openBarRef.current = openBar;

  // 增量搜索流：250ms 防抖；低于阈值不发起搜索且自动清理既有高亮。
  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = setTimeout(() => {
      if (!meetsFindInPageThreshold(query)) {
        seqRef.current += 1; // 作废在途结果，防止旧查询晚到污染计数
        setResult(EMPTY_FIND_RESULT);
        bridge?.stopFindInPage?.().catch((error: unknown) => {
          logger.warn("[find-in-page] 清理高亮失败", error);
        });
        return;
      }
      void dispatchFind(query, { findNext: true });
    }, FIND_IN_PAGE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query, bridge, dispatchFind]);

  // 打开即聚焦输入框（select() 受 400ms 闸；首开查询为空，select 无副作用）。
  useEffect(() => {
    if (!open) {
      return;
    }
    focusInputProgrammatically();
  }, [open, focusInputProgrammatically]);

  // 窗口 visibilitychange/focus 后 100ms 重聚焦；用户主动 blur 过则不抢。
  useEffect(() => {
    if (!open) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefocus = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const input = inputRef.current;
      if (!input || document.activeElement === input) {
        return;
      }
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        const element = inputRef.current;
        if (!element || document.activeElement === element || userBlurRef.current) {
          return;
        }
        element.focus();
        if (shouldSelectOnProgrammaticFocus(lastKeyAtRef.current, performance.now())) {
          element.select();
        }
      }, FIND_IN_PAGE_REFOCUS_DELAY_MS);
    };
    document.addEventListener("visibilitychange", scheduleRefocus);
    window.addEventListener("focus", scheduleRefocus);
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", scheduleRefocus);
      window.removeEventListener("focus", scheduleRefocus);
    };
  }, [open]);

  // F3/Shift+F3/Escape 的 window capture 分发（仅桌面端；录制态短路）。
  useEffect(() => {
    if (!supported) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // 设置页录制态由录制监听接管按键，查找栏不消费（useAppKeyboard 同一纪律）。
      if (isShortcutRecordingActive()) {
        return;
      }
      const intent = matchFindInPageBinding(event);
      if (intent !== null) {
        event.preventDefault();
        if (openRef.current) {
          stepRef.current(intent === "next");
        } else {
          openBarRef.current();
        }
        return;
      }
      if (!openRef.current || !isFindInPageCloseEscape(event)) {
        return;
      }
      // 模态对话框持有焦点时不消费 Escape——让位给对话框自身的关闭语义。
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('[role="dialog"],[role="alertdialog"]')) {
        return;
      }
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [supported]);

  // 主菜单「页内查找」推送打开（main → renderer 单向 send）。
  // 菜单 accelerator 会先于 renderer keydown 吃掉 F3——推送与键路统一语义：
  // 栏已开 = 下一处（等价 F3），栏未开 = 打开并聚焦。
  useEffect(() => {
    if (!bridge?.onOpenFindInPage) {
      return;
    }
    return bridge.onOpenFindInPage(() => {
      if (openRef.current) {
        stepRef.current(true);
      } else {
        openBarRef.current();
      }
    });
  }, [bridge]);

  const onQueryChange = useCallback((value: string) => {
    lastKeyAtRef.current = performance.now();
    setQuery(value);
    setResult(null); // 新一轮结果回来前隐藏计数（防误读旧值）
  }, []);

  const onInputBlur = useCallback((event: ReactFocusEvent<HTMLInputElement>) => {
    // 焦点移向查找栏内部（上/下/关按钮）不算「用户主动离开」。
    const related = event.relatedTarget;
    if (related instanceof Node && containerRef.current?.contains(related)) {
      return;
    }
    userBlurRef.current = true;
  }, []);

  const onContainerMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    // 点击容器空白 = 显式聚焦意图（复位 blur 标志）；按钮点击不劫持。
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button")) {
      return;
    }
    userBlurRef.current = false;
    inputRef.current?.focus();
  }, []);

  return {
    supported,
    open,
    query,
    result,
    inputRef,
    containerRef,
    onQueryChange,
    onInputBlur,
    onContainerMouseDown,
    step,
    close,
  };
}
