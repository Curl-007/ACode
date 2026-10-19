// 用量状态栏 bootstrap 投影验收（apps/acode-cli/specs/usage-statusbar.md 验收场景 3/8）。
//
// 覆盖面：onModelComplete 写 lastRequest/cumulative.reasoningTokens（含旁路发射点缺
// timing 字段的防御）；turnHeader.stats 每轮累计 + 首 TTFT + 纯问答 null + 取消轮 flush
// + hydration 零用量占位不算模型事实；autoCompactThresholdTokens 真值（seedUsage 与
// ModelSelected 两处 + 窗口未知不造值）；RunningSubagentSummary.cumulativeTokens
// （SubagentStopped.totalTokens 记账，resume 复活的 summary 附带；停止后按既有生命周期离场）。
// 验收场景 8（inFlight 链路，投影侧）：usageProgress 写 inFlight 且整键带回既有 usage 键、
// 同请求合并/跨请求替换、firstTokenAtMs 只认非空 delta、conflated 值未变不重复下发、
// ModelComplete/TurnComplete/TurnError/apiRetry 清除点、turnToDate = 累加器 + partial、
// 无 usageProgress 不产生 inFlight patch、迟到/旧轮事实不复活幽灵「进行中」。
import assert from "node:assert/strict";
import test from "node:test";

const { ProductProjection } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/product-projection.ts"
);
const { conversationDeltaSchema, conversationSnapshotSchema } = await import(
  "../../../packages/shared/src/acode-protocol-v4/index.ts"
);

const SID = "sess-usage-statusbar-projection";
const T0 = 1_700_000_000_000;

let seq = 0;
const ev = (type, payload, { turnId, atMs } = {}) => {
  seq += 1;
  return {
    id: `ev-${seq}`,
    sessionId: SID,
    type,
    timestamp: new Date(atMs ?? T0 + seq * 1000),
    traceId: "trace-usage-statusbar",
    sequenceNumber: seq,
    payload,
    ...(turnId ? { turnId } : {}),
  };
};

function startTurn(projection, turnId, messageId) {
  // envelope turnId 与 payload.turnId 一致：normalizer 的 runtimeTurnId 优先取
  // envelope，后续事件按同一 runtime turn 归属到 productTurnId（= messageId）。
  return projection.applyEvent(
    ev("turn_started", { turnId, turnNumber: 1, messageId, input: "do the thing" }, { turnId }),
  );
}

function modelComplete(projection, turnId, usage, timing, atMs) {
  return projection.applyEvent(
    ev(
      "model_complete",
      { content: "ok", querySource: "main_turn", stopReason: "end_turn", toolCallCount: 0, usage, ...timing },
      { turnId, atMs },
    ),
  );
}

function turnComplete(projection, turnId, resultType) {
  return projection.applyEvent(
    ev("turn_complete", { response: "", tokenCount: 0, toolCallCount: 0, duration: 9000, resultType }, { turnId }),
  );
}

function subagentEvent(projection, type, payload, turnId) {
  return projection.applyEvent(ev(type, payload, { turnId }));
}

function assertWireSafe(projection, deltas) {
  for (const delta of deltas) {
    const parsed = conversationDeltaSchema.safeParse(delta);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues ?? parsed.error ?? null));
  }
  const parsedSnapshot = conversationSnapshotSchema.safeParse(projection.getSnapshot());
  assert.ok(
    parsedSnapshot.success,
    JSON.stringify(parsedSnapshot.error?.issues ?? parsedSnapshot.error ?? null),
  );
}

function turnHeaderOf(projection, turnId) {
  const headers = projection
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "turnHeader" && row.turnId === turnId);
  assert.equal(headers.length, 1, `expected exactly one turnHeader for ${turnId}`);
  return headers[0];
}

const FULL_USAGE = {
  inputTokens: 100,
  outputTokens: 40,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  reasoningTokens: 12,
};

test("onModelComplete writes lastRequest and cumulative.reasoningTokens; missing timing keeps previous lastRequest", () => {
  const projection = new ProductProjection(SID, "epoch-last-request");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-a", "msg-a"));
  deltas.push(
    ...modelComplete(projection, "turn-a", FULL_USAGE, { generationMs: 2000, timeToFirstTokenMs: 800 }, T0 + 5_000),
  );
  let usage = projection.getSnapshot().usage;
  assert.deepEqual(usage.lastRequest, {
    outputTokens: 40,
    generationMs: 2000,
    timeToFirstTokenMs: 800,
    completedAtMs: T0 + 5_000,
  });
  assert.equal(usage.cumulative.reasoningTokens, 12);

  // 防御：旧事件/旁路发射点缺 generationMs → lastRequest 保留上一值（不造假值），
  // 但 token 与 reasoning 累计照常入账。
  deltas.push(
    ...modelComplete(projection, "turn-a", { inputTokens: 10, outputTokens: 6, reasoningTokens: 3 }, {}, T0 + 6_000),
  );
  usage = projection.getSnapshot().usage;
  assert.equal(usage.lastRequest.completedAtMs, T0 + 5_000, "lastRequest must survive");
  assert.equal(usage.lastRequest.generationMs, 2000);
  assert.equal(usage.cumulative.reasoningTokens, 15);
  assert.equal(usage.cumulative.inputTokens, 110);
  assert.equal(usage.cumulative.outputTokens, 46);

  // 缺 timeToFirstTokenMs 但带 generationMs：正常写 lastRequest，TTFT 字段缺席。
  deltas.push(
    ...modelComplete(projection, "turn-a", { inputTokens: 1, outputTokens: 2 }, { generationMs: 900 }, T0 + 7_000),
  );
  usage = projection.getSnapshot().usage;
  assert.deepEqual(usage.lastRequest, { outputTokens: 2, generationMs: 900, completedAtMs: T0 + 7_000 });
  assertWireSafe(projection, deltas);
});

test("cumulative.reasoningTokens stays absent while no event carries the fact", () => {
  const projection = new ProductProjection(SID, "epoch-reasoning-absent");
  startTurn(projection, "turn-r", "msg-r");
  modelComplete(projection, "turn-r", { inputTokens: 8, outputTokens: 2 }, { generationMs: 10 }, T0);
  const cumulative = projection.getSnapshot().usage.cumulative;
  assert.ok(
    !("reasoningTokens" in cumulative),
    "absent != 0: old events without the fact must not materialize reasoningTokens",
  );
});

test("turnHeader.stats accumulates multi-request turns with first TTFT and ΣgenerationMs", () => {
  const projection = new ProductProjection(SID, "epoch-stats-multi");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-b", "msg-b"));
  deltas.push(
    ...modelComplete(projection, "turn-b", FULL_USAGE, { generationMs: 2000, timeToFirstTokenMs: 800 }, T0 + 5_000),
  );
  deltas.push(
    ...modelComplete(
      projection,
      "turn-b",
      { inputTokens: 200, outputTokens: 60, cacheReadTokens: 20, reasoningTokens: 0 },
      { generationMs: 3000, timeToFirstTokenMs: 500 },
      T0 + 8_000,
    ),
  );
  deltas.push(...turnComplete(projection, "turn-b", "success"));
  const header = turnHeaderOf(projection, "msg-b");
  assert.equal(header.state, "completedSuccess");
  assert.deepEqual(header.stats, {
    inputTokens: 300,
    outputTokens: 100,
    reasoningTokens: 12,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    // 用户感知首字 = 本轮首个携带 TTFT 的请求，后续更小值不覆盖。
    timeToFirstTokenMs: 800,
    generationMs: 5000,
    modelRequestCount: 2,
  });
  assertWireSafe(projection, deltas);
});

test("turnHeader.stats is explicit null for pure-QA turns and hydration zero-usage placeholders", () => {
  const projection = new ProductProjection(SID, "epoch-stats-null");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-c", "msg-c"));
  // 冷恢复 hydration 会为历史轮合成零用量、无 timing 的 ModelComplete 占位；
  // 它不是模型事实，不得把 stats 变成全零对象。
  const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  deltas.push(...modelComplete(projection, "turn-c", zeroUsage, {}, T0 + 1_000));
  deltas.push(...turnComplete(projection, "turn-c", "success"));
  const header = turnHeaderOf(projection, "msg-c");
  assert.ok("stats" in header, "terminal turnHeader must carry explicit stats");
  assert.equal(header.stats, null);
  assertWireSafe(projection, deltas);
});

test("cancelled turns still flush accumulated stats", () => {
  const projection = new ProductProjection(SID, "epoch-stats-cancelled");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-d", "msg-d"));
  deltas.push(
    ...modelComplete(
      projection,
      "turn-d",
      { inputTokens: 50, outputTokens: 20, reasoningTokens: 4 },
      { generationMs: 1200, timeToFirstTokenMs: 300 },
      T0 + 2_000,
    ),
  );
  deltas.push(...turnComplete(projection, "turn-d", "cancelled"));
  const header = turnHeaderOf(projection, "msg-d");
  assert.equal(header.state, "completedInterrupted");
  assert.deepEqual(header.stats, {
    inputTokens: 50,
    outputTokens: 20,
    reasoningTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    timeToFirstTokenMs: 300,
    generationMs: 1200,
    modelRequestCount: 1,
  });
  assertWireSafe(projection, deltas);
});

test("stats omit timing fields when no request in the turn carried them", () => {
  const projection = new ProductProjection(SID, "epoch-stats-no-timing");
  startTurn(projection, "turn-e", "msg-e");
  modelComplete(projection, "turn-e", { inputTokens: 30, outputTokens: 9 }, {}, T0 + 1_000);
  turnComplete(projection, "turn-e", "success");
  const { stats } = turnHeaderOf(projection, "msg-e");
  assert.equal(stats.modelRequestCount, 1);
  assert.equal(stats.inputTokens, 30);
  assert.ok(!("generationMs" in stats), "no fabricated generationMs");
  assert.ok(!("timeToFirstTokenMs" in stats), "no fabricated TTFT");
});

test("autoCompactThresholdTokens gets real values from seedUsage and ModelSelected", () => {
  // seedUsage：200K 窗口 → 200000 − 21000(输出预留) − 13000(buffer) = 166000。
  const seeded = new ProductProjection(SID, "epoch-threshold-seed");
  seeded.seedUsage({
    contextWindow: { usedTokens: 5_000, maxTokens: 200_000, autoCompactThresholdTokens: null },
  });
  assert.equal(seeded.getSnapshot().usage.contextWindow.autoCompactThresholdTokens, 166_000);

  // ModelSelected：1M 窗口 → 966000；随后的 ModelComplete 只回写水位，不丢阈值。
  const selected = new ProductProjection(SID, "epoch-threshold-selected");
  const selectedEvent = ev("model_selected", {
    modelSelection: { providerId: "prov", modelId: "model" },
    contextWindow: 1_000_000,
  });
  const deltas = selected.applyEvent(selectedEvent);
  assert.equal(selected.getSnapshot().usage.contextWindow.autoCompactThresholdTokens, 966_000);
  startTurn(selected, "turn-t", "msg-t");
  deltas.push(
    ...modelComplete(selected, "turn-t", { inputTokens: 1200, outputTokens: 300 }, { generationMs: 400 }, T0 + 3_000),
  );
  assert.equal(
    selected.getSnapshot().usage.contextWindow.autoCompactThresholdTokens,
    966_000,
    "ModelComplete must carry the threshold, not reset it to null",
  );
  assertWireSafe(selected, deltas);

  // 事件已触碰窗口后的迟到 seed（touchedByEvent 分支，且尚无真实 ModelComplete
  // 水位）：阈值按当前窗口补齐，usedTokens 用种子真值，maxTokens 不被种子覆盖。
  const touched = new ProductProjection(SID, "epoch-threshold-touched");
  touched.applyEvent(selectedEvent);
  touched.seedUsage({
    contextWindow: { usedTokens: 8_000, maxTokens: 200_000, autoCompactThresholdTokens: null },
  });
  const window = touched.getSnapshot().usage.contextWindow;
  assert.equal(window.usedTokens, 8_000);
  assert.equal(window.maxTokens, 1_000_000, "seed must not override event-owned maxTokens");
  assert.equal(window.autoCompactThresholdTokens, 966_000);
});

test("unknown context window keeps threshold null instead of fabricating one", () => {
  const projection = new ProductProjection(SID, "epoch-threshold-unknown");
  projection.seedUsage({
    contextWindow: { usedTokens: 0, maxTokens: null, autoCompactThresholdTokens: null },
  });
  assert.equal(projection.getSnapshot().usage.contextWindow, null);
});

test("subagent summary carries cumulativeTokens from SubagentStopped across resume", () => {
  const projection = new ProductProjection(SID, "epoch-subagent-tokens");
  const spawn = {
    agentId: "agent-1",
    agentType: "Explore",
    childSessionId: "sess-c1",
    description: "explore the repo",
    status: "running",
  };
  const deltas = [];
  deltas.push(...subagentEvent(projection, "subagent_spawned", spawn, "turn-s"));
  let running = projection.getSnapshot().subagents.running;
  assert.equal(running.length, 1);
  assert.ok(!("cumulativeTokens" in running[0]), "no token fact yet: column must be absent, not 0");

  // 停止：summary 按既有生命周期离场（不在本任务扩语义）；totalTokens 记账。
  deltas.push(
    ...subagentEvent(
      projection,
      "subagent_stopped",
      { agentId: "agent-1", childSessionId: "sess-c1", status: "completed", totalTokens: 1234 },
      "turn-s",
    ),
  );
  assert.equal(projection.getSnapshot().subagents.running.length, 0);
  assert.equal(projection.getSnapshot().subagents.endedTotal, 1);

  // SendMessage resume 复活同一 child：summary 重新出现并附带已入账的累计 tokens。
  deltas.push(...subagentEvent(projection, "subagent_spawned", spawn, "turn-s"));
  running = projection.getSnapshot().subagents.running;
  assert.equal(running.length, 1);
  assert.equal(running[0].cumulativeTokens, 1234);
  assert.equal(running[0].childSessionId, "sess-c1");
  assertWireSafe(projection, deltas);
});

test("subagent stop without totalTokens does not fabricate a token column", () => {
  const projection = new ProductProjection(SID, "epoch-subagent-no-tokens");
  const spawn = { agentId: "agent-2", agentType: "Explore", childSessionId: "sess-c2", status: "running" };
  subagentEvent(projection, "subagent_spawned", spawn, "turn-n");
  subagentEvent(
    projection,
    "subagent_stopped",
    { agentId: "agent-2", childSessionId: "sess-c2", status: "failed", error: "boom" },
    "turn-n",
  );
  subagentEvent(projection, "subagent_spawned", spawn, "turn-n");
  const running = projection.getSnapshot().subagents.running;
  assert.equal(running.length, 1);
  assert.ok(!("cumulativeTokens" in running[0]));
});

// ── 验收场景 8：inFlight 链路（投影侧） ──────────────────────────────────────

function usageProgress(projection, turnId, progress, atMs) {
  return projection.applyEvent(
    ev(
      "model_streaming",
      {
        assistantMessageId: `msg-${turnId}`,
        delta: "",
        done: false,
        kind: "usage_progress",
        usageProgress: progress,
      },
      { turnId, atMs },
    ),
  );
}

function textDelta(projection, turnId, messageId, delta, atMs) {
  return projection.applyEvent(
    ev(
      "model_streaming",
      { assistantMessageId: messageId, delta, done: false, kind: "text_delta" },
      { turnId, atMs },
    ),
  );
}

function turnError(projection, turnId, atMs) {
  return projection.applyEvent(
    ev(
      "turn_error",
      {
        error: { type: "provider_error", message: "boom" },
        turnPhase: "streaming",
      },
      { turnId, atMs },
    ),
  );
}

function retryScheduled(projection, turnId, atMs) {
  return projection.applyEvent(
    ev(
      "model_network_status",
      {
        type: "model_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        reason: "network_error",
        message: "stream disconnected",
        requestId: "req-retry-1",
        providerId: "prov",
        modelId: "model",
        transport: "sse",
        timestamp: new Date(atMs ?? T0).toISOString(),
      },
      { turnId, atMs },
    ),
  );
}

/** 从 delta 列表提取所有 usage state patch（整键替换语义的载体）。 */
function usagePatches(deltas) {
  return deltas
    .filter((delta) => delta.op === "state.updated" && delta.patch?.usage !== undefined)
    .map((delta) => delta.patch.usage);
}

test("usageProgress writes inFlight; whole-key patch carries contextWindow/cumulative/lastRequest", () => {
  const projection = new ProductProjection(SID, "epoch-inflight-write");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-if", "msg-if"));
  // 首个模型步完成：权威 usage 三键落位（contextWindow/cumulative/lastRequest）。
  deltas.push(
    ...modelComplete(
      projection,
      "turn-if",
      FULL_USAGE,
      { generationMs: 2000, timeToFirstTokenMs: 800, contextWindow: 200_000 },
      T0 + 5_000,
    ),
  );
  const before = projection.getSnapshot().usage;
  assert.equal(before.inFlight, null, "ModelComplete must leave inFlight null");

  // 空 delta 不算首字（retry-safe 前奏语义，非用户感知输出）。
  deltas.push(...textDelta(projection, "turn-if", "msg-if2", "", T0 + 5_800));
  // 第二个模型步进行中：message_start 事实（只有 announced）→ 首条 inFlight。
  const startedAtMs = T0 + 5_500;
  let stepDeltas = usageProgress(projection, "turn-if", {
    announcedInputTokens: 1234,
    requestStartedAtMs: startedAtMs,
    observedAtMs: T0 + 6_100,
  });
  deltas.push(...stepDeltas);
  let patches = usagePatches(stepDeltas);
  assert.equal(patches.length, 1);
  // 整键带回：usage 补丁是整键替换语义，既有三键必须原值随行（spec 清除点节纪律）。
  assert.deepEqual(patches[0].contextWindow, before.contextWindow);
  assert.deepEqual(patches[0].cumulative, before.cumulative);
  assert.deepEqual(patches[0].lastRequest, before.lastRequest);
  // turnToDate = 累加器（input 100 / output 40）+ 本请求事实；首字未观测 → 缺席。
  assert.deepEqual(patches[0].inFlight, {
    startedAtMs,
    observedAtMs: T0 + 6_100,
    announcedInputTokens: 1234,
    turnToDateInputTokens: 100 + 1234,
    turnToDateOutputTokens: 40,
  });
  assert.ok(
    !("firstTokenAtMs" in patches[0].inFlight),
    "empty delta must not fabricate firstTokenAtMs",
  );

  // 非空 text_delta：投影观测首字时刻（firstTokenAtMs 进行中形态）。
  deltas.push(...textDelta(projection, "turn-if", "msg-if2", "Hello", T0 + 6_500));
  // message_delta 事实（同请求）：announced 合并保留（不被整键冲掉），partial 写入。
  stepDeltas = usageProgress(projection, "turn-if", {
    partialOutputTokens: 12,
    requestStartedAtMs: startedAtMs,
    observedAtMs: T0 + 7_000,
  });
  deltas.push(...stepDeltas);
  patches = usagePatches(stepDeltas);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].inFlight, {
    startedAtMs,
    observedAtMs: T0 + 7_000,
    announcedInputTokens: 1234,
    partialOutputTokens: 12,
    firstTokenAtMs: T0 + 6_500,
    turnToDateInputTokens: 1334,
    turnToDateOutputTokens: 52,
  });
  assert.deepEqual(projection.getSnapshot().usage.inFlight, patches[0].inFlight);

  // conflated：值未变（同 fact 重放）不重复下发 patch。
  stepDeltas = usageProgress(projection, "turn-if", {
    partialOutputTokens: 12,
    requestStartedAtMs: startedAtMs,
    observedAtMs: T0 + 7_000,
  });
  deltas.push(...stepDeltas);
  assert.equal(usagePatches(stepDeltas).length, 0, "unchanged value must not re-patch");

  // 跨请求（startedAtMs 变化 = 多模型步/流恢复）：整条替换，不继承旧请求字段。
  stepDeltas = usageProgress(projection, "turn-if", {
    partialOutputTokens: 3,
    requestStartedAtMs: T0 + 8_000,
    observedAtMs: T0 + 8_100,
  });
  deltas.push(...stepDeltas);
  patches = usagePatches(stepDeltas);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].inFlight, {
    startedAtMs: T0 + 8_000,
    observedAtMs: T0 + 8_100,
    partialOutputTokens: 3,
    turnToDateInputTokens: 100,
    turnToDateOutputTokens: 43,
  });
  assert.ok(
    !("announcedInputTokens" in patches[0].inFlight),
    "new request must not inherit previous announced fact",
  );
  assert.ok(
    !("firstTokenAtMs" in patches[0].inFlight),
    "first-token observation restarts with the new request",
  );
  assertWireSafe(projection, deltas);
});

test("turnToDate = accumulator + partial across multiple completed requests", () => {
  const projection = new ProductProjection(SID, "epoch-inflight-todate");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-td", "msg-td"));
  deltas.push(
    ...modelComplete(projection, "turn-td", { inputTokens: 100, outputTokens: 40 }, { generationMs: 500 }, T0 + 2_000),
  );
  deltas.push(
    ...modelComplete(projection, "turn-td", { inputTokens: 200, outputTokens: 60 }, { generationMs: 700 }, T0 + 3_000),
  );
  deltas.push(
    ...usageProgress(projection, "turn-td", {
      announcedInputTokens: 90,
      partialOutputTokens: 5,
      requestStartedAtMs: T0 + 3_500,
      observedAtMs: T0 + 3_900,
    }),
  );
  const inFlight = projection.getSnapshot().usage.inFlight;
  assert.equal(inFlight.turnToDateInputTokens, 300 + 90);
  assert.equal(inFlight.turnToDateOutputTokens, 100 + 5);
  assertWireSafe(projection, deltas);
});

test("fresh turn without accumulator keeps turnToDate at the live request facts only", () => {
  const projection = new ProductProjection(SID, "epoch-inflight-fresh");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-ft", "msg-ft"));
  // 只有 message_start 事实：turnToDateInput = announced；output 侧无任何事实 → 缺席不造 0。
  deltas.push(
    ...usageProgress(projection, "turn-ft", {
      announcedInputTokens: 77,
      requestStartedAtMs: T0 + 1_000,
      observedAtMs: T0 + 1_100,
    }),
  );
  const inFlight = projection.getSnapshot().usage.inFlight;
  assert.equal(inFlight.turnToDateInputTokens, 77);
  assert.ok(!("turnToDateOutputTokens" in inFlight), "absent != 0");
  assert.ok(!("partialOutputTokens" in inFlight));
  assertWireSafe(projection, deltas);
});

test("ModelComplete freezes inFlight to null atomically with authoritative usage", () => {
  const projection = new ProductProjection(SID, "epoch-inflight-clear-complete");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-mc", "msg-mc"));
  deltas.push(
    ...usageProgress(projection, "turn-mc", {
      announcedInputTokens: 500,
      requestStartedAtMs: T0 + 1_000,
      observedAtMs: T0 + 1_200,
    }),
  );
  assert.ok(projection.getSnapshot().usage.inFlight, "precondition: inFlight is live");
  const completeDeltas = modelComplete(
    projection,
    "turn-mc",
    FULL_USAGE,
    { generationMs: 1_500, timeToFirstTokenMs: 400 },
    T0 + 4_000,
  );
  deltas.push(...completeDeltas);
  assert.equal(projection.getSnapshot().usage.inFlight, null);
  // 权威 lastRequest/cumulative 与 inFlight:null 必须在同一 usage patch（原子替换）。
  const patches = usagePatches(completeDeltas);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].inFlight, null);
  assert.deepEqual(patches[0].lastRequest, {
    outputTokens: 40,
    generationMs: 1_500,
    timeToFirstTokenMs: 400,
    completedAtMs: T0 + 4_000,
  });
  assert.ok(patches[0].cumulative.inputTokens >= FULL_USAGE.inputTokens);
  assertWireSafe(projection, deltas);
});

test("TurnComplete clears inFlight alongside stats freeze", () => {
  const projection = new ProductProjection(SID, "epoch-inflight-clear-turncomplete");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-tc", "msg-tc"));
  deltas.push(
    ...usageProgress(projection, "turn-tc", {
      partialOutputTokens: 21,
      requestStartedAtMs: T0 + 1_000,
      observedAtMs: T0 + 1_600,
    }),
  );
  assert.ok(projection.getSnapshot().usage.inFlight);
  const completeDeltas = turnComplete(projection, "turn-tc", "success");
  deltas.push(...completeDeltas);
  assert.equal(projection.getSnapshot().usage.inFlight, null);
  assert.ok(
    usagePatches(completeDeltas).some((patch) => patch.inFlight === null),
    "TurnComplete must emit the inFlight clear patch",
  );
  assertWireSafe(projection, deltas);
});

test("TurnError clears inFlight when leaving running", () => {
  const projection = new ProductProjection(SID, "epoch-inflight-clear-turnerror");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-te", "msg-te"));
  deltas.push(
    ...usageProgress(projection, "turn-te", {
      announcedInputTokens: 640,
      requestStartedAtMs: T0 + 1_000,
      observedAtMs: T0 + 1_300,
    }),
  );
  assert.ok(projection.getSnapshot().usage.inFlight);
  const errorDeltas = turnError(projection, "turn-te", T0 + 2_000);
  deltas.push(...errorDeltas);
  assert.equal(projection.getSnapshot().usage.inFlight, null);
  assert.equal(projection.getSnapshot().control.phase, "error");
  assertWireSafe(projection, deltas);
});

test("apiRetry is an inFlight clearing point (stale physical request facts must not linger)", () => {
  const projection = new ProductProjection(SID, "epoch-inflight-clear-apiretry");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-ar", "msg-ar"));
  deltas.push(
    ...usageProgress(projection, "turn-ar", {
      announcedInputTokens: 800,
      partialOutputTokens: 9,
      requestStartedAtMs: T0 + 1_000,
      observedAtMs: T0 + 1_800,
    }),
  );
  assert.ok(projection.getSnapshot().usage.inFlight);
  // spec「In-flight 真实用量事实面」清除点：apiRetry/相位复位路径——重试调度意味着
  // 旧物理请求已死，进行中事实作废；新 attempt 的 message_start 会以新 startedAtMs 重建。
  const retryDeltas = retryScheduled(projection, "turn-ar", T0 + 2_500);
  deltas.push(...retryDeltas);
  assert.equal(projection.getSnapshot().usage.inFlight, null);
  assert.ok(projection.getSnapshot().control.apiRetry, "retry banner must be set");
  assertWireSafe(projection, deltas);
});

test("no usageProgress facts means no inFlight patches anywhere in the turn", () => {
  const projection = new ProductProjection(SID, "epoch-inflight-absent");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-na", "msg-na"));
  deltas.push(...textDelta(projection, "turn-na", "msg-na", "Hello world", T0 + 1_000));
  // 防御：kind=usage_progress 但 usageProgress 字段缺席（旧 core/异常发射点）→ 零 patch。
  const noFact = usageProgress(projection, "turn-na", undefined);
  deltas.push(...noFact);
  assert.equal(noFact.filter((delta) => delta.op === "state.updated").length, 0);
  const completeDeltas = modelComplete(projection, "turn-na", FULL_USAGE, { generationMs: 900 }, T0 + 2_000);
  deltas.push(...completeDeltas);
  const turnEndDeltas = turnComplete(projection, "turn-na", "success");
  deltas.push(...turnEndDeltas);
  // 全链路没有任何非 null inFlight 写入（provider 无中途事实 → 如实缺席，UI 降级秒表）。
  for (const patch of usagePatches(deltas)) {
    assert.ok(
      patch.inFlight === null || patch.inFlight === undefined,
      `unexpected inFlight write: ${JSON.stringify(patch.inFlight)}`,
    );
  }
  // 值未变不刷：inFlight 已为 null 时 TurnComplete 不再发多余 usage patch。
  assert.equal(usagePatches(turnEndDeltas).length, 0);
  assertWireSafe(projection, deltas);
});

test("late or stale-turn usageProgress cannot resurrect a ghost inFlight", () => {
  const projection = new ProductProjection(SID, "epoch-inflight-ghost");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-g1", "msg-g1"));
  deltas.push(
    ...usageProgress(projection, "turn-g1", {
      announcedInputTokens: 300,
      requestStartedAtMs: T0 + 1_000,
      observedAtMs: T0 + 1_400,
    }),
  );
  deltas.push(...turnComplete(projection, "turn-g1", "success"));
  assert.equal(projection.getSnapshot().usage.inFlight, null);

  // 离开 running 后迟到事实：拒收，不复活幽灵「进行中」。
  const afterEnd = usageProgress(projection, "turn-g1", {
    partialOutputTokens: 99,
    requestStartedAtMs: T0 + 1_000,
    observedAtMs: T0 + 9_000,
  });
  deltas.push(...afterEnd);
  assert.equal(afterEnd.length, 0);
  assert.equal(projection.getSnapshot().usage.inFlight, null);

  // 新一轮进行中，旧 turnId 的迟到事实按 turnId 隔离拒收；当前轮事实正常写入。
  deltas.push(...startTurn(projection, "turn-g2", "msg-g2"));
  const staleTurn = usageProgress(projection, "turn-g1", {
    partialOutputTokens: 77,
    requestStartedAtMs: T0 + 1_000,
    observedAtMs: T0 + 10_000,
  });
  deltas.push(...staleTurn);
  assert.equal(staleTurn.length, 0);
  assert.equal(projection.getSnapshot().usage.inFlight, null);
  const current = usageProgress(projection, "turn-g2", {
    announcedInputTokens: 42,
    requestStartedAtMs: T0 + 9_500,
    observedAtMs: T0 + 9_900,
  });
  deltas.push(...current);
  assert.equal(projection.getSnapshot().usage.inFlight?.startedAtMs, T0 + 9_500);
  assert.equal(projection.getSnapshot().usage.inFlight?.announcedInputTokens, 42);
  assertWireSafe(projection, deltas);
});
