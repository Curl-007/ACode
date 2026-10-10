import type { SessionId } from "./shared.js";

export interface SessionMailboxEnvelope {
  version: 1;
  messageId: string;
  fromSessionId: SessionId;
  toSessionId: SessionId;
  content: string;
  createdAt: string;
}

/**
 * 写入方入参（编排方案 Phase 5 P1，specs/agent-peer-messaging-cross-process.md R1）：
 * 信封身份（messageId/createdAt/fromSessionId）由调用方铸造，适配器不生成、不改写——
 * 身份单点在发送路径（peer port），落盘只是事实持久化。
 */
export interface SessionMailboxDeliverInput {
  content: string;
  fromSessionId: SessionId;
  messageId: string;
  toSessionId: SessionId;
  /** ISO 时间戳；缺省 now。落盘文件名按它排序，drain 顺序 = 发送顺序。 */
  createdAt?: string;
}

export interface SessionMailboxPort {
  deliver(input: SessionMailboxDeliverInput): Promise<void>;
  drainUnread(
    input: { sessionId: SessionId; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]>;
}
