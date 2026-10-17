// 回合收尾协议 TUI 最小呈现（apps/acode-cli/specs/turn-wrap-up.md R9 / 场景 7）：
// 工具行 detail 只取 nextStep 一行，按终端宽度截断；recap/建议卡属于富渲染，刻意不呈现。
import assert from "node:assert/strict";
import test from "node:test";

const { buildToolTranscriptProjection } =
  await import("../packages/tui/src/app-tool-transcript.ts");

const PAYLOAD = {
  recap: "Landed the retry budget and refreshed the affected tests.",
  nextStep: "Review the diff, then run the package test suite.",
  followUpSuggestion: {
    title: "Backfill retry telemetry",
    tldr: "Add counters for retry outcomes.",
    prompt: "Add telemetry counters for retry outcomes and wire them into the dashboard export.",
  },
};

test("TurnWrapUp projects a single next-step detail line", () => {
  const projection = buildToolTranscriptProjection("TurnWrapUp", PAYLOAD);
  assert.deepEqual(projection.detailLines, [
    "next: Review the diff, then run the package test suite.",
  ]);
});

test("tool name matching is case-insensitive like the other TUI tool branches", () => {
  const projection = buildToolTranscriptProjection("turnwrapup", PAYLOAD);
  assert.equal(projection.detailLines.length, 1);
  assert.ok(projection.detailLines[0].startsWith("next: "));
});

test("long next step is truncated to the detail width and recap never leaks in", () => {
  const projection = buildToolTranscriptProjection("TurnWrapUp", {
    recap: "R".repeat(400),
    nextStep: "N".repeat(400),
  });
  assert.equal(projection.detailLines.length, 1);
  assert.ok(projection.detailLines[0].length <= 100, "detail line must respect MAX_DETAIL_WIDTH");
  assert.ok(!projection.detailLines[0].includes("R"));
});

test("missing or malformed nextStep degrades to no detail lines", () => {
  assert.deepEqual(buildToolTranscriptProjection("TurnWrapUp", {}).detailLines, []);
  assert.deepEqual(buildToolTranscriptProjection("TurnWrapUp", { nextStep: 42 }).detailLines, []);
});
