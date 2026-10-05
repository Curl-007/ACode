// 机制参照 jcode (MIT) crates/jcode-base/src/memory_rerank.rs 的 LLM listwise 重排
// （实测 recall@5 0.53→0.75；cross-encoder 本地模型因域外掉点弃用），
// 自撰 TypeScript 实现的接口位。产品规则见 apps/acode-cli/specs/memory-semantic-recall.md R5。

/**
 * Phase C listwise 重排的候选表示（R5）：只含 content/description/tags，
 * **不含文件路径**——防路径泄漏进第三方推理面。
 */
export interface ListwiseRerankCandidate {
  id: string;
  content: string;
  description?: string;
  tags?: readonly string[];
}

/** 一次调用输出全部候选的 id 排序（focused query + 全候选一次 listwise 调用，非逐对打分）。 */
export interface ListwiseReranker {
  rerank(input: {
    query: string;
    candidates: readonly ListwiseRerankCandidate[];
    signal?: AbortSignal;
  }): Promise<string[]>;
}

/**
 * 接口位说明（Phase C，默认关）：
 * - 检索管线 deps 的 `reranker` 缺省 undefined = Phase C off，零模型调用（R5）；
 * - 触发条件（候选 ≥ RERANK_MIN_CANDIDATES 且 top1/top8 分差 < RERANK_SCORE_SPREAD）、
 *   10s 超时降级用融合序、prompt 不可信声明段（J3-2 R6 同款）在 Phase C 实现时落地；
 * - 开启决策依据 R8 度量账本数据（度量先行），不在本项实现任何具体 reranker。
 */
