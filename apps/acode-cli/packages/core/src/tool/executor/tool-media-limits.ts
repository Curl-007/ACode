// U11：node-repl 工具图片的**生产上限**与**默认关闭的生产门**
// （spec: apps/acode-cli/specs/tool-media-attachment-ref.md §6 R7/R10）。
//
// 为什么单独一个叶子：`result-display.ts` 与 `node-repl.ts` 都已贴住 max-lines(400)，
// 上限常量、mime→扩展名与生产门三者是 handler（异步写入面）与 display 构造器（同步投影面）
// 的**共同**依赖，放进任何一侧都会让另一侧反向依赖具体实现。抽成无依赖的叶子后两侧都只依赖它。
import {
  TOOL_MEDIA_MAX_IMAGES,
  TOOL_MEDIA_MAX_INLINE_BASE64_CHARS,
} from "@acode/shared/acode-protocol-v4";

/**
 * inline base64 形态的单张上限（字符数）。
 *
 * 直接**复用 shared 的常量**而不是在 core 再写一个字面量：这两处过去各写一份 `200 * 1024`，
 * 靠注释互相提醒同值（shared/tool-media-ref.ts 的 `TOOL_MEDIA_MAX_INLINE_BASE64_CHARS` 注释
 * 就点名了本文件）。U11 起以 shared 为单一真源，core 侧只做别名，杜绝漂移。
 * U11 non-goal 明确**不提高**生产上限。
 */
export const MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES = TOOL_MEDIA_MAX_INLINE_BASE64_CHARS;

/** 一个 `node_repl_images` display 最多承载的图片数（inline 与 ref 合计）。同样不提高。 */
export const MAX_NODE_REPL_DISPLAY_IMAGES = TOOL_MEDIA_MAX_IMAGES;

/**
 * 生产门：**默认关闭**（spec R10.1/R10.2）。
 *
 * 为什么不是「恒开 + gateway 按 clientMode 降级」：行投影 `toProtocolToolCallDisplay` 是同步纯
 * 白名单、发布器的 snapshot/delta 编码也同步，ref→inline 需要把外置字节**读回来**（异步 IO），
 * 投影里做不了（spec §6.4 论证 2）。而加 clientHello 能力位是**不安全方向**——那个 capabilities
 * 对象 `.strict()`，老 Host 见到不认识的键会整条握手失败（`transport.ts:92` 的既有警告）。
 * 故本项把 producer 落在默认关闭的门后，交由 lead 决策何时开启。
 */
export interface ToolMediaRefGateInput {
  /** 注册期灰度门（`RegisterBuiltInToolsOptions.nodeReplMediaRefs`）；缺席 = 关闭。 */
  enabled?: boolean;
  /** 连接的 clientMode；缺席（TUI/headless）= 没有 renderer，不产 ref。 */
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  /** artifact store 是否在场；缺席则无落点，产 ref 等于发布悬空引用。 */
  hasArtifactStore: boolean;
  /** store 是否具备本次需要的写入方法（端口上 `writeToolResultArtifact` 恒在，此处保留判据入口）。 */
  canWrite?: boolean;
}

/**
 * 三个条件**全部**成立才产 ref（纯函数，可单测）：
 *
 * 1. 灰度门显式打开（只有 `=== true`，与 `includeBrowserUse` / `includeOffPeak` 同族极性）；
 * 2. `clientMode === "desktop-continuous"`——桌面 host 与 renderer 同包同版本，无 intra-app 偏斜；
 *    `web-remote-replayable` 是唯一真实偏斜面（web bundle 与桌面 Host 可不同版），一律 inline；
 * 3. artifact store 在场且可写——没有落点就不产 ref（spec R9.3 悬空 ref 不变量的前置）。
 */
export function shouldEmitToolMediaRefs(input: ToolMediaRefGateInput): boolean {
  if (input.enabled !== true) return false;
  if (input.clientMode !== "desktop-continuous") return false;
  if (!input.hasArtifactStore) return false;
  return input.canWrite !== false;
}

/**
 * image MIME → artifact 扩展名。
 *
 * 写入 data URL 文本 artifact 时**不传** extension（store 按 `contentType: "text/plain"` 落
 * `.txt`，读回才是 utf8 文本 → `decodePromptAttachmentDataUrl` 能解析；spec R8.1）。本函数因此
 * 只服务于**裸二进制**写入面（模型面的 `browserScreenshotPaths`），两条链的落盘形态不同。
 */
export function extensionForImageMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  return ".png";
}
