import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRow } from "@acode/shared/acode-protocol-v4";
import { TURN_WRAP_UP_LIMITS, TURN_WRAP_UP_TOOL_NAME } from "@acode/shared/acode-protocol-v4";

import { resolveTurnWrapUpCard } from "../src/v4/turnWrapUpCards.js";
import { TURN_WRAP_UP_LABEL_KEYS, formatTurnWrapUpLabel } from "../src/v4/turnWrapUpLabels.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 轮尾收尾卡 resolver 的纯逻辑守护（packages/ui/specs/turn-wrap-up-card.md 验收）。
 * 包内无 DOM 测试先例（全部纯逻辑 node:test），组件渲染面由这里的 view-model 断言守护。
 */

const PAYLOAD = {
  recap: "Landed the retry budget and refreshed the affected tests.",
  nextStep: "Review the diff, then run the package test suite.",
};
const FOLLOW_UP = {
  title: "Backfill retry telemetry",
  tldr: "Add counters for retry outcomes so regressions show up in dashboards.",
  prompt:
    "Add telemetry counters for retry outcomes (exhausted, recovered, cancelled) and wire them into the dashboard export. Start from the retry budget module; no other context is required.",
};

function toolCallRow(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000,
    createdAtSeq: 1,
    kind: "toolCall",
    toolCallId: "tc-wrap-1",
    toolName: TURN_WRAP_UP_TOOL_NAME,
    status: "success",
    inputText: JSON.stringify(PAYLOAD),
    input: PAYLOAD,
    ...overrides,
  };
}

test("resolves the wrap-up card from a successful TurnWrapUp row", () => {
  const card = resolveTurnWrapUpCard([toolCallRow()]);
  assert.ok(card);
  assert.equal(card.rowId, 1);
  assert.equal(card.toolCallId, "tc-wrap-1");
  assert.deepEqual(card.payload, PAYLOAD);
});

test("last successful call wins when the model called the tool twice", () => {
  const second = { ...PAYLOAD, nextStep: "Second, corrected next step." };
  const card = resolveTurnWrapUpCard([
    toolCallRow(),
    toolCallRow({
      rowId: 9,
      toolCallId: "tc-wrap-2",
      input: second,
      inputText: JSON.stringify(second),
    }),
  ]);
  assert.ok(card);
  assert.equal(card.rowId, 9);
  assert.equal(card.payload.nextStep, "Second, corrected next step.");
});

test("non-success rows, other tools and malformed payloads never produce a card", () => {
  assert.equal(resolveTurnWrapUpCard([toolCallRow({ status: "error" })]), undefined);
  assert.equal(resolveTurnWrapUpCard([toolCallRow({ status: "running" })]), undefined);
  assert.equal(resolveTurnWrapUpCard([toolCallRow({ toolName: "Bash" })]), undefined);
  assert.equal(
    resolveTurnWrapUpCard([toolCallRow({ input: { ...PAYLOAD, extra: 1 } })]),
    undefined,
  );
  assert.equal(resolveTurnWrapUpCard([toolCallRow({ input: undefined })]), undefined);
  assert.equal(resolveTurnWrapUpCard([]), undefined);
  // 失败的调用之后有一次成功调用：成功那次生效（失败行被跳过而不是短路）。
  const card = resolveTurnWrapUpCard([
    toolCallRow({ rowId: 1, status: "error", input: undefined }),
    toolCallRow({ rowId: 2 }),
  ]);
  assert.ok(card);
  assert.equal(card.rowId, 2);
});

test("follow-up suggestion passes through for the suggested-task card", () => {
  const card = resolveTurnWrapUpCard([
    toolCallRow({ input: { ...PAYLOAD, followUpSuggestion: FOLLOW_UP } }),
  ]);
  assert.ok(card);
  assert.deepEqual(card.payload.followUpSuggestion, FOLLOW_UP);
});

test("payload strings are rendered trimmed (schema trim transform)", () => {
  const card = resolveTurnWrapUpCard([
    toolCallRow({ input: { recap: `  ${PAYLOAD.recap}  `, nextStep: ` ${PAYLOAD.nextStep} ` } }),
  ]);
  assert.ok(card);
  assert.equal(card.payload.recap, PAYLOAD.recap);
  assert.equal(card.payload.nextStep, PAYLOAD.nextStep);
});

test("over-limit payloads are rejected by the wire schema (no silent truncation)", () => {
  const card = resolveTurnWrapUpCard([
    toolCallRow({
      input: { ...PAYLOAD, recap: "x".repeat(TURN_WRAP_UP_LIMITS.recapMaxChars + 1) },
    }),
  ]);
  assert.equal(card, undefined);
});

// 过渡契约已到期（2026-10-16 locale 键接线）：FALLBACK 词典按两份 spec 写死的移除
// 条件删除，守护反转为「词典键必须在位」——缺键即 formatMessage 回落为 id，卡片文案
// 直接显示键名，属可见回归。
test("locale 词典双侧收齐收尾卡 7 键（en-US 与 zh-CN 同步）", () => {
  for (const [locale, dict] of [
    ["en-US", enUS],
    ["zh-CN", zhCN],
  ] as const) {
    for (const key of Object.values(TURN_WRAP_UP_LABEL_KEYS)) {
      const value = dict[key];
      assert.ok(typeof value === "string" && value.length > 0, `${locale} 缺收尾卡键: ${key}`);
    }
  }
});

test("label helper 直通 formatMessage：命中取词典值，缺键回落 id（接线回归信号）", () => {
  const wiredIntl = { formatMessage: () => "下一步" };
  assert.equal(formatTurnWrapUpLabel(wiredIntl, TURN_WRAP_UP_LABEL_KEYS.nextStep), "下一步");
  const missingKeyIntl = { formatMessage: ({ id }: { id: string }) => id };
  assert.equal(
    formatTurnWrapUpLabel(missingKeyIntl, TURN_WRAP_UP_LABEL_KEYS.nextStep),
    "chat.turnWrapUp.nextStep",
  );
});
