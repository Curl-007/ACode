// 机制参照 jcode (MIT) crates/jcode-base/src/memory.rs 的 hybrid 检索融合
// （dense + sparse → Reciprocal Rank Fusion），自撰 TypeScript 实现。
// 产品规则见 apps/acode-cli/specs/memory-semantic-recall.md R4。

import { RETRIEVAL_CONSTANTS } from "./constants.js";

export interface RrfFused {
  id: string;
  fusedScore: number;
}

/**
 * RRF 融合（R4）：`score(d) = Σ_s 1/(k + rank_s(d))`，k=60、每阶段候选池 5×limit
 * （jcode 同参）。**无硬余弦/分数阈值**——jcode benchmark 的教训：阈值会清零召回，
 * 长尾相关条目被剪掉；「是否值得注入」交给注入层协议（去重/限速）判定，
 * 检索层只负责排序，不替注入层做阈值决策。
 *
 * 输入是各阶段的 id 排名（rank 1 开始）；每阶段只有前 poolSize 名参与融合，
 * 其余条目对本阶段的贡献为零。并列按 id 字典序保证输出确定（去重层的文本签名
 * 依赖跨调用稳定）。
 */
export function fuseWithRrf(
  rankings: ReadonlyArray<ReadonlyArray<string>>,
  poolSize: number,
): RrfFused[] {
  const k = RETRIEVAL_CONSTANTS.RRF_K;
  const scores = new Map<string, number>();

  for (const ranking of rankings) {
    const pool = ranking.slice(0, Math.max(0, poolSize));
    for (let position = 0; position < pool.length; position++) {
      const id = pool[position]!;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + position + 1));
    }
  }

  return [...scores.entries()]
    .map(([id, fusedScore]) => ({ fusedScore, id }))
    .sort((left, right) => right.fusedScore - left.fusedScore || left.id.localeCompare(right.id));
}
