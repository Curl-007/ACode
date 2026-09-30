import { CompactTrigger } from "@acode/contracts";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@acode/shared";
import type {
  CompactBoundaryPayload,
  CompactPhase,
  CompactPreservedSegment,
  CompactReason,
  CompactTrigger as CompactTriggerValue,
  MessageId,
  ModelMessageContent,
  TraceContext,
} from "@acode/contracts";
import { modelMessageContentBlockToText, modelMessageContentToText } from "@acode/contracts";
import type { ModelMessageContentBlock } from "@acode/contracts";
import { groupByAssistantStartedRounds } from "./rounds.js";

const EMPTY_TOOL_CALL_INPUT_JSON = "{}";

/**
 * 内联 base64 媒体（image / video / 无正文的 file 附件）在本地 token 估算中的平价计费。
 *
 * 机制参照 jcode (MIT) crates/jcode-compaction-core/src/lib.rs:45-58（IMAGE_TOKEN_COST），自撰实现。
 *
 * 两个相反方向都会让 auto compact 阈值失真：
 * - 按 base64 长度 ÷ 字符除数计费会把一张截图放大成十几万 token（jcode 记录的事故：
 *   高估约 100 倍 → 连续三次压缩仍降不下来，因为图片就留在保留轮次里）；
 * - ACode 之前走 `modelMessageContentBlockToText` 的占位文本，一张 400KB 的截图只计 7 token
 *   （实测：`[Attached image/png]` 20 字符 ÷ 除数 3），无 usage anchor 时阈值等于看不见图片——
 *   首轮带图、以及 compact 之后 preserved 尾巴的 assistant usage 被清零
 *   （`runtime/helpers/compact.ts` 的 `cloneCompactPreservedRuntimeEntry`）都会落到这个分支。
 *
 * provider 按分辨率/采样帧计费而不是按传输编码长度，所以这里按「块」平价计费，
 * 取 Anthropic 单张图片的 token 上界量级；宁可略高也不要回到 ~0。
 * 该常量只服务于估算轨道：一旦拿到 provider usage，`shouldAutoCompact` 会以
 * `tokenSource: "provider_usage"` 覆盖本地估算。
 */
export const COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS = 1_600;

export interface CompactModelMessage {
  role: string;
  content: ModelMessageContent;
  toolCalls?: readonly {
    name: string;
    input: unknown;
  }[];
}

export interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface BuildManualCompactBoundaryInput {
  autoCompactThreshold?: number;
  boundaryId: string;
  compactReason?: CompactReason;
  customInstructions?: string;
  keptMessageCount?: number;
  lastSummarizedMessageId?: MessageId;
  phase?: CompactPhase;
  postCompactTokenCount?: number;
  preservedSegment?: CompactPreservedSegment;
  preCompactTokenCount: number;
  summarizedMessageCount: number;
  summaryMessageId: MessageId;
  traceContext: TraceContext;
  trigger?: CompactTriggerValue;
  truePostCompactTokenCount?: number;
  willRetriggerNextTurn?: boolean;
}

export const MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3;
export const COMPACT_PROMPT_TOO_LONG_RETRY_MARKER =
  "[earlier conversation truncated for compaction retry]";
export const COMPACT_PROMPT_TOO_LONG_USER_MESSAGE =
  "Conversation too long to compact automatically. Try /compact again after narrowing the active context.";

export function getMessagesToSummarize(
  messages: readonly CompactModelMessage[],
): CompactModelMessage[] {
  return messages
    .filter((message) => !isContextPrefixMessage(message))
    .map((message) => ({ ...message }));
}

export function hasEnoughMessagesToCompact(messages: readonly CompactModelMessage[]): boolean {
  const messagesToSummarize = getMessagesToSummarize(messages);
  return (
    groupMessagesByCompactRound(messagesToSummarize).length >= 2 &&
    messagesToSummarize.some((message) => message.role === "assistant")
  );
}

export function buildManualCompactBoundary(
  input: BuildManualCompactBoundaryInput,
): CompactBoundaryPayload {
  return {
    boundaryId: input.boundaryId,
    trigger: input.trigger ?? CompactTrigger.Manual,
    phase: input.phase,
    compactReason: input.compactReason,
    summarySource: "model",
    preCompactTokenCount: input.preCompactTokenCount,
    postCompactTokenCount: input.postCompactTokenCount,
    truePostCompactTokenCount: input.truePostCompactTokenCount,
    autoCompactThreshold: input.autoCompactThreshold,
    willRetriggerNextTurn: input.willRetriggerNextTurn,
    summarizedMessageCount: input.summarizedMessageCount,
    keptMessageCount: input.keptMessageCount ?? 0,
    lastSummarizedMessageId: input.lastSummarizedMessageId,
    preservedSegment: input.preservedSegment,
    summaryMessageIds: [input.summaryMessageId],
    customInstructions: input.customInstructions !== undefined,
    traceId: input.traceContext.traceId,
    turnId: input.traceContext.turnId,
  };
}

export function estimateMessageTokens(messages: readonly CompactModelMessage[]): number {
  return messages.reduce((total, message) => {
    const projection = projectMessageContentForTokenEstimate(message.content);
    let estimatedCharacterCount = projection.text.length;
    // assistant toolCalls 独立保存在 content 之外，旧估算只读取 content，
    // 大型工具入参会被完整发给 provider，却在 auto compact 和 preflight 中计为 0。
    for (const toolCall of message.toolCalls ?? []) {
      estimatedCharacterCount += (
        toolCall.name + stringifyToolCallInputForTokenEstimate(toolCall.input)
      ).length;
    }
    // 媒体走平价计费而不是字符投影，因此不能并入 estimatedCharacterCount 再除以除数。
    return (
      total +
      Math.ceil(estimatedCharacterCount / ESTIMATED_TOKEN_CHAR_DIVISOR) +
      projection.inlineMediaTokens
    );
  }, 0);
}

interface TokenEstimateProjection {
  inlineMediaTokens: number;
  text: string;
}

function stringifyToolCallInputForTokenEstimate(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? EMPTY_TOOL_CALL_INPUT_JSON;
  } catch {
    // tool_use 解析失败时降级为空对象的 JSON 表示，供 estimator 估算。
    // ACode 的模型输入仍可能包含未知内容；异常输入不能让本地预算估算中断 compact。
    return EMPTY_TOOL_CALL_INPUT_JSON;
  }
}

function projectMessageContentForTokenEstimate(
  content: ModelMessageContent,
): TokenEstimateProjection {
  if (typeof content === "string") return { inlineMediaTokens: 0, text: content };

  // modelMessageContentToText 是“可见正文”投影，会有意隐藏 reasoning；
  // compact fallback 却把它当作 provider 上下文体积，导致无 usage anchor 时 reasoning 全部计 0。
  // token 估算使用独立投影，避免改变正文、memory、错误文案等既有消费者的语义。
  // 同理，内联媒体在这里按块平价计费，`modelMessageContentBlockToText` 的占位文本语义保持不动。
  const textParts: string[] = [];
  let inlineMediaTokens = 0;
  for (const block of content) {
    if (block.type === "reasoning") {
      if (block.text.length > 0) textParts.push(block.text);
      continue;
    }
    if (isInlineMediaBlockForTokenEstimate(block)) {
      inlineMediaTokens += COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS;
      continue;
    }
    const text = modelMessageContentBlockToText(block);
    if (text.length > 0) textParts.push(text);
  }

  return { inlineMediaTokens, text: textParts.join("\n\n") };
}

function isInlineMediaBlockForTokenEstimate(block: ModelMessageContentBlock): boolean {
  if (block.type === "image" || block.type === "video") return true;
  // 带正文的 file 块按正文计费（既有语义）；只有 dataUrl/uri 的附件（PDF 等）
  // 与图片同源——provider 会真正 ingest 它，占位文本却只值几个 token。
  return (
    block.type === "file" &&
    (block.text === undefined || block.text.length === 0) &&
    (Boolean(block.dataUrl) || Boolean(block.uri))
  );
}

function isContextPrefixMessage<T extends CompactModelMessage>(message: T): boolean {
  return (
    message.role === "system" ||
    (message.role === "user" &&
      modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>"))
  );
}

function groupMessagesByCompactRound<T extends CompactModelMessage>(messages: readonly T[]): T[][] {
  return groupByAssistantStartedRounds(messages, (message) => message.role);
}

export function getUsageTotalTokens(usage?: TokenUsageLike): number {
  const inputTokens =
    usage?.inputTokens ?? (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
  return usage?.totalTokens ?? inputTokens + (usage?.outputTokens ?? 0);
}

export function createCompactBoundaryId(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return `compact_${randomUUID()}`;
}
