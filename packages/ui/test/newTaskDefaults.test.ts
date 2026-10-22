import assert from "node:assert/strict";
import test from "node:test";
import { applyNewTaskDefaults, resolveNewTaskDefaults } from "../src/lib/newTaskDefaults.js";

// 最小 ModelSelectionView 形状：只声明 data 面用到的 provider/model/optionSpecs。
// ModelSelection.options 支持 reasoningLevel 与 speed；固定值必须命中 Option Spec。
const view = {
  revision: 1,
  providers: [
    {
      providerId: "custom",
      providerName: "Custom",
      templateId: "custom",
      config: {},
      models: [
        {
          modelId: "demo",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["low", "high"], map: "{}" },
              maxOutputTokens: { max: 4096, map: "{}" },
              speed: { values: ["standard", "fast"], map: "{}" },
            },
          },
        },
        {
          // 档位列表为空：任何固定档位都无法命中。
          modelId: "no-levels",
          config: {
            optionSpecs: {
              reasoningLevel: { values: [], map: "{}" },
              maxOutputTokens: { max: 4096, map: "{}" },
            },
          },
        },
      ],
    },
  ],
} as unknown as Parameters<typeof applyNewTaskDefaults>[0];

const selection = {
  providerId: "custom",
  modelId: "demo",
  options: { reasoningLevel: "high", speed: "standard" },
};

test("开关关闭或无可运行固定项时不固定任何项", () => {
  assert.equal(resolveNewTaskDefaults(undefined), null);
  assert.equal(resolveNewTaskDefaults({ enabled: false } as never), null);
  // 开着但没有任何固定项：等同关闭，不构造第二条分叉。
  assert.equal(resolveNewTaskDefaults({ enabled: true } as never), null);
  // speed 是有效固定项。
  assert.deepEqual(resolveNewTaskDefaults({ enabled: true, speed: "fast" } as never), {
    mode: null,
    model: null,
    reasoningLevel: null,
    speed: "fast",
  });
  assert.equal(resolveNewTaskDefaults({ enabled: true, speed: null } as never), null);
});

test("固定项归一化：plan 不作为可固定的权限模式，dontAsk 可固定", () => {
  assert.deepEqual(
    resolveNewTaskDefaults({
      enabled: true,
      mode: "plan",
      model: { providerId: "custom", modelId: "demo" },
      reasoningLevel: null,
    } as never),
    {
      mode: null,
      model: { providerId: "custom", modelId: "demo" },
      reasoningLevel: null,
      speed: null,
    },
  );
  assert.deepEqual(
    resolveNewTaskDefaults({
      enabled: true,
      mode: "dontAsk",
      model: null,
      reasoningLevel: null,
      speed: null,
    } as never),
    { mode: "dontAsk", model: null, reasoningLevel: null, speed: null },
  );
});

test("固定推理档位命中目标模型时写入选择", () => {
  const defaults = resolveNewTaskDefaults({
    enabled: true,
    mode: "yolo",
    model: null,
    reasoningLevel: "low",
  } as never);
  assert.deepEqual(applyNewTaskDefaults(view, selection, defaults), {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "low", speed: "standard" },
  });
});

test("固定速度命中目标模型时写入选择，且与推理档位可同时生效", () => {
  const defaults = resolveNewTaskDefaults({
    enabled: true,
    mode: null,
    model: null,
    reasoningLevel: "low",
    speed: "fast",
  } as never);
  assert.deepEqual(defaults, { mode: null, model: null, reasoningLevel: "low", speed: "fast" });
  assert.deepEqual(applyNewTaskDefaults(view, selection, defaults), {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "low", speed: "fast" },
  });
});

test("固定速度不被目标模型支持时保留既有解析结果", () => {
  const defaults = resolveNewTaskDefaults({
    enabled: true,
    mode: null,
    model: null,
    reasoningLevel: null,
    speed: "turbo",
  } as never);
  assert.deepEqual(applyNewTaskDefaults(view, selection, defaults), selection);
});

test("固定档位不被目标模型支持时保留既有解析结果", () => {
  const defaults = resolveNewTaskDefaults({
    enabled: true,
    mode: null,
    model: null,
    reasoningLevel: "ultra",
  } as never);
  assert.deepEqual(applyNewTaskDefaults(view, selection, defaults), selection);

  // 模型声明了空档位列表：同样拒绝，不阻断新建任务。
  const noLevels = {
    providerId: "custom",
    modelId: "no-levels",
    options: { reasoningLevel: "low" },
  };
  assert.equal(applyNewTaskDefaults(view, noLevels, defaults), noLevels);
});

test("选择为空、默认值为空或模型已移除时原样返回", () => {
  const defaults = resolveNewTaskDefaults({
    enabled: true,
    mode: "yolo",
    model: { providerId: "gone", modelId: "missing" },
    reasoningLevel: "low",
  } as never);
  assert.equal(applyNewTaskDefaults(view, null, defaults), null);
  assert.equal(applyNewTaskDefaults(view, selection, null), selection);
  // 选择指向已移除模型：Registry 无法校验，按既有选择原样返回。
  const stale = { providerId: "gone", modelId: "missing" };
  assert.equal(applyNewTaskDefaults(view, stale, defaults), stale);
});

test("固定值与模型当前档位相同时返回原选择对象", () => {
  const defaults = resolveNewTaskDefaults({
    enabled: true,
    mode: null,
    model: null,
    reasoningLevel: "high",
    speed: "standard",
  } as never);
  assert.equal(applyNewTaskDefaults(view, selection, defaults), selection);
});
