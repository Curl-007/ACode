// ============================================================
// jcode 桥接：ACP session/update → ACode SessionEvent 翻译层（spec R2/R3）
//
// 本模块是 shim 的核心：把 jcode 的 ACP 事件流翻译成 v4 投影引擎能消费的
// SessionEvent 序列。纯内存状态机，无外部 I/O，可直接单测。
//
// 必须遵守 v4 投影的顺序不变量（product-projection.ts，违反则 row 静默丢失）：
//   1. SessionCreated → TurnStarted(executionKind:"agent") → 工具/流事件
//      → ModelComplete → TurnComplete/TurnError。
//   2. TurnStarted 必须最先让 phase=running；工具与流式 reducer 首行都是
//      `if (!this.isRunning()) return []`（:2398/:2919/:2978/:3011/:3095）。
//   3. 工具三段 Scheduled（建 row）→ Started（running）→ Result（终态），
//      后两段靠 toolCallId findToolRow，row 不存在即静默返回 []。
//   4. 同一轮所有事件的 turnId 必须一致（productTurnId 归属靠它）。
//   5. 对话文本只能走 ModelStreaming（text_start/text_delta/text_end）——
//      UserMessage/AssistantMessage 在 v4 reduce() 里**没有 case**，发了不产 row。
//
// jcode 侧无源、必须合成的字段（spike §3 实测确认）：turnId（jcode 无一等 turn id）、
// assistantMessageId（ACP 的 agent_message_chunk 不带 message id）、文本三段边界
// （ACP 只给 chunk，无 start/end 语义）、turnNumber、tokenCount/toolCallCount/duration。
// ============================================================

import { SessionEventType } from "@acode/contracts";

import { ACP_SESSION_UPDATE_KIND, ACP_TOOL_STATUS } from "./constants.js";
import type { AcpSessionUpdate, TranslatedSessionEvent, TranslatorDeps } from "./acp-types.js";

/** 单个进行中工具调用的翻译态。 */
interface InFlightTool {
  toolCallId: string;
  toolName: string;
  started: boolean;
}

/**
 * 每会话一个翻译器实例。
 *
 * 状态所有权（spec R3）：turnId 分配与封口、文本消息分段、工具三段归并全部归 shim。
 * jcode 的 16–27 个 tool_call_update 增量帧必须按 toolCallId 归并成一个 row，
 * 不得逐帧建 row（spec 验收场景 3）。
 */
export class JcodeEventTranslator {
  private seq = 0;
  private turnCount = 0;
  private currentTurnId: string | null = null;
  /** 当前打开的 assistant 文本消息 id；null = 无打开的文本段。 */
  private openTextMessageId: string | null = null;
  private textChunkOrdinal = 0;
  private readonly tools = new Map<string, InFlightTool>();
  private toolCallCount = 0;
  private lastUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  private turnStartedAt = 0;
  private sessionCreated = false;
  private readonly accumulatedText: string[] = [];

  constructor(private readonly deps: TranslatorDeps) {}

  /** 会话建立时发一次 SessionCreated（顺序不变量 1 的第一步）。 */
  sessionCreatedEvent(): TranslatedSessionEvent | null {
    if (this.sessionCreated) return null;
    this.sessionCreated = true;
    // turnId 用占位：SessionCreated 是 draft 语义，不产 row、不推进 phase
    // （product-projection.ts:1790-1795），归属哪一轮无意义。
    return this.make(SessionEventType.SessionCreated, this.currentTurnId ?? "turn-0", {
      mode: this.deps.defaultMode,
      contextWindow: this.deps.defaultContextWindow,
    });
  }

  /**
   * 一轮开始：shim 合成 turnId 并发 TurnStarted。
   *
   * 触发点是 v4 sendText 命令被 admission 接受时（spec R3 turn 合成规则），
   * 不是 jcode 事件——jcode 无 turn 边界信号。
   */
  beginTurn(userInput: string, messageId: string): TranslatedSessionEvent {
    this.turnCount += 1;
    this.currentTurnId = `jcode-turn-${this.turnCount}`;
    this.toolCallCount = 0;
    this.accumulatedText.length = 0;
    this.openTextMessageId = null;
    this.turnStartedAt = this.deps.now();
    return this.make(SessionEventType.TurnStarted, this.currentTurnId, {
      input: userInput,
      turnNumber: this.turnCount,
      messageId,
      // executionKind 缺省即 agent，但显式写出：只有 agent 才推进 phase=running
      // （product-projection.ts:1984-2007），controlOnly 会让后续事件全被丢弃。
      executionKind: "agent",
      inputVisibility: "user-visible",
    });
  }

  /** 翻译一条 ACP session/update 为 0..n 个 SessionEvent。 */
  translate(update: AcpSessionUpdate): TranslatedSessionEvent[] {
    const turnId = this.currentTurnId;
    // 无进行中轮次时 jcode 事件无处归属：不发（顺序不变量 2 保证不会被投影接受），
    // 由调用方留痕诊断，不静默伪造一个 turn。
    if (!turnId) return [];

    switch (update.sessionUpdate) {
      case ACP_SESSION_UPDATE_KIND.agentMessageChunk:
        return this.onTextChunk(turnId, update);
      case ACP_SESSION_UPDATE_KIND.toolCall:
        return this.onToolCall(turnId, update);
      case ACP_SESSION_UPDATE_KIND.toolCallUpdate:
        return this.onToolCallUpdate(turnId, update);
      case ACP_SESSION_UPDATE_KIND.usageUpdate:
        return this.onUsageUpdate(turnId, update);
      default:
        // available_commands_update / session_info_update 由调用方另行处理
        // （前者进 workspace-config，后者进 SessionTitleUpdated），不产对话 row。
        return [];
    }
  }

  /**
   * 文本 chunk → ModelStreaming 三段。
   *
   * jcode 只给 append 语义的 chunk，无 message id、无 start/end 边界（spike §3）。
   * 分段规则：无打开消息时先发 text_start（合成 messageId），随后 text_delta。
   * 边界收口在 closeOpenText()（工具开始或轮次结束时调用），对齐 v4 自身
   * 「tool_exec 前 finish_text」的行为。
   */
  private onTextChunk(turnId: string, update: AcpSessionUpdate): TranslatedSessionEvent[] {
    const text = update.content?.text ?? "";
    if (text.length === 0) return [];
    const out: TranslatedSessionEvent[] = [];
    if (this.openTextMessageId === null) {
      this.textChunkOrdinal += 1;
      this.openTextMessageId = `jcode-text-${this.textChunkOrdinal}`;
      out.push(
        this.make(SessionEventType.ModelStreaming, turnId, {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: this.openTextMessageId,
        }),
      );
    }
    this.accumulatedText.push(text);
    out.push(
      this.make(SessionEventType.ModelStreaming, turnId, {
        kind: "text_delta",
        delta: text,
        done: false,
        assistantMessageId: this.openTextMessageId,
      }),
    );
    return out;
  }

  /** tool_call（status pending）→ Scheduled + Started 两段（建 row 后置 running）。 */
  private onToolCall(turnId: string, update: AcpSessionUpdate): TranslatedSessionEvent[] {
    const toolCallId = update.toolCallId;
    if (!toolCallId) return [];
    // 工具开始会切断当前文本段（v4 同款语义：tool_exec 前 finish_text）。
    const out: TranslatedSessionEvent[] = this.closeOpenText(turnId);
    // jcode 的 tool_call 可能不带 name（只有 title）；用 title 兜底，绝不留空——
    // toolName 是 Scheduled 的必填字段，投影据此建 row。
    const toolName = update.name ?? update.title ?? "jcode-tool";
    if (this.tools.has(toolCallId)) return out;
    this.tools.set(toolCallId, { toolCallId, toolName, started: false });
    this.toolCallCount += 1;
    out.push(
      this.make(SessionEventType.ToolCallScheduled, turnId, {
        toolCallId,
        toolName,
        // ACP 的 tool_call 帧在 pending 阶段可能还没给入参；给空对象占位，
        // 后续 rawInput 到达时由 Started/Progress 补不了（投影只在 Scheduled 读 input），
        // 故入参缺失是 jcode 侧的诚实限制，不伪造。
        input: update.rawInput ?? {},
        // schedule 是 TS 必填但 reducer 不读；合成最小合法值以过 typecheck。
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      }),
    );
    return out;
  }

  /**
   * tool_call_update 归并：in_progress → Started（仅首次），completed/failed → Result。
   *
   * spike 实测一轮有 16–27 个 update 帧且多数为空字段增量，故必须按 toolCallId
   * 归并、按 status 变迁发事件，绝不逐帧建 row（spec 验收场景 3）。
   */
  private onToolCallUpdate(turnId: string, update: AcpSessionUpdate): TranslatedSessionEvent[] {
    const toolCallId = update.toolCallId;
    if (!toolCallId) return [];
    const tracked = this.tools.get(toolCallId);
    // 未见过 tool_call 就来 update：jcode 侧事件乱序或 shim 漏帧。不伪造 row
    // （Scheduled 缺失时 Started/Result 会被投影静默丢弃），只留空返回由调用方诊断。
    if (!tracked) return [];
    const out: TranslatedSessionEvent[] = [];
    const status = update.status;

    if (status === ACP_TOOL_STATUS.inProgress && !tracked.started) {
      tracked.started = true;
      // 工具真正开始执行会切断文本段（与 onToolCall 同理，双保险）。
      out.push(...this.closeOpenText(turnId));
      out.push(
        this.make(SessionEventType.ToolCallStarted, turnId, {
          toolCallId,
          toolName: tracked.toolName,
          // startedAt 是 TS 必填但 reducer 不读（用 event.timestamp），合成即可。
          startedAt: new Date(this.deps.now()),
        }),
      );
      return out;
    }

    if (status === ACP_TOOL_STATUS.completed || status === ACP_TOOL_STATUS.failed) {
      // 未先发过 Started 的（jcode 直接 pending→completed）补一发，否则投影里
      // row 停在 inputStreaming，终态 Result 虽然会落但状态机不完整。
      if (!tracked.started) {
        tracked.started = true;
        out.push(
          this.make(SessionEventType.ToolCallStarted, turnId, {
            toolCallId,
            toolName: tracked.toolName,
            startedAt: new Date(this.deps.now()),
          }),
        );
      }
      const ok = status === ACP_TOOL_STATUS.completed;
      const output = update.rawOutput?.output ?? "";
      const errorText = update.rawOutput?.error;
      out.push(
        this.make(SessionEventType.ToolCallResult, turnId, {
          toolCallId,
          // duration 是 TS 必填但 reducer 不读（endedAt 用 event.timestamp）。
          duration: 0,
          result: ok
            ? { success: true, content: output }
            : {
                success: false,
                content: output,
                // jcode 只给错误文本，无错误分类；type 用稳定字符串不伪造细分码。
                error: { type: "jcode_tool_failed", message: errorText ?? output ?? "tool failed" },
              },
        }),
      );
      this.tools.delete(toolCallId);
      return out;
    }
    // pending 或无 status 的增量帧：不发事件（归并）。
    return out;
  }

  /** usage_update → 累加；真正的 ModelComplete 在轮次收口时发（带全量 usage）。 */
  private onUsageUpdate(_turnId: string, update: AcpSessionUpdate): TranslatedSessionEvent[] {
    // ACP 的 usage_update 给 {used,size}（上下文水位），非 token 增量；
    // token 用量在 prompt 返回的 usage 里（spike 实测 inputTokens/outputTokens/…）。
    // 这里只记上下文水位供 ModelComplete 的 contextWindow 用，不发事件。
    if (typeof update.size === "number" && update.size > 0) {
      this.lastUsage = { ...this.lastUsage, totalTokens: update.used };
    }
    return [];
  }

  /**
   * 轮次收口：关闭文本段 + ModelComplete（带 usage）+ TurnComplete/TurnError。
   *
   * @param outcome prompt 返回的 stopReason；cancelled/其他异常按 TurnError 走。
   * @param usage prompt 返回的 token 用量（spike 实测字段名）。
   */
  endTurn(
    outcome: { stopReason?: string; errorMessage?: string },
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedReadTokens?: number;
    },
  ): TranslatedSessionEvent[] {
    const turnId = this.currentTurnId;
    if (!turnId) return [];
    const out: TranslatedSessionEvent[] = this.closeOpenText(turnId);
    const mergedUsage = {
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens ?? this.lastUsage.totalTokens,
      cacheReadTokens: usage?.cachedReadTokens,
    };
    // ModelComplete 的 content/stopReason 是必填但 reducer 只用 stopReason 判
    // isMainTurn（!== "tool_internal"）与续写（=== "length"）；给 "stop" 即主轮正常收口。
    out.push(
      this.make(SessionEventType.ModelComplete, turnId, {
        content: this.accumulatedText.join(""),
        stopReason: "stop",
        usage: mergedUsage,
        querySource: "main_turn",
        toolCallCount: this.toolCallCount,
      }),
    );
    const cancelled = outcome.stopReason === "cancelled";
    const failed =
      Boolean(outcome.errorMessage) ||
      (!cancelled && outcome.stopReason !== "end_turn" && outcome.stopReason !== undefined);
    if (failed && !cancelled) {
      out.push(
        this.make(SessionEventType.TurnError, turnId, {
          error: {
            type: "jcode_turn_failed",
            message:
              outcome.errorMessage ?? `jcode turn stopped: ${outcome.stopReason ?? "unknown"}`,
          },
          turnPhase: "execution",
        }),
      );
    } else {
      out.push(
        this.make(SessionEventType.TurnComplete, turnId, {
          response: this.accumulatedText.join(""),
          tokenCount: mergedUsage.totalTokens ?? 0,
          toolCallCount: this.toolCallCount,
          duration: Math.max(0, this.deps.now() - this.turnStartedAt),
          resultType: cancelled ? "cancelled" : "success",
          usage: mergedUsage,
        }),
      );
    }
    this.currentTurnId = null;
    this.openTextMessageId = null;
    this.tools.clear();
    return out;
  }

  /** 收口当前打开的文本段（text_end）。无打开段时返回空。 */
  private closeOpenText(turnId: string): TranslatedSessionEvent[] {
    if (this.openTextMessageId === null) return [];
    const messageId = this.openTextMessageId;
    this.openTextMessageId = null;
    return [
      this.make(SessionEventType.ModelStreaming, turnId, {
        kind: "text_end",
        delta: "",
        done: true,
        assistantMessageId: messageId,
      }),
    ];
  }

  private make(
    type: string,
    turnId: string,
    payload: Record<string, unknown>,
  ): TranslatedSessionEvent {
    this.seq += 1;
    return {
      id: this.deps.nextEventId(),
      sessionId: this.deps.v4SessionId,
      turnId,
      type,
      timestamp: new Date(this.deps.now()),
      traceId: this.deps.traceId,
      // sequenceNumber 是 v4 的 seq 账本源（product-projection.ts:883），
      // 必须每会话单调递增——翻译器持有计数器，不依赖 jcode 侧任何序号。
      sequenceNumber: this.seq,
      payload,
    };
  }

  /** 诊断用：当前是否有进行中的轮次。 */
  get hasActiveTurn(): boolean {
    return this.currentTurnId !== null;
  }
}
