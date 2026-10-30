// U11：工具图片的**受授权附件引用**（specs 见 apps/acode-cli/specs/tool-media-attachment-ref.md
// 与 packages/ui/specs/tool-media-on-demand.md）。
//
// 背景：`toolDisplay.ts` 的 `node_repl_images` display 过去只内联 base64——每张 ≤200 KiB 字符、
// 最多两张，字节随 row 一起进 snapshot/replay，lazy <img> 只延迟解码、不减 row 字节。本模块新增
// 一个 **ref 形态**：display 只携带稳定的 `acode-artifact://` 引用 + mime + bytes + 可选尺寸/校验，
// 字节在图片可见或预览打开时按 `attachmentRead` 的既有分块纪律按需读取。
//
// 安全不变量（本项存在的理由）：
// 1. ref 只能是 `acode-artifact://` scheme。刻意**不接受裸路径**——裸路径会命中 host 的
//    `fileSystemPort.readBinaryFile`（任意路径读取），违反 U11 non-goal「不增加任意路径读取」。
// 2. ref 字符串逐字照 `workflowRunArtifactRead` / 附件的路径纪律拒绝 traversal（`..`）、NUL、
//    反斜杠、以及 authority/path 里的裸冒号（Windows ADS `file:stream`）。
// 3. 授权发生在**读取时**的 gateway（见 v4-gateway 的 tool-media-authorization），依据是当前
//    session 权威 toolCall row 的 display 是否携带该 ref——ref 出现在任意文本里**不**构成授权。
//    模型可控正文无法铸造授权：display 由 runtime 生产、经 gateway 投影，模型无法注入 images[].ref。
//
// 兼容：inline base64 形态原样保留（旧 CLI/agent 仍发它，且 U11 non-goal 明确不提高生产上限）。
// 两种形态互斥（各自 `.strict()`），一个 image 不能同时携带 base64 与 ref。
import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "./core.js";

/** 工具媒体 ref 唯一可授权的 scheme（与 host artifact store 的 URI 形态一致）。 */
export const TOOL_MEDIA_REF_SCHEME = "acode-artifact://";

/**
 * inline base64 形态的单张上限（字符数）。与 CLI producer 的
 * `MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES`（core/result-display.ts）同值——U11 不提高生产上限，
 * 这里只是把散落的字面量提成命名常量（AGENTS.md 常量纪律）。
 */
export const TOOL_MEDIA_MAX_INLINE_BASE64_CHARS = 200 * 1024;

/** ref 字符串上界。与协议里其它 URI/路径字段（如 readToolResultDisplay.filePath）同级。 */
export const TOOL_MEDIA_REF_MAX_CHARS = 4096;

/** 尺寸元数据上界（像素）。仅用于 row 轻量占位，不是解码上限。 */
export const TOOL_MEDIA_MAX_DIMENSION = 16_384;

/** 一个 node_repl display 最多携带的图片数（inline 与 ref 合计）。U11 不提高此上限。 */
export const TOOL_MEDIA_MAX_IMAGES = 2;

/** image MIME 的形态约束（与既有 inline 分支逐字相同）。 */
const TOOL_MEDIA_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/iu;

/** sha256 完整性校验（可选）；hex，64 位。与协议别处（artifactRow.sha256）同形态。 */
const TOOL_MEDIA_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** ref 形态校验的稳定拒绝原因（供 gateway 日志、测试断言与降级文案分类）。 */
export const TOOL_MEDIA_REF_REJECTIONS = {
  notString: "not_string",
  empty: "empty",
  tooLong: "too_long",
  nul: "nul",
  backslash: "backslash",
  wrongScheme: "wrong_scheme",
  traversal: "traversal",
  adsColon: "ads_colon",
  emptyAuthority: "empty_authority",
  emptyPath: "empty_path",
} as const;
export type ToolMediaRefRejection =
  (typeof TOOL_MEDIA_REF_REJECTIONS)[keyof typeof TOOL_MEDIA_REF_REJECTIONS];

/**
 * 工具媒体 ref 的形态检查（纯函数；zod schema 与 gateway 授权共用同一判据，不各写一套）。
 *
 * 返回 `null` = 形态合法；返回拒绝 code = 不可授权。这条检查只判「ref 长得像一个可授权的
 * artifact 引用」，**不**判归属——归属（该 ref 是否属于当前 session 的权威工具产物）在 gateway
 * 读取时按投影证明，见 specs/tool-media-attachment-ref.md R3。
 *
 * 纪律逐字照 `workflowRunArtifactRead`：renderer/文本传来的任何 id **绝不**直接成为路径，形态
 * 不合规的 ref 在进授权链之前就被挡掉。
 *
 * 拒绝顺序是**可证明**的（测试据此断言分类）：先长度/NUL/反斜杠这类「任何位置都非法」的字符，
 * 再 scheme，最后 scheme-specific 的 authority/path 结构。traversal 与 ADS 冒号在 scheme 之后判，
 * 因为它们只对 authority+path 段有意义（`acode-artifact://` 里的冒号是 scheme 分隔符，不算 ADS）。
 */
export function inspectToolMediaRef(ref: unknown): ToolMediaRefRejection | null {
  if (typeof ref !== "string") return TOOL_MEDIA_REF_REJECTIONS.notString;
  if (ref.length === 0) return TOOL_MEDIA_REF_REJECTIONS.empty;
  if (ref.length > TOOL_MEDIA_REF_MAX_CHARS) return TOOL_MEDIA_REF_REJECTIONS.tooLong;
  // NUL / 反斜杠：跨平台路径注入面（Windows 反斜杠、C 字符串截断）。整串检查，先于 scheme——
  // 一个带 NUL 的串不该因为前缀正确就进后续解析。
  if (ref.includes("\0")) return TOOL_MEDIA_REF_REJECTIONS.nul;
  if (ref.includes("\\")) return TOOL_MEDIA_REF_REJECTIONS.backslash;
  if (!ref.startsWith(TOOL_MEDIA_REF_SCHEME)) return TOOL_MEDIA_REF_REJECTIONS.wrongScheme;

  const rest = ref.slice(TOOL_MEDIA_REF_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return TOOL_MEDIA_REF_REJECTIONS.emptyPath;
  const authority = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (authority.length === 0) return TOOL_MEDIA_REF_REJECTIONS.emptyAuthority;
  if (path.length === 0) return TOOL_MEDIA_REF_REJECTIONS.emptyPath;

  // traversal：`..` 段。检查 authority 与 path——两处都可能被拼进最终定位键。
  if (hasTraversalSegment(authority) || hasTraversalSegment(path)) {
    return TOOL_MEDIA_REF_REJECTIONS.traversal;
  }
  // Windows ADS（`name:stream`）：scheme 分隔符已切掉，authority/path 里再出现裸冒号即为 ADS
  // 或第二个 scheme，一律拒绝。percent-encoded `%3a` 不在这里解码——host 侧读 artifact 按整串
  // URI 记账，不解码 path，故编码冒号不构成 ADS 注入面（见 spec R2 论证）。
  if (authority.includes(":") || path.includes(":")) {
    return TOOL_MEDIA_REF_REJECTIONS.adsColon;
  }
  return null;
}

/** `..` 是否作为一个完整 path 段出现（不拒绝 `a..b` 这类合法 id 片段）。 */
function hasTraversalSegment(segment: string): boolean {
  return segment.split("/").some((part) => part === "..");
}

/**
 * 工具媒体 ref 的 zod 校验：形态合法才 parse 通过。用于 display schema 的 `ref` 字段——
 * 一个形态非法的 ref 在**协议校验层**就被拒（整块 display 被 `.catch(undefined)` 剥掉降级为
 * 无图卡），不会带着一个可被 host 误读的串进授权链。
 */
export const toolMediaRefSchema = z.string().superRefine((value, context) => {
  const rejection = inspectToolMediaRef(value);
  if (rejection !== null) {
    context.addIssue({
      code: "custom",
      message: `tool media ref rejected: ${rejection}`,
    });
  }
});

/** inline base64 形态（legacy，与 U11 之前逐字同界）。 */
export const toolMediaInlineImageSchema = z
  .object({
    base64: z.string().min(1).max(TOOL_MEDIA_MAX_INLINE_BASE64_CHARS),
    mimeType: z.string().regex(TOOL_MEDIA_MIME_PATTERN),
  })
  .strict();

/**
 * ref 形态（U11 新增）：只含稳定引用与展示元数据，字节不进 row。
 *
 * `bytes` 必填：renderer 用它做**轻量占位**（宽高比/骨架），也用于分块读取的进度与越界判定，
 * 无需先读字节。`width`/`height` 可选（producer 拿得到就带，拿不到 renderer 按 bytes 占位）。
 * `sha256` 可选完整性校验：读取后 renderer 可核对（当前只做元数据承载，校验接线见 spec R6）。
 */
export const toolMediaRefImageSchema = z
  .object({
    ref: toolMediaRefSchema,
    mimeType: z.string().regex(TOOL_MEDIA_MIME_PATTERN),
    bytes: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    width: z.number().int().positive().max(TOOL_MEDIA_MAX_DIMENSION).optional(),
    height: z.number().int().positive().max(TOOL_MEDIA_MAX_DIMENSION).optional(),
    sha256: z.string().regex(TOOL_MEDIA_SHA256_PATTERN).optional(),
  })
  .strict();

/**
 * 单张工具图片：inline 或 ref，二者互斥。
 *
 * 用 union 而非「一张对象上两个可选字段」：union 让 `.strict()` 分别作用于每个分支，一个既带
 * base64 又带 ref、或带未知字段的对象在两个分支都失败 → 整块被拒。这比运行时 superRefine 判
 * 互斥更硬（未知字段在 `.strict()` 层就被挡，符合本文件顶部「两侧 strict」的既有纪律）。
 */
export const toolMediaImageSchema = z.union([toolMediaInlineImageSchema, toolMediaRefImageSchema]);
export type ToolMediaImage = z.infer<typeof toolMediaImageSchema>;
export type ToolMediaInlineImage = z.infer<typeof toolMediaInlineImageSchema>;
export type ToolMediaRefImage = z.infer<typeof toolMediaRefImageSchema>;

/** 类型守卫：该图片是 ref 形态（需按需读取）还是 inline 形态（字节已在 row）。 */
export function isToolMediaRefImage(image: ToolMediaImage): image is ToolMediaRefImage {
  return "ref" in image;
}
