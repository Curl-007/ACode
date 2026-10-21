// 用量状态栏 bootstrap 投影验收（apps/acode-cli/specs/usage-statusbar.md 验收场景 3）。
//
// 覆盖面：onModelComplete 写 lastRequest/cumulative.reasoningTokens（含旁路发射点缺
// timing 字段的防御）；turnHeader.stats 每轮累计 + 首 TTFT + 纯问答 null + 取消轮 flush
// + hydration 零用量占位不算模型事实；autoCompactThresholdTokens 真值（seedUsage 与
// ModelSelected 两处 + 窗口未知不造值）；RunningSubagentSummary.cumulativeTokens
// （SubagentStopped.totalTokens 记账，resume 复活的 summary 附带；停止后按既有生命周期离场）。
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

// ── 本轮生成指标（composerTurnMetrics）与会话工具统计（sessionToolStats）──
// 口径见 apps/acode-cli/specs/usage-statusbar-port.md §3.1/§3.2。

let requestSequence = 0;

function requestCompleted(projection, turnId, options = {}) {
  requestSequence += 1;
  const inputTokens = options.inputTokens ?? 100;
  const outputTokens = options.outputTokens ?? 40;
  const durationMs = options.durationMs ?? 4_000;
  // 「显式传 undefined」与「没传」语义不同：前者必须继续缺席（旁路/旧事件）。
  const timeToFirstContentMs = Object.hasOwn(options, "timeToFirstContentMs")
    ? options.timeToFirstContentMs
    : 300;
  const querySource = Object.hasOwn(options, "querySource") ? options.querySource : "main_turn";
  const { reasoningTokens } = options;
  return projection.applyEvent(
    ev(
      "model_network_status",
      {
        type: "model_request_completed",
        requestId: `req-${requestSequence}`,
        ...(querySource === undefined ? {} : { querySource }),
        durationMs,
        ...(timeToFirstContentMs === undefined ? {} : { timeToFirstContentMs }),
        usage: {
          inputTokens,
          outputTokens,
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        },
        providerId: "provider",
        modelId: "model",
        transport: "http",
        attempt: 1,
        maxAttempts: 1,
      },
      { turnId },
    ),
  );
}

function retryScheduled(projection, turnId, querySource = "main_turn") {
  requestSequence += 1;
  return projection.applyEvent(
    ev(
      "model_network_status",
      {
        type: "model_retry_scheduled",
        requestId: `req-retry-${requestSequence}`,
        querySource,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1_000,
        reason: "rate_limit",
        message: "429",
        providerId: "provider",
        modelId: "model",
        transport: "http",
      },
      { turnId },
    ),
  );
}

function toolScheduled(projection, turnId, toolCallId, toolName = "Read") {
  return projection.applyEvent(
    ev("tool_call_scheduled", { toolCallId, toolName, input: { path: "README.md" } }, { turnId }),
  );
}

function toolResult(projection, turnId, toolCallId, toolName = "Read", success = true, duration = 120) {
  return projection.applyEvent(
    ev(
      "tool_call_result",
      {
        toolCallId,
        toolName,
        duration,
        result: success
          ? { success: true, content: "ok" }
          : { success: false, content: "boom", error: { type: "tool_failed", message: "boom" } },
      },
      { turnId },
    ),
  );
}

function toolCancelled(projection, turnId, toolCallId, toolName = "Read") {
  return projection.applyEvent(
    ev(
      "tool_call_error",
      { toolCallId, toolName, error: { type: "tool_cancelled", message: "cancelled" } },
      { turnId },
    ),
  );
}

function modelCompletedWithFileChanges(projection, turnId, files, additions, deletions, atMs) {
  requestSequence += 1;
  return projection.applyEvent(
    ev(
      "model_complete",
      {
        content: "ok",
        querySource: "main_turn",
        stopReason: "end_turn",
        toolCallCount: 0,
        usage: { inputTokens: 10, outputTokens: 10 },
        fileChanges: { additions, deletions, files },
      },
      { turnId, atMs },
    ),
  );
}

test("composerTurnMetrics: main_turn request accumulates and streaming follows turn lifecycle", () => {
  const projection = new ProductProjection(SID, "epoch-turn-metrics");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-m", "msg-m"));
  deltas.push(
    ...requestCompleted(projection, "turn-m", {
      inputTokens: 100,
      outputTokens: 465,
      durationMs: 10_000,
      timeToFirstContentMs: 850,
    }),
  );
  let metrics = projection.getSnapshot().composerTurnMetrics;
  assert.equal(metrics?.streaming, true);
  assert.equal(metrics?.metrics.firstTokenMs, 850);
  assert.equal(metrics?.metrics.outputTokens, 465);
  assert.equal(metrics?.metrics.inputTokens, 100);
  assert.equal(metrics?.metrics.requestCount, 1);
  // tok/s = 465 / (10000-850)ms * 1000 ≈ 50.82
  assert.ok(Math.abs((metrics?.metrics.tokensPerSecond ?? 0) - 50.82) < 0.1);
  assert.ok(
    deltas.some(
      (delta) =>
        delta.op === "state.updated" && delta.patch.composerTurnMetrics?.streaming === true,
    ),
  );

  // 旁路请求（标题/压缩/subagent/缺 querySource）不进入累加器。
  for (const querySource of ["session_title", "compact", "subagent", undefined]) {
    requestCompleted(projection, "turn-m", { querySource, outputTokens: 999 });
  }
  assert.equal(projection.getSnapshot().composerTurnMetrics?.metrics.outputTokens, 465);

  const completion = turnComplete(projection, "turn-m", "success");
  deltas.push(...completion);
  metrics = projection.getSnapshot().composerTurnMetrics;
  assert.equal(metrics?.streaming, false);
  assert.equal(metrics?.metrics.outputTokens, 465);

  // 新 TurnStarted 清空 composerTurnMetrics，不残留上一轮数字。
  deltas.push(...startTurn(projection, "turn-n", "msg-n"));
  assert.equal(projection.getSnapshot().composerTurnMetrics, null);
  assertWireSafe(projection, deltas);
});

test("composerTurnMetrics: peak is per-request max, weighted tps uses完整 decode windows", () => {
  const projection = new ProductProjection(SID, "epoch-turn-metrics-peak");
  startTurn(projection, "turn-p", "msg-p");
  // 段 1 慢：200 tokens / (10000-0)ms ≈ 20 tok/s；段 2 快：800 / 2000ms = 400 tok/s。
  requestCompleted(projection, "turn-p", {
    outputTokens: 200,
    durationMs: 10_000,
    timeToFirstContentMs: 0,
  });
  requestCompleted(projection, "turn-p", {
    outputTokens: 800,
    durationMs: 2_000,
    timeToFirstContentMs: 0,
  });
  const metrics = projection.getSnapshot().composerTurnMetrics?.metrics;
  assert.ok(Math.abs((metrics?.tokensPerSecond ?? 0) - 83.33) < 0.2);
  assert.ok(Math.abs((metrics?.peakTokensPerSecond ?? 0) - 400) < 0.2);
  assert.equal(metrics?.requestCount, 2);

  // 缺 timeToFirstContentMs 的请求只加输出 token，不进 tok/s / 峰值分母。
  requestCompleted(projection, "turn-p", {
    outputTokens: 9_999,
    durationMs: 1_000,
    timeToFirstContentMs: undefined,
  });
  const after = projection.getSnapshot().composerTurnMetrics?.metrics;
  assert.equal(after?.outputTokens, 10_999);
  assert.ok(Math.abs((after?.peakTokensPerSecond ?? 0) - 400) < 0.2);
  assert.ok(Math.abs((after?.tokensPerSecond ?? 0) - 83.33) < 0.2);
});

test("turnHeader.stats carries the same tokensPerSecond/peak as composerTurnMetrics", () => {
  const projection = new ProductProjection(SID, "epoch-turn-metrics-stats");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-s", "msg-s"));
  deltas.push(
    ...requestCompleted(projection, "turn-s", {
      outputTokens: 800,
      durationMs: 2_000,
      timeToFirstContentMs: 0,
    }),
  );
  deltas.push(
    ...modelComplete(
      projection,
      "turn-s",
      { inputTokens: 100, outputTokens: 800 },
      { generationMs: 2_000, timeToFirstTokenMs: 100 },
      T0 + 9_000,
    ),
  );
  deltas.push(...turnComplete(projection, "turn-s", "success"));
  const composer = projection.getSnapshot().composerTurnMetrics?.metrics;
  const header = turnHeaderOf(projection, "msg-s");
  assert.equal(header.stats.tokensPerSecond, composer.tokensPerSecond);
  assert.equal(header.stats.peakTokensPerSecond, composer.peakTokensPerSecond);
  assertWireSafe(projection, deltas);
});

test("sessionToolStats: terminal transitions only, cancelled counts calls but not errors", () => {
  const projection = new ProductProjection(SID, "epoch-tool-stats");
  const deltas = [];
  deltas.push(...startTurn(projection, "turn-t", "msg-t"));
  assert.equal(projection.getSnapshot().sessionToolStats?.turnCount, 1);
  // 仅排期不算调用。
  deltas.push(...toolScheduled(projection, "turn-t", "tool-a"));
  assert.equal(projection.getSnapshot().sessionToolStats?.calls, 0);
  // 成功 → calls+1。
  deltas.push(...toolResult(projection, "turn-t", "tool-a", "Read", true, 1_000));
  assert.equal(projection.getSnapshot().sessionToolStats?.calls, 1);
  assert.equal(projection.getSnapshot().sessionToolStats?.errors, 0);
  // 迟到重复结果不重复计数。
  deltas.push(...toolResult(projection, "turn-t", "tool-a", "Read", true, 1_000));
  assert.equal(projection.getSnapshot().sessionToolStats?.calls, 1);
  // 失败 → calls+1 / errors+1。
  deltas.push(...toolScheduled(projection, "turn-t", "tool-b", "Read"));
  deltas.push(...toolResult(projection, "turn-t", "tool-b", "Read", false, 2_500));
  let stats = projection.getSnapshot().sessionToolStats;
  assert.equal(stats?.calls, 2);
  assert.equal(stats?.errors, 1);
  assert.deepEqual(stats?.tools, [{ name: "Read", calls: 2, errors: 1, durationMs: 3_500 }]);
  // 取消 → calls+1 / errors 不变；耗时未知不写 0。
  deltas.push(...toolScheduled(projection, "turn-t", "tool-c", "Bash"));
  deltas.push(...toolCancelled(projection, "turn-t", "tool-c", "Bash"));
  stats = projection.getSnapshot().sessionToolStats;
  assert.equal(stats?.calls, 3);
  assert.equal(stats?.errors, 1);
  assert.deepEqual(stats?.tools, [
    { name: "Read", calls: 2, errors: 1, durationMs: 3_500 },
    { name: "Bash", calls: 1, errors: 0 },
  ]);
  assertWireSafe(projection, deltas);
});

test("sessionToolStats: retry/request/reasoning/rounds are main_turn scoped", () => {
  const projection = new ProductProjection(SID, "epoch-tool-stats-session");
  startTurn(projection, "turn-r", "msg-r");
  retryScheduled(projection, "turn-r");
  retryScheduled(projection, "turn-r");
  retryScheduled(projection, "turn-r", "session_title");
  assert.equal(projection.getSnapshot().sessionToolStats?.retryCount, 2);
  requestCompleted(projection, "turn-r", { reasoningTokens: 12 });
  assert.equal(projection.getSnapshot().sessionToolStats?.requestCount, 1);
  assert.equal(projection.getSnapshot().sessionToolStats?.reasoningTokens, 12);
  requestCompleted(projection, "turn-r", { querySource: "subagent", reasoningTokens: 999 });
  assert.equal(projection.getSnapshot().sessionToolStats?.requestCount, 1);
  // 会话累计不随轮归零；轮数随新轮 +1。
  startTurn(projection, "turn-r2", "msg-r2");
  const stats = projection.getSnapshot().sessionToolStats;
  assert.equal(stats?.turnCount, 2);
  assert.equal(stats?.retryCount, 2);
  assert.equal(stats?.requestCount, 1);
});

test("sessionToolStats: file changes take each turn's latest value and sum across turns", () => {
  const projection = new ProductProjection(SID, "epoch-tool-stats-files");
  startTurn(projection, "turn-f", "msg-f");
  modelCompletedWithFileChanges(projection, "turn-f", 5, 100, 20, T0 + 5_000);
  modelCompletedWithFileChanges(projection, "turn-f", 7, 120, 30, T0 + 6_000);
  let stats = projection.getSnapshot().sessionToolStats;
  assert.equal(stats?.linesAdded, 120);
  assert.equal(stats?.linesDeleted, 30);
  assert.equal(stats?.fileCount, 7);

  startTurn(projection, "turn-f2", "msg-f2");
  modelCompletedWithFileChanges(projection, "turn-f2", 3, 10, 1, T0 + 9_000);
  stats = projection.getSnapshot().sessionToolStats;
  assert.equal(stats?.linesAdded, 130);
  assert.equal(stats?.linesDeleted, 31);
  assert.equal(stats?.fileCount, 10);
});
