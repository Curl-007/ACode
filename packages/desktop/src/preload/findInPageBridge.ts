/**
 * 页内查找 preload 桥（specs/find-in-page.md，一期 + 二期 provider 双路）。
 *
 * 独立成文件（index.ts 有 max-lines 门禁），由 preload 入口 spread 进 window.acode
 * 主桥对象；ui 侧按 EmbeddedBrowserPermissionPromptHost 先例以局部结构类型消费，
 * 桥缺席（Web 端）即视为平台不支持。
 */
import { ipcRenderer } from "electron";
import { PlatformChannels } from "@acode/shared";
import type {
  FindInPageDispatchPayload,
  FindInPageReportPayload,
  FindInPageRequest,
  FindInPageResult,
} from "@acode/shared";

export const findInPageBridge = {
  /**
   * 页内查找：main 封装 found-in-page requestId 匹配 + 三路竞速，
   * 超时/目标丢失 fail-soft 返回 {activeIndex:0,total:0}；未过阈值/载荷非法返回 null。
   * 二期：main 侧按 provider 申报状态双路仲裁（provider 路走 dispatch/report 协调）。
   */
  findInPage: (request: FindInPageRequest): Promise<FindInPageResult | null> =>
    ipcRenderer.invoke(PlatformChannels.FindInPage, request),
  /** 清除查找高亮（查询过短/关闭查找栏时调用；main 侧 WeakSet 防重复，会话保留）。 */
  stopFindInPage: (): Promise<void> => ipcRenderer.invoke(PlatformChannels.StopFindInPage),
  /** 结束查找会话：清高亮 + main 侧拆失效链监听。 */
  endFindInPageSession: (): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.EndFindInPageSession),
  /** 订阅 main 推送的打开查找栏请求（主菜单/accelerator 入口），返回 disposer。 */
  onOpenFindInPage: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on(PlatformChannels.OpenFindInPage, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenFindInPage, handler);
  },
  /**
   * 二期：provider 双路能力申报（provider 注册表非空即 true）。
   * main 侧 findInPage handler 按此在原生路之前仲裁（specs/find-in-page.md R8）。
   */
  setFindInPageProviderActive: (active: boolean): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.FindInPageProviderActive, { active }),
  /** 二期：订阅 main 下发的 provider 路查找请求（epoch 守卫），返回 disposer。 */
  onFindInPageDispatch: (callback: (payload: FindInPageDispatchPayload) => void): (() => void) => {
    const handler = (_event: unknown, payload: FindInPageDispatchPayload): void => {
      callback(payload);
    };
    ipcRenderer.on(PlatformChannels.FindInPageDispatch, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.FindInPageDispatch, handler);
  },
  /** 二期：申报 provider 路查找结果（main 运行时校验后按 epoch 结算 pending）。 */
  reportFindInPageResult: (payload: FindInPageReportPayload): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.FindInPageReport, payload),
  /** 二期：订阅 main 下发的 provider 路高亮清理（stop/end-session/失效链），返回 disposer。 */
  onFindInPageClear: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on(PlatformChannels.FindInPageClear, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.FindInPageClear, handler);
  },
} as const;
