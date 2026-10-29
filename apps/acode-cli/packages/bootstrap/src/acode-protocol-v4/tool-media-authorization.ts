// U11：工具 row 媒体的**读取授权**（specs/tool-media-attachment-ref.md R3）。
//
// 从 v4-gateway.ts 拆出的纯函数叶子（那个文件已在 max-lines 既有欠账里，不再加码；同
// product-projection-* 的拆分理由）。它回答一个问题：renderer 请求读取某个 `acode-artifact://`
// ref 的字节时，这个 ref 是否被**当前 session 的权威工具产物**授权？
//
// **授权链**（逐字照 attachmentRead / workflowRunArtifactRead 的纪律）：
//
//   调用方给的 ref
//        │
//        ├─① ref 形态合法吗？（inspectToolMediaRef：scheme/traversal/ADS/NUL/反斜杠）  否 ⇒ null
//        ├─② ref 的 authority == encodeURIComponent(本 session) 吗？                  否 ⇒ null
//        └─③ 当前 session 投影里，有一条 toolCall row 的 display(node_repl_images)
//             的 images[].ref **逐字**等于它吗？                                       否 ⇒ null
//             命中 ⇒ 返回**行上的** mimeType/bytes（不是 renderer 自报的那份）
//
// 第 ③ 步是全部要点，也是「模型可控内容不能铸造授权」的落点：
// - row.display 由 runtime 的 result-display.ts 生产、经 gateway 投影，**模型无法注入** images[].ref。
//   对比 assistant-Markdown 那条授权分支——它读的是模型可控的 row.text，所以必须额外靠 ② 的
//   session 绑定兜底；工具媒体这里 ② 与 ③ 双重约束，③ 的权威来源本身就不可被模型污染。
// - renderer 传来的 ref 只用于**在投影里比对**，从不直接成为路径（与 workflowRunArtifactRead
//   「拿行上的 uri 去 store 读」同一条纪律）。命中后返回的 mime 也取**行上的**值，不采信
//   renderer 自报 MIME。
// - 越权（另一个 session/workspace 的 ref）与「ref 根本不在投影里」对调用方是同一个业务事实：
//   一律返回 null，由 gateway 归一成 `previewRefNotAuthorized`，不告诉越权者它猜对了哪一半。
import { TOOL_MEDIA_REF_SCHEME, inspectToolMediaRef } from "@acode/shared/acode-protocol-v4";
import type { AttachmentRef, ConversationRow, ToolMediaRefImage } from "@acode/shared/acode-protocol-v4";

/**
 * ref 是否归属某个 session：形态合法 ∧ authority 段逐字等于 `encodeURIComponent(sessionId)`。
 *
 * 与 v4-gateway.ts 私有的 `artifactRefBelongsToSession` 同判据，但多走一遍 `inspectToolMediaRef`
 * 的形态门——工具媒体的 ref 会进入按需读取链，形态非法的串必须在授权比对前就被挡掉，不能只靠
 * 前缀匹配（一个带 traversal 的串也可能前缀正确）。
 */
export function toolMediaRefBelongsToSession(ref: unknown, sessionId: string): boolean {
  if (inspectToolMediaRef(ref) !== null) return false;
  const value = ref as string;
  const authorityEnd = value.indexOf("/", TOOL_MEDIA_REF_SCHEME.length);
  const authority = value.slice(TOOL_MEDIA_REF_SCHEME.length, authorityEnd);
  return authority === encodeURIComponent(sessionId);
}

/** 授权命中时归一成 AttachmentRef 的展示名（与 assistant-image 分支同姿态）。 */
const TOOL_MEDIA_ATTACHMENT_FILE_NAME = "tool-image";

/**
 * 在 session 投影的行窗口里，找一条 toolCall row，其 `node_repl_images` display 的某张 ref 图片
 * 逐字等于 `ref`。命中返回可直接喂给既有 `readAttachmentPayload` 的 `AttachmentRef`（mime/bytes 取
 * **行上的**值）；未命中（含跨 session、伪造 target、ref 只在文本里出现）返回 null。
 *
 * 纯函数、无 this 依赖：gateway 传入 `snapshot.rows.window` 与 `sessionId` 即可，便于对授权矩阵
 * 单测（tests/tool-media-authorization.test.mjs）。
 */
export function resolveAuthorizedToolMedia(params: {
  rows: readonly ConversationRow[];
  sessionId: string;
  ref: string;
}): AttachmentRef | null {
  // ①②：形态 + session 绑定。跨 session/workspace 的 ref 在这里就被挡，不进投影扫描。
  if (!toolMediaRefBelongsToSession(params.ref, params.sessionId)) return null;

  for (const row of params.rows) {
    if (row.kind !== "toolCall") continue;
    const display = row.display;
    // 只认 node_repl_images 这一族工具媒体 display；其它 kind 没有 images[].ref 语义。
    if (!display || display.kind !== "node_repl_images") continue;
    const images = display.images;
    if (!images || images.length === 0) continue;
    for (const image of images) {
      // inline 形态（有 base64、无 ref）不参与授权读取——它的字节已在 row 里。
      if (!("ref" in image)) continue;
      const refImage = image as ToolMediaRefImage;
      // ③：逐字相等才命中。ref 出现在别处（output.text、markdown）不构成授权。
      if (refImage.ref === params.ref) {
        return {
          ref: params.ref,
          fileName: TOOL_MEDIA_ATTACHMENT_FILE_NAME,
          mime: refImage.mimeType,
          bytes: refImage.bytes,
        };
      }
    }
  }
  return null;
}
