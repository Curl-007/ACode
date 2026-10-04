// 检索管线公共出口（specs/memory-semantic-recall.md 接口节）。
// 渲染与去重仍然只经 pending.ts 的 `inject()`——检索层不渲染注入文本（R9 不变量）。
export { RETRIEVAL_CONSTANTS } from "./constants.js";
export { buildBm25Index, rankByBm25 } from "./bm25.js";
export type { Bm25Document, Bm25Index, Bm25Ranked } from "./bm25.js";
export { createLocalWasmEmbeddingBackend } from "./embedding.js";
export type { EmbeddingBackend, LocalWasmEmbeddingBackendDeps } from "./embedding.js";
export {
  createRecallMetricsLedger,
  recallQueryHash,
} from "./metrics.js";
export type { RecallMetricEvent, RecallMetricsLedger, RecallSuppressionReason } from "./metrics.js";
export { createMemoryRetrievalPipeline } from "./pipeline.js";
export type {
  MemoryRetrievalCandidate,
  MemoryRetrievalOutcome,
  MemoryRetrievalPipeline,
  MemoryRetrievalPipelineDeps,
  MemoryRetrievalResult,
} from "./pipeline.js";
export { fuseWithRrf } from "./rrf.js";
export type { RrfFused } from "./rrf.js";
export type { ListwiseRerankCandidate, ListwiseReranker } from "./rerank.js";
export {
  RECALL_SIDECAR_FILE,
  RECALL_SIDECAR_VERSION,
  computeSidecarCoverage,
  isSidecarModelSpaceCurrent,
  loadRecallSidecarIndex,
  parseRecallSidecarIndex,
  recallSidecarPath,
  saveRecallSidecarIndex,
  selectSidecarBackfill,
  serializeRecallSidecarIndex,
} from "./sidecar.js";
export type {
  RecallSidecarEntry,
  RecallSidecarIndex,
  RecallSidecarLoad,
  SidecarCoverage,
} from "./sidecar.js";
export {
  buildRetrievalDocumentTokens,
  stripMemoryFrontmatter,
  tokenizeForRetrieval,
} from "./tokenize.js";
export type { MemoryRetrievalDocumentInput } from "./tokenize.js";
