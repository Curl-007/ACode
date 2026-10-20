/* eslint-disable max-lines -- 存量基线豁免:该文件先于 CLI lint 门禁建立即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,turbo lint 因此从未变绿)。头注豁免以恢复门禁信号;拆分重构超出本批范围。 */
// ============================================================
// Message History - Maintains conversation context across turns
// ============================================================

import {
  type RuntimeInputPresentation,
  modelMessageContentToText,
  type ModelCacheControl,
  type ModelCallWrapper,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type Model,
  type ModelReasoningContentBlock,
  type ModelToolCall,
  type TokenUsageInfo,
  type ToolSearchAnnouncement,
} from "@acode/contracts";
import { SYSTEM_REMINDER_SOURCES, type SystemReminderSource } from "../system-reminder/source.js";

// Tool call from model (simple type, no brand)
export interface ToolCallInput {
  /**
   * 包装标记（specs/tool-search.md R6）：内部历史统一用目标工具名与内层参数，
   * 标记仅为严格字面量 "DeferredToolCall"；provider 渲染经 toModelToolCall 恢复
   * 包装形态并剥离标记，内部消费者始终读取目标 name/input。
   */
  modelCallWrapper?: ModelCallWrapper;
  id: string;
  name: string;
  input: unknown;
}

/** 仅模型协议出口使用：带标记的调用恢复为 DeferredToolCall + {name, input} 包装形态。 */
export function toModelToolCall(call: ToolCallInput): ModelToolCall {
  if (!call.modelCallWrapper) return call;
  return {
    id: call.id,
    name: call.modelCallWrapper,
    input: { name: call.name, input: call.input },
  };
}

export type ReasoningContentInput = ModelReasoningContentBlock;

export interface ModelInputMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
  cacheControl?: ModelCacheControl;
  toolCalls?: ToolCallInput[];
  toolCallId?: string;
  toolName?: string;
  /** tool 结果消息的包装标记（R6）：渲染时 toolName 恢复为外层名并剥离标记。 */
  modelCallWrapper?: ModelCallWrapper;
  isError?: boolean;
  providerId?: Model["providerId"];
  modelId?: Model["modelId"];
}

export type RuntimeMessageSource =
  | SystemReminderSource
  | "shared_context"
  | "real_user"
  | "legacy_synthetic";

export interface RuntimeMessageMetadata {
  source: RuntimeMessageSource;
  inputPresentation?: RuntimeInputPresentation;
  /**
   * compact 边界携带的发现元数据（specs/tool-search.md R8/R10）：检查点提升名单的
   * 读侧事实源；写侧在 compact 边界 payload（preCompactDiscoveredTools），冷恢复
   * 水合（agent/tool-search-hydration.ts）时回填到这里。
   */
  compactBoundary?: {
    boundaryId?: string;
    preCompactDiscoveredTools?: readonly string[];
  };
  /** 工具搜索公告的增量事实（readded ⊆ added 由契约 schema 保证）。 */
  toolSearchAnnouncement?: ToolSearchAnnouncement;
}

export interface RuntimeMessageMessageEntry {
  kind?: "message";
  message: ModelInputMessage;
  metadata?: RuntimeMessageMetadata;
  /** 已提交 assistant 自己的 provider tokens；不会发送到 provider。 */
  tokens?: TokenUsageInfo;
  /** 仅在当前 query 内生效；不得进入 canonical history 或 Session persistence。 */
  queryScope?: "output_token_continuation";
}

export interface RuntimeAttachmentEntry {
  kind: "attachment";
  content: string;
  cacheControl?: ModelCacheControl;
  metadata: RuntimeMessageMetadata;
}

export type RuntimeMessageEntry = RuntimeMessageMessageEntry | RuntimeAttachmentEntry;

export interface CacheStats {
  totalMessages: number;
  cachedMessages: number;
  lastCacheHit: boolean;
  cacheReadTokens?: number;
}

// ============================================================
// Message History Interface
// ============================================================

export interface MessageHistory {
  // Initialize with optional system prompt or context prefix messages
  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void;

  // Add user message
  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void;

  // Add structured internal context that provider projection renders at request time.
  addAttachment(source: SystemReminderSource, content: string): void;

  // Add already-built runtime entries while preserving their source metadata.
  addEntries(entries: readonly RuntimeMessageEntry[]): void;

  // Add assistant message (may include tool calls)
  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void;

  // Add tool result
  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError?: boolean,
    modelCallWrapper?: ModelCallWrapper,
  ): void;

  // 借用当前权威 entries，只允许同步只读；跨异步边界时由调用方做数组浅快照。
  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[];

  // 创建可写的防御性副本；Runtime 内部普通只读点应使用 borrowReadOnlyRuntimeEntries。
  toRuntimeEntries(): RuntimeMessageEntry[];

  // Replace the active provider-visible history after compact/rewind.
  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void;

  // Get current message count
  getMessageCount(): number;

  // Cache management
  getCacheStats(): CacheStats;
  setCacheHit(tokens?: number): void;
  setCacheMiss(): void;

  // Reset for new turn
  reset(): void;
}

// ============================================================
// Message History Implementation
// ============================================================

export class MessageHistoryImpl implements MessageHistory {
  private entries: RuntimeMessageEntry[] = [];
  private cacheStats: CacheStats = {
    totalMessages: 0,
    cachedMessages: 0,
    lastCacheHit: false,
  };

  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void {
    this.entries = [];

    if (typeof systemPromptOrMessages === "string" && systemPromptOrMessages.length > 0) {
      this.entries.push({
        message: {
          role: "system",
          content: systemPromptOrMessages,
        },
      });
    } else if (Array.isArray(systemPromptOrMessages)) {
      this.entries.push(...systemPromptOrMessages.map(cloneEntryInput));
    }

    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void {
    this.entries.push(createRuntimeUserEntry(content, metadata));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAttachment(source: SystemReminderSource, content: string): void {
    this.entries.push(systemReminderAttachmentEntry(source, content));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addEntries(entries: readonly RuntimeMessageEntry[]): void {
    this.entries.push(...entries.map(cloneRuntimeMessageEntry));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void {
    const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
    this.entries.push({
      message: {
        role: "assistant",
        content:
          reasoningBlocks.length > 0
            ? [
                ...reasoningBlocks,
                ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
              ]
            : content,
        toolCalls: toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
          ...(tc.modelCallWrapper ? { modelCallWrapper: tc.modelCallWrapper } : {}),
        })),
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
      },
      ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
    });
    this.cacheStats.totalMessages = this.entries.length;
  }

  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError = !success,
    modelCallWrapper?: ModelCallWrapper,
  ): void {
    this.entries.push(
      createRuntimeToolResultEntry(toolCallId, toolName, content, isError, modelCallWrapper),
    );
    this.cacheStats.totalMessages = this.entries.length;
  }

  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[] {
    return this.entries;
  }

  toRuntimeEntries(): RuntimeMessageEntry[] {
    return this.entries.map(cloneRuntimeMessageEntry);
  }

  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void {
    // 身份复用（specs/stable-prefix-pause-gate.md R2）：入参中与当前 entries[i]
    // 引用相等的项保留原对象——旧 turn 永不重序列化/重克隆。每 turn 的
    // context-refresh 传入 [...新前缀, ...borrowReadOnlyRuntimeEntries().slice(n)]，
    // 会话尾部引用相等 ⇒ 零重拷贝；前缀计数变化导致引用不对位时自动退化为
    // 全量克隆，正确性不依赖对位假设。复用不引入新别名：被复用对象本来就是
    // history 自己的 entries。
    const previous = this.entries;
    this.entries = messages.map((item, index) =>
      index < previous.length && item === previous[index]
        ? previous[index]
        : cloneEntryInput(item),
    );
    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  getMessageCount(): number {
    return this.entries.length;
  }

  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  setCacheHit(tokens?: number): void {
    this.cacheStats.lastCacheHit = true;
    this.cacheStats.cacheReadTokens = tokens;
    // Mark all messages as potentially cached
    this.cacheStats.cachedMessages = this.entries.length;
  }

  setCacheMiss(): void {
    this.cacheStats.lastCacheHit = false;
    this.cacheStats.cacheReadTokens = undefined;
    this.cacheStats.cachedMessages = countContextPrefixMessages(this.entries);
  }

  reset(): void {
    const contextPrefixMessages = this.entries.slice(0, countContextPrefixMessages(this.entries));
    this.entries = contextPrefixMessages.map(cloneRuntimeMessageEntry);
    this.cacheStats = {
      totalMessages: contextPrefixMessages.length,
      cachedMessages: contextPrefixMessages.length,
      lastCacheHit: false,
    };
  }
}

export function countContextPrefixMessages(
  messagesOrEntries: readonly (ModelInputMessage | RuntimeMessageEntry)[],
): number {
  let count = 0;
  for (const item of messagesOrEntries) {
    if (isRuntimeAttachmentEntry(item)) {
      if (item.metadata.source === "context_prefix" || item.metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    const message = messageFromEntryInput(item);
    const metadata = metadataFromEntryInput(item);
    if (message.role === "system") {
      count++;
      continue;
    }
    if (message.role !== "user") break;
    if (metadata) {
      if (metadata.source === "context_prefix" || metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    if (isMetaUserContext(message.content)) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

function isMetaUserContext(content: ModelMessageContent): boolean {
  return modelMessageContentToText(content).trimStart().startsWith("<system-reminder>");
}

export function systemReminderRuntimeMetadata(
  source: SystemReminderSource,
): RuntimeMessageMetadata {
  return { source };
}

export function realUserRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "real_user" };
}

export function legacySyntheticRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "legacy_synthetic" };
}

export function todoReminderRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "todo_reminder" };
}

export function systemReminderAttachmentEntry(
  source: SystemReminderSource,
  content: string,
): RuntimeAttachmentEntry {
  return {
    kind: "attachment",
    content,
    metadata: systemReminderRuntimeMetadata(source),
  };
}

export function createRuntimeUserEntry(
  content: ModelMessageContent,
  metadata?: RuntimeMessageMetadata,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "user",
      content,
    },
    metadata: cloneRuntimeMessageMetadata(metadata),
  };
}

export function createRuntimeAssistantEntry(
  content: string,
  toolCalls?: readonly ToolCallInput[],
  reasoning?: readonly ReasoningContentInput[],
  model?: Pick<Model, "providerId" | "modelId">,
  tokens?: TokenUsageInfo,
): RuntimeMessageMessageEntry {
  const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
  return {
    message: {
      role: "assistant",
      content:
        reasoningBlocks.length > 0
          ? [
              ...reasoningBlocks,
              ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
            ]
          : content,
      toolCalls: toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        ...(toolCall.modelCallWrapper ? { modelCallWrapper: toolCall.modelCallWrapper } : {}),
      })),
      ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
    },
    ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
  };
}

export function createRuntimeToolResultEntry(
  toolCallId: string,
  toolName: string,
  content: ModelMessageContent,
  isError: boolean,
  modelCallWrapper?: ModelCallWrapper,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "tool",
      content,
      toolCallId,
      toolName,
      isError,
      // 包装标记（R6）：内部历史用目标名，provider 渲染恢复外层名后剥离。
      ...(modelCallWrapper ? { modelCallWrapper } : {}),
    },
  };
}

export function isKnownSystemReminderSource(value: unknown): value is SystemReminderSource {
  return (
    typeof value === "string" && SYSTEM_REMINDER_SOURCES.includes(value as SystemReminderSource)
  );
}

function cloneEntryInput(input: ModelInputMessage | RuntimeMessageEntry): RuntimeMessageEntry {
  if (isRuntimeMessageEntry(input)) {
    return cloneRuntimeMessageEntry(input);
  }
  return { message: cloneModelInputMessage(input) };
}

export function cloneRuntimeMessageEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  if (entry.kind === "attachment") {
    return {
      kind: "attachment",
      content: entry.content,
      cacheControl: entry.cacheControl ? { ...entry.cacheControl } : undefined,
      metadata: cloneRuntimeMessageMetadata(entry.metadata)!,
    };
  }
  return {
    message: cloneModelInputMessage(entry.message),
    metadata: cloneRuntimeMessageMetadata(entry.metadata),
    ...(entry.tokens ? { tokens: cloneTokenUsageInfo(entry.tokens) } : {}),
    ...(entry.queryScope ? { queryScope: entry.queryScope } : {}),
  };
}

/**
 * Compact 之后 preserved assistant 的 provider usage 仍属于被替换的旧前缀。
 * 只对 projection 副本清零，不能改写 SessionStore 中的原始 tokens。
 */
export function invalidateRuntimeTokenUsage(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

function cloneTokenUsageInfo(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    cache: { ...tokens.cache },
  };
}

function cloneRuntimeMessageMetadata(
  metadata: RuntimeMessageMetadata | undefined,
): RuntimeMessageMetadata | undefined {
  return metadata ? { ...metadata } : undefined;
}

function messageFromEntryInput(input: ModelInputMessage | RuntimeMessageEntry): ModelInputMessage {
  if (isRuntimeAttachmentEntry(input)) {
    throw new Error("Runtime attachment entries do not have a direct model message representation");
  }
  return isRuntimeMessageEntry(input) ? input.message : input;
}

function metadataFromEntryInput(
  input: ModelInputMessage | RuntimeMessageEntry,
): RuntimeMessageMetadata | undefined {
  return isRuntimeMessageEntry(input) ? input.metadata : undefined;
}

function isRuntimeMessageEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeMessageEntry {
  return "message" in input || ("kind" in input && input.kind === "attachment");
}

export function isRuntimeAttachmentEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeAttachmentEntry {
  return isRuntimeMessageEntry(input) && "kind" in input && input.kind === "attachment";
}

export function cloneModelInputMessage(message: ModelInputMessage): ModelInputMessage {
  const next: ModelInputMessage = {
    role: message.role,
    content: cloneModelMessageContent(message.content),
  };
  if (message.cacheControl) next.cacheControl = { ...message.cacheControl };
  if (message.toolCalls) next.toolCalls = message.toolCalls.map((toolCall) => ({ ...toolCall }));
  if (message.toolCallId) next.toolCallId = message.toolCallId;
  // 空字符串是可恢复调用的 provider 原始名称，不能在 request-local clone 时按 falsy 丢失。
  if (message.toolName !== undefined) next.toolName = message.toolName;
  // 包装标记随历史复制/分支恢复保留（R6）；渲染层剥离只发生在 request-local clone 上。
  if (message.modelCallWrapper) next.modelCallWrapper = message.modelCallWrapper;
  if (message.isError !== undefined) next.isError = message.isError;
  if (message.providerId) next.providerId = message.providerId;
  if (message.modelId) next.modelId = message.modelId;
  return next;
}

function cloneReasoningBlock(block: ReasoningContentInput): ReasoningContentInput {
  return {
    ...block,
    providerOptions: block.providerOptions ? { ...block.providerOptions } : undefined,
  };
}

export function cloneModelMessageContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map(cloneModelMessageContentBlock);
}

function cloneModelMessageContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  if (block.type === "reasoning") {
    return cloneReasoningBlock(block);
  }
  if ("source" in block && block.source) {
    return { ...block, source: { ...block.source } };
  }
  return { ...block };
}

// ============================================================
// Factory
// ============================================================

export function createMessageHistory(): MessageHistory {
  return new MessageHistoryImpl();
}
