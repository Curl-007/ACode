import type { LegacySkewFallbackMethod } from "@acode/shared";
import type { V4Method } from "@acode/shared/acode-protocol-v4";
import type { ACodeProtocolAgentServerContext, ACodeProtocolClientRequestOptions, ParamsSchema } from "./server-types.js";
import { ProtocolRequestError } from "./server-types.js";

/**
 * M2-7：v4 优先、-32601 回落 legacy 的双形态请求助手。
 *
 * CLI 出站反向 RPC（automation/offPeak 等）在偏斜窗口的发送形态：
 * - v4 命中（新 host 已登记 V4_METHODS）→ v4 形态生效；
 * - 旧 host 只认 legacy 方法，返回 -32601（方法不存在）→ 原参数回落 legacy 形态。
 * 两条路径的 params 逐字同形（wire 形态不变，只换方法名），结果形状两侧逐字一致，
 * 因此一次构造即可双发。
 *
 * 注意 -32601 是 host「不认识 v4 方法」的唯一可信信号；其它错误（含 -32021 取消）
 * 原样抛出，不做回落。legacy 回落路径的删除归属：M3（v4 全量切换后统一移除，
 * 见 docs/protocol-v4-migration-roadmap.md）。偏斜方向：新 CLI + 旧 host。
 */
export async function requestV4WithLegacyFallback<T>(
  context: Pick<ACodeProtocolAgentServerContext, "requestClient">,
  v4Method: V4Method,
  legacyMethod: LegacySkewFallbackMethod,
  params: unknown,
  v4ResultSchema: ParamsSchema<T>,
  legacyResultSchema: ParamsSchema<T>,
  options?: ACodeProtocolClientRequestOptions,
): Promise<T> {
  try {
    return await context.requestClient(v4Method, params, v4ResultSchema, options);
  } catch (error) {
    if (!(error instanceof ProtocolRequestError) || error.code !== -32601) {
      throw error;
    }
  }
  return context.requestClient(legacyMethod, params, legacyResultSchema, options);
}
