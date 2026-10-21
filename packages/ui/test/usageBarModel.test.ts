import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import {
  buildUsageBarModel,
  DEFAULT_USAGE_BAR_SETTINGS,
  mergeUsageBarSettings,
  resolveUsageBarSettings,
  USAGE_BAR_COLLAPSE_ORDER,
  USAGE_BAR_COLLAPSE_TIER,
  USAGE_BAR_TOGGLE_LABEL_ID,
  USAGE_BAR_TOGGLE_ORDER,
  USAGE_BAR_TOGGLE_PREFERENCE_KEY,
  type UsageBarInput,
  type UsageBarSettings,
} from "../src/v4/composer/usage-bar/usageBarModel.js";
import type { TurnMetricsMessageFormat } from "../src/chat-input-toolbar/turnMetrics.js";

// 用真实 en-US 词典驱动，顺带守护 §7.3 的键存在性。
function formatMessage(descriptor: { id: string }, values?: Record<string, string | number>) {
  let text = enUS[descriptor.id] ?? descriptor.id;
  if (values) {
    // 极简 ICU：覆盖本文件用到的键（{count, plural, one {# error} other {# errors}}）。
    text = text.replace(
      /\{count, plural, one \{# ([^}]+)\} other \{# ([^}]+)\}\}/g,
      (_m, one, other) => (Number(values.count) === 1 ? String(one) : String(other)),
    );
    for (const [key, value] of Object.entries(values)) {
      text = text.replaceAll(`{${key}}`, String(value));
    }
  }
  return text;
}
const fmt: TurnMetricsMessageFormat = formatMessage;

const metrics = (overrides: Record<string, unknown> = {}) => ({
  firstTokenMs: 800,
  outputTokens: 1200,
  tokensPerSecond: 88.5,
  inputTokens: 2000,
  requestCount: 6,
  reasoningTokens: 300,
  cacheReadTokens: 1000,
  cacheWriteTokens: 200,
  peakTokensPerSecond: 168,
  ...overrides,
});

function input(overrides: Partial<UsageBarInput> = {}): UsageBarInput {
  return {
    turnMetrics: { metrics: metrics(), streaming: false },
    turnLive: false,
    mainTokenTotal: 3200,
    mainInputTokens: 2000,
    mainOutputTokens: 1200,
    sessionTokenTotal: 4000,
    incompleteTotal: false,
    contextCapacity: {
      usedTokens: 30000,
      maxTokens: 100000,
      autoCompactThresholdTokens: 85000,
      cacheHitRate: 0.5,
    },
    liveOutputRate: null,
    childLiveOutputRate: null,
    childCount: 0,
    childTokenTotal: 0,
    childCurrentOutputTokens: null,
    cacheHitRate: 0.5,
    toolStats: {
      calls: 10,
      errors: 0,
      turnCount: 3,
      requestCount: 5,
      reasoningTokens: 300,
      retryCount: 1,
      linesAdded: 10,
      linesDeleted: 2,
      fileCount: 3,
    },
    subagentGroups: { running: 0, ended: 0, mainTokenTotal: 3200, runningTokenTotal: null },
    todayUsage: {
      totalTokens: 5000,
      turnCount: 4,
      toolCallCount: 9,
      inputTokens: 4000,
      outputTokens: 1000,
      cacheHitRate: 0.5,
      requestCount: 8,
    },
    estimatedCostLabel: null,
    settings: DEFAULT_USAGE_BAR_SETTINGS,
    formatMessage: fmt,
    locale: "en-US",
    ...overrides,
  };
}

test("empty input hides every segment (no placeholders)", () => {
  const model = buildUsageBarModel(
    input({
      turnMetrics: null,
      mainTokenTotal: null,
      sessionTokenTotal: null,
      contextCapacity: null,
      toolStats: null,
      todayUsage: null,
      childCount: 0,
    }),
  );
  assert.deepEqual(model.segments, []);
  assert.equal(model.visible, false);
});

test("segment switches hide their own segment only", () => {
  const settings: UsageBarSettings = {
    ...DEFAULT_USAGE_BAR_SETTINGS,
    context: false,
    today: false,
  };
  const model = buildUsageBarModel(input({ settings }));
  assert.deepEqual(
    model.segments.map((segment) => segment.id),
    ["speed", "turnUsage", "session", "tools"],
  );
});

test("speed: streaming shows estimate with ≈ and live tone; settled uses measured tiers", () => {
  const live = buildUsageBarModel(
    input({
      turnLive: true,
      liveOutputRate: 42,
      turnMetrics: { metrics: metrics({ tokensPerSecond: 88.5 }), streaming: false },
    }),
  ).segments[0]!;
  assert.equal(live.id, "speed");
  assert.equal(live.tone, "live");
  assert.match(live.value, /≈42 tok\/s/u);

  const measured = (tokensPerSecond: number) =>
    buildUsageBarModel(
      input({ turnMetrics: { metrics: metrics({ tokensPerSecond }), streaming: false } }),
    ).segments[0]!;
  assert.equal(measured(70).tone, "success");
  assert.equal(measured(69.9).tone, "warning");
  assert.equal(measured(39.9).tone, "error");
  // 收口后不回退到实时估算。
  const settled = buildUsageBarModel(
    input({ liveOutputRate: 42, turnMetrics: { metrics: metrics(), streaming: false } }),
  ).segments[0]!;
  assert.equal(settled.tone, "success");
  assert.equal(
    settled.detailRows.some((row) => row.label.includes("tok/s")),
    false,
  );
});

test("turnUsage hides before the first completed request (target has no inFlight)", () => {
  const model = buildUsageBarModel(input({ turnLive: true, turnMetrics: null }));
  assert.equal(
    model.segments.some((segment) => segment.id === "turnUsage"),
    false,
  );
  const legacy = buildUsageBarModel(
    input({ turnMetrics: { metrics: metrics({ inputTokens: undefined }), streaming: false } }),
  );
  assert.equal(
    legacy.segments.some((segment) => segment.id === "turnUsage"),
    false,
  );
  const withInput = buildUsageBarModel(input()).segments.find((s) => s.id === "turnUsage")!;
  assert.equal(withInput.value, "3.2K");
  assert.equal(withInput.detailRows.length, 9);
});

test("context capacity: three tiers, ring, blink and overflow advice", () => {
  const normal = buildUsageBarModel(input()).segments.find((s) => s.id === "context")!;
  assert.equal(normal.tone, "default");
  assert.deepEqual(normal.ring, { ratio: 0.3 });
  const near = buildUsageBarModel(
    input({
      contextCapacity: {
        usedTokens: 85000,
        maxTokens: 100000,
        autoCompactThresholdTokens: 85000,
        cacheHitRate: null,
      },
    }),
  ).segments.find((s) => s.id === "context")!;
  assert.equal(near.tone, "warning");
  const over = buildUsageBarModel(
    input({
      contextCapacity: {
        usedTokens: 103000,
        maxTokens: 100000,
        autoCompactThresholdTokens: 85000,
        cacheHitRate: null,
      },
    }),
  ).segments.find((s) => s.id === "context")!;
  assert.equal(over.tone, "error");
  assert.equal(over.blink, true);
  assert.match(over.value, /103%/u);
  assert.match(over.note ?? "", /compact/u);
  const missing = buildUsageBarModel(
    input({
      contextCapacity: {
        usedTokens: 100,
        maxTokens: 0,
        autoCompactThresholdTokens: null,
        cacheHitRate: null,
      },
    }),
  );
  assert.equal(
    missing.segments.some((s) => s.id === "context"),
    false,
  );
});

test("session segment: ≥ for unknown children, detail rows and estimated cost", () => {
  const segment = buildUsageBarModel(
    input({ incompleteTotal: true, estimatedCostLabel: "$0.42" }),
  ).segments.find((s) => s.id === "session")!;
  assert.match(segment.value, /^≥/u);
  const labels = segment.detailRows.map((row) => row.label);
  assert.ok(labels.some((label) => label.includes("Reasoning")));
  assert.ok(labels.some((label) => label.includes("Turns")));
  assert.ok(labels.some((label) => label.includes("Model requests")));
  assert.ok(labels.some((label) => label.includes("Code +/−")));
  assert.ok(labels.includes("Estimated session cost"));
  assert.match(segment.note ?? "", /third-party price/u);
});

test("tools segment: count value + error badge, 12-row cap sorted by calls then name", () => {
  const tools = Array.from({ length: 14 }, (_, index) => ({
    name: `tool-${String(index).padStart(2, "0")}`,
    calls: index === 0 ? 20 : 2,
    errors: index === 1 ? 3 : 0,
    durationMs: index === 0 ? 65_000 : undefined,
  }));
  const segment = buildUsageBarModel(
    input({ toolStats: { calls: 114, errors: 2, tools } }),
  ).segments.find((s) => s.id === "tools")!;
  assert.equal(segment.value, "114");
  assert.equal(segment.badge?.count, 2);
  assert.equal(segment.tone, "error");
  // 1 header + 12 tools + 1 failures row.
  assert.equal(segment.detailRows.length, 14);
  assert.match(segment.detailRows[1]!.value, /20 · 1m5s/u);
  assert.equal(segment.detailRows[2]!.badge?.count, 3);
  const clean = buildUsageBarModel(input({ toolStats: { calls: 3, errors: 0 } })).segments.find(
    (s) => s.id === "tools",
  )!;
  assert.equal(clean.badge, undefined);
  assert.equal(clean.tone, "default");
});

test("today segment: breakdown rows only when fields exist", () => {
  const full = buildUsageBarModel(input()).segments.find((s) => s.id === "today")!;
  assert.equal(full.value, "5K");
  assert.equal(full.detailRows.length, 5);
  const legacy = buildUsageBarModel(
    input({ todayUsage: { totalTokens: 5000, turnCount: 4, toolCallCount: 9 } }),
  ).segments.find((s) => s.id === "today")!;
  assert.equal(legacy.detailRows.length, 2);
});

test("subagents segment: only running tasks count; no speed means default tone", () => {
  const running = buildUsageBarModel(
    input({
      childCount: 2,
      childTokenTotal: 900,
      childLiveOutputRate: 40,
      subagentGroups: { running: 2, ended: 3, mainTokenTotal: 3200, runningTokenTotal: 900 },
    }),
  ).segments.find((s) => s.id === "subagents")!;
  assert.match(running.value, /^2 · 900 · 40\/s/u);
  assert.equal(running.tone, "live");
  assert.equal(running.dot, "live");
  const endedOnly = buildUsageBarModel(
    input({
      childCount: 3,
      childTokenTotal: 700,
      subagentGroups: { running: 0, ended: 3, mainTokenTotal: 3200, runningTokenTotal: null },
    }),
  ).segments.find((s) => s.id === "subagents")!;
  assert.equal(endedOnly.value, "700");
  assert.equal(endedOnly.tone, "default");
  assert.equal(endedOnly.dot, undefined);
});

test("total switch disables the whole bar without touching sub-switches", () => {
  const model = buildUsageBarModel(
    input({ settings: { ...DEFAULT_USAGE_BAR_SETTINGS, enabled: false } }),
  );
  assert.equal(model.visible, false);
  assert.deepEqual(
    resolveUsageBarSettings({ enabled: false, visibleItems: { generationSpeed: false } }),
    { ...DEFAULT_USAGE_BAR_SETTINGS, enabled: false, speed: false },
  );
});

test("resolveUsageBarSettings maps the target preference slice", () => {
  assert.deepEqual(resolveUsageBarSettings(null), DEFAULT_USAGE_BAR_SETTINGS);
  const resolved = resolveUsageBarSettings({
    enabled: true,
    visibleItems: {
      generationSpeed: false,
      turnUsage: false,
      contextCapacity: false,
      sessionCumulative: false,
      toolCalls: false,
      todayTotal: false,
      subagents: false,
    },
    rateLineEnabled: false,
  });
  assert.equal(resolved.speed, false);
  assert.equal(resolved.context, false);
  assert.equal(resolved.answerFooter, false);
  // 旧字段只影响 answerFooter，不影响七段。
  assert.equal(resolved.turnUsage, false);
});

test("merge and toggle tables stay aligned", () => {
  assert.deepEqual(mergeUsageBarSettings(DEFAULT_USAGE_BAR_SETTINGS, { today: false }), {
    ...DEFAULT_USAGE_BAR_SETTINGS,
    today: false,
  });
  assert.deepEqual(
    [...USAGE_BAR_TOGGLE_ORDER],
    ["speed", "turnUsage", "context", "session", "tools", "today", "subagents", "answerFooter"],
  );
  for (const key of USAGE_BAR_TOGGLE_ORDER) {
    assert.ok(USAGE_BAR_TOGGLE_LABEL_ID[key]);
    assert.ok(USAGE_BAR_TOGGLE_PREFERENCE_KEY[key]);
  }
  assert.deepEqual(
    [...USAGE_BAR_COLLAPSE_ORDER],
    ["context", "today", "turnUsage", "subagents", "tools"],
  );
  assert.equal(USAGE_BAR_COLLAPSE_TIER.context, "wideTier");
  assert.equal(USAGE_BAR_COLLAPSE_TIER.tools, "narrowTier");
});
