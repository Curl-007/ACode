/**
 * 会话行分页读取器（conversation-export 专用薄包装）。
 *
 * ACode1 当前还没有完整的 conversation-share 落地；为让 conversationExportService
 * 编译通过，stub 出一个最小实现：声明契约接口并把"读取全量"委托到 agent service 的
 * 单一分页调用（readAllConversationRows 退化为 readConversationRowsPage 一次拉满）。
 *
 * 后续接 conversation-share 时，把 readAllConversationRows 改为真正的游标分页即可，
 * 调用面契约（ConversationRowsReaderAgentService / readAllConversationRows / readConversationRowsPage）
 * 与 anker-code 保持一致。
 */

import type { IACodeAgentService } from "../acode-agent/acodeAgent.js";

export type ConversationRowsReaderAgentService = Pick<
  IACodeAgentService,
  "conversationRowsRangeV4"
>;

export interface ConversationRowsReadInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

export interface ConversationRowsRead {
  rows: ReadonlyArray<unknown>;
  revision: number;
  logEpoch: string;
}

interface RowsRangeResult {
  rows: ReadonlyArray<unknown>;
  atLogEpoch: string;
  atRevision: number;
  hasMore: boolean;
}

export async function readConversationRowsPage(
  agentService: ConversationRowsReaderAgentService,
  input: ConversationRowsReadInput,
): Promise<RowsRangeResult> {
  return agentService.conversationRowsRangeV4({
    workspacePath: input.workspacePath,
    ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
    ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
    sessionId: input.sessionId,
  });
}

export async function readAllConversationRows(
  agentService: ConversationRowsReaderAgentService,
  input: ConversationRowsReadInput,
): Promise<ConversationRowsRead> {
  // stub：单次拉全量；真正的分页 + 水位校验由后续 conversation-share 落地
  const page = await readConversationRowsPage(agentService, input);
  return {
    rows: page.rows,
    revision: page.atRevision,
    logEpoch: page.atLogEpoch,
  };
}
