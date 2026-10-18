import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 上下文晋升执行体（runtime/methods/context-promotion.ts）的桩 runtime 单测。
 *
 * specs/failure-recovery-tracks.md 轨道 1 验收：溢出→晋升候选存在时先晋升重试；
 * 无候选直接落压缩（fail-safe）；晋升只试一次；用户可见告知（ModelSelected + warn 日志）。
 * 不做真实网络：modelFactory / catalog port / 事件面全部桩注入（任务纪律：假时钟/桩模型）。
 */

const { tryPromoteContextModelForRecovery } = await import(
  "../packages/core/src/runtime/methods/context-promotion.ts"
);

// ————————————————————————————————————————————————————————————————
// 桩件
// ————————————————————————————————————————————————————————————————

const WINDOWS = { small: 100_000, mid: 120_000, huge: 1_000_000 };

function fakeModel(selection, contextWindow) {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    displayName: selection.modelId,
    properties: { contextWindow },
    optionSpecs: {
      maxOutputTokens: { max: 32_000 },
      reasoningLevel: { values: ["low", "high"] },
    },
    options: selection.options ? { ...selection.options } : {},
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("stub model must not be called");
    },
    async streamText() {
      throw new Error("stub model must not be called");
    },
  };
}

function makeStubRuntime(options = {}) {
  const calls = {
    emitModelSelected: [],
    setSessionModelSelection: [],
    warn: [],
    info: [],
  };
  const runtime = {
    calls,
    config: {},
    // rebuildContextPrefix 的未初始化分支：contextBuilder 缺席 + contextInitialized=false
    // → 原样返回 turnRequestEntries（测试不触真实 context 构建）。
    contextBuilder: undefined,
    contextInitialized: false,
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
    sessionStore: undefined, // persistRuntimeModelSelection 直接短路
    modelCatalogPort:
      options.catalog === undefined ? undefined : { listModels: () => options.catalog },
    modelFactory: (input) => {
      if (options.factoryErrorFor === input.selection.modelId) {
        throw new Error("provider client unavailable");
      }
      // factoryWindowOverride 模拟「目录与工厂物化结果不一致」的防御分支。
      const window =
        options.factoryWindowOverride?.[input.selection.modelId] ??
        WINDOWS[input.selection.modelId] ??
        0;
      return fakeModel(input.selection, window);
    },
    modelRequestAdmission: undefined,
    getSessionModelSelection: () => options.previousSelection,
    setSessionModelSelection(selection) {
      calls.setSessionModelSelection.push(selection);
    },
    async emitModelSelected(payload) {
      calls.emitModelSelected.push(payload);
    },
    logger: {
      warn(message, fields) {
        calls.warn.push({ message, fields });
      },
      info(message, fields) {
        calls.info.push({ message, fields });
      },
    },
  };
  return runtime;
}

function makeState(overrides = {}) {
  return {
    model: fakeModel({ providerId: "p1", modelId: "small" }, WINDOWS.small),
    turnRequestState: { entries: [{ marker: "request" }], outputTokenContinuationCount: 0 },
    turnTraceContext: { traceId: "trace-test" },
    ...overrides,
  };
}

const CATALOG_WITH_BIGGER_SIBLING = [
  { providerId: "p1", modelId: "small", contextWindow: WINDOWS.small, current: true, reasoningLevels: [] },
  { providerId: "p1", modelId: "mid", contextWindow: WINDOWS.mid, current: false, reasoningLevels: ["low", "high"] },
  { providerId: "p1", modelId: "huge", contextWindow: WINDOWS.huge, current: false, reasoningLevels: [] },
  { providerId: "p2", modelId: "alien", contextWindow: 9_000_000, current: false, reasoningLevels: [] },
];

// ————————————————————————————————————————————————————————————————
// 晋升成功路径
// ————————————————————————————————————————————————————————————————

test("(1) 候选存在 → 晋升：换绑 state.model、每轮一次占位、返回晋升模型", async () => {
  const runtime = makeStubRuntime({ catalog: CATALOG_WITH_BIGGER_SIBLING });
  const state = makeState();
  const promoted = await tryPromoteContextModelForRecovery.call(runtime, state, {
    trigger: "overflow",
  });
  assert.ok(promoted, "候选存在时必须返回晋升模型");
  assert.equal(String(promoted.modelId), "mid", "取最小的更大窗口");
  assert.equal(state.model, promoted, "state.model 必须换绑（下一请求即用晋升模型）");
  assert.equal(state.contextPromotionAttempted, true);
  // context 前缀重投影的未初始化分支原样返回 entries（不丢本轮请求历史）。
  assert.deepEqual(state.turnRequestState.entries, [{ marker: "request" }]);
});

test("(2) 用户可见告知：ModelSelected 事件 + selection 写入 + warn 日志（不许静默换模型）", async () => {
  const previousSelection = { providerId: "p1", modelId: "small" };
  const runtime = makeStubRuntime({ catalog: CATALOG_WITH_BIGGER_SIBLING, previousSelection });
  const state = makeState();
  await tryPromoteContextModelForRecovery.call(runtime, state, { trigger: "overflow" });

  assert.equal(runtime.calls.emitModelSelected.length, 1);
  const event = runtime.calls.emitModelSelected[0];
  assert.deepEqual(event.modelSelection, { providerId: "p1", modelId: "mid" });
  assert.deepEqual(event.previousModelSelection, previousSelection);
  assert.deepEqual(event.supportedThoughtLevels, ["low", "high"]);

  assert.equal(runtime.calls.setSessionModelSelection.length, 1);
  assert.deepEqual(runtime.calls.setSessionModelSelection[0], { providerId: "p1", modelId: "mid" });

  const warn = runtime.calls.warn.find((entry) => entry.fields?.event === "compact.context_promotion.applied");
  assert.ok(warn, "晋升事实必须落 warn 日志");
  assert.equal(warn.fields.from, "p1/small");
  assert.equal(warn.fields.to, "p1/mid");
  assert.equal(warn.fields.trigger, "overflow");
  assert.equal(warn.fields.promotedContextWindow, WINDOWS.mid);
});

test("(3) 晋升只试一次：同轮第二次调用直接 undefined，无副作用", async () => {
  const runtime = makeStubRuntime({ catalog: CATALOG_WITH_BIGGER_SIBLING });
  const state = makeState();
  const first = await tryPromoteContextModelForRecovery.call(runtime, state, { trigger: "overflow" });
  assert.ok(first);
  const second = await tryPromoteContextModelForRecovery.call(runtime, state, { trigger: "threshold" });
  assert.equal(second, undefined, "每轮至多晋升 1 次");
  assert.equal(runtime.calls.emitModelSelected.length, 1, "第二次不得再发事件");
});

test("(4) reasoningLevel 仅在候选支持时随迁", async () => {
  const supported = makeStubRuntime({
    catalog: CATALOG_WITH_BIGGER_SIBLING,
    previousSelection: { providerId: "p1", modelId: "small", options: { reasoningLevel: "high" } },
  });
  await tryPromoteContextModelForRecovery.call(supported, makeState(), { trigger: "overflow" });
  assert.deepEqual(supported.calls.emitModelSelected[0].modelSelection, {
    providerId: "p1",
    modelId: "mid",
    options: { reasoningLevel: "high" },
  });

  // 候选不支持当前档位（huge 的 reasoningLevels 为空）时不猜档位。
  const onlyHuge = makeStubRuntime({
    catalog: [
      { providerId: "p1", modelId: "small", contextWindow: WINDOWS.small, current: true, reasoningLevels: [] },
      { providerId: "p1", modelId: "huge", contextWindow: WINDOWS.huge, current: false, reasoningLevels: [] },
    ],
    previousSelection: { providerId: "p1", modelId: "small", options: { reasoningLevel: "high" } },
  });
  await tryPromoteContextModelForRecovery.call(onlyHuge, makeState(), { trigger: "overflow" });
  assert.deepEqual(onlyHuge.calls.emitModelSelected[0].modelSelection, {
    providerId: "p1",
    modelId: "huge",
  });
});

// ————————————————————————————————————————————————————————————————
// fail-safe：一切异常路径都落回压缩轨道（返回 undefined，零副作用）
// ————————————————————————————————————————————————————————————————

function assertNoSideEffects(runtime, state, originalModel) {
  assert.equal(state.model, originalModel, "失败路径不得换绑模型");
  assert.notEqual(state.contextPromotionAttempted, true, "失败路径不占每轮一次的额度");
  assert.equal(runtime.calls.emitModelSelected.length, 0);
  assert.equal(runtime.calls.setSessionModelSelection.length, 0);
}

test("(5) catalog port 缺席 / 空目录 / 无候选 → undefined（直接压缩，fail-safe）", async () => {
  const noPort = makeStubRuntime({ catalog: undefined });
  const stateA = makeState();
  const modelA = stateA.model;
  assert.equal(
    await tryPromoteContextModelForRecovery.call(noPort, stateA, { trigger: "overflow" }),
    undefined,
  );
  assertNoSideEffects(noPort, stateA, modelA);

  const empty = makeStubRuntime({ catalog: [] });
  const stateB = makeState();
  assert.equal(
    await tryPromoteContextModelForRecovery.call(empty, stateB, { trigger: "overflow" }),
    undefined,
  );

  const noCandidate = makeStubRuntime({
    catalog: [{ providerId: "p1", modelId: "tiny", contextWindow: 10, current: false }],
  });
  const stateC = makeState();
  const modelC = stateC.model;
  assert.equal(
    await tryPromoteContextModelForRecovery.call(noCandidate, stateC, { trigger: "overflow" }),
    undefined,
  );
  assertNoSideEffects(noCandidate, stateC, modelC);
});

test("(6) 工厂抛错（provider client 失效）→ warn + undefined，不落任何切换副作用", async () => {
  const runtime = makeStubRuntime({
    catalog: CATALOG_WITH_BIGGER_SIBLING,
    factoryErrorFor: "mid",
  });
  const state = makeState();
  const originalModel = state.model;
  assert.equal(
    await tryPromoteContextModelForRecovery.call(runtime, state, { trigger: "overflow" }),
    undefined,
  );
  assertNoSideEffects(runtime, state, originalModel);
  assert.ok(
    runtime.calls.warn.some((entry) => entry.fields?.event === "compact.context_promotion.model_creation_failed"),
    "工厂失败必须落 warn 日志",
  );
});

test("(7) 目录与工厂窗口不一致（复核不可证更大）→ 放弃晋升", async () => {
  const runtime = makeStubRuntime({
    catalog: CATALOG_WITH_BIGGER_SIBLING,
    factoryWindowOverride: { mid: 50_000 },
  });
  const state = makeState();
  const originalModel = state.model;
  assert.equal(
    await tryPromoteContextModelForRecovery.call(runtime, state, { trigger: "overflow" }),
    undefined,
  );
  assertNoSideEffects(runtime, state, originalModel);
  assert.ok(
    runtime.calls.warn.some((entry) => entry.fields?.event === "compact.context_promotion.window_recheck_failed"),
  );
});

test("(8) 钉住轮/无人值守轮：有候选也不晋升", async () => {
  for (const overrides of [
    { modelSelectionScope: "execution" },
    { subagentModelOverride: { providerId: "p1", modelId: "mid" } },
    { automationId: "auto-1" },
    { offPeakTaskId: "offpeak-1" },
  ]) {
    const runtime = makeStubRuntime({ catalog: CATALOG_WITH_BIGGER_SIBLING });
    const state = makeState(overrides);
    const originalModel = state.model;
    assert.equal(
      await tryPromoteContextModelForRecovery.call(runtime, state, { trigger: "overflow" }),
      undefined,
      `${JSON.stringify(overrides)} 不得晋升`,
    );
    assertNoSideEffects(runtime, state, originalModel);
  }
});
