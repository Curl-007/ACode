import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * A9 待验证项（docs/cli-dispatch-and-system-prompt-upgrade-plan.md §8.2 #5）：
 * **中断输出围栏回灌等价物**——ACode 的 compact / turn 路径上，有没有把「中途被打断的输出」
 * 回灌进上下文、并指示模型续写而不重复的机制。
 *
 * 结论（本文件逐条钉住）：等价机制**存在，而且是两条**，但形态与「围栏」不同：
 *
 *   1. turn 路径（输出被 output token 上限截断）：
 *      - 回灌：截断的 partial assistant 文本作为**普通 assistant 条目**提交进 canonical history
 *        与本轮 request entries（turn-model-step.ts:651-659 → commitAssistantToTurnRequest）。
 *      - 指示续写：随后追加一条 user 条目 OUTPUT_TOKEN_CONTINUE_PROMPT
 *        （turn-output-token-continuation.ts:12-13,139-142），文本要求「直接续写、不道歉、
 *        不复述、从被切断的那半句接上」。
 *      - **没有围栏**：截断处不带任何标记（无 [truncated]、无 XML 界定、无 metadata 标志）；
 *        模型只能从「assistant 消息到此为止 + 紧跟一条续写指令」推断被切过。
 *      - 指令条目是 query-scoped（message-history.ts:56 的 queryScope 注释明写「不得进入
 *        canonical history 或 Session persistence」），所以**跨 compact / 跨冷恢复不保留**，
 *        而 partial 文本保留。
 *      - 上限 3 次（MAX_OUTPUT_TOKEN_CONTINUATIONS），耗尽后转 ModelError（可恢复）。
 *
 *   2. compact 路径（上下文被打断/压缩）：这一条**有围栏形态**——摘要生成时被
 *      `<analysis>` / `<summary>` 标签界定（compact/prompt.ts 的 BASE_COMPACT_PROMPT），
 *      回灌前 formatCompactSummary 剥掉 analysis、把 summary 解围成 "Summary:" 段
 *      （prompt.ts:119-131），再套上「本会话从上一段对话继续」的框（:142-144）与
 *      「Continue … Resume directly — do not acknowledge the summary, do not recap …
 *      Pick up the last task as if the break never happened」（:159-162）。
 *      摘要提示词本身还要求逐字引用「你正在做什么、停在哪里」（第 8、9 条）。
 *
 *   3. 用户取消（Esc）路径：partial 同样被持久化并回灌进 live history
 *      （turn-model-step.ts:372-393 + cancelled-stream-persistence.ts），但**不追加任何续写指示**
 *      （turn 已结束），也不带截断标记——这条不在本文件的断言范围（需要整套 runtime），
 *      只在结论里记录，证据是上面两处 file:line。
 */

const {
  appendOutputTokenContinuation,
  classifyOutputTokenContinuation,
  commitAssistantToTurnRequest,
  completeOutputTokenRecovery,
  filterOutputTokenContinuationEntries,
  isOutputTokenLimitFinishReason,
  OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
} = await import("../packages/core/src/runtime/methods/turn-output-token-continuation.ts");
const {
  buildCompactPrompt,
  buildCompactSummaryMessage,
  formatCompactSummary,
} = await import("../packages/core/src/compact/prompt.ts");

/** 取出一个 entry 的纯文本（user 条目的 content 是字符串，assistant 可能是块数组）。 */
function entryText(entry) {
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => (typeof block === "string" ? block : (block.text ?? "")))
    .join("\n");
}

function makeTurnRequestState() {
  return { entries: [], outputTokenContinuationCount: 0 };
}

// ————————————————————————————————————————————————————————————————
// 1. turn 路径：什么情况判「输出被截断，需要续写」
// ————————————————————————————————————————————————————————————————

test("(1) 触发面：finishReason=length 与三个 raw reason 都算输出上限；普通 stop 不算", () => {
  assert.equal(isOutputTokenLimitFinishReason("length", undefined), true);
  assert.equal(isOutputTokenLimitFinishReason(undefined, "max_tokens"), true);
  assert.equal(isOutputTokenLimitFinishReason(undefined, "max_output_tokens"), true);
  // 有意设计（turn-output-token-continuation.ts:44-56 的注释）：成功响应带这个 raw reason
  // 属于「截断成功」，先续写、按需压缩，不抢先转 Reactive Compact。
  assert.equal(isOutputTokenLimitFinishReason(undefined, "model_context_window_exceeded"), true);
  assert.equal(isOutputTokenLimitFinishReason("stop", undefined), false);
  assert.equal(isOutputTokenLimitFinishReason("tool_calls", undefined), false);
  assert.equal(isOutputTokenLimitFinishReason(undefined, undefined), false);
});

test("(2) 决策表：带工具调用的截断**不**续写；上限 3 次；耗尽后转 exhausted", () => {
  const base = { continuationCount: 0, finishReason: "length", rawFinishReason: undefined };
  assert.equal(classifyOutputTokenContinuation(base), "continue");
  // 截断但已经吐出工具调用 → 交给工具执行，不走续写（turn-output-token-continuation.ts:33）。
  assert.equal(classifyOutputTokenContinuation({ ...base, toolCallCount: 2 }), "none");
  assert.equal(classifyOutputTokenContinuation({ ...base, finishReason: "stop" }), "none");
  assert.equal(classifyOutputTokenContinuation({ ...base, continuationCount: 2 }), "continue");
  assert.equal(classifyOutputTokenContinuation({ ...base, continuationCount: 3 }), "exhausted");
  assert.equal(classifyOutputTokenContinuation({ ...base, continuationCount: 9 }), "exhausted");
});

// ————————————————————————————————————————————————————————————————
// 2. turn 路径：partial 回灌 + 续写指示（有没有「围栏」）
// ————————————————————————————————————————————————————————————————

test("(3) partial 回灌：截断的 assistant 文本原样进 canonical history 与本轮 request entries，且**不带任何截断标记**", () => {
  const added = [];
  const runtime = { messageHistory: { addEntries: (entries) => added.push(...entries) } };
  const state = {
    model: { modelId: "m", providerId: "p" },
    modelResponse: "前半段已经写出来的内容，到这里被切",
    turnRequestState: makeTurnRequestState(),
  };
  const committed = commitAssistantToTurnRequest(runtime, state, { usage: {} }, []);

  assert.equal(committed, true);
  // 两个去处都拿到了同一条 assistant 条目（canonical history + 本轮 request）。
  assert.equal(added.length, 1);
  assert.equal(state.turnRequestState.entries.length, 1);
  const entry = added[0];
  assert.equal(entry.message.role, "assistant");
  assert.equal(entryText(entry), "前半段已经写出来的内容，到这里被切");
  // 「围栏」核对：条目上没有任何表示「这条被截断」的字段——只有 role/content/tokens/模型归因。
  assert.deepEqual(Object.keys(entry.message).sort(), [
    "content",
    "modelId",
    "providerId",
    "role",
    "toolCalls",
  ]);
  assert.equal(entry.queryScope, undefined);
  assert.equal(entry.truncated, undefined);
  assert.equal(JSON.stringify(entry).includes("truncat"), false);
});

test("(4) 空响应不回灌：没有 assistant 内容时 commit 返回 false（不写一条空消息进历史）", () => {
  const added = [];
  const runtime = { messageHistory: { addEntries: (entries) => added.push(...entries) } };
  const state = {
    model: { modelId: "m", providerId: "p" },
    modelResponse: "",
    turnRequestState: makeTurnRequestState(),
  };
  assert.equal(commitAssistantToTurnRequest(runtime, state, { usage: {} }, []), false);
  assert.deepEqual(added, []);
  assert.deepEqual(state.turnRequestState.entries, []);
});

test("(5) 续写指示：追加一条 user 条目，文本要求「直接续写、不复述、从切断处接上」，并计数 +1", () => {
  const state = makeTurnRequestState();
  appendOutputTokenContinuation(state);

  assert.equal(state.outputTokenContinuationCount, 1);
  assert.equal(state.entries.length, 1);
  const entry = state.entries[0];
  assert.equal(entry.message.role, "user");
  // 这条就是「指示续写不重复」的等价物；断言语义承重的三处措辞，而不是整段逐字。
  const text = entryText(entry);
  assert.match(text, /Output token limit hit\./);
  assert.match(text, /Resume directly/);
  assert.match(text, /no apology, no recap/);
  assert.match(text, /Pick up mid-thought if that is where the cut happened/);
  assert.match(text, /Break remaining work into smaller pieces/);
  // 它是 query-scoped 的脚手架：带标记，且**不**声称自己是真实用户输入。
  assert.equal(entry.queryScope, "output_token_continuation");
  assert.equal(entry.metadata?.source, undefined);
});

test("(6) 脚手架不外泄：filter 精确摘掉续写指示条目，partial assistant 条目留下", () => {
  const state = makeTurnRequestState();
  const assistant = { message: { content: "被切的前半段", role: "assistant" } };
  state.entries = [assistant];
  appendOutputTokenContinuation(state);
  assert.equal(state.entries.length, 2);

  const recordable = filterOutputTokenContinuationEntries(state.entries);
  assert.deepEqual(recordable, [assistant]);
  // 没有续写条目时返回**同一个数组**（调用方据此跳过重投影，见 turn-loop.ts:178-186）。
  const untouched = [{ message: { content: "x", role: "user" } }];
  assert.equal(filterOutputTokenContinuationEntries(untouched), untouched);
});

test("(7) 计数复位：恢复成功后归零；耗尽时对外表达为可恢复的 ModelError 文案", () => {
  const state = makeTurnRequestState();
  appendOutputTokenContinuation(state);
  appendOutputTokenContinuation(state);
  assert.equal(state.outputTokenContinuationCount, 2);
  completeOutputTokenRecovery(state);
  assert.equal(state.outputTokenContinuationCount, 0);
  assert.equal(
    OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
    "The model's response exceeded the output token maximum.",
  );
});

// ————————————————————————————————————————————————————————————————
// 3. compact 路径：这一条确实带「围栏 → 解围 → 续写指示」的完整形态
// ————————————————————————————————————————————————————————————————

test("(8) 摘要生成被 XML 围栏界定，且要求逐字引用「停在哪里」", () => {
  const prompt = buildCompactPrompt(undefined);
  assert.match(prompt, /<analysis>/);
  assert.match(prompt, /<summary>/);
  // 第 8、9 条：Current Work / Optional Next Step + 逐字引用，防任务解释漂移。
  assert.match(prompt, /8\. Current Work:/);
  assert.match(prompt, /9\. Optional Next Step:/);
  assert.match(prompt, /include direct quotes from the most recent conversation/);
  assert.match(prompt, /where you left off/);
  // 自定义指令有插槽（不复制第三方文本：只断言插槽存在）。
  assert.match(buildCompactPrompt("focus on tests"), /Additional Instructions:\nfocus on tests/);
  assert.equal(buildCompactPrompt("  "), buildCompactPrompt(undefined));
});

test("(9) 回灌前解围：analysis 整段丢弃，summary 去标签成 \"Summary:\" 段", () => {
  const formatted = formatCompactSummary(
    "<analysis>内部思考，不该回灌</analysis>\n<summary>\n真正的摘要正文\n</summary>",
  );
  assert.equal(formatted.includes("内部思考"), false);
  assert.equal(formatted.includes("<summary>"), false);
  assert.match(formatted, /^Summary:\n真正的摘要正文$/);
  // 空摘要不造出孤零零的 "Summary:" 头。
  assert.equal(formatCompactSummary(undefined), "");
  assert.equal(formatCompactSummary("   "), "");
});

test("(10) 回灌消息：框 + 摘要 + 续写指示（不承认摘要、不复述、当作没断过）", () => {
  // 用带围栏的真实摘要形态：解围后才是 "Summary:" 段（裸字符串不带标签时原样透传，见 (11)）。
  const message = buildCompactSummaryMessage("<summary>摘要正文</summary>", {
    suppressFollowup: true,
  });
  assert.match(message, /^This session is being continued from a previous conversation/);
  assert.match(message, /Summary:\n摘要正文/);
  assert.match(message, /Continue the conversation from where it left off/);
  assert.match(message, /without asking the user any further questions/);
  assert.match(message, /Resume directly — do not acknowledge the summary, do not recap/);
  assert.match(message, /Pick up the last task as if the break never happened/);
});

test("(11) 不 suppressFollowup 时只回灌摘要，不追加续写指示（手动 compact 的形态）", () => {
  const message = buildCompactSummaryMessage("摘要正文", {});
  // 裸文本原样回灌（没有 <summary> 标签可解围）。
  assert.match(message, /\n\n摘要正文/);
  assert.equal(message.includes("Summary:"), false);
  assert.equal(message.includes("Resume directly"), false);
});

test("(12) 逐字保留与逃生舱：recentMessagesPreserved / transcriptPath / replStateCleared 三个可选段", () => {
  const message = buildCompactSummaryMessage("摘要正文", {
    recentMessagesPreserved: true,
    replStateCleared: true,
    suppressFollowup: true,
    transcriptPath: "/tmp/fake-transcript.jsonl",
  });
  assert.match(message, /Recent messages are preserved verbatim\./);
  assert.match(message, /read the full transcript at: \/tmp\/fake-transcript\.jsonl/);
  assert.match(message, /Your REPL VM state has been cleared/);
});
