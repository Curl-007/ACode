// ============================================================
// Session Store messages - user/assistant message records
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session-store.port.ts（1282 行）按主题拆叶，
// 本文件承载消息记录类型（user/assistant info、summary、format）。
// FileDiff 放在本叶而非 session 叶：MessageSummary.diffs 依赖它，若 FileDiff 住在
// session 叶，则 message→session→parts→message 成环；下沉本叶后依赖方向保持 DAG。
// 依赖方向（DAG）：shared.js / model/index / context-source.port / session-shared /
// session-store-vocab → 本文件 → parts 叶 → session 叶 → port 叶 → session-store.port.ts 桶。
// 断环纪律：MessageVisibility / SyntheticUserMessageSource 的权威定义在 session-shared.ts。

import type { MessageId, SessionId } from "./shared.js";
import type { ModelId, ModelProviderId, ModelSelection } from "../model/index.js";
import type { EnvInfo } from "./context-source.port.js";
import type { MessageVisibility, SyntheticUserMessageSource } from "./session-shared.js";
import type { MessageSemantics, MessageProjectionAnchor } from "./session-store-vocab.js";

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  oldPath?: string;
  newPath?: string;
}

export type OutputFormat =
  | { type: "text" }
  | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };

export interface MessageSummary {
  title?: string;
  body?: string;
  diffs: FileDiff[];
}

export interface MessageContextSnapshot {
  envInfo?: EnvInfo;
}

export interface UserMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "user";
  time: {
    created: number;
  };
  format?: OutputFormat;
  summary?: MessageSummary;
  agent: string;
  /** 未绑定会话的合成消息、缺少模型信息的旧消息不伪造请求来源。 */
  modelSelection?: ModelSelection;
  system?: string;
  tools?: Record<string, boolean>;
  contextSnapshot?: MessageContextSnapshot;
  synthetic?: boolean;
  source?: SyntheticUserMessageSource;
  visibility?: MessageVisibility;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  metadata?: Record<string, unknown>;
}

export interface AssistantErrorInfo {
  name: string;
  data?: Record<string, unknown>;
}

export interface TokenUsageInfo {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface AssistantMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  error?: AssistantErrorInfo;
  parentID: MessageId;
  /** 真正模型输出应携带来源；历史恢复的合成时间线允许没有执行模型。 */
  modelId?: ModelId;
  providerId?: ModelProviderId;
  mode: string;
  /** 当前输出对应的 Plan 状态；旧记录缺失时按旧 mode 解释，不回填历史。 */
  planEnabled?: boolean;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: TokenUsageInfo;
  structured?: unknown;
  reasoningLevel?: string;
  finish?: string;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  /** 附加领域语义（fork copy 的 forkOrigin provenance 等）。 */
  metadata?: Record<string, unknown>;
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo;
