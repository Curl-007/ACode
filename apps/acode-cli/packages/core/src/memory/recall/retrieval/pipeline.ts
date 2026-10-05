// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-base/src/memory.rs
// （hybrid 检索 BM25+dense → RRF 融合）、embedding_backend.rs（后端可插拔 + 向量空间
// 隔离不变量）、memory_rerank.rs（LLM listwise 重排），自撰 TypeScript 实现。
// 产品规则与三阶段递进见 apps/acode-cli/specs/memory-semantic-recall.md R1-R5。

import { createHash } from "node:crypto";

import {
  isFileSystemPortError,
  type FileSystemPort,
  type Logger,
  type TraceContext,
} from "@acode/contracts";

import {
  MANIFEST_FILE_LIMIT,
  collectMemoryFilePaths,
  memoryFileRelativeName,
  parseMemoryFrontmatter,
} from "../manifest.js";
import type {
  MemoryRecallEntry,
  MemoryRecallInjector,
  MemoryRecallRejectionReason,
  MemoryRecallScope,
} from "../pending.js";
import type { MemoryRecallType } from "../types.js";
import { buildBm25Index, rankByBm25 } from "./bm25.js";
import { RETRIEVAL_CONSTANTS } from "./constants.js";
import type { EmbeddingBackend } from "./embedding.js";
import { fuseWithRrf } from "./rrf.js";
import type { ListwiseReranker } from "./rerank.js";
import {
  buildRetrievalDocumentTokens,
  stripMemoryFrontmatter,
  tokenizeForRetrieval,
} from "./tokenize.js";

/** 融合后的 top-K 候选（spec 接口节）。entry 是完整的 J3-2 条目（含语义签名）。 */
export interface MemoryRetrievalCandidate {
  entry: MemoryRecallEntry;
  fusedScore: number;
  bm25Rank?: number;
  denseRank?: number;
}

export interface MemoryRetrievalResult {
  status: "ok";
  candidates: MemoryRetrievalCandidate[];
  /** 本轮实际启用的阶段组合（R1 阶段门）：A 永远在，是降级底线。 */
  phaseMask: "A" | "AB" | "ABC";
  /** 降级记录（R1）：检索层 fail-open 的每一次退守都留痕。 */
  degradedReasons: string[];
}

/** 检索层读取失败（与 J3-2 capture 同口径）：调用方据此跳过注入并记 discarded 度量。 */
export type MemoryRetrievalOutcome =
  | MemoryRetrievalResult
  | { status: "rejected"; reason: MemoryRecallRejectionReason };

export interface MemoryRetrievalPipelineDeps {
  /** J3-2 注入通道：注入协议复用；检索层只选条目，注入仍全量走协议（R1）。 */
  injector: MemoryRecallInjector;
  /**
   * 检索层的读盘端口：必须与 injector 构造时是**同一个实例**——两层的文件视图一致，
   * 签名判定才同源（检索选中的条目若在注入前被改写，注入层重验证会拦下）。
   * J3-2 的 injector 把 fileSystem 封装在闭包里不外露，所以这里显式再传一次。
   */
  fileSystem: FileSystemPort;
  /** 缺省 undefined → Phase A only（本地 wasm 后端 Phase B 登记，见 embedding.ts）。 */
  embedding?: EmbeddingBackend;
  /** 缺省 undefined → Phase C off，零模型调用（R5）。 */
  reranker?: ListwiseReranker;
  logger?: Logger;
  now?: () => number;
}

export interface MemoryRetrievalPipeline {
  retrieve(input: {
    /** 最新用户消息的纯文本投影（R6）；空 query 直接返回零候选。 */
    query: string;
    scope: MemoryRecallScope;
    signal?: AbortSignal;
    traceContext?: TraceContext;
  }): Promise<MemoryRetrievalOutcome>;
}

export function createMemoryRetrievalPipeline(
  deps: MemoryRetrievalPipelineDeps,
): MemoryRetrievalPipeline {
  // 降级 warn 去重（R1：warn 一次，同类不刷屏）。键是降级原因字符串。
  const warnedDegradations = new Set<string>();

  const warnDegradedOnce = (reason: string, detail: Record<string, unknown>): void => {
    if (warnedDegradations.has(reason)) return;
    warnedDegradations.add(reason);
    deps.logger?.warn("Memory semantic recall degraded to BM25-only", {
      ...detail,
      event: "memory.recall.degraded",
      module: "core.memory",
      reason,
      status: "failed",
    });
  };

  return {
    async retrieve(input) {
      if (input.scope.memoryRoot === undefined) {
        return { status: "rejected", reason: "disabled" };
      }
      const queryTokens = tokenizeForRetrieval(input.query);
      if (queryTokens.length === 0) {
        // 空 query（纯附件/符号消息）跳过本轮检索（R6），不是错误。
        return { candidates: [], degradedReasons: [], phaseMask: "A", status: "ok" };
      }

      const documents = await readRetrievalDocuments(
        deps.fileSystem,
        input.scope.memoryRoot,
        input.signal,
      );
      if (documents.status === "rejected") return documents;
      if (documents.documents.length === 0) {
        return { candidates: [], degradedReasons: [], phaseMask: "A", status: "ok" };
      }

      const topK = RETRIEVAL_CONSTANTS.RECALL_TOP_K;
      const poolSize = RETRIEVAL_CONSTANTS.RRF_POOL_MULTIPLIER * topK;
      const degradedReasons: string[] = [];

      // Phase A：BM25 永远在，是降级底线（R1）。
      const index = buildBm25Index(
        documents.documents.map((document) => ({ id: document.id, tokens: document.tokens })),
      );
      const bm25Ranking = rankByBm25(index, queryTokens);
      const rankings: string[][] = [bm25Ranking.map((ranked) => ranked.id)];
      const bm25Ranks = new Map(bm25Ranking.map((ranked) => [ranked.id, ranked.rank]));

      // Phase B：dense 向量（后端存在且本次可用时）→ 与 A 做 RRF 融合（R4）。
      // 本轮（Phase A 构建）生产路径不传 embedding；桩后端供接线与验收测试使用。
      // sidecar 向量缓存 Phase B 接入：当前 dense 路径每次现算全文向量，同一后端
      // 同一空间，无跨空间复用问题；接 sidecar 后必须先过 isSidecarModelSpaceCurrent
      // 守卫（sidecar.ts，一向量空间一索引），绝不混空间比较。
      let denseRanks: Map<string, number> | undefined;
      if (deps.embedding) {
        try {
          const denseRanking = await rankByDenseSimilarity(
            deps.embedding,
            documents.documents,
            input.query,
          );
          if (denseRanking) {
            rankings.push(denseRanking.map((ranked) => ranked.id));
            denseRanks = new Map(denseRanking.map((ranked) => [ranked.id, ranked.rank]));
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          // 检索层降级 fail-open（R1）：embedding 后端不可用（模型未下载/wasm 加载失败/
          // 推理抛错）→ 退 Phase A 纯 BM25 + warn 一次（同因不刷屏）；注入层维持 fail-closed。
          const reason = "embedding-unavailable";
          degradedReasons.push(reason);
          warnDegradedOnce(reason, {
            errorKind: error instanceof Error ? error.name : typeof error,
          });
        }
      }

      const fused = fuseWithRrf(rankings, poolSize);

      // Phase C：LLM listwise 重排（接口位，默认关——deps.reranker 缺省 undefined）。
      // 触发门槛（候选 ≥8 且 top1/top8 分差 <0.5）的分数语义在 Phase B/C 接线时按
      // 融合分归一口径校准；本轮钉住「不传 reranker = 零调用」这一档（R5 度量先行）。
      let ordered = fused;
      let rerankApplied = false;
      if (deps.reranker && fused.length >= RETRIEVAL_CONSTANTS.RERANK_MIN_CANDIDATES) {
        const spread =
          fused[0]!.fusedScore -
          fused[RETRIEVAL_CONSTANTS.RERANK_MIN_CANDIDATES - 1]!.fusedScore;
        if (spread < RETRIEVAL_CONSTANTS.RERANK_SCORE_SPREAD) {
          const reranked = await applyListwiseRerank(
            deps.reranker,
            documents.documents,
            fused,
            input,
          );
          if (reranked) {
            ordered = reranked;
            rerankApplied = true;
          }
        }
      }

      const byId = new Map(documents.documents.map((document) => [document.id, document]));
      const candidates: MemoryRetrievalCandidate[] = [];
      for (const fusedEntry of ordered.slice(0, topK)) {
        const document = byId.get(fusedEntry.id);
        if (!document) continue;
        candidates.push({
          bm25Rank: bm25Ranks.get(fusedEntry.id),
          denseRank: denseRanks?.get(fusedEntry.id),
          entry: toRecallEntry(document, candidates.length + 1),
          fusedScore: fusedEntry.fusedScore,
        });
      }

      const phaseMask: MemoryRetrievalResult["phaseMask"] = rerankApplied
        ? "ABC"
        : denseRanks
          ? "AB"
          : "A";
      return { candidates, degradedReasons, phaseMask, status: "ok" };
    },
  };
}

// ── 检索文档读取（只读记忆文件；写只发生在 Phase B 的 sidecar backfill，R9） ──

interface RetrievalDocument {
  /** 稳定 id：相对 memoryRoot 的正斜杠名（与注入协议 filename 同源）。 */
  id: string;
  filePath: string;
  /** R2 分词后的文档表示（description 已 ×2 计权）。 */
  tokens: string[];
  /** frontmatter 剥离后的正文；只供 Phase C rerank 候选用，绝不渲染进注入文本。 */
  body: string;
  /** 与 J3-2 R2 签名同源的字段（contentHash/mtimeMs/sizeBytes + frontmatter 投影）。 */
  contentHash: string;
  mtimeMs: number;
  sizeBytes: number;
  name?: string;
  description?: string;
  type?: MemoryRecallType;
}

type RetrievalDocumentsRead =
  | { status: "read"; documents: RetrievalDocument[] }
  | { status: "rejected"; reason: MemoryRecallRejectionReason };

/**
 * 读取检索文档表示。与注入协议（pending.ts 的 readEntryDrafts）同口径并发读全文并算
 * sha256 签名——两层的判定因此同源：检索选中的条目若在注入前被改写，注入层重验证会
 * 以 entry-modified 拦下，检索层的过期排序不会变成过期注入。读取失败与 capture 一致
 * 整体拒绝（fail-closed 口径），不做「部分文档也打分」：半份语料的 IDF 是错的。
 * 检索层不再重复 pending.ts 的 invalid-name 采集期剔除——注入层 capture 是权威，
 * 检索层多选一个坏名条目最多浪费一个候选名额，无害。
 */
async function readRetrievalDocuments(
  fileSystem: FileSystemPort,
  memoryRoot: string,
  signal: AbortSignal | undefined,
): Promise<RetrievalDocumentsRead> {
  let paths: string[];
  try {
    paths = await collectMemoryFilePaths(fileSystem, memoryRoot, signal);
  } catch {
    signal?.throwIfAborted();
    return { status: "rejected", reason: "storage-error" };
  }

  const settled = await Promise.allSettled(
    paths.map(async (filePath): Promise<RetrievalDocument> => {
      const [stat, read] = await Promise.all([
        fileSystem.stat({ path: filePath }, { signal }),
        fileSystem.readTextFile({ path: filePath }, { signal }),
      ]);
      if (stat.kind !== "file") throw new MissingEntryError();
      const frontmatter = parseMemoryFrontmatter(read.content);
      return {
        body: stripMemoryFrontmatter(read.content),
        contentHash: createHash("sha256").update(read.content, "utf8").digest("hex"),
        description: frontmatter.description,
        filePath,
        id: memoryFileRelativeName(memoryRoot, filePath),
        mtimeMs: stat.mtimeMs ?? 0,
        name: frontmatter.name,
        sizeBytes: stat.sizeBytes,
        tokens: buildRetrievalDocumentTokens({
          content: stripMemoryFrontmatter(read.content),
          description: frontmatter.description,
          name: frontmatter.name,
          tags: frontmatter.tags,
          type: frontmatter.type,
        }),
        type: frontmatter.type,
      };
    }),
  );
  signal?.throwIfAborted();

  const documents: RetrievalDocument[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      documents.push(result.value);
      continue;
    }
    if (result.reason instanceof MissingEntryError) {
      return { status: "rejected", reason: "entry-missing" };
    }
    return {
      status: "rejected",
      reason: isNotFoundPortError(result.reason) ? "entry-missing" : "storage-error",
    };
  }

  // 与 capture 的 mtime 倒序 + 200 上限同源（R10 既有语义）：排序确定保证 RRF 并列
  // 打破与去重文本签名跨调用稳定。
  documents.sort((left, right) => right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id));
  return { status: "read", documents: documents.slice(0, MANIFEST_FILE_LIMIT) };
}

class MissingEntryError extends Error {
  constructor() {
    // 不携带文件名：错误对象可能进日志上下文，路径与不可信内容不落日志（J3-2 R4 口径）。
    super("memory entry is no longer a regular file");
    this.name = "MissingEntryError";
  }
}

function toRecallEntry(document: RetrievalDocument, position: number): MemoryRecallEntry {
  return {
    filePath: document.filePath,
    filename: document.id,
    ...(document.name ? { name: document.name } : {}),
    // 检索层的临时序号（按融合序分配）；注入层 render 时按当次集合重新分配（J3-2 R6）。
    reference: `memory_${position}`,
    signature: {
      contentHash: document.contentHash,
      ...(document.description ? { description: document.description } : {}),
      mtimeMs: document.mtimeMs,
      sizeBytes: document.sizeBytes,
      ...(document.type ? { type: document.type } : {}),
    },
  };
}

// ── Phase B dense 排序（无硬余弦阈值——jcode benchmark 教训，进 R4 注释） ──

async function rankByDenseSimilarity(
  backend: EmbeddingBackend,
  documents: readonly RetrievalDocument[],
  query: string,
): Promise<Array<{ id: string; rank: number }>> {
  const texts = [
    query,
    ...documents.map((document) => `${document.description ?? ""}\n${document.body}`),
  ];
  const vectors = await backend.embed(texts);
  if (vectors.length !== texts.length) {
    throw new Error("embedding backend returned a wrong vector count");
  }
  const queryVector = vectors[0]!;
  const scored = documents
    .map((document, index) => ({
      id: document.id,
      score: cosineSimilarity(queryVector, vectors[index + 1]!),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return scored.map((entry, position) => ({ id: entry.id, rank: position + 1 }));
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return Number.NaN;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  if (leftNorm === 0 || rightNorm === 0) return Number.NaN;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

// ── Phase C listwise 重排（接口位装配；候选不含文件路径——防路径泄漏，R5） ──

async function applyListwiseRerank(
  reranker: ListwiseReranker,
  documents: readonly RetrievalDocument[],
  fused: ReadonlyArray<{ id: string; fusedScore: number }>,
  input: { query: string; signal?: AbortSignal },
): Promise<Array<{ fusedScore: number; id: string }> | undefined> {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const fusedIds = fused.map((entry) => entry.id);
  // 候选对外只暴露不透明序号（rerank_1..N）：文档 id 就是相对文件名，直接当 rerank id
  // 传给第三方推理面等于泄漏路径（R5「不含文件路径」）；映射在本函数内闭环。
  const opaqueIds = fusedIds.map((_, position) => `rerank_${position + 1}`);
  const documentIdByOpaqueId = new Map(
    fusedIds.map((documentId, position) => [opaqueIds[position]!, documentId]),
  );
  const rerankCandidates = fusedIds
    .map((documentId) => byId.get(documentId))
    .filter((document): document is RetrievalDocument => document !== undefined)
    .map((document, position) => ({
      // 只给 content/description，不给文件路径与文件名（R5：防路径泄漏进第三方推理面）。
      content: document.body,
      description: document.description,
      id: opaqueIds[position]!,
    }));
  try {
    // 失败/超时（10s）→ 用融合序（降级不 fail，R5）。
    const ranked = await withTimeout(
      reranker.rerank({ candidates: rerankCandidates, query: input.query, signal: input.signal }),
      RETRIEVAL_CONSTANTS.RERANK_TIMEOUT_MS,
    );
    // 返回必须是不透明序号的全量重排（一次 listwise 调用输出全部候选的排序，R5）；
    // 缺项/重复/未知 id 都视为后端违约，退融合序。
    if (
      ranked.length !== opaqueIds.length ||
      new Set(ranked).size !== ranked.length ||
      !ranked.every((opaqueId) => documentIdByOpaqueId.has(opaqueId))
    ) {
      return undefined;
    }
    const rankOfDocument = new Map(
      ranked.map((opaqueId, position) => [documentIdByOpaqueId.get(opaqueId)!, position]),
    );
    return fused
      .slice()
      .sort((left, right) => rankOfDocument.get(left.id)! - rankOfDocument.get(right.id)!);
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("rerank timeout")), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isNotFoundPortError(error: unknown): boolean {
  return (
    isFileSystemPortError(error) && (error.code === "not_found" || error.code === "is_directory")
  );
}
