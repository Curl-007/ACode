// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-base/src/memory.rs
// （hybrid BM25+dense 检索与 RRF 融合）、embedding_backend.rs（向量空间隔离不变量）、
// memory_rerank.rs（listwise 重排），自撰 TypeScript 实现。
// 产品规则与取舍见 apps/acode-cli/specs/memory-semantic-recall.md。

/**
 * 检索管线常量（specs/memory-semantic-recall.md 常量表）。改这里即改协议，
 * 不要在调用点内联数值；测试按源码文本钉住这些值与 spec 一致。
 */
export const RETRIEVAL_CONSTANTS = Object.freeze({
  /** 单轮检索交给注入层的 top-K 候选数（R1）。 */
  RECALL_TOP_K: 8,
  /** 会话首轮静默期：第一条用户消息就是任务书，检索噪声大于收益（R6）。 */
  RECALL_FIRST_TURN_SKIP: true,
  /** BM25 缺省参数（R3）：没有标注集之前调参是过拟合噪声，用业界缺省。 */
  BM25_K1: 1.2,
  BM25_B: 0.75,
  /** RRF 融合参数（R4，jcode 同参）：k=60、候选池 5×limit。 */
  RRF_K: 60,
  RRF_POOL_MULTIPLIER: 5,
  /**
   * Phase B 本地 dense 模型的空间标签（R4）：自定义短 id 而非 HF 全名——
   * 向量空间标签要跨版本稳定，sidecar 的 `model` 字段与它全等才可比余弦。
   */
  EMBEDDING_MODEL_ID: "minilm-l6-v2-int8-384",
  EMBEDDING_DIM: 384,
  /** 单次检索的 sidecar 向量补算上限（R4）：防长尾卡顿，剩余下轮继续。 */
  SIDECAR_BACKFILL_LIMIT_PER_RETRIEVAL: 20,
  /** Phase C listwise 重排的触发门槛（R5）：候选足够多且分数接近才值得花一次模型调用。 */
  RERANK_MIN_CANDIDATES: 8,
  RERANK_SCORE_SPREAD: 0.5,
  RERANK_TIMEOUT_MS: 10_000,
  // 注：FILENAME_MIN_INTERVAL_MS（R7 层 4 filename 限速）追加在 pending.ts 的
  // MEMORY_RECALL_TIMING 里——它是去重账本协议常量，消费方也在 pending.ts，
  // 与 J3-2 既有账本常量同表管理，不在此处复制第二份。
});
