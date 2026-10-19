// 舰队目录行事实解析（specs/subagent-fleet-panel.md 验收 1/2/4）：
// tokens 缺席不假零、0 合法、elapsed 门控（now 只属于运行中行）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSubagentRowFacts } from "../src/app-shell/subagentDirectoryFacts.js";
import type { RunningSubagentSummary } from "@acode/shared/acode-protocol-v4";
import type { ACodeSessionEndedSubagent } from "@acode/shared";

const RUNNING = {
  childSessionId: "child-1",
  subagentType: "Explore",
  title: "探索代码库",
  status: "running",
  startedAt: 1_000,
  cumulativeTokens: 12_345,
} as RunningSubagentSummary;

const ENDED = {
  childSessionId: "child-2",
  subagentType: "general-purpose",
  title: "实现功能",
  status: "success",
  startedAt: 500,
  endedAt: 900,
} as ACodeSessionEndedSubagent;

test("运行中行：tokens + elapsed（now − startedAt，负值钳 0）", () => {
  const facts = resolveSubagentRowFacts(RUNNING, 6_000);
  assert.equal(facts.cumulativeTokens, 12_345);
  assert.equal(facts.elapsedMs, 5_000);
  const clamped = resolveSubagentRowFacts(RUNNING, 500);
  assert.equal(clamped.elapsedMs, 0);
});

test("ended 行（now=undefined）：无 elapsed；tokens 缺席 → undefined（不假零）", () => {
  const facts = resolveSubagentRowFacts(ENDED, undefined);
  assert.equal(facts.elapsedMs, undefined);
  assert.equal(facts.cumulativeTokens, undefined);
});

test("cumulativeTokens=0 是合法事实（有字段 ≠ 缺席），显示 0", () => {
  const facts = resolveSubagentRowFacts({ ...RUNNING, cumulativeTokens: 0 }, 2_000);
  assert.equal(facts.cumulativeTokens, 0);
});

test("startedAt 缺席：即使 now 传入也无 elapsed（不造假值）", () => {
  const facts = resolveSubagentRowFacts(
    { ...RUNNING, startedAt: undefined } as RunningSubagentSummary,
    9_000,
  );
  assert.equal(facts.elapsedMs, undefined);
});
