/**
 * OpenSplitButton「外部打开」的目标路由（纯函数，便于回归守护）。
 *
 * 背景（specs/electron-hardening.md §4）：本地文件不能用 platform.openExternal(裸路径)——
 * main 的 OpenExternal 白名单只放行 http/https/file:，而裸 Windows 路径经 WHATWG `new URL()`
 * 会被解析成 `c:` 协议（不是 file:），因此被拒，「外部打开」本地文件成了静默死链路。
 * 本地文件必须走 platform.openExternalFile（main 侧 openPathInDefaultApp 硬化链路）。
 *
 * 这里把「给定 target 与能力位，选哪个 platform 方法、传什么参数」收敛成可测的纯判定，
 * 组件只负责按结果调用，避免路由逻辑散落在 JSX 事件回调里。
 */

/** OpenSplitButtonTarget 的结构子集（结构化兼容，避免与组件文件形成类型环）。 */
export type OpenExternalTarget =
  | { type: "website"; url: string; localPath?: string }
  | { type: "file"; path: string };

export type OpenExternalAction =
  /** 本地文件：走 openExternalFile（main openPathInDefaultApp）。 */
  | { kind: "openExternalFile"; path: string }
  /** 网站且无本地副本：走 openExternal 打开 http/https URL。 */
  | { kind: "openExternalUrl"; url: string }
  /** 本地文件但宿主无 openExternalFile 能力：显式失败，绝不退回 openExternal 死链路。 */
  | { kind: "unsupportedLocalFile"; path: string };

export function resolveOpenExternalAction(
  target: OpenExternalTarget,
  hasOpenExternalFile: boolean,
): OpenExternalAction {
  // file 目标的 path、website 目标的本地缓存副本 localPath 都是「本地文件」。
  const localFilePath = target.type === "file" ? target.path : target.localPath;
  if (localFilePath) {
    return hasOpenExternalFile
      ? { kind: "openExternalFile", path: localFilePath }
      : { kind: "unsupportedLocalFile", path: localFilePath };
  }
  if (target.type === "website") {
    return { kind: "openExternalUrl", url: target.url };
  }
  // file 目标 path 为空属畸形输入：归入 unsupported，交给调用方显式报错，
  // 而不是把空串塞进 openExternal 触发一次注定被拒的死链路调用。
  return { kind: "unsupportedLocalFile", path: target.path };
}
