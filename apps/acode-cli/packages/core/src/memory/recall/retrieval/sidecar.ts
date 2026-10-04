// 机制参照 jcode (MIT) crates/jcode-base/src/embedding_backend.rs 的
// 向量空间隔离不变量（一向量空间一索引），自撰 TypeScript 实现。
// 产品规则见 apps/acode-cli/specs/memory-semantic-recall.md R4。

import { join } from "node:path";

import type { FileSystemPort } from "@acode/contracts";

import { RETRIEVAL_CONSTANTS } from "./constants.js";

/** sidecar 索引文件名（R4）：`<memoryRoot>/.recall-index.json`。 */
export const RECALL_SIDECAR_FILE = ".recall-index.json";

export function recallSidecarPath(memoryRoot: string): string {
  return join(memoryRoot, RECALL_SIDECAR_FILE);
}

export interface RecallSidecarEntry {
  /** 相对 memoryRoot 的正斜杠名（与注入协议的 `filename` 同源）。 */
  file: string;
  /** sha256 全文——与 J3-2 R2 签名同源同算法，索引条目失效判定直接复用。 */
  contentHash: string;
  vector: number[];
}

export interface RecallSidecarIndex {
  version: number;
  /** 向量空间标签；与运行后端 modelId 不全等 → 整个 sidecar 判过期（见 load）。 */
  model: string;
  entries: RecallSidecarEntry[];
}

/**
 * sidecar 的 shape 契约：版本号、模型标签与条目数组。Phase B 落地接写侧时若结构
 * 演进，先升 version 并保留旧版判 `invalid` 触发重建，绝不静默混读两种结构。
 */
export const RECALL_SIDECAR_VERSION = 1;

export type RecallSidecarLoad =
  | { status: "loaded"; index: RecallSidecarIndex }
  /**
   * 模型空间已换（model 标签 ≠ 运行后端 modelId）：整个 sidecar 判过期，后台重算，
   * 期间 Phase B 关闭（不阻塞注入）。**绝不混空间比较**——`embedding_model` 不同
   * 的向量不在同一空间，余弦值无意义；跨空间条目只能经 BM25 命中（R4 不变量）。
   */
  | { status: "model-space-changed" }
  /** JSON 解析失败 / shape 不符：调用方删除重建 + warn（R4）。 */
  | { status: "invalid" }
  /** 文件不存在：首次启用或已被重建删除。 */
  | { status: "missing" };

/**
 * 解析并校验 sidecar 索引（纯逻辑）。任何字段缺失、类型不符、vector 不是
 * number[]（含维度校验，若给出 expectedDim）都判 `undefined`（= invalid → 重建）。
 */
export function parseRecallSidecarIndex(
  raw: string,
  options: { expectedDim?: number } = {},
): RecallSidecarIndex | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.version !== RECALL_SIDECAR_VERSION) return undefined;
  if (typeof parsed.model !== "string" || parsed.model.length === 0) return undefined;
  if (!Array.isArray(parsed.entries)) return undefined;

  const entries: RecallSidecarEntry[] = [];
  for (const candidate of parsed.entries) {
    if (!isRecord(candidate)) return undefined;
    if (typeof candidate.file !== "string" || candidate.file.length === 0) return undefined;
    if (typeof candidate.contentHash !== "string" || candidate.contentHash.length === 0) {
      return undefined;
    }
    if (!Array.isArray(candidate.vector) || candidate.vector.length === 0) return undefined;
    if (candidate.vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      return undefined;
    }
    if (options.expectedDim !== undefined && candidate.vector.length !== options.expectedDim) {
      return undefined;
    }
    entries.push({
      contentHash: candidate.contentHash,
      file: candidate.file,
      vector: candidate.vector,
    });
  }

  return { entries, model: parsed.model, version: parsed.version };
}

export function serializeRecallSidecarIndex(index: RecallSidecarIndex): string {
  return `${JSON.stringify(index)}\n`;
}

/**
 * 「一向量空间一索引」的判定守卫（R4 不变量）：sidecar 的 `model` 字段与运行后端
 * `modelId` 必须**全等**才允许任何余弦比较。这是唯一守卫点——所有想消费 sidecar
 * 向量的代码必须先经过它，禁止各自内联字符串比较后绕过。
 */
export function isSidecarModelSpaceCurrent(index: RecallSidecarIndex, modelId: string): boolean {
  return index.model === modelId;
}

/**
 * 读取 sidecar 并完成全部前置判定（纯读，不修复不重建——删除重建由 Phase B 的
 * 写侧消费方决定，读侧只报告状态）。读失败按 ENOENT 口径归 `missing`，
 * 其余 IO 错误归 `invalid`（fail-safe：宁可重建也不用可疑状态）。
 */
export async function loadRecallSidecarIndex(
  fileSystem: FileSystemPort,
  memoryRoot: string,
  options: { modelId: string; dim?: number; signal?: AbortSignal },
): Promise<RecallSidecarLoad> {
  let raw: string;
  try {
    const read = await fileSystem.readTextFile(
      { path: recallSidecarPath(memoryRoot) },
      { signal: options.signal },
    );
    raw = read.content;
  } catch (error) {
    if (isNotFoundError(error)) return { status: "missing" };
    return { status: "invalid" };
  }

  const index = parseRecallSidecarIndex(raw, { expectedDim: options.dim });
  if (!index) return { status: "invalid" };
  if (!isSidecarModelSpaceCurrent(index, options.modelId)) return { status: "model-space-changed" };
  return { status: "loaded", index };
}

export async function saveRecallSidecarIndex(
  fileSystem: FileSystemPort,
  memoryRoot: string,
  index: RecallSidecarIndex,
): Promise<boolean> {
  try {
    await fileSystem.writeTextFile({
      content: serializeRecallSidecarIndex(index),
      createParents: true,
      path: recallSidecarPath(memoryRoot),
    });
    return true;
  } catch {
    return false;
  }
}

export interface SidecarCoverage {
  /** 与当前 contentHash 一致、可直接消费向量的文件。 */
  upToDate: string[];
  /** 在索引里但 contentHash 已变（文件被改写）——向量过期，需重算。 */
  stale: string[];
  /** 完全没有向量条目的文件。 */
  missing: string[];
}

/**
 * 对照当前文件签名计算 sidecar 覆盖情况（纯逻辑）。`contentHash` 与 J3-2 R2 签名
 * 同源同算法（sha256 全文），所以索引条目失效判定与注入协议的重验证同源——
 * 文件改写会同时击穿两边，不会出现「注入层判改写、索引层还用旧向量」的漂移。
 */
export function computeSidecarCoverage(
  index: RecallSidecarIndex,
  files: readonly { file: string; contentHash: string }[],
): SidecarCoverage {
  const indexed = new Map(index.entries.map((entry) => [entry.file, entry.contentHash]));
  const coverage: SidecarCoverage = { missing: [], stale: [], upToDate: [] };
  for (const file of files) {
    const hash = indexed.get(file.file);
    if (hash === undefined) {
      coverage.missing.push(file.file);
      continue;
    }
    if (hash === file.contentHash) coverage.upToDate.push(file.file);
    else coverage.stale.push(file.file);
  }
  return coverage;
}

/**
 * 单次检索的 backfill 上限（R4）：只补算前 `SIDECAR_BACKFILL_LIMIT_PER_RETRIEVAL`
 * 条，防 200 条全量重算把 turn 卡死；剩余下轮继续。优先补 missing（新文件），
 * 再补 stale（改写文件），顺序与传入一致保证跨轮推进。
 */
export function selectSidecarBackfill(coverage: SidecarCoverage): string[] {
  return [...coverage.missing, ...coverage.stale].slice(
    0,
    RETRIEVAL_CONSTANTS.SIDECAR_BACKFILL_LIMIT_PER_RETRIEVAL,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ENOENT 口径与 pending.ts 的 isNotFoundError 同源：裸 ENOENT（测试桩件）与端口 not_found/is_directory。 */
function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "not_found" || code === "is_directory";
}
