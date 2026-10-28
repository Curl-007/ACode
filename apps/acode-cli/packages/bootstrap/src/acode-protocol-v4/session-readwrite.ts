// M2-3 session 读写面六 query 的 CLI handler（spec apps/acode-cli/specs/
// m2-3-session-readwrite.md）。全部是薄转发：parse v4 params schema（值域与 legacy
// 逐字 parity）→ 调 server-operations.ts 的既有导出 op（op 内部以 legacy schema
// 重解析，幂等双解析）。实体不搬进 v4 目录——M3 收编 legacy 目录时随目录走
// （session-header-meta-query.ts 头注同一纪律）。
//
// - read/resume：返回 legacy ACodeSessionStateSnapshot 形态（renderer/facade 重度消费，
//   spec §2.4 不采 headerMeta+conversationSubscribe 拼接）。
// - resume 有冷恢复激活副作用（activateSessionForResume），等价 legacy session/resume。
// - subscribe：写 record.deliveryKind/legacyStreamSubscribed，原子返回同一水位
//   {eventSeq, events, snapshot?}（spec §6.2 换名承载 legacy 语义）。
import {
  v4SessionEventsParamsSchema,
  v4SessionMessagesParamsSchema,
  v4SessionReadParamsSchema,
  v4SessionResumeParamsSchema,
  v4SessionSubscribeParamsSchema,
  v4SessionsListParamsSchema,
} from "@acode/shared/acode-protocol-v4";
import {
  listSessions,
  readEvents,
  readMessages,
  readSession,
  resumeSession,
  subscribeSession,
} from "../acode-protocol/server-operations.js";
import {
  parseParams,
  type ACodeProtocolAgentServerContext,
} from "../acode-protocol/server-types.js";

export async function querySessionReadV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return readSession(context, parseParams(v4SessionReadParamsSchema, rawParams));
}

export async function querySessionResumeV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return resumeSession(context, parseParams(v4SessionResumeParamsSchema, rawParams));
}

export async function querySessionsListV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return listSessions(context, parseParams(v4SessionsListParamsSchema, rawParams));
}

export async function querySessionMessagesV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return readMessages(context, parseParams(v4SessionMessagesParamsSchema, rawParams));
}

export async function querySessionEventsV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return readEvents(context, parseParams(v4SessionEventsParamsSchema, rawParams));
}

export async function subscribeSessionV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return subscribeSession(context, parseParams(v4SessionSubscribeParamsSchema, rawParams));
}
