/**
 * 桌面页内查找 main 侧封装（specs/find-in-page.md 一期 + 二期 provider 双路）。
 *
 * 机制：webContents.findInPage 返回 requestId → found-in-page 事件按 requestId 匹配，
 * 与 destroyed / render-process-gone / 5s 超时三路竞速，任何非正常路径 fail-soft 收口
 * {activeIndex:0,total:0}（原生 Promise 实现，不引入 RxJS）。会话带失效链：目标跨文档
 * 导航或渲染进程崩溃即清高亮、摘监听、结束会话；WeakSet 防重复 stopFindInPage。
 *
 * 二期双路仲裁（spec R8）：handleFindInPage 在原生路之前判定 provider 路——renderer
 * 申报 provider 注册表非空时改走 dispatch/report 协调（findInPageProviderMain.ts，
 * epoch 守卫 + 同一 fail-soft 收口）；两路互斥，provider 路激活期间不调用 Chromium
 * findInPage（renderer 内置 DOM 腿等价覆盖已渲染文本，并行会双重高亮、索引分裂）。
 */
import { ipcMain } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { PlatformChannels } from "@acode/shared";
import type { FindInPageRequest, FindInPageResult } from "@acode/shared";
import { deriveIpcSyncLabel, wrapIpcHandle } from "./ipcSyncTiming.js";
import {
  clearProviderFind,
  dispatchProviderFind,
  handleProviderActiveDeclaration,
  handleProviderReport,
  isProviderPathActive,
  resetProviderFind,
} from "./findInPageProviderMain.js";

/** fail-soft 统一空结果：超时/销毁/崩溃/未匹配都收口到这里，不向 renderer 抛错。 */
const EMPTY_FIND_RESULT: FindInPageResult = { activeIndex: 0, total: 0 };

/** 三路竞速超时（生产 5s；registerFindInPageIpc 的 timeoutMs 仅测试注入）。 */
const FIND_IN_PAGE_TIMEOUT_MS = 5000;

/**
 * CJK 感知起搜阈值：Han/平假名/片假名/谚文单字即搜，拉丁 3 字符起搜。
 * 与 renderer 侧 packages/ui/src/find-in-page/findInPageModel.ts 同构镜像
 * （main 不能 import ui 包；单一事实源为 specs/find-in-page.md，两处各自单测锁定）。
 */
const CJK_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function meetsFindInPageThreshold(text: string): boolean {
  return text.length > 2 || CJK_SCRIPT_PATTERN.test(text);
}

/**
 * 载荷运行时校验（不信任 renderer 输入，直连 IPC 可绕过 preload 类型）：
 * text/findNext 必须为 string/boolean，forward 可选 boolean；非法即 null（不抛错）。
 */
function parseFindInPageRequest(payload: unknown): FindInPageRequest | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Partial<FindInPageRequest>;
  if (typeof candidate.text !== "string") {
    return null;
  }
  if (typeof candidate.findNext !== "boolean") {
    return null;
  }
  if (candidate.forward !== undefined && typeof candidate.forward !== "boolean") {
    return null;
  }
  return { text: candidate.text, findNext: candidate.findNext, forward: candidate.forward };
}

/** 高亮存在标记：只对确有活动高亮的目标调 stopFindInPage("clearSelection")，防重复。 */
const highlightActiveTargets = new WeakSet<WebContents>();

/** per-sender 查找会话：失效链监听的拆卸器。WeakMap 让 webContents 回收即会话消亡。 */
const findSessions = new WeakMap<WebContents, () => void>();

export interface FindInPageIpcLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** 清高亮（WeakSet 防重复）；崩溃后的 stopFindInPage 可能抛错，fail-soft 忽略。 */
function clearFindHighlight(target: WebContents): void {
  if (!highlightActiveTargets.has(target)) {
    return;
  }
  highlightActiveTargets.delete(target);
  if (target.isDestroyed()) {
    return;
  }
  try {
    target.stopFindInPage("clearSelection");
  } catch {
    // render-process-gone 之后 Render frame 已 disposed，stopFindInPage 会抛；
    // 高亮随进程消失，无需清理，吞掉即可（fail-soft 纪律）。
  }
}

interface FoundInPageEventResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
}

/**
 * 三路竞速：found-in-page(按 requestId 过滤，首个命中即结算) | destroyed /
 * render-process-gone | 超时。任何路径都结算（不 reject），并摘除全部监听器与定时器——
 * 快速输入会产生多轮并存竞速，泄漏监听会让后续轮次被旧回调污染。
 */
function raceFoundInPage(
  target: WebContents,
  text: string,
  options: { forward: boolean; findNext: boolean },
  timeoutMs: number,
): Promise<FindInPageResult> {
  let requestId: number;
  try {
    requestId = target.findInPage(text, options);
  } catch {
    return Promise.resolve(EMPTY_FIND_RESULT);
  }
  highlightActiveTargets.add(target);
  return new Promise<FindInPageResult>((resolve) => {
    let settled = false;
    const onFound = (_event: unknown, result: FoundInPageEventResult): void => {
      // requestId 匹配：只认本轮，多轮并存时旧轮事件自然被各自回调消费或超时。
      if (result.requestId !== requestId) {
        return;
      }
      settle({ activeIndex: result.activeMatchOrdinal, total: result.matches });
    };
    const onTargetLost = (): void => {
      settle(EMPTY_FIND_RESULT);
    };
    const timer = setTimeout(onTargetLost, timeoutMs);
    function settle(result: FindInPageResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      target.removeListener("found-in-page", onFound);
      target.removeListener("destroyed", onTargetLost);
      target.removeListener("render-process-gone", onTargetLost);
      resolve(result);
    }
    target.on("found-in-page", onFound);
    target.once("destroyed", onTargetLost);
    target.once("render-process-gone", onTargetLost);
  });
}

interface NavigationDetails {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

/**
 * 会话失效链：跨文档导航（did-start-navigation 非同文档 / did-redirect / did-navigate）、
 * 渲染进程崩溃、webContents 销毁 → 结束会话（清高亮 + 摘全部监听）。
 * same-document 导航（hash/pushState）不失效——DOM 与高亮都还在。
 */
function ensureFindSession(target: WebContents, logger: FindInPageIpcLogger): void {
  if (findSessions.has(target)) {
    return;
  }
  const invalidate = (): void => {
    // 二期：失效链额外复位 provider 路（active=false + 结算 pending + 下发 clear）——
    // 跨文档导航/崩溃后 renderer 上下文已换，注册表由重载后的 renderer 重新申报（spec R10）。
    resetProviderFind(target);
    endFindInPageSession(target);
  };
  const onDidStartNavigation = (details: NavigationDetails): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      invalidate();
    }
  };
  const onDidRedirectNavigation = (details: NavigationDetails): void => {
    if (details.isMainFrame) {
      invalidate();
    }
  };
  target.on("did-start-navigation", onDidStartNavigation);
  target.on("did-redirect-navigation", onDidRedirectNavigation);
  target.on("did-navigate", invalidate);
  target.on("render-process-gone", invalidate);
  target.once("destroyed", invalidate);
  findSessions.set(target, () => {
    target.removeListener("did-start-navigation", onDidStartNavigation);
    target.removeListener("did-redirect-navigation", onDidRedirectNavigation);
    target.removeListener("did-navigate", invalidate);
    target.removeListener("render-process-gone", invalidate);
    target.removeListener("destroyed", invalidate);
    findSessions.delete(target);
  });
  logger.info("[find-in-page] session opened", { webContentsId: target.id });
}

/** 结束会话：清高亮（WeakSet 防重复）+ 拆失效链。幂等，可在任何状态安全调用。 */
export function endFindInPageSession(target: WebContents): void {
  clearFindHighlight(target);
  // 二期：provider 路 pending 结算 {0,0} + 下发 FindInPageClear；active 保留
  // （能力申报由 renderer 注册表驱动，与会话生命周期解耦，spec R10/R14）。
  clearProviderFind(target);
  findSessions.get(target)?.();
}

async function handleFindInPage(
  event: IpcMainInvokeEvent,
  payload: unknown,
  timeoutMs: number,
): Promise<FindInPageResult | null> {
  const target = event.sender;
  const request = parseFindInPageRequest(payload);
  // 阈值双层防御：renderer 已 gate，这里挡住直连 IPC 的短查询（不起搜、返回 null）。
  if (request === null || !meetsFindInPageThreshold(request.text)) {
    return null;
  }
  if (target.isDestroyed()) {
    return null;
  }
  ensureFindSession(target, installLogger);
  // 二期双路仲裁（spec R8）：provider 路激活时不调用 Chromium findInPage——renderer
  // 协调器的内置 DOM 腿等价覆盖已渲染文本，并行会双重高亮、索引分裂。
  if (isProviderPathActive(target)) {
    return await dispatchProviderFind(target, request, timeoutMs);
  }
  // 首查（WeakSet 未命中 = 目标尚无活动高亮）强制 findNext:true——Chromium 从当前
  // 视口续搜，用户先看到视口附近的匹配（浏览器查找习惯）；已有高亮时透传调用方语义。
  const options = {
    forward: request.forward ?? true,
    findNext: highlightActiveTargets.has(target) ? request.findNext : true,
  };
  return await raceFoundInPage(target, request.text, options, timeoutMs);
}

/** install 时注入的 logger（模块级持有，避免 handler 链路层层传参）。 */
let installLogger: FindInPageIpcLogger = {
  info: () => {},
  warn: () => {},
};

/**
 * install 接口：注册三条 invoke handler。main/index.ts 接线（接线位置见交付报告）：
 *   registerFindInPageIpc({ logger });
 * timeoutMs 仅测试注入（生产缺省 5s）。
 */
export function registerFindInPageIpc(options: {
  logger: FindInPageIpcLogger;
  timeoutMs?: number;
}): void {
  installLogger = options.logger;
  const timeoutMs = options.timeoutMs ?? FIND_IN_PAGE_TIMEOUT_MS;
  ipcMain.handle(
    PlatformChannels.FindInPage,
    wrapIpcHandle(deriveIpcSyncLabel(PlatformChannels.FindInPage), (event, payload) =>
      handleFindInPage(event, payload, timeoutMs),
    ),
  );
  ipcMain.handle(
    PlatformChannels.StopFindInPage,
    wrapIpcHandle(deriveIpcSyncLabel(PlatformChannels.StopFindInPage), (event) => {
      clearFindHighlight(event.sender);
      // 二期：provider 路高亮同步清理（pending 结算 {0,0} + FindInPageClear）。
      clearProviderFind(event.sender);
    }),
  );
  ipcMain.handle(
    PlatformChannels.EndFindInPageSession,
    wrapIpcHandle(deriveIpcSyncLabel(PlatformChannels.EndFindInPageSession), (event) => {
      endFindInPageSession(event.sender);
    }),
  );
  ipcMain.handle(
    PlatformChannels.FindInPageProviderActive,
    wrapIpcHandle(
      deriveIpcSyncLabel(PlatformChannels.FindInPageProviderActive),
      (event, payload: unknown) => {
        handleProviderActiveDeclaration(event.sender, payload);
      },
    ),
  );
  ipcMain.handle(
    PlatformChannels.FindInPageReport,
    wrapIpcHandle(
      deriveIpcSyncLabel(PlatformChannels.FindInPageReport),
      (event, payload: unknown) => {
        handleProviderReport(event.sender, payload);
      },
    ),
  );
}

/** 菜单入口推送打开查找栏（main → renderer 单向 send；W1-8 菜单接线用）。 */
export function requestFindInPageOpen(target: WebContents): void {
  if (!target.isDestroyed()) {
    target.send(PlatformChannels.OpenFindInPage);
  }
}
