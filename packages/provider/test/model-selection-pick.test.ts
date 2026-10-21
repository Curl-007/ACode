import assert from "node:assert/strict";
import test from "node:test";
import { completeNewModelSelection } from "../src/model-selection-config.js";

function registry(values: readonly string[]) {
  return {
    providers: [
      {
        providerId: "custom",
        models: [{ modelId: "demo", config: { optionSpecs: { reasoningLevel: { values } } } }],
      },
    ],
  };
}

const selection = { providerId: "custom", modelId: "demo" };

test("未配置默认取法时使用列表第一项", () => {
  assert.deepEqual(completeNewModelSelection(registry(["low", "medium", "max"]), selection), {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "low" },
  });
});

test("highest 取列表最后一项", () => {
  assert.deepEqual(
    completeNewModelSelection(registry(["low", "medium", "max"]), selection, {
      reasoningLevel: "highest",
    }),
    { providerId: "custom", modelId: "demo", options: { reasoningLevel: "max" } },
  );
});

test("具体档位精确命中", () => {
  assert.deepEqual(
    completeNewModelSelection(registry(["low", "medium", "max"]), selection, {
      reasoningLevel: "medium",
    }),
    { providerId: "custom", modelId: "demo", options: { reasoningLevel: "medium" } },
  );
});

test("具体档位缺失时降到最近的更低档", () => {
  assert.deepEqual(
    completeNewModelSelection(registry(["low", "medium", "max"]), selection, {
      reasoningLevel: "high",
    }),
    { providerId: "custom", modelId: "demo", options: { reasoningLevel: "medium" } },
  );
});

test("没有更低档时取最近的更高档", () => {
  assert.deepEqual(
    completeNewModelSelection(registry(["medium", "max"]), selection, {
      reasoningLevel: "low",
    }),
    { providerId: "custom", modelId: "demo", options: { reasoningLevel: "medium" } },
  );
});

test("厂商别名按统一阶梯匹配", () => {
  assert.deepEqual(
    completeNewModelSelection(registry(["none", "enabled", "extra-high"]), selection, {
      reasoningLevel: "off",
    }),
    { providerId: "custom", modelId: "demo", options: { reasoningLevel: "none" } },
  );
  assert.deepEqual(
    completeNewModelSelection(registry(["none", "enabled", "extra-high"]), selection, {
      reasoningLevel: "medium",
    }),
    { providerId: "custom", modelId: "demo", options: { reasoningLevel: "enabled" } },
  );
  assert.deepEqual(
    completeNewModelSelection(registry(["none", "enabled", "extra-high"]), selection, {
      reasoningLevel: "xhigh",
    }),
    { providerId: "custom", modelId: "demo", options: { reasoningLevel: "extra-high" } },
  );
});

test("档位表无法识别时回落第一项", () => {
  assert.deepEqual(
    completeNewModelSelection(registry(["custom-a", "custom-b"]), selection, {
      reasoningLevel: "high",
    }),
    { providerId: "custom", modelId: "demo", options: { reasoningLevel: "custom-a" } },
  );
});

test("模型不存在或没有档位时返回 undefined", () => {
  assert.equal(completeNewModelSelection(registry([]), selection), undefined);
  assert.equal(
    completeNewModelSelection(registry(["low"]), { providerId: "gone", modelId: "missing" }),
    undefined,
  );
});
