// ============================================================
// read/search 结构化工具卡 display payload（specs/tool-display-read-search.md R1）
// ============================================================
// 唯一权威定义；packages/shared/src/acode-protocol-v4/toolDisplay.ts 持有 wire 镜像
// 成员（两侧 strict、字段表必须同步——缺成员 = agent 下发的 display 整块被剥，
// 先例教训见 toolDisplay.ts 头注）。display 不经 tool result budget，所有字段自带
// 上限；不携带内容正文（content 属于 toolOutput.text 唯一所有）。

import { z } from "zod";

/** display 里单条路径的长度上限（超长路径截断后仍要可序列化、可跨事件稳定）。 */
export const READ_SEARCH_DISPLAY_MAX_PATH_CHARS = 512;
/** filenames 列表条数上限（有界纪律：grep 全仓命中可能上千条）。 */
export const READ_SEARCH_DISPLAY_MAX_FILENAMES = 20;

export const readUrlToolResultDisplaySchema = z
  .object({
    finalUrl: z.string().min(1).max(4096),
    status: z.number().int().min(100).max(599),
    contentType: z.string().max(256),
    cacheHit: z.literal(true).optional(),
  })
  .strict();

export const readToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("read"),
    /** 解析后的真实路径或原始 URL（选择器/skill:// 已剥离后的权威形态）。 */
    filePath: z.string().min(1).max(4096),
    startLine: z.number().int().min(1),
    numLines: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    /** 行窗/预算截断（含 token cap）。 */
    truncated: z.literal(true).optional(),
    /** 输出带 conflict:// 尾注（冲突检出，specs/conflict-uri-resolution.md）。 */
    conflicts: z.literal(true).optional(),
    /** 输出带结构化摘要尾注（骨架化阅读，specs/read-structural-summary.md）。 */
    summarized: z.literal(true).optional(),
    /** URL 直读元数据（specs/read-url-direct.md）；仅 http(s) 目标携带。 */
    url: readUrlToolResultDisplaySchema.optional(),
  })
  .strict();

export const searchToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("search"),
    tool: z.enum(["grep", "glob"]),
    /** grep 专有：输出模式。 */
    mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    numFiles: z.number().int().nonnegative(),
    /** grep 专有：匹配总数。 */
    numMatches: z.number().int().nonnegative().optional(),
    /** grep 专有：输出行数。 */
    numLines: z.number().int().nonnegative().optional(),
    filenames: z
      .array(z.string().min(1).max(READ_SEARCH_DISPLAY_MAX_PATH_CHARS))
      .max(READ_SEARCH_DISPLAY_MAX_FILENAMES),
    /** 原始 filenames 超过上限（display 只带前 N 条）。 */
    filenamesTruncated: z.literal(true).optional(),
    /** 工具自身 head_limit 截断。 */
    truncated: z.literal(true).optional(),
  })
  .strict();

export type ReadUrlToolResultDisplay = z.infer<typeof readUrlToolResultDisplaySchema>;
export type ReadToolResultDisplayPayload = z.infer<typeof readToolResultDisplayPayloadSchema>;
export type SearchToolResultDisplayPayload = z.infer<typeof searchToolResultDisplayPayloadSchema>;
