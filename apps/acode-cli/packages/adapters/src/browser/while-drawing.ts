// Ported from oh-my-pi (MIT) — packages/coding-agent/src/tools/browser/screenshot.ts:161-193,
// Copyright (c) 2025 Mario Zechner & Stencil Labs. 适配 ACode：Playwright CDPSession 以可注入
// 工厂暴露（测试用桩会话验证时序）、中止复用 request.ts 的 raceWithAbort。
import type { Page } from "playwright-core";
import { abortError, raceWithAbort } from "./request.js";

/**
 * whileDrawing 依赖的 CDP 会话最小结构面。Playwright 的 CDPSession 结构兼容；
 * 独立成接口让测试注入桩会话验证时序，而不启动浏览器。
 */
export interface ScreencastSession {
  send(method: "Page.startScreencast" | "Page.stopScreencast", params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

export type ScreencastSessionFactory = (page: Page) => Promise<ScreencastSession>;

/** 缺省会话工厂：为 page 开一路专用 CDP 会话（用完即弃，不影响 Playwright 自身的会话）。 */
export const defaultScreencastSessionFactory: ScreencastSessionFactory = async (page) => {
  const session = await page.context().newCDPSession(page);
  // Playwright CDPSession 的 send/detach 结构兼容本接口；显式收窄便于桩替换。
  return session as unknown as ScreencastSession;
};

/**
 * Run `capture` while `page` is made to draw. Chromium stops drawing a hidden
 * page (a background tab, a minimized or covered window) shortly after its last
 * change, and `Page.captureScreenshot` waits for a fresh frame, so capturing such
 * a page would wait until the op times out. A DevTools screencast makes Chromium
 * draw the page for capture without showing or activating it and without changing
 * its visibility. A browser that refuses the screencast is captured without it.
 *
 * 时序（顺序不可变，见 specs/browser-relay-inplace-capture.md R1）：
 * startScreencast(1×1 jpeg) → capture → stopScreencast → detach；任一 screencast 步骤
 * 失败即降级为无 screencast 的直接捕获（非错误），capture 抛错时清理照常执行再上抛。
 */
export async function whileDrawing<T>(
  page: Page,
  signal: AbortSignal | undefined,
  capture: () => Promise<T>,
  factory: ScreencastSessionFactory = defaultScreencastSessionFactory,
): Promise<T> {
  // raceWithAbort 要求非空 signal；无 signal 时直接等待原 promise（等价：永不中止）。
  const race = <T2>(promise: Promise<T2>): Promise<T2> => (signal ? raceWithAbort(promise, signal) : promise);
  let session: ScreencastSession | undefined;
  try {
    if (signal?.aborted) throw abortError();
    try {
      const screencast = await factory(page);
      session = screencast;
      // 1×1 jpeg：帧内容不消费，只利用「screencast 存在 ⇒ Chromium 持续合成」的副作用。
      await race(
        screencast.send("Page.startScreencast", { format: "jpeg", quality: 1, maxWidth: 1, maxHeight: 1 }),
      );
    } catch (error) {
      signal?.throwIfAborted();
      // 拒绝 screencast 的浏览器（或非 Chromium 内核）退化为直接捕获；降级不是错误，
      // 不额外接日志管线（adapters 浏览器路径现无 logger 装配）。session 保持持有，
      // finally 里的 stop+detach 负责清理这路半开的会话（omp 原语义）。
      void error;
    }
    return await race(capture());
  } finally {
    if (session) {
      await session.send("Page.stopScreencast").catch(() => undefined);
      await session.detach().catch(() => undefined);
    }
  }
}
