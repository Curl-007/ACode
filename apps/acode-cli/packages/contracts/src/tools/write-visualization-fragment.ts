// ============================================================
// WriteVisualizationFragment Tool - 对话内可视化片段的写入契约
// ============================================================
// 三段式契约（apps/acode-cli/specs/gen-ui-visualize.md）的写入半边：
//   ① 本工具把 HTML fragment 写进会话产物存储（不进 Write 工具权限链，不碰工作区）；
//   ② 最终文本以 `::visualize{"name":...}` 行内引用（投影层翻成既有 artifactRow）；
//   ③ v4 `conversationVisualizationRead` 分块读字节（授权按会话 + 注册名）。
//
// 上限与 name 规则是**线上 schema 的同源常量**（packages/shared/src/acode-protocol-v4/
// visualization-read.ts 的 VISUALIZATION_LIMITS 镜像写入侧）；两边必须一起改。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const WRITE_VISUALIZATION_FRAGMENT_TOOL_NAME = "WriteVisualizationFragment";

/**
 * 对话内可视化技能名（apps/acode-cli/packages/bundled-skills/skills/visualize/SKILL.md）。
 * 工具的技能门（428 族，同 DYNAMIC_WORKFLOW_SKILL_NAME 先例）以它为判据：会话里没有加载过
 * 这份技能时，本工具拒绝写入——技能里才有 fragment 契约（fragment-only、CSP 白名单、
 * 引用时机），没读过的模型写出来的片段几乎必然违反渲染端约束。
 */
export const VISUALIZE_SKILL_NAME = "visualize";

/** 单个片段的写入上限（spec：≤ 1 MiB，UTF-8 字节口径）。 */
export const VISUALIZATION_FRAGMENT_MAX_BYTES = 1_048_576;

/** name 的长度上限（与 shared VISUALIZATION_LIMITS.maxNameLength 同源）。 */
export const VISUALIZATION_FRAGMENT_MAX_NAME_LENGTH = 80;

/** 正文里每轮至多解析的引用条数（投影层同一常量的写入侧声明）。 */
export const MAX_VISUALIZE_REFERENCES_PER_TURN = 8;

/**
 * name 规则：ASCII 小写-连字符段 + 可选点段（`^[a-z0-9-]+(\.[a-z0-9-]+)*$`），
 * 且必须以 `.html` 结尾（读取契约按它固定 mimeType=text/html）。
 */
export const visualizationFragmentNameSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+(\.[a-z0-9-]+)*$/u,
    "visualization name must be lowercase-hyphen dot segments (e.g. queue-backpressure.html)",
  )
  .max(VISUALIZATION_FRAGMENT_MAX_NAME_LENGTH)
  .refine((value) => value.endsWith(".html"), {
    message: "visualization name must end with .html",
  });

export const WriteVisualizationFragmentInputSchema = z
  .object({
    name: visualizationFragmentNameSchema.describe(
      "Fragment file name: lowercase-hyphen ASCII with `.html` suffix, e.g. `queue-backpressure.html`. Rewriting the same name updates that visualization in place.",
    ),
    content: z.string().min(1).describe(
      "The HTML fragment (no <!doctype>/<html>/<head>/<body> — the host wraps it). Inline all data; no network calls.",
    ),
    title: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("Short human-facing card title. Defaults to the fragment name."),
  })
  .strict();

export type WriteVisualizationFragmentInput = z.infer<typeof WriteVisualizationFragmentInputSchema>;

export const WriteVisualizationFragmentInputJsonSchema = toToolJsonSchema(
  WriteVisualizationFragmentInputSchema,
);

export interface WriteVisualizationFragmentOutput {
  name: string;
  bytes: number;
}

export const WriteVisualizationFragmentOutputSchema = z
  .object({
    name: z.string(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const WriteVisualizationFragmentOutputJsonSchema = toToolJsonSchema(
  WriteVisualizationFragmentOutputSchema,
);

/** 422 语义业务失败的稳定前缀（模型是唯一读者；判别键在 message 前缀）。 */
export const VISUALIZATION_FRAGMENT_ERROR_PREFIX = "visualization_fragment_invalid";

/** 「内容不是 fragment」的拒绝文案常量（与 schema describe 同一句话，避免两处漂移）。 */
export const VISUALIZATION_FRAGMENT_ONLY_MESSAGE =
  "visualization_fragment_invalid: content looks like a full HTML document. Write a fragment only — no <!doctype>, <html>, <head> or <body> tags; the host wraps the fragment for you.";

/** 「超过 1 MiB」的拒绝文案常量。 */
export const VISUALIZATION_FRAGMENT_TOO_LARGE_MESSAGE = `visualization_fragment_invalid: fragment exceeds ${VISUALIZATION_FRAGMENT_MAX_BYTES} bytes. Aggregate, bin, or downsample the data and rewrite.`;
