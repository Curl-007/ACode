// ============================================================
// TurnWrapUp Tool Handler - 回合收尾载荷（apps/acode-cli/specs/turn-wrap-up.md）
// ============================================================
// 义务语义（spec R2/R4）：改了文件、跑了命令或维护过任务列表的回合，必须在收尾消息
// **之前**调用一次；载荷 { recap, nextStep, followUpSuggestion? } 随 toolCall row 的
// input 通道过线（无 schema 透传，旧客户端安全忽略），由客户端在轮尾渲染收尾卡。
//
// handler 刻意无外部副作用（协议档 sideEffectScope=session）：载荷的持久化与投影全部
// 复用工具调用的既有事实链（part state.input + ToolCallResult 事件），不开第二份存储。
// runtime 侧的义务事实记录/收口评估在 runtime/methods/turn-wrap-up.ts。

import {
  TURN_WRAP_UP_TOOL_NAME,
  TurnWrapUpInputJsonSchema,
  TurnWrapUpInputSchema,
  TurnWrapUpOutputJsonSchema,
  TurnWrapUpOutputSchema,
  type TurnWrapUpInput,
  type TurnWrapUpOutput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TURN_WRAP_UP_MODEL_BYTES = 16_000;

/**
 * 工具描述 = 义务的模型面载体（本波不改系统提示词；spec §2.1 侵入面裁决）。
 * 文案纪律：恒英文（prompt-language-policy R3 双面文本按模型面处理）；
 * 义务触发条件、载荷字段语义、followUpSuggestion 的 new_task 判别（自成一体的后续，
 * prompt 必须自包含）、每回合至多一次且收口在最终消息之前。
 */
const TURN_WRAP_UP_DESCRIPTION = [
  "Record the structured end-of-turn summary that the conversation UI renders after this turn closes: a short recap, the next step, and optionally a suggested follow-up task card.",
  "",
  "Obligation: if this turn edited files, ran commands, or updated the task list, you MUST call this tool once after the work is done and BEFORE your final message. Without this call the app has no structured recap or next step to show the user.",
  "",
  "- recap: two or three sentences on what this turn actually accomplished - observed facts, not promises.",
  "- nextStep: one sentence telling the user what happens next or what you recommend doing next.",
  "- followUpSuggestion: only when the request leaves a follow-up that genuinely deserves its own task - an unverified part, work that can run in parallel while the user reviews, something deferred earlier, a self-contained next task. The new task starts from the prompt alone and may not have this session's context, so the prompt must stand on its own. Omit it otherwise; do not invent follow-ups.",
  "",
  "Call it at most once per turn, as your last tool call before the final message. Do not repeat the recap or next step verbatim in the final message.",
].join("\n");

const turnWrapUpHandler: ToolHandler = async (input) => {
  // executor 已按 runtimeInputSchema 校验过一次；handler 再 parse 是既有防御惯例
  // （todo/escalate 同款），保证本文件的返回形状与契约同源。
  const parsed = TurnWrapUpInputSchema.parse(input) as TurnWrapUpInput;
  const message = parsed.followUpSuggestion
    ? "Wrap-up recorded, including the suggested follow-up task. Finish the turn now with your final message to the user; do not restate the recap or the next step."
    : "Wrap-up recorded. Finish the turn now with your final message to the user; do not restate the recap or the next step.";
  return { status: "recorded", message } satisfies TurnWrapUpOutput;
};

export const turnWrapUpToolEntry: ToolEntry = {
  capability: "Record the structured end-of-turn wrap-up payload rendered by conversation clients",
  metadata: {
    shouldDefer: true, // tool-search wave1a: 非常驻内置工具默认 defer(specs/tool-search.md R4)
    name: TURN_WRAP_UP_TOOL_NAME,
    description: TURN_WRAP_UP_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_TURN_WRAP_UP_MODEL_BYTES,
    // 协议档：只把收尾载荷交回会话事实链（part/事件），不碰外部世界——
    // isWorldTouchingToolCall=false，与 escalate/submit_result 同一档语义。
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: turnWrapUpHandler,
  inputSchema: TurnWrapUpInputJsonSchema,
  outputSchema: TurnWrapUpOutputJsonSchema,
  runtimeInputSchema: TurnWrapUpInputSchema,
  runtimeOutputSchema: TurnWrapUpOutputSchema,
  permission: {
    permission: "turn.wrapup",
    reason: "TurnWrapUp only records session-local end-of-turn summary state",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TURN_WRAP_UP_MODEL_BYTES,
    maxModelBytes: MAX_TURN_WRAP_UP_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TURN_WRAP_UP_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30_000,
    maxMs: 30_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TurnWrapUp was cancelled before the wrap-up payload was recorded",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    // recap/nextStep 可能复述用户内容：日志只留摘要，不落原文（spec R3 日志纪律同源）。
    recordInput: "summary",
    recordOutput: "summary",
  },
};
