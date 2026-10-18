import assert from "node:assert/strict";
import test from "node:test";
import {
  modelCompatFlagsDataSchema,
  type ModelCompatFlagsData,
} from "../src/model-config.js";

// spec: apps/acode-cli/specs/model-compat-flags.md R1。
// compat 标志族：稀疏（全部可选、缺省 = 通用行为）、strict 拒绝未知标志（词汇表即
// schema）、nullable 与既有 sparse 家族一致（为配置 overlay 的 null 清除语义预留）。

test("compat flags: 空对象合法（缺省 = 通用行为 = 零变换）", () => {
  const parsed = modelCompatFlagsDataSchema.parse({});
  assert.deepEqual(parsed, {});
});

test("compat flags: 稀疏解析——每个种子标志独立可选", () => {
  assert.deepEqual(modelCompatFlagsDataSchema.parse({ toolCallIdProfile: "openai-40" }), {
    toolCallIdProfile: "openai-40",
  });
  assert.deepEqual(modelCompatFlagsDataSchema.parse({ requiresToolResultName: true }), {
    requiresToolResultName: true,
  });
  assert.deepEqual(modelCompatFlagsDataSchema.parse({ singleLeadingSystem: true }), {
    singleLeadingSystem: true,
  });
  assert.deepEqual(modelCompatFlagsDataSchema.parse({ requiresStringSystemContent: true }), {
    requiresStringSystemContent: true,
  });
});

test("compat flags: null 与缺省同义（overlay 清除语义预留）", () => {
  const parsed = modelCompatFlagsDataSchema.parse({
    toolCallIdProfile: null,
    requiresToolResultName: null,
  });
  assert.equal(parsed.toolCallIdProfile, null);
  assert.equal(parsed.requiresToolResultName, null);
});

test("compat flags: strict 拒绝未知标志（规则表 typo 加载即炸）", () => {
  // omp 有 ~200 个标志；ACode 词汇表按需增长，未编目标志不允许混进规则表。
  assert.throws(() => modelCompatFlagsDataSchema.parse({ thinkingFormat: "zai" }));
  assert.throws(() => modelCompatFlagsDataSchema.parse({ requiresMistralToolIds: true }));
});

test("compat flags: enum 档位拒绝未预置值（Mistral 未接入，不发明档位）", () => {
  assert.throws(() => modelCompatFlagsDataSchema.parse({ toolCallIdProfile: "mistral-9-alnum" }));
  assert.throws(() => modelCompatFlagsDataSchema.parse({ toolCallIdProfile: "" }));
  assert.throws(() => modelCompatFlagsDataSchema.parse({ requiresToolResultName: "yes" }));
});

test("compat flags: 类型面——解析结果满足 ModelCompatFlagsData（编译期锚点）", () => {
  const flags: ModelCompatFlagsData = modelCompatFlagsDataSchema.parse({
    toolCallIdProfile: "openai-40",
    singleLeadingSystem: true,
  });
  assert.equal(flags.toolCallIdProfile, "openai-40");
  assert.equal(flags.singleLeadingSystem, true);
});
