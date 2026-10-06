/**
 * Main 进程窗口 ID 品牌类型（2026-10-05 深度审查 P1 落地）。
 *
 * Electron 有两套彼此独立的整数 ID 空间，历史上 main 内 5+ 个注册表混用两者、
 * 靠人工对齐（同一函数内 broadcastHub 用 webContents.id、taskRealtimeBus 用
 * win.id；同名参数 windowId 在不同模块分属不同空间）。品牌类型把「这是哪套
 * ID」变成编译器可见的事实：混用直接类型错误，裸 number 只允许出现在取值点。
 *
 * 各注册表的 ID 空间（2026-10-05 实测登记）：
 *
 * | 注册表 / 链路 | ID 空间 |
 * | --- | --- |
 * | windowHostProcessMap、broadcastHub、cuaPipFocusRouter（含 syncActiveTaskSession 链） | WebContentsId |
 * | windowWorkspaceMap、windowTaskRealtimeHostIdMap（含 syncTaskRealtimeWorkspaceKeys 链）、windowUnreadCountMap、taskRealtimeBus.registerHost 的 windowId | WindowId |
 *
 * 规则：取值点显式品牌化——`asWindowId(win.id)` / `asWebContentsId(win.webContents.id)`；
 * IPC/路由描述符等边界数据在构造点或校验点品牌化并注明依据。
 */
declare const windowIdBrand: unique symbol;
declare const webContentsIdBrand: unique symbol;

/** BrowserWindow.id 空间。 */
export type WindowId = number & { readonly [windowIdBrand]: true };
/** WebContents.id 空间。 */
export type WebContentsId = number & { readonly [webContentsIdBrand]: true };

export function asWindowId(id: number): WindowId {
  return id as WindowId;
}

export function asWebContentsId(id: number): WebContentsId {
  return id as WebContentsId;
}
