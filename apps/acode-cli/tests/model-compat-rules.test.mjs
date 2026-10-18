import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/model-compat-flags.md R3 —— 规则表解析：种子命中、
// 缺省稀疏、rank/priority 裁决、等秩冲突抛 AmbiguousCompatOverlapError、加载期校验。

const {
  MODEL_COMPAT_RULES,
  resolveModelCompat,
  resolveCompatFromRules,
  validateModelCompatRules,
  hasCompatFlags,
  ruleRank,
  AmbiguousCompatOverlapError,
} = await import("../packages/adapters/src/model/model-compat-rules.ts");
const { classifyModel } = await import(
  "../packages/adapters/src/model/model-compat-identity.ts"
);

function resolve(modelId, apiType = "openai-chat-completions", providerId = "p") {
  return resolveModelCompat({ providerId, modelId, apiType });
}

test("种子规则 S1: gpt class → toolCallIdProfile openai-40（responses wire）", () => {
  const flags = resolve("gpt-5.6-luna", "openai-responses", "openai");
  assert.equal(flags.toolCallIdProfile, "openai-40");
  assert.equal(flags.singleLeadingSystem, undefined);
});

test("种子规则 S1: gpt 在 chat wire 同时命中 wire 级 singleLeadingSystem", () => {
  const flags = resolve("gpt-5.6", "openai-chat-completions");
  assert.equal(flags.toolCallIdProfile, "openai-40");
  assert.equal(flags.singleLeadingSystem, true);
});

test("种子规则 S2: kimi-k3 → requiresToolResultName；kimi-k2.7-code 不命中（bounded）", () => {
  const k3 = resolve("kimi-k3", "openai-chat-completions");
  assert.equal(k3.requiresToolResultName, true);
  assert.equal(k3.singleLeadingSystem, true);
  const k2 = resolve("kimi-k2.7-code", "openai-chat-completions");
  assert.equal(k2.requiresToolResultName, undefined);
  const k3256 = resolve("kimi-k3-256k", "openai-chat-completions");
  assert.equal(k3256.requiresToolResultName, true); // bounded：- 边界命中
});

test("种子规则 S3: chat wire 一律 singleLeadingSystem；responses wire 无此标志", () => {
  assert.equal(resolve("glm-5.3", "openai-chat-completions").singleLeadingSystem, true);
  assert.equal(resolve("anything", "openai-chat-completions").singleLeadingSystem, true);
  assert.equal(resolve("glm-5.3", "openai-responses").singleLeadingSystem, undefined);
});

test("种子规则 S4: anthropic wire 一律 requiresStringSystemContent", () => {
  const flags = resolve("claude-fable-5.1", "anthropic-messages");
  assert.equal(flags.requiresStringSystemContent, true);
  const glmAnthropic = resolve("glm-4.7", "anthropic-messages");
  assert.equal(glmAnthropic.requiresStringSystemContent, true);
  // kimi-k3 的 anthropic 路由：标志解析但转换器对 anthropic body 自然 no-op（spec R3）。
  const kimiAnthropic = resolve("kimi-k3", "anthropic-messages");
  assert.equal(kimiAnthropic.requiresStringSystemContent, true);
  assert.equal(kimiAnthropic.requiresToolResultName, true);
});

test("缺省面：responses wire 的未知模型 → 空档案（零变换、字节不变）", () => {
  const flags = resolve("hy3-free", "openai-responses");
  assert.deepEqual(flags, {});
  assert.equal(hasCompatFlags(flags), false);
  assert.ok(Object.isFrozen(flags));
});

test("hasCompatFlags: 稀疏判定", () => {
  assert.equal(hasCompatFlags({}), false);
  assert.equal(hasCompatFlags(resolve("gpt-5.6", "openai-responses")), true);
});

test("rank: model matcher > class > wire-only", () => {
  assert.ok(ruleRank({ model: { kind: "exact", token: "x" } }) > ruleRank({ class: "gpt" }));
  assert.ok(ruleRank({ class: "gpt" }) > ruleRank({ apiTypes: ["openai-responses"] }));
  assert.ok(
    ruleRank({ model: { kind: "bounded", token: "x" } }) >
      ruleRank({ model: { kind: "prefix", token: "x" } }),
  );
});

function identityOf(modelId, apiType) {
  return classifyModel({ providerId: "p", modelId, apiType });
}

test("等秩冲突：同 rank 同 priority 赋不同值 → AmbiguousCompatOverlapError（fail-closed）", () => {
  const rules = [
    { class: "gpt", flags: { toolCallIdProfile: "openai-40" } },
    { class: "gpt", flags: { toolCallIdProfile: null } }, // null 视为缺省，不参与冲突
    { apiTypes: ["openai-chat-completions"], flags: { singleLeadingSystem: true } },
    { apiTypes: ["openai-chat-completions"], flags: { singleLeadingSystem: false } },
  ];
  assert.throws(
    () => resolveCompatFromRules(rules, identityOf("glm-5.3", "openai-chat-completions"), "glm-5.3"),
    (error) => {
      assert.ok(error instanceof AmbiguousCompatOverlapError);
      assert.match(error.message, /singleLeadingSystem/);
      return true;
    },
  );
  // null 赋值不触发冲突（与缺省同义）。
  const okFlags = resolveCompatFromRules(
    rules.slice(0, 2),
    identityOf("gpt-5.6", "openai-responses"),
    "gpt-5.6",
  );
  assert.equal(okFlags.toolCallIdProfile, "openai-40");
});

test("rank 裁决：更高 rank 覆盖更低 rank；priority 破同 rank 平局", () => {
  const rules = [
    { apiTypes: ["openai-chat-completions"], flags: { singleLeadingSystem: true } },
    // bounded(3) 覆盖 wire 级(-1)：kimi-k3 关闭合并（假想规则，验证裁决方向）。
    { model: { kind: "bounded", token: "kimi-k3" }, flags: { singleLeadingSystem: false } },
  ];
  const flags = resolveCompatFromRules(rules, identityOf("kimi-k3", "openai-chat-completions"), "kimi-k3");
  assert.equal(flags.singleLeadingSystem, false);

  const tieRules = [
    { class: "gpt", priority: 10, flags: { toolCallIdProfile: "openai-40" } },
    { class: "gpt", flags: { toolCallIdProfile: null, singleLeadingSystem: true } },
  ];
  // 同 rank（class=2）：priority 10 的赋值保留；priority 0 规则的 null 不覆盖。
  const tieFlags = resolveCompatFromRules(tieRules, identityOf("gpt-5.6", "openai-responses"), "gpt-5.6");
  assert.equal(tieFlags.toolCallIdProfile, "openai-40");
});

test("同值幂等：等秩同值不抛", () => {
  const rules = [
    { class: "gpt", flags: { toolCallIdProfile: "openai-40" } },
    { class: "gpt", flags: { toolCallIdProfile: "openai-40" } },
  ];
  const flags = resolveCompatFromRules(rules, identityOf("gpt-5.6", "openai-responses"), "gpt-5.6");
  assert.equal(flags.toolCallIdProfile, "openai-40");
});

test("加载期校验：未知标志 / 无匹配域 / 同签名冲突都被拒绝", () => {
  assert.throws(() => validateModelCompatRules([{ flags: { thinkingFormat: "zai" } }]));
  assert.throws(() => validateModelCompatRules([{ flags: { singleLeadingSystem: true } }]), /匹配域/);
  assert.throws(
    () =>
      validateModelCompatRules([
        { class: "gpt", flags: { toolCallIdProfile: "openai-40" } },
        { class: "gpt", flags: { toolCallIdProfile: null, singleLeadingSystem: true } },
        { class: "gpt", flags: { singleLeadingSystem: false } },
      ]),
    AmbiguousCompatOverlapError,
  );
  // 合法表不抛。
  validateModelCompatRules(MODEL_COMPAT_RULES);
});

test("providerIds 收窄：仅命中声明的 provider", () => {
  const rules = [
    { providerIds: ["zai-coding"], class: "glm", flags: { requiresToolResultName: true } },
  ];
  const hit = resolveCompatFromRules(rules, { ...identityOf("glm-5.3", "anthropic-messages"), providerId: "zai-coding" }, "glm-5.3");
  assert.equal(hit.requiresToolResultName, true);
  const miss = resolveCompatFromRules(rules, identityOf("glm-5.3", "anthropic-messages"), "glm-5.3");
  assert.deepEqual(miss, {});
});
