/**
 * HTTP 413（请求体字节超限）恢复轨道的媒体预算阶梯。
 *
 * 机制参照 jcode (MIT) crates/jcode-compaction-core/src/lib.rs:33-40（PAYLOAD_IMAGE_CHAR_BUDGET）
 * 与 crates/jcode-app-core/src/agent/compaction.rs:187-207（try_recover_after_payload_too_large），
 * 自撰实现。
 *
 * 为什么需要独立轨道：413 由「序列化后的请求体字节数」触发，与模型 token 上下文窗口是两条
 * 独立的失败路径。请求体几乎总是被内联 base64 媒体撑爆，而 token 会计**有意**不按 base64 长度
 * 计费（见 `manual.ts` 的 `COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS`），所以 token 轨道的恢复动作
 * （丢旧轮次 / 截断 summary 输入）既诊断不出原因，也不一定降得下字节数。
 *
 * ACode 已有的预防侧预算是 `runtime/helpers/media-budget.ts` 的 40MiB 聚合媒体预算
 * （`DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES`），它高于 Anthropic 约 32MB 的请求体硬上限，
 * 因此单靠预防侧不足以排除 413；本阶梯提供反应侧的逐级收缩。
 */

/**
 * 413 后第一级重试允许保留的内联媒体字节数。
 *
 * 取 jcode 同一量级（12MiB base64 字符）：明显低于 provider 的请求体硬上限，
 * 给正文、tool schema 与协议封装留出余量，使一次重试大概率能过。
 */
export const COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_BYTES = 12 * 1024 * 1024;

/** 第二级：剥掉全部内联媒体（0 字节预算），等价于既有的 summary 媒体剥离语义。 */
export const COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_EXHAUSTED_BYTES = 0;

/**
 * 返回下一级媒体预算；`undefined` 表示阶梯已耗尽，调用方必须停止重试并把错误抛出去。
 *
 * 阶梯：未启用 → 12MiB（丢最旧媒体，保留最近的）→ 0（全部剥离）→ 耗尽。
 * 与 jcode 一致：没有可剥的媒体时不空转重试（`strip_oversized_images` 返回 0 即放弃）。
 */
export function nextCompactPayloadRecoveryMediaBudget(
  currentBudgetBytes: number | undefined,
): number | undefined {
  if (currentBudgetBytes === undefined) return COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_BYTES;
  if (!Number.isFinite(currentBudgetBytes)) return undefined;
  if (currentBudgetBytes > COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_EXHAUSTED_BYTES) {
    return COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_EXHAUSTED_BYTES;
  }
  return undefined;
}
