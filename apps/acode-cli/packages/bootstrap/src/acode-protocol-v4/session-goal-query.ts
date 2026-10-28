// v4 goal 状态 query（M2-2，spec apps/acode-cli/specs/m2-2-session-control.md §2.2）：
// legacy session/goal action:"show" 的读形态。只读、无状态、超时重发安全。
//
// live record 定域（requireSession）：goal 的权威是 runtime target 面（app.readTarget），
// 刻意不做 headerMeta 式持久层冷读——session_headerMeta 读持久层是因为归档会话没有 live
// record，而 goal show 的调用场景（facade goalSession action=show）必经活跃会话。
//
// supported 维度承载 legacy「Goal management is not available in this client.」分支
// （app.readTarget 缺席的 client kind）；supported=true && target=null = 有能无目标。
// wire 形态复用 acodeSessionGoalSchema，收窄走既有 mapSessionGoal（session-mapper.ts）。
import {
  v4SessionGoalQueryParamsSchema,
  type V4SessionGoalQueryResult,
} from "@acode/shared/acode-protocol-v4";
import { mapSessionGoal } from "../acode-protocol/session-mapper.js";
import {
  parseParams,
  requireSession,
  type ACodeProtocolAgentServerContext,
} from "../acode-protocol/server-types.js";

export async function querySessionGoalV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4SessionGoalQueryResult> {
  const params = parseParams(v4SessionGoalQueryParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  if (typeof record.app.readTarget !== "function") {
    return { supported: false };
  }
  const target = await record.app.readTarget();
  return { supported: true, target: mapSessionGoal(target) ?? null };
}
