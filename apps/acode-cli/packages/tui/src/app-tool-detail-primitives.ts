import { truncateDisplay } from "./app-terminal-width.js";
import { stringField } from "./state.js";

/**
 * 工具行详情的共享原语（从 app-tool-transcript.ts 拆出，max-lines ratchet）：
 * 行宽/行数纪律、敏感键遮蔽、大文本折叠与字段行拼装。transcript 主文件与
 * 舰队一行态（app-tool-fleet-details.ts）共用同一份，绝不各写一套。
 */

export const MAX_DETAIL_LINES = 4;
export const MAX_DETAIL_WIDTH = 100;
export const SENSITIVE_KEY_PATTERN =
  /token|secret|password|api[_-]?key|authorization|credential|cookie/i;
export const LARGE_TEXT_KEYS = new Set(["content", "old_string", "new_string"]);

export function fieldLine(record: Record<string, unknown>, key: string): string | undefined {
  if (!(key in record)) return undefined;
  return `${key}: ${previewValue(key, record[key])}`;
}

export function previewLine(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value ? `${key}: ${previewText(value)}` : undefined;
}

export function combinedLine(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): string | undefined {
  const fields = keys.flatMap((key) => {
    if (!(key in record)) return [];
    return `${key}=${previewValue(key, record[key])}`;
  });
  return fields.length > 0 ? `${label}: ${fields.join(", ")}` : undefined;
}

export function compactLines(lines: Array<string | undefined>): string[] {
  return lines
    .filter((line): line is string => Boolean(line))
    .map((line) => truncateDisplay(line, MAX_DETAIL_WIDTH))
    .slice(0, MAX_DETAIL_LINES);
}

export function previewValue(key: string, value: unknown): string {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (LARGE_TEXT_KEYS.has(key)) return `[${value.length} chars]`;
    return previewText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === "object") return `{${Object.keys(value).length} keys}`;
  return String(value);
}

export function previewText(value: string): string {
  return truncateDisplay(value.replace(/\s+/g, " ").trim(), MAX_DETAIL_WIDTH);
}

export function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  return arrayField(record, key).filter((item): item is string => typeof item === "string");
}
