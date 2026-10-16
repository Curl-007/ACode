/**
 * 页内查找 preload 桥（specs/find-in-page.md）。
 *
 * 独立成文件（index.ts 有 max-lines 门禁），由 preload 入口 spread 进 window.acode
 * 主桥对象；ui 侧按 EmbeddedBrowserPermissionPromptHost 先例以局部结构类型消费，
 * 桥缺席（Web 端）即视为平台不支持。
 */
import { ipcRenderer } from "electron";
import { PlatformChannels } from "@acode/shared";
import type { FindInPageRequest, FindInPageResult } from "@acode/shared";

export const findInPageBridge = {
  /**
   * 页内查找：main 封装 found-in-page requestId 匹配 + 三路竞速，
   * 超时/目标丢失 fail-soft 返回 {activeIndex:0,total:0}；未过阈值/载荷非法返回 null。
   */
  findInPage: (request: FindInPageRequest): Promise<FindInPageResult | null> =>
    ipcRenderer.invoke(PlatformChannels.FindInPage, request),
  /** 清除查找高亮（查询过短/关闭查找栏时调用；main 侧 WeakSet 防重复，会话保留）。 */
  stopFindInPage: (): Promise<void> => ipcRenderer.invoke(PlatformChannels.StopFindInPage),
  /** 结束查找会话：清高亮 + main 侧拆失效链监听。 */
  endFindInPageSession: (): Promise<void> => ipcRenderer.invoke(PlatformChannels.EndFindInPageSession),
  /** 订阅 main 推送的打开查找栏请求（主菜单/accelerator 入口），返回 disposer。 */
  onOpenFindInPage: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on(PlatformChannels.OpenFindInPage, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenFindInPage, handler);
  },
} as const;
