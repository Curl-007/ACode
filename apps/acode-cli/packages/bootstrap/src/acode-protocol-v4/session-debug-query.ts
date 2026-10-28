// v4 session debug 观测快照 query（M2-2，spec apps/acode-cli/specs/m2-2-session-control.md §2.4；
// 裁决 2026-10-28：sessionDebug 保留，新建 v4 query）。
//
// 实体放 v4 目录、server.ts 只留一行转发（M3 纪律，同 session-header-meta-query.ts 先例）。
// 观测存储（WeakMap 旁路 + 有界 rounds/networkEntries/cache）留在 legacy session-debug.ts
// 不动——事件写入（observeSessionDebug，server-operations.ts 接线）与读取（readSessionDebug）
// 都是既有件，本 handler 只是 v4 词表下的薄壳：
// params 校验 → requireSession（live record 定域，与 legacy session/debug 一致；
// 无 record 抛 sessionUnavailable，不做 headerMeta 式持久层冷读）→ 快照直通。
import {
  v4SessionDebugParamsSchema,
  type V4SessionDebugResult,
} from "@acode/shared/acode-protocol-v4";
import { readSessionDebug } from "../acode-protocol/session-debug.js";
import {
  parseParams,
  requireSession,
  type ACodeProtocolAgentServerContext,
} from "../acode-protocol/server-types.js";

export function querySessionDebugV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): V4SessionDebugResult {
  const params = parseParams(v4SessionDebugParamsSchema, rawParams);
  return readSessionDebug(requireSession(context, params.sessionId));
}
