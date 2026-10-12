/**
 * 导出文件名生成（纯函数，单一来源）。
 *
 * `sanitizeExportTitle` 只做「本地文件名安全」清洗；路径穿越防护仍由 Desktop main
 * 的 `basename(...).slice(0, 120)`（desktopSaveFile.ts:190）负责，但主进程只取 basename、
 * 不清 `:` `*` 等 Windows 非法字符，所以这里必须自己清。
 */

/** Windows 非法字符（NUL 单独用字符串替换处理：放进字符类会触发 no-control-regex）。 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/gu;
const NUL_CHAR = "\u0000";
/** 截断上限（按 Unicode code point 计，避免切出半个代理对）。 */
export const EXPORT_TITLE_MAX_CODE_POINTS = 60;

export function sanitizeExportTitle(rawTitle: string): string {
  const trimmed = rawTitle.trim();
  if (!trimmed) return "session";
  const replaced = trimmed
    .split(NUL_CHAR)
    .join("-")
    .replace(ILLEGAL_FILENAME_CHARS, "-")
    .replace(/\s+/gu, "-");
  // 用 Array.from 按 code point 遍历：直接 slice(0, 60) 会在代理对（emoji）中间切断。
  const truncated = Array.from(replaced).slice(0, EXPORT_TITLE_MAX_CODE_POINTS).join("");
  const cleaned = truncated.replace(/^[-.]+|[-.]+$/gu, "");
  return cleaned || "session";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** yyyyMMdd-HHmmss（本地时间）。 */
export function formatExportTimestampForFilename(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

export function buildConversationExportFilename(options: {
  title: string;
  extension: "md" | "html";
  now: Date;
}): string {
  const base = sanitizeExportTitle(options.title);
  const stamp = formatExportTimestampForFilename(options.now);
  return `${base}-${stamp}.${options.extension}`;
}
