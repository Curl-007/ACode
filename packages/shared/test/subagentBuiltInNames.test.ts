import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_SUBAGENT_NAMES,
  isBuiltInSubagentName,
  type BuiltInSubagentName,
} from "../src/subagents-types.js";

/**
 * 内置子智能体名单契约（apps/acode-cli/specs/builtin-subagent-catalog.md R2/R5）：
 * BUILT_IN_SUBAGENT_NAMES 是保留名单、模型覆盖键集与 GUI 内置判定的单一事实源，
 * isBuiltInSubagentName 是成员判定的共用谓词（bootstrap 烘焙通道 / UI settings 控件）。
 */

test("BUILT_IN_SUBAGENT_NAMES 冻结为核心二名 + bundled 预置三名（R2 目录，R9.1 名字即兼容面）", () => {
  // 名字字面量是派发命中与 agents-state id 的依赖面，改动即契约变更：冻结防漂移。
  assert.deepEqual(
    [...BUILT_IN_SUBAGENT_NAMES],
    ["general-purpose", "Explore", "Plan", "Verify", "Review"],
  );
});

test("isBuiltInSubagentName：联合成员全命中，非成员（含大小写/空白变体）拒绝", () => {
  for (const name of BUILT_IN_SUBAGENT_NAMES) {
    assert.equal(isBuiltInSubagentName(name), true, name);
  }
  for (const name of [
    "",
    "plan",
    "review",
    "Helper",
    "plugin:test:verify",
    "general-purpose ",
    "built-in:built-in:plan",
  ]) {
    assert.equal(isBuiltInSubagentName(name), false, name);
  }
});

test("isBuiltInSubagentName 的 true 分支把 string 收窄为 BuiltInSubagentName（编译即证明）", () => {
  const candidate: string = "Review";
  if (isBuiltInSubagentName(candidate)) {
    const narrowed: BuiltInSubagentName = candidate;
    assert.equal(narrowed, "Review");
  } else {
    assert.fail("Review 应命中内置名单");
  }
});
