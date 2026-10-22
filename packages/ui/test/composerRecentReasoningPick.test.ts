import assert from "node:assert/strict";
import test from "node:test";
import { resolveDraftInitialModelSelection } from "../src/lib/composerRecent.js";

function view(
  values: readonly string[],
  preferredSelection?: { providerId: string; modelId: string },
) {
  return {
    revision: 1,
    preferredSelection,
    providers: [
      {
        providerId: "custom",
        providerName: "Custom",
        models: [
          {
            modelId: "demo",
            config: { optionSpecs: { reasoningLevel: { values } } },
          },
          {
            modelId: "second",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "max"] } } },
          },
        ],
      },
    ],
  } as unknown as Parameters<typeof resolveDraftInitialModelSelection>[0];
}

const recent = { providerId: "custom", modelId: "demo", options: { reasoningLevel: "high" } };

test("目录未就绪时原样保留 recent", () => {
  assert.deepEqual(resolveDraftInitialModelSelection(null, recent, "highest"), {
    selection: recent,
    invalidated: false,
  });
});

test("recent 只决定模型身份，档位按默认取法重新解析", () => {
  assert.deepEqual(
    resolveDraftInitialModelSelection(view(["low", "medium", "max"]), recent, "highest"),
    {
      selection: {
        providerId: "custom",
        modelId: "demo",
        options: { reasoningLevel: "max" },
      },
      invalidated: false,
    },
  );
  assert.deepEqual(resolveDraftInitialModelSelection(view(["low", "medium", "max"]), recent), {
    selection: {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "low" },
    },
    invalidated: false,
  });
});

test("具体档位缺失时降到最近的更低档", () => {
  assert.deepEqual(
    resolveDraftInitialModelSelection(view(["low", "medium", "max"]), recent, "high"),
    {
      selection: {
        providerId: "custom",
        modelId: "demo",
        options: { reasoningLevel: "medium" },
      },
      invalidated: false,
    },
  );
});

test("recent 飘移档位不再保留，统一按默认取法补齐", () => {
  assert.deepEqual(
    resolveDraftInitialModelSelection(view(["low", "medium", "max"]), recent, "first"),
    {
      selection: {
        providerId: "custom",
        modelId: "demo",
        options: { reasoningLevel: "low" },
      },
      invalidated: false,
    },
  );
});

test("recent 模型已移除时回落到 preferredSelection", () => {
  assert.deepEqual(
    resolveDraftInitialModelSelection(
      view(["low", "max"], { providerId: "custom", modelId: "second" }),
      { providerId: "custom", modelId: "missing" },
      "medium",
    ),
    {
      selection: {
        providerId: "custom",
        modelId: "second",
        options: { reasoningLevel: "low" },
      },
      invalidated: true,
    },
  );
});

test("recent 模型与首选都不可用时回落到目录首个模型", () => {
  assert.deepEqual(
    resolveDraftInitialModelSelection(
      view(["low", "max"], { providerId: "gone", modelId: "missing" }),
      { providerId: "custom", modelId: "missing" },
      "highest",
    ),
    {
      selection: {
        providerId: "custom",
        modelId: "demo",
        options: { reasoningLevel: "max" },
      },
      invalidated: true,
    },
  );
});

test("无 recent 时优先使用 preferredSelection", () => {
  assert.deepEqual(
    resolveDraftInitialModelSelection(
      view(["low", "max"], { providerId: "custom", modelId: "second" }),
      null,
    ),
    {
      selection: {
        providerId: "custom",
        modelId: "second",
        options: { reasoningLevel: "low" },
      },
      invalidated: false,
    },
  );
});
