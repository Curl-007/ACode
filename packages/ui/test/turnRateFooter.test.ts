import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import { buildTurnRateFooterText } from "../src/v4/composer/usage-bar/TurnRateFooter.js";

function fmt(descriptor: { id: string }, values?: Record<string, string | number>) {
  let text = enUS[descriptor.id] ?? descriptor.id;
  if (values) {
    for (const [key, value] of Object.entries(values))
      text = text.replaceAll(`{${key}}`, String(value));
  }
  return text;
}

const stats = (overrides: Record<string, unknown> = {}) => ({
  inputTokens: 2000,
  outputTokens: 1200,
  reasoningTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  modelRequestCount: 6,
  timeToFirstTokenMs: 800,
  generationMs: 15000,
  tokensPerSecond: 88.5,
  peakTokensPerSecond: 168,
  ...overrides,
});

function build(row: {
  stats?: ReturnType<typeof stats> | null;
  activeMs?: number;
  state?: "running" | "completedSuccess" | "completedInterrupted" | "failed";
}) {
  return buildTurnRateFooterText({
    row: {
      stats: row.stats === undefined ? stats() : row.stats,
      activeMs: "activeMs" in row ? row.activeMs : 65_000,
      state: row.state ?? "completedSuccess",
    },
    formatMessage: fmt,
    locale: "en-US",
  } as Parameters<typeof buildTurnRateFooterText>[0]);
}

test("full row orders speed → first token → output → segments/peak → duration", () => {
  assert.equal(
    build({}),
    "88.5 tok/s · First token 800ms · Output 1.2K · 6 segments · peak 168 · 1m 5s",
  );
});

test("missing peak hides the segments/peak row but keeps the rest", () => {
  const text = build({ stats: stats({ peakTokensPerSecond: undefined }) });
  assert.doesNotMatch(text ?? "", /segments/u);
  assert.match(text ?? "", /88.5 tok\/s/u);
});

test("only peak without request count also hides the row", () => {
  const text = build({ stats: stats({ modelRequestCount: 0 }) });
  assert.doesNotMatch(text ?? "", /segments/u);
});

test("missing items are omitted, never rendered as 0 or placeholder", () => {
  const text = build({
    stats: stats({ tokensPerSecond: undefined, timeToFirstTokenMs: undefined, outputTokens: 0 }),
    activeMs: undefined,
  });
  assert.equal(text, "6 segments · peak 168");
});

test("no stats hides the whole footer", () => {
  assert.equal(build({ stats: null }), null);
});

test("duration buckets: seconds below 60s, exact minutes without 0s", () => {
  assert.match(build({ activeMs: 42_000 }) ?? "", /42s$/u);
  assert.match(build({ activeMs: 120_000 }) ?? "", /2m$/u);
  assert.match(build({ activeMs: 125_000 }) ?? "", /2m 5s$/u);
});
