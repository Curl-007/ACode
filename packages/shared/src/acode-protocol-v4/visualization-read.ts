// ============================================================
// 对话内可视化（gen-ui / ::visualize）的读取契约
// ============================================================
// 三段式契约（完整设计见 apps/acode-cli/specs/gen-ui-visualize.md）：
// 写入走专用工具（<storageRoot>/cli/artifacts/<sessionId>/visualize/<name>.html），
// 引用是最终文本里的 `::visualize{"name":...}` 指令，投影层把它翻成既有 artifactRow
// （artifactType "html"）。本模块只放读取的分块 query——形状逐字照 workflowRunArtifactRead
// （那边对「为什么 ≤512KiB 一块、为什么 superRefine」的论证这里全部沿用）：
//   ① 权威在会话存储，renderer 传的任何字符串不直接成为路径；
//   ② sessionId 必须是发起方会话、name 必须在该会话注册过（写入工具是唯一注册者）；
//   ③ 授权链在 CLI 侧闭合，新方法对旧桌面天然偏斜安全（不会调用）。
//
// 与 workflowRunArtifactRead 的差别只有一处：产物 runId/artifactId/version 三元组换成
// 会话级 name 单键——可视化片段没有版本历史，同名再写即更新（引用读新内容）。

import { z } from "zod";

import { PROTOCOL_V4_LIMITS } from "./core.js";

/** 可视化片段的上限（写入侧同名常量的线上镜像；见 spec 的 1 MiB 决策）。 */
export const VISUALIZATION_LIMITS = {
  /** 单个片段的总字节上界。 */
  maxBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
  /** name：ASCII 小写-连字符段 + 可选点段，≤ 80 字符。 */
  maxNameLength: 80,
} as const;

/** name 的线上形状：与写入工具的清洗规则同源（`^[a-z0-9-]+(\.[a-z0-9-]+)?$`）。 */
export const visualizationNameSchema = z
  .string()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/, "visualization name must be lowercase-hyphen segments");

// ── v4 query：conversationVisualizationRead ──
// 只读、无状态、超时重发安全，刻意不是 v4 command（与 workflowRunArtifacts 同族）。
export const v4ConversationVisualizationReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    name: visualizationNameSchema.max(VISUALIZATION_LIMITS.maxNameLength),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict();
export type V4ConversationVisualizationReadParams = z.infer<
  typeof v4ConversationVisualizationReadParamsSchema
>;

export const v4ConversationVisualizationReadResultSchema = z
  .object({
    /** base64（不带 data: 前缀）；解码后 ≤ attachmentChunkMaxBytes。 */
    dataBase64: z.string(),
    /** 恒为 `text/html`（写入侧强制 .html；显式携带让 UI 不必猜）。 */
    mediaType: z.literal("text/html"),
    /** 片段总字节数（≤ VISUALIZATION_LIMITS.maxBytes）。 */
    totalBytes: z.number().int().nonnegative().max(VISUALIZATION_LIMITS.maxBytes),
    /** 下一块的 offset；本块读到尾时为 null。 */
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "visualization read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4ConversationVisualizationReadResult = z.infer<
  typeof v4ConversationVisualizationReadResultSchema
>;

/**
 * base64 字符串的解码字节数，非法输入回 null。
 *
 * 与 workflow-artifacts.ts 里同名私有 helper 逐字相同（那边注释已论证为什么不共享导出）。
 */
function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
