import assert from "node:assert/strict";
import test from "node:test";
import { importSubagentStateSelections } from "../src/subagent-state-migration.js";

/**
 * 迁移键集回归（apps/acode-cli/specs/builtin-subagent-catalog.md 验收场景 6；
 * Review 子代理 E2E 首跑 finding F1 的修复用例）。
 *
 * importSubagentStateSelections 是 host 启动迁移入口，用循环结果**整体替换**
 * builtInModelSelectionOverrides：键集遍历若被收窄回字面二名（或在别处引入第二份
 * 键集），GUI 已持久化的 Plan/Verify/Review 覆盖会在每次启动时静默丢弃——
 * 无异常、无提示，只能靠本测试钉住。
 */

test("current 分支：Plan/Verify/Review 覆盖保留，未知键丢弃", () => {
  const result = importSubagentStateSelections({
    builtInModelSelectionOverrides: {
      Explore: { providerId: "provider-a", modelId: "model-explore" },
      Plan: { providerId: "provider-a", modelId: "model-plan" },
      Verify: { providerId: "provider-b", modelId: "model-verify" },
      Review: { providerId: "provider-b", modelId: "model-review" },
      // 未知键（未来名单收窄/旧版本残留）必须被丢弃，不得穿透整体替换。
      Ghost: { providerId: "provider-x", modelId: "model-ghost" },
    },
    disabledAgentIds: [],
  });
  const overrides = result.builtInModelSelectionOverrides;
  assert.deepEqual(Object.keys(overrides).sort(), ["Explore", "Plan", "Review", "Verify"]);
  assert.deepEqual(overrides.Plan, { providerId: "provider-a", modelId: "model-plan" });
  assert.deepEqual(overrides.Verify, { providerId: "provider-b", modelId: "model-verify" });
  assert.deepEqual(overrides.Review, { providerId: "provider-b", modelId: "model-review" });
  // current 分支不做 legacy Provider 迁移，选择原样保留（含其余输入字段透传）。
  assert.deepEqual(result.disabledAgentIds, []);
});

test("旧双 map 分支：bundled 三名不产生键，旧二名照旧迁移", () => {
  const result = importSubagentStateSelections({
    builtInModelOverrides: {
      Explore: "provider-a/model-explore",
      "general-purpose": "provider-a/model-gp",
    },
    builtInThoughtLevelOverrides: { Explore: "high" },
  });
  const overrides = result.builtInModelSelectionOverrides;
  // 旧格式文件不可能含 bundled 成员键，迁移也不得凭空产生。
  assert.equal(overrides.Plan, undefined);
  assert.equal(overrides.Verify, undefined);
  assert.equal(overrides.Review, undefined);
  // 旧二名迁移行为不变：model 字符串 + thoughtLevel → 结构化选择。
  assert.equal(overrides.Explore?.modelId, "model-explore");
  assert.equal(overrides.Explore?.options?.reasoningLevel, "high");
  assert.equal(overrides["general-purpose"]?.modelId, "model-gp");
});
