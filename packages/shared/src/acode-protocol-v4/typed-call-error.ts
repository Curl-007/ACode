// typed error 分层：「根本没尝试」（协议道）vs「尝试了但失败」（业务道 typed error_code）。
// spec: apps/acode-cli/specs/protocol-attachment-typed-errors.md R1（含证据出处）。
// 混层的代价：把尝试后的失败报成协议错误，调用方会当成「重投递安全」盲目重试，把已产生
// 一半副作用的调用再跑一遍。ACode 既有对照：CommandAck reasonCode 的 `proto.*`（协议道）
// 与 `fault.*`（业务道）命名空间已经是这套分层；本叶子显式化并为 staged 调用面提供形状。
import { z } from "zod";

/** 协议道 reasonCode 命名空间前缀：以此开头的失败 = 根本没尝试，重投递不产生重复副作用。 */
export const NOT_ATTEMPTED_REASON_PREFIX = "proto." as const;

/**
 * 这个 reasonCode 是不是「根本没尝试」层。只认命名空间前缀，不做消息文本匹配
 * （attachment-faults.ts 头注同一纪律：错误文本会被包装/本地化，分类必须走稳定码）。
 */
export function isNotAttemptedReasonCode(reasonCode: string | undefined): boolean {
  return typeof reasonCode === "string" && reasonCode.startsWith(NOT_ATTEMPTED_REASON_PREFIX);
}

/**
 * 业务道 typed error：尝试型调用失败时挂在**成功载体**上的字段，不得降级成 JSON-RPC
 * error / `proto.*`。errorCode 属于该调用面自己的闭集词表（additive 演进）；errorMessage
 * 人类可读，消费方禁止对它做文本分流。
 */
export const typedCallErrorSchema = z
  .object({
    errorCode: z.string().min(1),
    errorMessage: z.string().optional(),
    /** 该面自己的重试安全判断；缺席 = 未知，消费方 fail-closed 不自动重试。 */
    retryable: z.boolean().optional(),
  })
  .strict();
export type TypedCallError = z.infer<typeof typedCallErrorSchema>;

/**
 * 未知码收敛为缺席：闭集外的 errorCode 读成 undefined（additive 演进——新码先行发布
 * 不打碎旧消费方：旧端把新码当「没有可行动的码」走通用失败路径，而不是解析崩帧）。
 */
export function parseKnownTypedCallErrorCode<T extends string>(
  value: unknown,
  knownCodes: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  return knownCodes.includes(value as T) ? (value as T) : undefined;
}

/**
 * 尝试型调用的业务道结果包络：`attempted: true` 恒在（响应本身宣告「尝试过了」），
 * `error` 缺席 = 尝试且成功、在场 = 尝试但失败。重试前必须按该调用面自己的幂等/CAS
 * 机制对账——协议层不承诺重跑安全（R1 规则 4）。
 */
export const attemptedCallResultSchema = z
  .object({
    attempted: z.literal(true),
    error: typedCallErrorSchema.optional(),
  })
  .strict();
export type AttemptedCallResult = z.infer<typeof attemptedCallResultSchema>;
