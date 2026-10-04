// 机制参照 jcode (MIT) crates/jcode-base/src/memory.rs 的 sparse 检索（BM25），
// 自撰 TypeScript 实现。产品规则见 apps/acode-cli/specs/memory-semantic-recall.md R3。

import { RETRIEVAL_CONSTANTS } from "./constants.js";

/** 参与索引的单篇文档：稳定 id + 分词后的 token 序列（R2 分词器产出）。 */
export interface Bm25Document {
  id: string;
  tokens: readonly string[];
}

export interface Bm25Index {
  readonly totalDocs: number;
  readonly averageDocLength: number;
  /** id → { token → tf, 文档长度 }。 */
  readonly docs: ReadonlyMap<string, Bm25IndexedDoc>;
  /** token → 出现该 token 的文档数（df）。 */
  readonly documentFrequencies: ReadonlyMap<string, number>;
}

export interface Bm25IndexedDoc {
  readonly termFrequencies: ReadonlyMap<string, number>;
  readonly length: number;
}

/**
 * 内存构建 BM25 索引（R3）。文档数 ≤ MANIFEST_FILE_LIMIT=200/项目，每 turn 检索时从
 * 当次采集的文档现算——不落盘索引文件：落盘是第二份可漂移状态（AGENTS.md 单一所有者），
 * 且 200 文档 × 千级 token 的现算成本在打分预算内（见验收场景 3 的性能钉子）。
 */
export function buildBm25Index(documents: readonly Bm25Document[]): Bm25Index {
  const docs = new Map<string, Bm25IndexedDoc>();
  const documentFrequencies = new Map<string, number>();
  let totalLength = 0;

  for (const document of documents) {
    const termFrequencies = new Map<string, number>();
    for (const token of document.tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }
    docs.set(document.id, { termFrequencies, length: document.tokens.length });
    totalLength += document.tokens.length;
    for (const token of termFrequencies.keys()) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }

  return {
    averageDocLength: documents.length > 0 ? totalLength / documents.length : 0,
    docs,
    documentFrequencies,
    totalDocs: documents.length,
  };
}

export interface Bm25Ranked {
  id: string;
  rank: number;
  score: number;
}

/**
 * 对整个索引按 Okapi BM25 打分并给出排名（R3）。
 * 参数 k1=1.2、b=0.75 用业界缺省——没有标注集之前调参是过拟合噪声。
 * 文档长度归一用 token 数（R2 分词器计数）。IDF 用 Lucene 式 `ln(1 + (N-df+0.5)/(df+0.5))`
 * 恒为正，避免稀疏 query 下出现负贡献。零分文档不进排名。
 */
export function rankByBm25(index: Bm25Index, queryTokens: readonly string[]): Bm25Ranked[] {
  // 同一 query token 出现多次只计一次（BM25 求和项按词型去重，重复 token 不放大权重）。
  const uniqueQueryTokens = [...new Set(queryTokens)];
  const k1 = RETRIEVAL_CONSTANTS.BM25_K1;
  const b = RETRIEVAL_CONSTANTS.BM25_B;

  const scored: Array<{ id: string; score: number }> = [];
  for (const [id, doc] of index.docs) {
    if (doc.length === 0) continue;
    let score = 0;
    for (const token of uniqueQueryTokens) {
      const termFrequency = doc.termFrequencies.get(token);
      if (!termFrequency) continue;
      const documentFrequency = index.documentFrequencies.get(token) ?? 0;
      if (index.totalDocs === 0) continue;
      const idf = Math.log(
        1 + (index.totalDocs - documentFrequency + 0.5) / (documentFrequency + 0.5),
      );
      const normalization =
        termFrequency * (k1 + 1) /
        (termFrequency + k1 * (1 - b + (b * doc.length) / index.averageDocLength));
      score += idf * normalization;
    }
    if (score > 0) scored.push({ id, score });
  }

  scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return scored.map((entry, position) => ({ ...entry, rank: position + 1 }));
}
