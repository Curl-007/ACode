import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isObjectRecord, type JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";

/** R2 对抗硬门槛常量（spec「常量」表）。 */
export const IMPORT_LINE_MAX_BYTES = 4 * 1024 * 1024;
export const IMPORT_JSON_MAX_DEPTH = 64;
export const IMPORT_FIELD_MAX_CHARS = 1024 * 1024;
/** R4：发现阶段缺省上限，与既有 UI 的 500 上限同源。 */
export const IMPORT_DISCOVER_DEFAULT_LIMIT = 500;
/**
 * 单文件 JSON（Gemini chats / opencode session 等）的读取上限。
 * spec 只钉死了 JSONL 行级 4 MiB；单文件上限是行级防护在整文件形态上的同构补齐，
 * 防止一个超大 chat 文件把导入流程整体拖入内存压力。
 */
export const IMPORT_JSON_FILE_MAX_BYTES = 64 * 1024 * 1024;

export interface ExternalLineGuardStats {
  skippedLinesOverSize: number;
  skippedLinesMalformed: number;
  skippedLinesTooDeep: number;
  skippedLinesNonObject: number;
  truncatedFields: number;
}

class JsonDepthOverflowMarker extends Error {}

function clampJsonString(value: string, stats: ExternalLineGuardStats): string {
  if (value.length <= IMPORT_FIELD_MAX_CHARS) {
    return value;
  }
  stats.truncatedFields += 1;
  // 截断而不是丢弃整行：1 MiB 的文本投影已远超对话消息的实际形态，
  // 保留前缀既能继续导入可见内容，又防止深嵌套/超长字段炸弹撑爆下游。
  return value.slice(0, IMPORT_FIELD_MAX_CHARS);
}

/**
 * 就地钳制已解析 JSON 树：深度超过 64 抛标记，超长字符串截断。
 * 使用显式栈而不是递归，深嵌套输入不会打爆解析进程自身的调用栈。
 */
function clampJsonTreeInPlace(root: unknown, stats: ExternalLineGuardStats): void {
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const item = stack.pop() as { node: unknown; depth: number };
    if (item.depth > IMPORT_JSON_MAX_DEPTH) {
      throw new JsonDepthOverflowMarker();
    }
    const node = item.node;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const child = node[index];
        if (typeof child === "string") {
          node[index] = clampJsonString(child, stats);
        } else if (child !== null && typeof child === "object") {
          stack.push({ node: child, depth: item.depth + 1 });
        }
      }
      continue;
    }
    if (isObjectRecord(node)) {
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (typeof child === "string") {
          node[key] = clampJsonString(child, stats);
        } else if (child !== null && typeof child === "object") {
          stack.push({ node: child, depth: item.depth + 1 });
        }
      }
    }
  }
}

export type ExternalGuardedJsonFailure = "malformed" | "too_deep";

/** 带防护的 JSON 解析：损坏 → malformed；深嵌套 → too_deep；超长字段就地截断。 */
export function parseGuardedJsonText(
  text: string,
  stats: ExternalLineGuardStats,
): { ok: true; value: unknown } | { ok: false; reason: ExternalGuardedJsonFailure } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // V8 对极端深嵌套可能在 parse 阶段就抛 RangeError；这里统一归入 malformed，
    // 行级跳过语义不变（损坏 JSONL 中途截断 → 部分导入）。
    return { ok: false, reason: "malformed" };
  }
  try {
    clampJsonTreeInPlace(value, stats);
  } catch (error) {
    if (error instanceof JsonDepthOverflowMarker) {
      return { ok: false, reason: "too_deep" };
    }
    throw error;
  }
  return { ok: true, value };
}

export interface GuardedJsonLinesResult {
  records: JsonLineRecord[];
  stats: ExternalLineGuardStats;
}

async function readJsonLinesStream(
  filePath: string,
  maxRecords: number | undefined,
): Promise<GuardedJsonLinesResult> {
  const records: JsonLineRecord[] = [];
  const stats: ExternalLineGuardStats = {
    skippedLinesOverSize: 0,
    skippedLinesMalformed: 0,
    skippedLinesTooDeep: 0,
    skippedLinesNonObject: 0,
    truncatedFields: 0,
  };
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line.trim().length === 0) {
        continue;
      }
      if (Buffer.byteLength(line, "utf8") > IMPORT_LINE_MAX_BYTES) {
        stats.skippedLinesOverSize += 1;
        continue;
      }
      const parsed = parseGuardedJsonText(line, stats);
      if (!parsed.ok) {
        if (parsed.reason === "malformed") {
          stats.skippedLinesMalformed += 1;
        } else {
          stats.skippedLinesTooDeep += 1;
        }
        continue;
      }
      if (!isObjectRecord(parsed.value)) {
        stats.skippedLinesNonObject += 1;
        continue;
      }
      records.push(parsed.value);
      if (maxRecords !== undefined && records.length >= maxRecords) {
        break;
      }
    }
    return { records, stats };
  } finally {
    reader.close();
    stream.destroy();
  }
}

/** 全量读取并解析 JSONL（带 R2 行级防护：4 MiB/深嵌套/超长字段/损坏行跳过）。 */
export function readGuardedJsonLinesFile(filePath: string): Promise<GuardedJsonLinesResult> {
  return readJsonLinesStream(filePath, undefined);
}

/** 只读前 maxRecords 条（发现阶段的轻量头部扫描）。 */
export function readGuardedJsonLinesFileHead(
  filePath: string,
  maxRecords: number,
): Promise<GuardedJsonLinesResult> {
  return readJsonLinesStream(filePath, Math.max(0, maxRecords));
}

export type ExternalGuardedFileFailure = "malformed" | "too_deep" | "file_too_large" | "missing";

/** 整文件 JSON 读取（Gemini chats / opencode session 等）的带防护版本。 */
export async function readGuardedJsonFile(
  filePath: string,
): Promise<
  { ok: true; value: unknown; stats: ExternalLineGuardStats } | { ok: false; reason: ExternalGuardedFileFailure }
> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > IMPORT_JSON_FILE_MAX_BYTES) {
    return { ok: false, reason: "file_too_large" };
  }
  const stats: ExternalLineGuardStats = {
    skippedLinesOverSize: 0,
    skippedLinesMalformed: 0,
    skippedLinesTooDeep: 0,
    skippedLinesNonObject: 0,
    truncatedFields: 0,
  };
  const parsed = parseGuardedJsonText(raw, stats);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  return { ok: true, value: parsed.value, stats };
}

/**
 * 时间戳归一化：秒/毫秒 epoch 或 ISO 字符串 → 毫秒。
 * 语义与 claude-native 解析器一致（秒级 *1000、其余原样），保证跨来源排序可比。
 */
export function readExternalTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return Math.trunc(value);
    }
    if (value > 1_000_000_000) {
      return Math.trunc(value * 1000);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const numericValue = Number(normalized);
  if (Number.isFinite(numericValue)) {
    return readExternalTimestampMs(numericValue);
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}
