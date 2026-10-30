// 模型调用轨迹（model_io）投影类型：自 acodeTaskService.ts 拆出的纯类型叶子，
// 写入所有者仍是任务索引侧，本文件只承载只读派生视图的结构定义。

/** 一次模型请求里出现的消息内容片段（文本 / 工具调用 / 工具结果 / 其他原始结构）。 */
export type ACodeModelTrajectoryContentPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolCallId?: string; toolName: string; input?: unknown }
  | { kind: "tool-result"; toolCallId?: string; toolName?: string; output?: unknown }
  | { kind: "image"; mediaType?: string }
  | { kind: "unknown"; raw: unknown };

/** 单条对话消息（system / user / assistant / tool）。 */
export interface ACodeModelTrajectoryMessage {
  role: string;
  parts: ACodeModelTrajectoryContentPart[];
}

/** model_io 记录里归一化出来的 token 用量。 */
export interface ACodeModelTrajectoryUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

export type ACodeModelTrajectoryCallSourceKind =
  | "main"
  | "sidecar"
  | "subagent"
  | "compact"
  | "unknown";

export interface ACodeModelTrajectoryCallSource {
  kind: ACodeModelTrajectoryCallSourceKind;
  querySource?: string;
}

/**
 * 一次模型调用（一条 model_io 记录）。轨迹按时间顺序由多条调用组成。
 * request.messages 是该次请求发送给模型的完整上下文（随轮次增长），
 * response 是这次调用模型产出的新内容。
 */
export interface ACodeModelTrajectoryRecord {
  requestId: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  turnId?: string;
  traceId?: string;
  callSource?: ACodeModelTrajectoryCallSource;
  model: {
    modelId?: string;
    providerId?: string;
    role?: string;
    source?: string;
  };
  request: {
    messages: ACodeModelTrajectoryMessage[];
    toolNames: string[];
  };
  response?: {
    finishReason?: string;
    text?: string;
    reasoningText?: string;
    toolCalls: ACodeModelTrajectoryContentPart[];
    usage?: ACodeModelTrajectoryUsage;
    responseId?: string;
    modelId?: string;
  };
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/** 某个 task/session 的完整模型调用轨迹。 */
export interface ACodeModelTrajectory {
  taskId: string;
  /** runtime 是否支持读取 model-io 轨迹（仅 ACode Agent 落盘 model-io）。 */
  available: boolean;
  records: ACodeModelTrajectoryRecord[];
  /** 命中的源文件绝对路径，便于排查。 */
  sourceFiles: string[];
  /** 是否因为超出上限而截断（只保留最近 N 条）。 */
  truncated: boolean;
}
