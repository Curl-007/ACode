// ============================================================
// read/search 结构化 display 装配（specs/tool-display-read-search.md R2）
// ============================================================
// 从 result-display.ts 拆出的新文件（该文件已超 legacy ratchet 基线，只准瘦身）。
// 构造前用 contracts 输出 schema 校验（Grep/Glob）或结构化判定（Read），构造后再过
// 一遍 payload schema——解析失败返回 undefined（fail-safe：UI 走 fallback，不报错）。

import {
  GlobOutputSchema,
  GrepOutputSchema,
  READ_SEARCH_DISPLAY_MAX_FILENAMES,
  READ_SEARCH_DISPLAY_MAX_PATH_CHARS,
  readToolResultDisplayPayloadSchema,
  searchToolResultDisplayPayloadSchema,
  type ToolResultDisplayPayload,
} from "@acode/contracts";
import { readUrlDisplayMeta } from "../handlers/read-url.js";
import { isRecord } from "./utils.js";

const MAX_DISPLAY_FILE_PATH_CHARS = 4096;
const MAX_DISPLAY_CONTENT_TYPE_CHARS = 256;

/** Read 的 type:"text" 输出 → kind:"read" display；其余输出形态不产生（spec R1）。 */
export function createReadResultDisplay(output: unknown): ToolResultDisplayPayload | undefined {
  if (!isRecord(output) || output.type !== "text") return undefined;
  const filePath = output.filePath;
  if (typeof filePath !== "string" || filePath.trim().length === 0) return undefined;

  const startLine = toDisplayCount(output.startLine, 1);
  const numLines = toDisplayCount(output.numLines, 0);
  const totalLines = toDisplayCount(output.totalLines, 0);
  // 截断事实两个来源：显式 truncated（行窗/预算）与 token cap（模型可见内容被截）。
  const truncated = output.truncated === true || output.truncatedByTokenCap === true;
  const conflicts =
    typeof output.conflictFooter === "string" && output.conflictFooter.trim().length > 0;
  // summarized 只认 preNumbered（结构化摘要恒置位）；summaryFooter 单独出现有歧义
  // （URL 直读的元数据尾注也用它），不作为判据。
  const summarized = output.preNumbered === true;

  const urlMeta = readUrlDisplayMeta(output as never);
  const parsed = readToolResultDisplayPayloadSchema.safeParse({
    kind: "read",
    filePath: filePath.slice(0, MAX_DISPLAY_FILE_PATH_CHARS),
    startLine,
    numLines,
    totalLines,
    ...(truncated ? { truncated: true } : {}),
    ...(conflicts ? { conflicts: true } : {}),
    ...(summarized ? { summarized: true } : {}),
    ...(urlMeta
      ? {
          url: {
            finalUrl: urlMeta.finalUrl.slice(0, MAX_DISPLAY_FILE_PATH_CHARS),
            status: urlMeta.status,
            contentType: urlMeta.contentType.slice(0, MAX_DISPLAY_CONTENT_TYPE_CHARS),
            ...(urlMeta.cacheHit ? { cacheHit: true } : {}),
          },
        }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/** Grep/Glob 输出 → kind:"search" display（filenames 有界投影，spec R1）。 */
export function createSearchResultDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  const tool = toolName === "Glob" ? "glob" : "grep";
  const parsedOutput =
    tool === "glob" ? GlobOutputSchema.safeParse(output) : GrepOutputSchema.safeParse(output);
  if (!parsedOutput.success) return undefined;
  const data = parsedOutput.data;

  const cleaned = data.filenames
    .filter((name) => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.slice(0, READ_SEARCH_DISPLAY_MAX_PATH_CHARS));
  const filenames = cleaned.slice(0, READ_SEARCH_DISPLAY_MAX_FILENAMES);
  const filenamesTruncated = cleaned.length > filenames.length;

  const parsed = searchToolResultDisplayPayloadSchema.safeParse({
    kind: "search",
    tool,
    ...("mode" in data && data.mode ? { mode: data.mode } : {}),
    numFiles: data.numFiles,
    ...("numMatches" in data && data.numMatches !== undefined
      ? { numMatches: data.numMatches }
      : {}),
    ...("numLines" in data && data.numLines !== undefined ? { numLines: data.numLines } : {}),
    filenames,
    ...(filenamesTruncated ? { filenamesTruncated: true } : {}),
    ...(data.truncated === true ? { truncated: true } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

function toDisplayCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}
