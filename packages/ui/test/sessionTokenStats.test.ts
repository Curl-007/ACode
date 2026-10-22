import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import * as sessionTokenStats from "../src/v4/composer/sessionTokenStats.js";
import {
  collectChildSessionIds,
  collectLiveChildSessionIds,
  isLiveOutputPhase,
  readChildSessionTokenTotal,
  readLiveOutputObservation,
  readSessionTokenTotal,
  readStreamingOutputRate,
  readStreamingOutputSample,
  recordStreamingOutputSample,
  retainObservedOutputRate,
} from "../src/v4/composer/sessionTokenStats.js";

function snapshot(overrides: Record<string, unknown> = {}): ConversationSnapshot {
  return {
    sessionId: "parent",
    logEpoch: 1,
    revision: 1,
    seq: 1,
    control: { phase: "running" },
    config: { model: "provider/model-x" },
    usage: {
      cumulative: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5 },
      contextWindow: { usedTokens: 0, maxTokens: 1000, autoCompactThresholdTokens: null },
    },
    subagents: { revision: 1, childSessionIds: [], running: [], endedTotal: 0 },
    workflowRuns: { runs: [] },
    rows: { window: [] },
    ...overrides,
  } as unknown as ConversationSnapshot;
}

test("no inFlight API is exposed (spec §12.3)", () => {
  assert.equal("readInFlightSessionUsage" in sessionTokenStats, false);
  assert.equal("withInFlightSessionUsage" in sessionTokenStats, false);
});

test("live output observation follows one streaming reasoning response during prewarming", () => {
  const value = snapshot({
    control: { phase: "prewarming" },
    rows: {
      window: [
        {
          kind: "reasoning",
          rowId: 1,
          assistantResponseId: "r1",
          state: "streaming",
          text: "思考中",
        },
      ],
    },
  });
  assert.equal(isLiveOutputPhase("prewarming"), true);
  const observation = readLiveOutputObservation(value);
  assert.equal(observation?.sessionId, "parent");
  // 3 个汉字各计 2，共 6 / 3 = 2。
  assert.equal(observation?.sample.estimatedTokens, 2);
});

test("tool rows end the streaming sample; completed rows are not sampled", () => {
  assert.equal(
    readStreamingOutputSample([
      { kind: "assistantText", rowId: 1, state: "streaming", text: "hello" },
      { kind: "toolCall", rowId: 2 },
    ] as never),
    null,
  );
  assert.equal(
    readStreamingOutputSample([
      { kind: "assistantText", rowId: 1, state: "complete", text: "hello" },
    ] as never),
    null,
  );
});

test("child ids include dispatched workflow actors and dedupe", () => {
  const value = snapshot({
    subagents: { revision: 1, childSessionIds: ["a", "parent", "a"], running: [], endedTotal: 0 },
    workflowRuns: {
      runs: [
        {
          actors: [
            { sessionId: "w-queued", siteId: "s1", ordinal: 1 },
            { sessionId: "w-live", siteId: "s2", ordinal: 1 },
            { sessionId: "parent", siteId: "s3", ordinal: 1 },
          ],
          nodes: [
            { actorSiteId: "s1", actorOrdinal: 1, phase: "queued" },
            { actorSiteId: "s2", actorOrdinal: 1, phase: "running" },
            { actorSiteId: "s3", actorOrdinal: 1, phase: "running" },
          ],
        },
      ],
    },
  });
  assert.deepEqual(collectChildSessionIds(value, "parent"), ["a", "w-live"]);
});

test("live child subscriptions only include running subagents/actors, capped at 6", () => {
  const value = snapshot({
    subagents: {
      revision: 1,
      childSessionIds: ["a", "b", "c"],
      running: [
        { childSessionId: "a", subagentType: "Explore", title: "A", status: "running" },
        { childSessionId: "b", subagentType: "Explore", title: "B", status: "waiting" },
      ],
      endedTotal: 0,
    },
    workflowRuns: {
      runs: [
        {
          actors: Array.from({ length: 10 }, (_, index) => ({
            sessionId: `w-${index}`,
            siteId: `s-${index}`,
            ordinal: 1,
          })),
          nodes: Array.from({ length: 10 }, (_, index) => ({
            actorSiteId: `s-${index}`,
            actorOrdinal: 1,
            phase: index === 0 ? "settled" : "running",
          })),
        },
      ],
    },
  });
  const ids = collectLiveChildSessionIds(value, "parent");
  assert.equal(ids.length, 6);
  assert.deepEqual(ids.slice(0, 2), ["a", "b"]);
  assert.equal(ids.includes("w-0"), false);
});

test("child total: completed answer without usage is unknown, not zero", () => {
  const unknown = snapshot({
    usage: {
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextWindow: { usedTokens: 0, maxTokens: 1000, autoCompactThresholdTokens: null },
    },
    rows: {
      window: [{ kind: "assistantText", rowId: 1, state: "complete", text: "done" }],
    },
  });
  assert.equal(readChildSessionTokenTotal(unknown), null);
  const empty = snapshot({
    usage: {
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextWindow: { usedTokens: 0, maxTokens: 1000, autoCompactThresholdTokens: null },
    },
  });
  assert.equal(readChildSessionTokenTotal(empty), 0);
});

test("session total counts input+output once and treats zero-with-context as unknown", () => {
  assert.equal(
    readSessionTokenTotal({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    }),
    15,
  );
  assert.equal(
    readSessionTokenTotal(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      42,
    ),
    null,
  );
  assert.equal(readSessionTokenTotal(null), null);
});

test("rolling rate: 2.5s window, 1.5s staleness, 200ms minimum span", () => {
  let tracker = recordStreamingOutputSample(null, { responseId: "r1", estimatedTokens: 10 }, 1000);
  tracker = recordStreamingOutputSample(tracker, { responseId: "r1", estimatedTokens: 30 }, 2000);
  assert.equal(readStreamingOutputRate(tracker, 2000), 20);
  // 1.5s 内没有新样本 → 作废。
  assert.equal(readStreamingOutputRate(tracker, 3501), null);
  // 新响应重置窗口。
  tracker = recordStreamingOutputSample(tracker, { responseId: "r2", estimatedTokens: 5 }, 2100);
  assert.equal(readStreamingOutputRate(tracker, 2100), null);
  assert.equal(retainObservedOutputRate(12, null), 12);
  assert.equal(retainObservedOutputRate(12, 0), 12);
  assert.equal(retainObservedOutputRate(12, 30), 30);
});
