// Mechanism ported from oh-my-pi (MIT) packages/mnemopi — core/beam/recall.ts
// （superseded_by / valid_until 可见性过滤，recall.ts:459）与 core/beam/store.ts
// （重复合并的 UPDATE 语义，store.ts:449-495），Copyright (c) 2025 Mario Zechner &
// Stencil Labs。SQLite 行语义移植为 markdown frontmatter 字段语义，
// 规则与偏差逐条记录在 specs/memory-semantic-recall.md R12/R13。

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { MemoryVeracity } from "./veracity.js";
import { mergeVeracity, parseMemoryVeracity } from "./veracity.js";

/** frontmatter `importance` 的缺省值（omp remember() 缺省同值；R13）。 */
export const MEMORY_IMPORTANCE_DEFAULT = 0.5;

/**
 * 记忆生命周期 frontmatter 字段（全部可选；kebab-case 键，顶层或 `metadata:` 嵌套均认，
 * 与 `type` 字段的读取约定一致）：
 * - `veracity`：可信度四档（R11）；
 * - `importance`：0..1 重要度（本波只参与 R13 合并取高，不参与检索打分）；
 * - `superseded-by`：被取代标记（R12）；
 * - `valid-until`：有效期 ISO-8601（R12）。
 */
export interface MemoryLifecycleFields {
  hasVeracityField: boolean;
  veracity: MemoryVeracity;
  importance?: number;
  supersededBy?: string;
  validUntil?: string;
}

/** 行判定与 parseMemoryFrontmatter（recall/manifest.ts）同构。 */
export interface MemoryFrontmatterBlock {
  record: Record<string, unknown>;
  /** frontmatter 结束行之后的正文（保留原始换行形态，供无损重组）。 */
  body: string;
}

/**
 * 从完整文件内容解析 frontmatter 块（含原始 YAML record，供合并改写）；无合法
 * frontmatter 时返回 undefined。与 manifest.ts 的投影式解析互补：投影面给检索，
 * 这里给写侧合并——检索不读原始 record，写侧不改投影口径。
 */
export function parseMemoryFrontmatterBlock(content: string): MemoryFrontmatterBlock | undefined {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") return undefined;

  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join("\n"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  return { body: lines.slice(end + 1).join("\n"), record: parsed };
}

/**
 * frontmatter 块序列化：record 走 yaml stringify（键序 = 既有插入序 + 追加的新键），
 * body 原样接回。写侧合并改写只经此函数，保证文件结构（--- 围栏 + 正文）不漂移。
 */
export function serializeMemoryFrontmatterBlock(
  record: Record<string, unknown>,
  body: string,
): string {
  return `---\n${stringifyYaml(record).trimEnd()}\n---\n${body}`;
}

/**
 * 读取生命周期字段（R11/R12/R13）。字段缺失与无法解析都收敛到安全缺省：
 * veracity → unknown、importance/supersededBy/validUntil → undefined。
 */
export function readMemoryLifecycleFields(record: Record<string, unknown>): MemoryLifecycleFields {
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  const hasVeracityField =
    typeof record.veracity === "string" || (metadata !== undefined && typeof metadata.veracity === "string");
  const importance =
    parseMemoryImportance(record.importance) ??
    (metadata ? parseMemoryImportance(metadata.importance) : undefined);
  const supersededBy = readStringField(record, metadata, "superseded-by");
  const validUntil = readStringField(record, metadata, "valid-until");
  return {
    hasVeracityField,
    importance,
    ...(supersededBy !== undefined ? { supersededBy } : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
    veracity: parseMemoryVeracity(record.veracity ?? metadata?.veracity),
  };
}

/**
 * R12 可见性判定（omp recall.ts:459 的 WHERE 语义移植）：
 * `superseded_by IS NULL AND (valid_until IS NULL OR valid_until > now)` 的否定——
 * 非空 superseded-by，或 valid-until 已到期（<= now）→ 条目对检索不可见。
 * 解析失败 fail-open：valid-until 无法解析为时间 → 视为字段不存在（不过滤）；
 * 过滤是隐藏内容的负向动作，坏数据不隐藏内容。
 */
export function isMemoryEntryLifecycleFiltered(
  fields: Pick<MemoryLifecycleFields, "supersededBy" | "validUntil">,
  nowMs: number,
): boolean {
  if (fields.supersededBy !== undefined && fields.supersededBy.trim().length > 0) return true;
  const validUntilMs = parseMemoryTimestampMs(fields.validUntil);
  if (validUntilMs === undefined) return false;
  return validUntilMs <= nowMs;
}

/**
 * 解析 `valid-until` 为毫秒时间戳：接受 ISO-8601 字符串（YAML 1.2 core schema 下
 * 未加引号的日期也是字符串；对已解析成 Date 的形态防御性兼容）。无法解析 → undefined。
 */
export function parseMemoryTimestampMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const time = Date.parse(value.trim());
  return Number.isFinite(time) ? time : undefined;
}

/** frontmatter `importance` 解析：有限数字夹紧到 [0,1]；其余形态视为字段不存在。 */
export function parseMemoryImportance(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/**
 * R13 合并规则（omp store.ts:449-495 的 UPDATE 语义移植）：把新写文件的 frontmatter
 * 合入幸存者 record，返回**新对象**（不改入参）。逐字段：
 * - `importance` = MAX(既有 ?? 缺省, 新写 ?? 缺省)——omp `MAX(importance, ?)`；两边都
 *   缺省时写入缺省值（合并动作本身落在盘上，字段从此存在）；
 * - `veracity`：新写非 unknown → 覆盖，否则保留既有（omp CASE WHEN 同语义）；
 * - `valid-until` / `type` / `description`：新写存在 → 覆盖（omp `COALESCE(?, col)` =
 *   新非空则新）；
 * - `superseded-by` / `name` / 其余键：保留既有——合并不得复活已失效记忆；name 是
 *   `[[name]]` 互链身份，omp 无对应概念，此处刻意偏离 COALESCE 语义（spec R13）。
 * type 的写入位置跟随既有文件：既有把 type 放在 `metadata:` 下就更新那里，否则写顶层。
 */
export function mergeMemoryFrontmatterFields(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  const existingMetadata = isRecord(merged.metadata) ? merged.metadata : undefined;
  const incomingMetadata = isRecord(incoming.metadata) ? incoming.metadata : undefined;

  const existingFields = readMemoryLifecycleFields(existing);
  const incomingFields = readMemoryLifecycleFields(incoming);

  merged.importance = Math.max(
    existingFields.importance ?? MEMORY_IMPORTANCE_DEFAULT,
    incomingFields.importance ?? MEMORY_IMPORTANCE_DEFAULT,
  );

  const veracity = mergeVeracity(
    existingFields.hasVeracityField ? existingFields.veracity : undefined,
    incomingFields.hasVeracityField ? incomingFields.veracity : undefined,
  );
  if (veracity !== undefined) merged.veracity = veracity;

  const incomingValidUntil = readStringField(incoming, incomingMetadata, "valid-until");
  if (incomingValidUntil !== undefined) {
    setLifecycleField(merged, "valid-until", incomingValidUntil);
  }

  const incomingType = incoming.type ?? incomingMetadata?.type;
  if (typeof incomingType === "string" && incomingType.length > 0) {
    if (existingMetadata && typeof existingMetadata.type === "string") {
      merged.metadata = { ...existingMetadata, type: incomingType };
    } else {
      merged.type = incomingType;
    }
  }

  if (typeof incoming.description === "string" && incoming.description.length > 0) {
    merged.description = incoming.description;
  }

  return merged;
}

function readStringField(
  record: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record[key] ?? metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function setLifecycleField(
  record: Record<string, unknown>,
  key: string,
  value: string,
): void {
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  if (metadata && typeof metadata[key] === "string") {
    record.metadata = { ...metadata, [key]: value };
    return;
  }
  record[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
