// ============================================================
// Session Event model payloads - 模型请求/流式/网络/完成/异常载荷
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session.events.ts（1373 行）按主题拆叶，
// 本文件承载模型侧载荷（request/selected/streaming/network/anomaly/complete/error）。
// 依赖方向（DAG）：shared.js / model/index（类型）/ interfaces/http-client.port /
// support 叶 → 本文件 → factory 叶 → session.events.ts 桶。

import type { MessageId, PartId, ToolCallId } from "../interfaces/shared.js";
import type {
  ModelNetworkStatusEvent,
  ModelSelection,
  ModelUsage,
} from "../model/index.js";
import type { HttpClientEgressInfo } from "../interfaces/http-client.port.js";
import type { ErrorPayload, ModelMessage, TokenUsage } from "./session-event-support.js";

export interface ModelRequestPayload {
  messages: ModelMessage[];
  providerId: string;
  modelId: string;
  querySource?: string;
  temperature?: number;
  maxTokens?: number;
}

// ModelEvent Payloads
export type ModelSelectionOrigin = "registryFallback";

export interface ModelSelectedPayload {
  modelSelection: ModelSelection;
  /** Active Model 已解析出的 reasoning，仅供执行事实/展示投影，不属于稀疏 Selection。 */
  effectiveReasoningLevel?: string;
  /** 缺失表示只更新当前选型；null 表示显式 ∅→selection 模型边界。 */
  previousModelSelection?: ModelSelection | null;
  /** 只有 Agent 自动恢复模型时携带；缺失表示普通选型或旧事件。 */
  origin?: ModelSelectionOrigin;
  /** 当前 selection 对应的思考档位能力；与模型选型同事件原子发布。 */
  supportedThoughtLevels?: string[];
  /** 当前 selection 在 runtime 实际应用的上下文窗口；null 表示显式清除，字段缺失兼容旧事件。 */
  contextWindow?: number | null;
}

// Streaming events
export type ModelStreamingKind =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_input_start"
  | "tool_input_delta"
  | "tool_input_end"
  | "tool_call"
  | "finish"
  | "error";

export interface ModelStreamingPayload {
  delta: string;
  done: boolean;
  kind?: ModelStreamingKind;
  assistantMessageId?: MessageId;
  partId?: PartId;
  toolCallId?: ToolCallId;
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

// Network status events
export type ModelNetworkStatusPayload = ModelNetworkStatusEvent;

// Model anomaly warning
export type ModelAnomalyWarningCategory =
  | "tool_call_budget"
  | "repeated_tool_call"
  | "provider_finish_mismatch"
  | "malformed_tool_call";

export type ModelAnomalyWarningSeverity = "info" | "warning";

export interface ModelAnomalyWarningPayload {
  category: ModelAnomalyWarningCategory;
  severity: ModelAnomalyWarningSeverity;
  observedCount?: number;
  threshold?: number;
  toolName?: string;
  toolCallId?: ToolCallId;
  warningInjected: boolean;
  modelVisibleMessageId?: MessageId;
}

// Network request status events
export type NetworkRequestSource = "http_client" | "model" | "tool" | "mcp" | "plugin" | "unknown";

export type NetworkRequestLifecycleStatus = "pending" | "complete" | "error";

export interface NetworkRequestStatusPayload {
  requestId: string;
  source: NetworkRequestSource;
  status: NetworkRequestLifecycleStatus;
  method: string;
  url: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  statusCode?: number;
  error?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  attempt?: number;
  egress?: HttpClientEgressInfo;
}

/**
 * prompt-cache miss 归因闭集（specs/prompt-cache-diagnostics.md R1）——因集唯一家。
 * shared 镜像 schema 用开放 record 不复刻枚举（版本偏斜安全：CLI 未来加因无需再动
 * shared）；闭集纪律由生产侧类型与单测钉住。phase 2 登记不实现：
 * system_prompt_changed / tools_changed（需 runtime hash 对比回路）。
 */
export const PROMPT_CACHE_MISS_CAUSES = [
  "conversation_rewind",
  "control_only_turn",
  "compaction",
  "context_refresh",
  "model_changed",
  "idle_ttl_suspected",
  "unknown",
] as const;

export type PromptCacheMissCause = (typeof PROMPT_CACHE_MISS_CAUSES)[number];

// ModelEvent Payloads
export interface ModelCompletePayload {
  cacheHit?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    latestHitRate: number | null;
    hitRate: number | null;
    hitRateRequestCount: number;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    /**
     * 进程内累计的 miss 归因计数快照（R2/R3）：随每个 main_turn ModelComplete 下发；
     * resume/rewind 重建后从空开始（tokens 可重建命中率、不可重建归因）。
     */
    missCauses?: Partial<Record<PromptCacheMissCause, number>>;
  };
  content: string;
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  contextWindow?: number;
  fileChanges?: TurnFileChangeSummary;
  /**
   * 生成耗时口径（specs/usage-statusbar.md 数据口径 3，producer = core
   * usage-observability computeGenerationMs）：含思考（reasoningTokens > 0）或无首字
   * 时间戳 = completedAt − startedAt；否则 = completedAt − firstTokenAt。
   * 仅主链路模型步发射点写入；sidecar/compact 等发射点与旧事件缺失。
   */
  generationMs?: number;
  querySource?: string;
  /**
   * 主链路实际服务本次请求的模型身份（turn-model-step 的 main_turn 发射点写入；
   * sidecar/compact/旧事件缺席——不造假值）。v4 投影按轮累计去重进
   * turnHeader.stats.servedModels；≥2 个不同模型 = 轮中模型晋升的用户可见面
   * （specs/usage-statusbar.md「多模型轮标记」，omp served-model marker 对应物）。
   */
  servedModel?: { providerId: string; modelId: string };
  stopReason: string;
  /** 首字延迟 ms（firstTokenAt − startedAt）；无首字时间戳的发射点缺失，不造假值。 */
  timeToFirstTokenMs?: number;
  /** 当前模型请求组装出的完整 tool call 数量；旧事件可能缺失。 */
  toolCallCount?: number;
  usage: TokenUsage | ModelUsage;
}

export interface TurnFileChangeSummary {
  additions: number;
  deletions: number;
  files: number;
  items: TurnFileChangeSummaryItem[];
}

export interface TurnFileChangeSummaryItem {
  additions: number;
  deletions: number;
  path: string;
  toolNames?: string[];
  writeCount: number;
}

export type ContextUsageBreakdownSource =
  | "system_prompt"
  | "meta_user_context"
  | "skills"
  | "tool_prompt"
  | "system_tool_schemas"
  | "mcp_tool_schemas"
  | "messages";

/**
 * 单次模型调用的上下文用量明细。事件侧与投影层使用同一结构，
 * 保证持久化事件与投影输出之间不引入两套口径。
 */
export interface ContextUsageBreakdownItem {
  source: ContextUsageBreakdownSource;
  chars: number;
}

export interface ModelErrorPayload {
  error: ErrorPayload;
  retryable: boolean;
}
