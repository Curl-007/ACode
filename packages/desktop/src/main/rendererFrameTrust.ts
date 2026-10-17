// 受信 renderer 帧校验（specs/main-stall-diagnostics.md R12）：内容面包屑与
// print() 假死守卫两条 send-only 通道共用的 sender 判定。
//
// 判定面与 desktopWebContentsGuard 对「应用自身页面」的既有定义一致：dev 态主窗
// 跑在 vite origin（http://localhost:*），打包态是 loadFile 的 file: 页面。嵌入
// 浏览器 guest（远程 https origin）与一切子帧的 IPC 上报一律拒绝——guest 页面
// 不含 ACode preload、本不该出现在这两条通道上，出现即为异常面。
// 纯函数，无 IO，不 import electron（senderFrame 以结构面传入）。

/** WebFrameMain 的最小结构面：主帧 parent === null；url 为帧当前文档地址。 */
export interface SenderFrameLike {
  url?: unknown;
  parent?: unknown;
}

/** dev 态 vite origin 的本机 hostname 闭集（URL.hostname 对 IPv6 保留方括号）。 */
const DEV_LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

/**
 * sender 帧是否属于「应用自身 renderer 主帧」：
 * - 帧缺失 / 非主帧（parent !== null，含 parent 字段缺失的伪对象）⇒ false；
 * - URL 缺失或不可解析 ⇒ false；
 * - file:（打包态 loadFile）⇒ true；
 * - http(s) 且 hostname 在本机闭集（dev vite）⇒ true；
 * - 其余（远程 origin、自定义协议）⇒ false。
 */
export function isTrustedRendererSenderFrame(frame: SenderFrameLike | null | undefined): boolean {
  if (!frame || typeof frame !== "object") return false;
  if (frame.parent !== null) return false;
  if (typeof frame.url !== "string" || !frame.url) return false;
  let parsed: URL;
  try {
    parsed = new URL(frame.url);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") return true;
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return DEV_LOCAL_HOSTNAMES.has(parsed.hostname);
  }
  return false;
}
