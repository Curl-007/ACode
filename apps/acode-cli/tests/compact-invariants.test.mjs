import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * J1-3 压缩不变量审计的回归 + 守卫测试。
 *
 * 对应规格 apps/acode-cli/specs/compact-invariants.md 的五条不变量：
 *   I1 图片平价计费（缺口 → 已修，回归）
 *   I2 provider token 会计归一（成立 → 守卫）
 *   I3 压缩切点不拆 tool_use/tool_result 对（成立 → 守卫）
 *   I4 无并发压缩（不适用 → 前提守卫）
 *   I5 HTTP 413 字节超限独立恢复轨道（缺口 → 已修，回归）
 *
 * 机制参照 jcode (MIT) crates/jcode-compaction-core/src/lib.rs 与
 * crates/jcode-base/src/compaction.rs 的事故记录，测试用例为自撰。
 */

const coreRoot = new URL("../packages/core/src/", import.meta.url);
const readCore = (path) => readFile(new URL(path, coreRoot), "utf8");

const { COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS, estimateMessageTokens } =
  await import("../packages/core/src/compact/manual.ts");
const { getAutoCompactThreshold, shouldAutoCompact } =
  await import("../packages/core/src/compact/policy.ts");
const { COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_BYTES, nextCompactPayloadRecoveryMediaBudget } =
  await import("../packages/core/src/compact/payload-recovery.ts");
const { groupByAssistantStartedRounds } = await import("../packages/core/src/compact/rounds.ts");
const { hasEnoughMessagesToCompact } = await import("../packages/core/src/compact/manual.ts");
const {
  hasEnoughRuntimeEntriesToCompact,
  selectCompactEntries,
  selectCompactEntriesAfterPromptTooLong,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
} = await import("../packages/core/src/runtime/helpers/compact-selection.ts");
const { projectMessagesForMediaBudget } =
  await import("../packages/core/src/runtime/helpers/media-budget.ts");
const {
  isModelContextExceededError,
  isModelMediaTooLargeError,
  isModelRequestPayloadTooLargeError,
} = await import("../packages/core/src/runtime/helpers/model-errors.ts");
const { estimateCurrentModelInputTokens } =
  await import("../packages/core/src/runtime/methods/compact.ts");
const { beginActiveTurn, finishActiveTurn } =
  await import("../packages/core/src/runtime/methods/steering.ts");
const { initializeRuntimeTurnCoordination } =
  await import("../packages/core/src/runtime/turn-coordination.ts");
const { modelMessageContentBlockToText } = await import("../packages/contracts/src/model/index.ts");
const { CompactTrigger } = await import("../packages/contracts/src/compact/index.ts");

// ---------------------------------------------------------------------------
// 构造器
// ---------------------------------------------------------------------------

const IMAGE_MEDIA_TOKENS = COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS;

function imageBlock(mediaType = "image/png", base64Length = 400_000) {
  return {
    type: "image",
    mediaType,
    dataUrl: `data:${mediaType};base64,${"A".repeat(base64Length)}`,
  };
}

function userMessage(content) {
  return { role: "user", content };
}

function assistantMessage(content, toolCalls) {
  return { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) };
}

function userEntry(content, metadata) {
  return { message: { role: "user", content }, ...(metadata ? { metadata } : {}) };
}

function assistantEntry(content, toolCalls) {
  return { message: { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) } };
}

function toolEntry(toolCallId, content = "tool output", toolName = "Read") {
  return { message: { role: "tool", content, toolCallId, toolName } };
}

function systemEntry(content = "system prompt") {
  return { message: { role: "system", content } };
}

function adapterError(message, context) {
  return Object.assign(new Error(message), {
    name: "AiSdkModelAdapterError",
    code: "MODEL_REQUEST_FAILED",
    context,
  });
}

const TRACE_CONTEXT = { traceId: "trace_compact_invariants", turnId: "turn_compact_invariants" };

/** 收集 tool 配对事实：调用 id 集合与结果 id 集合。 */
function toolPairFacts(entries) {
  const callIds = new Set();
  const resultIds = new Set();
  for (const entry of entries) {
    const message = entry.message;
    for (const toolCall of message.toolCalls ?? []) callIds.add(toolCall.id);
    if (message.role === "tool" && message.toolCallId) resultIds.add(message.toolCallId);
  }
  return { callIds, resultIds };
}

// ---------------------------------------------------------------------------
// I1 图片平价计费（缺口 → 已修）
// ---------------------------------------------------------------------------

test("(I1-1) 内联图片按平价计费，且不随 base64 长度放大", () => {
  // 修正前实测：一张 400KB base64 截图只计 7 token（占位文本 "[Attached image/png]" 20 字符 ÷ 3）。
  const small = estimateMessageTokens([userMessage([imageBlock("image/png", 1_000)])]);
  const large = estimateMessageTokens([userMessage([imageBlock("image/png", 4_000_000)])]);

  assert.equal(small, IMAGE_MEDIA_TOKENS);
  assert.equal(
    large,
    IMAGE_MEDIA_TOKENS,
    "平价计费：体积不得影响 token 估算（jcode 事故：高估 100 倍）",
  );
  assert.ok(
    large > 100,
    "占位文本低估（修正前 7 token）必须消失，否则无 usage anchor 时阈值看不见图片",
  );
});

test("(I1-2) 多张图片线性累加，正文与 toolCalls 入参仍按字符计费", () => {
  const messages = [
    userMessage([{ type: "text", text: "x".repeat(300) }, imageBlock(), imageBlock("image/jpeg")]),
    {
      ...assistantMessage("done"),
      toolCalls: [{ name: "Write", input: { content: "y".repeat(600) } }],
    },
  ];
  const estimated = estimateMessageTokens(messages);
  // 独立手算：字符部分 ceil((300 + 5 + 'Write' + JSON) / 3) + 2 × 平价。
  const toolCallChars = ("Write" + JSON.stringify({ content: "y".repeat(600) })).length;
  const expectedChars = Math.ceil(300 / 3) + Math.ceil(("done".length + toolCallChars) / 3);
  assert.equal(estimated, expectedChars + 2 * IMAGE_MEDIA_TOKENS);
});

test("(I1-3) video 与无正文 file 附件同样平价计费；带正文的 file 仍按正文计费", () => {
  const video = estimateMessageTokens([
    userMessage([{ type: "video", mediaType: "video/mp4", dataUrl: "data:video/mp4;base64,AAAA" }]),
  ]);
  assert.equal(video, IMAGE_MEDIA_TOKENS);

  const pdfWithoutText = estimateMessageTokens([
    userMessage([
      { type: "file", mediaType: "application/pdf", dataUrl: "data:application/pdf;base64,AAAA" },
    ]),
  ]);
  assert.equal(pdfWithoutText, IMAGE_MEDIA_TOKENS);

  const fileWithText = estimateMessageTokens([
    userMessage([{ type: "file", mediaType: "text/plain", text: "z".repeat(300) }]),
  ]);
  assert.equal(fileWithText, Math.ceil(300 / 3), "带正文的 file 不得叠加平价（既有语义不变）");
});

test("(I1-4) reasoning 独立投影零回归：估算仍计入 reasoning 正文", () => {
  const reasoningText = "r".repeat(600);
  const visibleText = "t".repeat(300);
  const estimated = estimateMessageTokens([
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: reasoningText },
        { type: "text", text: visibleText },
      ],
    },
  ]);
  const withoutReasoning = estimateMessageTokens([
    { role: "assistant", content: [{ type: "text", text: visibleText }] },
  ]);

  // 多块正文按 "\n\n" 连接后统一除以字符除数（与实现的连接口径一致，独立手算长度）。
  assert.equal(estimated, Math.ceil((reasoningText.length + 2 + visibleText.length) / 3));
  assert.equal(withoutReasoning, Math.ceil(visibleText.length / 3));
  assert.ok(estimated - withoutReasoning >= 199, "reasoning 不得重新计 0（既有修正的零回归）");
});

test("(I1-5) 共享正文投影语义未被改动：image 仍投影为占位文本", () => {
  // memory、错误文案、UI 摘要都消费 modelMessageContentBlockToText；平价计费只能落在
  // compact 自己的估算投影里（与 reasoning 独立投影同一先例）。
  assert.equal(modelMessageContentBlockToText(imageBlock("image/png")), "[Attached image/png]");
});

test("(I1-6) 阈值效果：20 张截图在 estimate 模式下触发 auto compact（修正前不触发）", () => {
  const config = { contextWindow: 60_000, maxOutputTokens: 32_000 };
  const threshold = getAutoCompactThreshold(config);
  assert.equal(threshold, 60_000 - 21_000 - 13_000, "既有阈值常量语义不变");

  const messages = [
    userMessage("question"),
    assistantMessage("answer"),
    userMessage(Array.from({ length: 20 }, () => imageBlock())),
    assistantMessage("answer 2"),
  ];
  assert.equal(hasEnoughMessagesToCompact(messages), true);

  const decision = shouldAutoCompact({ messages, config });
  assert.equal(decision.tokenSource, "estimate");
  assert.equal(decision.shouldCompact, true);
  assert.equal(decision.reason, "above_threshold");
  assert.ok(decision.estimatedTokenCount >= 20 * IMAGE_MEDIA_TOKENS);
  // 反证：把平价计费拿掉（即修正前的行为）就落在阈值之下 —— 这条不变量不是恒真断言。
  assert.ok(
    decision.estimatedTokenCount - 20 * IMAGE_MEDIA_TOKENS < threshold,
    "修正前的占位文本估算必须低于阈值，否则本用例证明不了缺口已修",
  );
});

// ---------------------------------------------------------------------------
// I2 provider token 会计归一（成立 → 守卫）
// ---------------------------------------------------------------------------

test("(I2-1) provider 会计：cache read/write 不得叠加到 input window 上", () => {
  const messages = [
    userMessage("hello there"),
    assistantMessage("ok"),
    { role: "tool", content: "x".repeat(3_000), toolCallId: "t1", toolName: "Read" },
    userMessage("next"),
  ];
  const anchorTokens = {
    input: 50_000,
    output: 1_000,
    total: 51_000,
    reasoning: 0,
    cache: { read: 40_000, write: 5_000 },
  };
  const sourceEntries = [
    undefined,
    { kind: "message", message: { role: "assistant", content: "ok" }, tokens: anchorTokens },
    undefined,
    undefined,
  ];

  const accounted = estimateCurrentModelInputTokens(messages, sourceEntries);
  const tailEstimate = estimateMessageTokens(messages.slice(2));
  // AI SDK v6 的 Anthropic inputTokens 已经是 total input（含 cache read/write），
  // 再叠一次会把 context meter 与 compact 阈值同时放大（split vs subset accounting 事故）。
  assert.equal(accounted, 51_000 + tailEstimate);
  assert.ok(accounted < 51_000 + 45_000 + tailEstimate, "cache 字段被重复计入");
});

test("(I2-2) 无 usage anchor 时回落 estimate，且 tokenSource 如实标注", () => {
  const messages = [userMessage("hello"), assistantMessage("ok")];
  const accounted = estimateCurrentModelInputTokens(messages, [undefined, undefined]);
  assert.equal(accounted, estimateMessageTokens(messages));

  const decision = shouldAutoCompact({ messages, config: { contextWindow: 60_000 } });
  assert.equal(decision.tokenSource, "estimate");
  assert.equal(decision.tokenCount, decision.estimatedTokenCount);
});

test("(I2-3) 决策只认唯一事实来源：provider override 覆盖估算，两个数值都外显", () => {
  const messages = [userMessage("hello"), assistantMessage("ok")];
  const override = {
    baseTokenCount: 90_000,
    cacheReadTokens: 70_000,
    cacheWriteTokens: 1_000,
    contextUsageTokenCount: 95_000,
    incrementalTokenCount: 4_999,
    outputTokens: 5_000,
    source: "provider_usage",
    tokenCount: 99_999,
  };
  const decision = shouldAutoCompact({
    messages,
    config: { contextWindow: 100_000 },
    tokenOverride: override,
  });

  assert.equal(decision.tokenSource, "provider_usage");
  assert.equal(decision.tokenCount, 99_999, "阈值判定必须使用 provider 数值");
  assert.equal(decision.providerContextUsageTokenCount, 95_000);
  assert.equal(decision.estimatedTokenCount, estimateMessageTokens(messages));
  assert.notEqual(decision.estimatedTokenCount, decision.tokenCount);
  assert.ok(
    decision.estimatedTokenCount < decision.threshold,
    "本地估算低于阈值：只有 provider 数值能触发压缩，才能证明判定用的是唯一事实来源",
  );
  assert.equal(decision.shouldCompact, true);
  assert.equal(decision.reason, "above_threshold");
});

test("(I2-4) provider 轨道的本地增量段也吃到图片平价计费", () => {
  const messages = [userMessage("hello"), assistantMessage("ok"), userMessage([imageBlock()])];
  const sourceEntries = [
    undefined,
    {
      kind: "message",
      message: { role: "assistant", content: "ok" },
      tokens: {
        input: 10_000,
        output: 500,
        total: 10_500,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    undefined,
  ];
  const accounted = estimateCurrentModelInputTokens(messages, sourceEntries);
  assert.equal(accounted, 10_500 + IMAGE_MEDIA_TOKENS);
});

// ---------------------------------------------------------------------------
// I3 压缩切点不拆 tool_use/tool_result 对（成立 → 守卫）
// ---------------------------------------------------------------------------

function toolPairedHistory() {
  return [
    systemEntry(),
    userEntry("q1"),
    assistantEntry("", [{ id: "t1", name: "Read", input: {} }]),
    toolEntry("t1", "result 1"),
    userEntry("q2"),
    assistantEntry("", [
      { id: "t2", name: "Bash", input: {} },
      { id: "t3", name: "Grep", input: {} },
    ]),
    toolEntry("t2", "result 2", "Bash"),
    toolEntry("t3", "result 3", "Grep"),
    userEntry("q3"),
    assistantEntry("final answer"),
  ];
}

test("(I3-1) 保留尾巴不以 tool 结果开头，且每个 tool 结果都与调用同侧", () => {
  const entries = toolPairedHistory();
  const selection = selectCompactEntries({ entries, trigger: CompactTrigger.Auto });

  assert.ok(selection.groupsPreserved >= 1, "auto compact 必须保留最近轮次");
  assert.notEqual(selection.preservedEntries[0]?.message.role, "tool");

  const preserved = toolPairFacts(selection.preservedEntries);
  const summarized = toolPairFacts(selection.entriesForSummary);
  for (const resultId of preserved.resultIds) {
    assert.ok(preserved.callIds.has(resultId), `保留侧 tool 结果 ${resultId} 缺少同侧 tool 调用`);
    assert.ok(!summarized.callIds.has(resultId), "tool 调用被切到摘要侧，结果留在保留侧");
  }
  for (const resultId of summarized.resultIds) {
    assert.ok(summarized.callIds.has(resultId), `摘要侧 tool 结果 ${resultId} 缺少同侧 tool 调用`);
  }
  for (const callId of summarized.callIds) {
    assert.ok(summarized.resultIds.has(callId), `摘要侧以未回答的 tool 调用 ${callId} 结尾`);
  }
});

test("(I3-2) 分组不变量：tool 结果永不成为一轮的起点", () => {
  const shapes = [
    toolPairedHistory(),
    [userEntry("q"), assistantEntry("", [{ id: "a", name: "Read", input: {} }]), toolEntry("a")],
    [
      systemEntry(),
      assistantEntry("", [{ id: "b", name: "Bash", input: {} }]),
      toolEntry("b", "out", "Bash"),
      assistantEntry("", [{ id: "c", name: "Bash", input: {} }]),
      toolEntry("c", "out", "Bash"),
    ],
  ];

  for (const entries of shapes) {
    const groups = groupByAssistantStartedRounds(entries, (entry) => entry.message.role);
    for (const group of groups) {
      // 首轮可能以 user/system 开头（含历史里已存在的孤儿 tool 结果），
      // 但除首轮外每一轮都必须由 assistant 起始 —— 这正是切点不拆配对的结构性原因。
      if (groups.indexOf(group) === 0) continue;
      assert.equal(group[0].message.role, "assistant");
    }
  }
});

test("(I3-3) prompt-too-long 重选与旧轮次截断后，配对不变量仍成立", () => {
  const entries = toolPairedHistory();
  const cause = new Error("prompt is too long: 210000 tokens > 200000 maximum");

  const reselected = selectCompactEntriesAfterPromptTooLong({
    entries,
    promptTooLongCause: cause,
    trigger: CompactTrigger.Reactive,
    useMidConversationSystem: true,
    currentGroupsPreserved: 1,
  });
  assert.ok(reselected, "重选应当能保留更多最近轮次");
  assert.ok(reselected.groupsPreserved > 1);
  assert.notEqual(reselected.preservedEntries[0]?.message.role, "tool");
  const reselectedPreserved = toolPairFacts(reselected.preservedEntries);
  for (const resultId of reselectedPreserved.resultIds) {
    assert.ok(reselectedPreserved.callIds.has(resultId));
  }

  const warnings = [];
  const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
    attempt: 0,
    cause,
    entriesForSummary: selectCompactEntries({ entries, trigger: CompactTrigger.Manual })
      .entriesForSummary,
    logger: { warn: (message) => warnings.push(message) },
    traceContext: TRACE_CONTEXT,
    useMidConversationSystem: true,
  });
  assert.ok(truncated, "截断回退应当产出更短的摘要输入");
  const truncatedFacts = toolPairFacts(truncated);
  for (const resultId of truncatedFacts.resultIds) {
    assert.ok(
      truncatedFacts.callIds.has(resultId),
      "截断丢轮次后出现孤儿 tool 结果（Anthropic 硬约束会被违反）",
    );
  }
  assert.ok(warnings.length > 0, "截断必须留痕");
});

test("(I3-4) 「配不齐就放弃压缩」的 ACode 等价语义：不足两轮直接 skipped", async () => {
  // ACode 没有数值 cutoff，因此不需要 jcode safe_compaction_cutoff 的回退搜索；
  // 对应的放弃语义是「不足两轮不压缩」，由 hasEnough* 判定并把结果标成 skipped。
  const singleRound = [
    systemEntry(),
    assistantEntry("", [{ id: "t1", name: "Read", input: {} }]),
    toolEntry("t1"),
  ];
  assert.equal(hasEnoughRuntimeEntriesToCompact(singleRound), false);
  assert.equal(hasEnoughMessagesToCompact(singleRound.map((entry) => entry.message)), false);

  const twoRounds = [...singleRound, userEntry("q2"), assistantEntry("answer")];
  assert.equal(hasEnoughRuntimeEntriesToCompact(twoRounds), true);

  // 放弃压缩必须表现为健康 no-op（skipped），而不是暴露成系统故障。
  const compactActiveSource = await readCore("runtime/methods/compact-active.ts");
  assert.match(
    compactActiveSource,
    /if \(!hasEnoughRuntimeEntriesToCompact\(entriesForSummary\)\) \{/,
  );
  const skippedBranch = compactActiveSource.slice(
    compactActiveSource.indexOf("if (!hasEnoughRuntimeEntriesToCompact(entriesForSummary)) {"),
    compactActiveSource.indexOf("const compactStartedPayload"),
  );
  assert.match(skippedBranch, /outcome: "skipped"/);
  assert.match(skippedBranch, /CompactTimelineStatus\.Skipped/);
});

// ---------------------------------------------------------------------------
// I4 无并发压缩（不适用 → 前提守卫）
// ---------------------------------------------------------------------------

test("(I4-1) 三个 compact 调用点全部内联 await，无 fire-and-forget", async () => {
  const sources = {
    "methods/compact.ts": await readCore("runtime/methods/compact.ts"),
    "methods/compact-active.ts": await readCore("runtime/methods/compact-active.ts"),
    "methods/microcompact.ts": await readCore("runtime/methods/microcompact.ts"),
  };

  const callSites = sources["methods/compact.ts"].match(/this\.compactActiveConversation\(/g) ?? [];
  const awaitedCallSites =
    sources["methods/compact.ts"].match(/await this\.compactActiveConversation\(/g) ?? [];
  assert.equal(callSites.length, 3, "manual/auto/reactive 三个调用点");
  assert.equal(awaitedCallSites.length, callSites.length, "存在未 await 的压缩调用");

  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /void\s+this\.compact/, `${name} 出现 fire-and-forget 压缩`);
    assert.doesNotMatch(
      source,
      /setTimeout\(|setInterval\(|queueMicrotask\(|setImmediate\(/,
      `${name} 出现延迟/后台压缩调度`,
    );
    assert.doesNotMatch(
      source,
      /compactActiveConversation\([^)]*\)\s*\.then\(/,
      `${name} 出现 .then 形式的后台压缩`,
    );
  }
});

test("(I4-2) 单活跃 turn 互斥：compact turn 不能与在途 turn 并存", () => {
  const busyRuntime = { activeTurn: { kind: "regular", turnId: "turn_busy" } };
  assert.throws(
    () => beginActiveTurn.call(busyRuntime, "turn_compact", TRACE_CONTEXT, "compact", false),
    (error) => {
      assert.equal(error.type, "turn_in_progress");
      return true;
    },
  );

  // 预约态同样互斥：reserveTurnStart 之后 compact 也不能插队。
  const reservedRuntime = {
    activeTurnStartReservation: { kind: "regular", turnId: "turn_reserved" },
  };
  assert.throws(
    () => beginActiveTurn.call(reservedRuntime, "turn_compact", TRACE_CONTEXT, "compact", false),
    (error) => error.type === "turn_in_progress",
  );

  const idleRuntime = {};
  initializeRuntimeTurnCoordination(idleRuntime);
  const activeTurn = beginActiveTurn.call(
    idleRuntime,
    "turn_compact",
    TRACE_CONTEXT,
    "compact",
    false,
  );
  assert.equal(idleRuntime.activeTurn, activeTurn);
  assert.throws(
    () => beginActiveTurn.call(idleRuntime, "turn_other", TRACE_CONTEXT, "regular", true),
    (error) => error.type === "turn_in_progress",
  );
  finishActiveTurn.call(idleRuntime, activeTurn);
  assert.equal(idleRuntime.activeTurn, undefined);
  // 只释放自己那一把锁：别人的 activeTurn 不得被误清。
  const otherRuntime = { activeTurn: { kind: "regular", turnId: "turn_other" } };
  finishActiveTurn.call(otherRuntime, activeTurn);
  assert.notEqual(otherRuntime.activeTurn, undefined);
});

test("(I4-3) 前提登记：replaceMessages 是无条件覆盖，stale 防护只能靠上游互斥", async () => {
  const historySource = await readCore("agent/message-history.ts");
  // 用 lastIndexOf 跳过 MessageHistory 接口声明，取 MessageHistoryImpl 的实现体。
  const replaceStart = historySource.lastIndexOf("  replaceMessages(messages");
  assert.ok(replaceStart > 0);
  const replaceBody = historySource.slice(
    replaceStart,
    historySource.indexOf("  getMessageCount()", replaceStart),
  );
  assert.match(replaceBody, /this\.entries = messages\.map\(cloneEntryInput\);/);
  assert.doesNotMatch(
    replaceBody,
    /revision|version|stale|expectedCount|generation/i,
    "replaceMessages 出现了新的 stale 守卫：请同步更新 spec I4 的前提登记",
  );

  // 已存在的 stale 缓解：turn-local compact 回写时重读 canonical prefix。
  const compactActiveSource = await readCore("runtime/methods/compact-active.ts");
  assert.match(compactActiveSource, /preserveCanonicalContextPrefix\(/);
});

// ---------------------------------------------------------------------------
// I5 HTTP 413 字节超限独立恢复轨道（缺口 → 已修）
// ---------------------------------------------------------------------------

test("(I5-1) 413 判定命中：状态码、marker、provider 文案与 cause 链", () => {
  const positives = [
    adapterError("Model request failed.", { statusCode: 413, reason: "unknown" }),
    adapterError("Model request failed.", { responseStatus: 413 }),
    adapterError("413 Payload Too Large", {}),
    adapterError("413 Request Entity Too Large", {}),
    adapterError("request too large", {}),
    adapterError("Anthropic API error", { code: "request_too_large" }),
    adapterError("Request exceeds the maximum size", { httpResponseStatus: 413 }),
    Object.assign(new Error("outer wrapper"), {
      cause: adapterError("Model request failed.", { statusCode: 413 }),
    }),
    { context: { statusCode: 413 } },
  ];
  for (const error of positives) {
    assert.equal(isModelRequestPayloadTooLargeError(error), true, `应命中 413：${describe(error)}`);
  }
});

test("(I5-2) 413 判定不误命中：4130、限流、token 超窗文案", () => {
  const negatives = [
    adapterError("model version 4130 is unavailable", {}),
    adapterError("Provider business error", { code: "4130", statusCode: 400 }),
    adapterError("rate limit exceeded, retry after 20s", { statusCode: 429 }),
    adapterError("Provider authentication failed.", { statusCode: 403 }),
    // token 轨道的文案里出现三位数不得被抢判成字节轨道。
    adapterError("prompt is too long: 413 tokens > 200 maximum", { statusCode: 400 }),
    {
      code: "MODEL_CONTEXT_EXCEEDED",
      message: "Model request exceeded the provider context window.",
    },
    adapterError("image exceeds maximum size", { code: "media_payload_too_large" }),
    new Error("Model stream failed"),
    undefined,
    null,
    "413",
  ];
  for (const error of negatives) {
    assert.equal(
      isModelRequestPayloadTooLargeError(error),
      false,
      `不应命中 413：${describe(error)}`,
    );
  }
});

test("(I5-3) 三条轨道互不吞并：413 / token 超窗 / 单媒体过大", () => {
  const payloadError = adapterError("Model request failed.", { statusCode: 413 });
  assert.equal(isModelRequestPayloadTooLargeError(payloadError), true);
  assert.equal(isModelContextExceededError(payloadError), false);
  assert.equal(isModelMediaTooLargeError(payloadError), false);

  const contextError = {
    code: "MODEL_CONTEXT_EXCEEDED",
    message: "Model request exceeded the provider context window.",
    context: { statusCode: 400 },
  };
  assert.equal(isModelContextExceededError(contextError), true);
  assert.equal(isModelRequestPayloadTooLargeError(contextError), false);

  const mediaError = { code: "media_payload_too_large", message: "image too large" };
  assert.equal(isModelMediaTooLargeError(mediaError), true);
  assert.equal(isModelRequestPayloadTooLargeError(mediaError), false);
});

test("(I5-4) 预算阶梯：12MiB → 0 → 耗尽，非法值不产生无限重试", () => {
  assert.equal(
    nextCompactPayloadRecoveryMediaBudget(undefined),
    COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_BYTES,
  );
  assert.equal(COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_BYTES, 12 * 1024 * 1024);
  assert.equal(
    nextCompactPayloadRecoveryMediaBudget(COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_BYTES),
    0,
  );
  assert.equal(nextCompactPayloadRecoveryMediaBudget(0), undefined, "阶梯耗尽必须停止重试");
  assert.equal(nextCompactPayloadRecoveryMediaBudget(Number.NaN), undefined);
  assert.equal(nextCompactPayloadRecoveryMediaBudget(-1), undefined);
});

test("(I5-5) 恢复动作：按预算 oldest-first 剥离内联媒体，占位文案保留 media_type", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "old screenshot" }, imageBlock("image/png", 5_000_000)],
    },
    { role: "assistant", content: "ok" },
    { role: "user", content: [imageBlock("image/jpeg", 100_000)] },
  ];

  const reduced = projectMessagesForMediaBudget(structuredClone(messages), {
    maxMediaBytes: 200_000,
    preserveLatestUserMedia: false,
  });
  assert.equal(reduced.omittedMediaCount, 1, "只剥最旧的大图");
  assert.equal(reduced.retainedMediaCount, 1);
  assert.equal(reduced.messages[2].content[0].type, "image", "最近的媒体必须保留");
  const marker = reduced.messages[0].content[1];
  assert.equal(marker.type, "text");
  assert.match(marker.text, /image\/png/, "占位文案必须带 media_type");

  const stripped = projectMessagesForMediaBudget(structuredClone(messages), {
    maxMediaBytes: 0,
    preserveLatestUserMedia: false,
  });
  assert.equal(stripped.omittedMediaCount, 2, "0 预算 = 全部剥离（阶梯第二级）");

  // compact 必须显式关掉「保护最近用户媒体」：否则 0 预算会抛错而不是剥离。
  assert.throws(
    () => projectMessagesForMediaBudget(structuredClone(messages), { maxMediaBytes: 0 }),
    (error) => {
      assert.equal(error.code, "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE");
      return true;
    },
  );
});

test("(I5-6) 接线守卫：compact summary 请求存在独立 413 轨道且顺序正确", async () => {
  const source = await readCore("runtime/methods/compact-active.ts");

  const payloadIndex = source.indexOf("if (isModelRequestPayloadTooLargeError(error)) {");
  const mediaIndex = source.indexOf(
    "if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {",
  );
  const contextIndex = source.indexOf("if (isModelContextExceededError(error)) {");
  assert.ok(payloadIndex > 0, "缺少 413 恢复分支");
  assert.ok(mediaIndex > payloadIndex, "413 轨道必须先于单媒体过大轨道（字节阶梯更渐进）");
  assert.ok(contextIndex > payloadIndex, "413 不得被 token 轨道吸收");

  const payloadBranch = source.slice(payloadIndex, mediaIndex);
  assert.match(payloadBranch, /nextCompactPayloadRecoveryMediaBudget\(/);
  assert.match(payloadBranch, /continue;/);
  assert.match(payloadBranch, /throw error;/, "阶梯耗尽必须抛出，不得回落 token 轨道");
  assert.doesNotMatch(
    payloadBranch,
    /reselectEntriesAfterPromptTooLong|truncateEntriesAfterPromptTooLong/,
    "413 分支不得复用丢轮次/截断（那是 token 轨道的恢复动作）",
  );

  assert.match(source, /let payloadRecoveryMediaBudgetBytes: number \| undefined;/);
  assert.equal(
    source.split("projectCompactMessagesForPayloadRecovery(").length - 1,
    3,
    "定义 + 请求消息 + 可记录消息投影各一处",
  );
  assert.match(source, /preserveLatestUserMedia: false/);
  assert.match(source, /compact\.request\.payload_too_large\.retry/);
});

function describe(error) {
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  if (typeof error === "string") return `string(${error})`;
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return String(message).slice(0, 80);
}
