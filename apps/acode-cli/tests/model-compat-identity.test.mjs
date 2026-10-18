import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/model-compat-flags.md R2 —— classifyModel 最小面：
// rank exact(4) > bounded(3) > prefix(1) > glob(0)、bare 提取、大小写归一、平局抛错。

const { classifyModel, matcherHits, globMatch, AmbiguousModelError } = await import(
  "../packages/adapters/src/model/model-compat-identity.ts"
);

function classify(modelId, overrides = {}) {
  return classifyModel({
    providerId: "test-provider",
    modelId,
    apiType: "openai-chat-completions",
    ...overrides,
  });
}

test("classifyModel: ACode 已接模板的 class 解析（大小写归一）", () => {
  assert.equal(classify("GLM-5.3").modelClass, "glm");
  assert.equal(classify("glm-5.3-flash").modelClass, "glm");
  assert.equal(classify("glm-4-flashx-250414").modelClass, "glm");
  assert.equal(classify("kimi-k3").modelClass, "kimi");
  assert.equal(classify("kimi-k2.7-code").modelClass, "kimi");
  assert.equal(classify("gpt-5.6-luna").modelClass, "gpt");
  assert.equal(classify("gpt-6-astra").modelClass, "gpt");
  assert.equal(classify("claude-fable-5.1").modelClass, "claude");
  assert.equal(classify("claude-haiku-4-5-20251001").modelClass, "claude");
  assert.equal(classify("deepseek-v4-pro").modelClass, "deepseek");
  assert.equal(classify("MiniMax-M3").modelClass, "minimax");
  assert.equal(classify("qwen3.8-max").modelClass, "qwen");
  assert.equal(classify("mimo-v2.5-pro").modelClass, "mimo");
  assert.equal(classify("grok-4.6").modelClass, "grok");
});

test("classifyModel: bounded 语义——charglm 等衍生名不误入 glm class", () => {
  assert.equal(classify("charglm-4").modelClass, "unknown");
  // bounded：token 后必须是串尾或 - _ . : 0-9。
  assert.equal(classify("glm5").modelClass, "glm"); // 数字边界
  assert.equal(classify("glm").modelClass, "glm"); // 串尾
});

test("classifyModel: bare 提取——网关路由前缀剥离", () => {
  const identity = classify("openrouter/glm-5.3");
  assert.equal(identity.bare, "glm-5.3");
  assert.equal(identity.modelClass, "glm");
  const nested = classify("gateway/ns/deepseek-v4.1-flash");
  assert.equal(nested.bare, "deepseek-v4.1-flash");
  assert.equal(nested.modelClass, "deepseek");
});

test("classifyModel: 未知 id → unknown class，不抛", () => {
  assert.equal(classify("hy3-free").modelClass, "unknown");
  assert.equal(classify("big-pickle").modelClass, "unknown");
  assert.equal(classify("").modelClass, "unknown");
});

test("classifyModel: family/revision 最小解析（波 2 规则不消费，字段暴露）", () => {
  const glm = classify("glm-5.3-flash");
  assert.equal(glm.family, "glm");
  assert.equal(glm.revision, "5.3");
  const kimi = classify("kimi-k3");
  assert.equal(kimi.family, "kimi");
  assert.equal(kimi.revision, "3");
  const gpt = classify("gpt-5.6-luna");
  assert.equal(gpt.revision, "5.6");
  const none = classify("big-pickle");
  assert.equal(none.revision, undefined);
});

test("classifyModel: 结果是冻结的纯数据", () => {
  const identity = classify("gpt-5.6");
  assert.ok(Object.isFrozen(identity));
  assert.equal(identity.providerId, "test-provider");
  assert.equal(identity.modelId, "gpt-5.6");
  assert.equal(identity.apiType, "openai-chat-completions");
});

test("matcherHits: 四种 kind 语义", () => {
  assert.ok(matcherHits("exact", "kimi-k3", "kimi-k3"));
  assert.ok(!matcherHits("exact", "kimi-k3", "kimi-k3-256k"));
  assert.ok(matcherHits("bounded", "kimi-k3", "kimi-k3-256k")); // - 边界
  assert.ok(matcherHits("bounded", "kimi-k3", "kimi-k30")); // omp 语义：数字也是边界字符
  assert.ok(!matcherHits("bounded", "kimi-k3", "kimi-k3x")); // 字母边界不中
  assert.ok(matcherHits("prefix", "gpt-", "gpt-6-astra"));
  assert.ok(!matcherHits("prefix", "gpt-", "ogpt-1"));
  assert.ok(matcherHits("glob", "deepseek-v4*", "deepseek-v4-pro"));
  assert.ok(!matcherHits("glob", "deepseek-v4*", "deepseek-v3"));
});

test("globMatch: * 与 ? 基本语义", () => {
  assert.ok(globMatch("*", "anything"));
  assert.ok(globMatch("glm-*", "glm-5.3"));
  assert.ok(globMatch("gpt-?.6", "gpt-5.6"));
  assert.ok(!globMatch("gpt-?.6", "gpt-51.6"));
  assert.ok(globMatch("*k3*", "kimi-k3-256k"));
  assert.ok(!globMatch("glm", "glm-5"));
});

test("AmbiguousModelError: 类型可捕获（平局抛错语义的载体）", () => {
  const error = new AmbiguousModelError("x-1", "glm", "gpt");
  assert.equal(error.name, "AmbiguousModelError");
  assert.match(error.message, /歧义/);
});
