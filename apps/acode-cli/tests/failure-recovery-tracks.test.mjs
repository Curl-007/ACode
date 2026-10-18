import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 分层故障恢复轨道（specs/failure-recovery-tracks.md）的纯策略单测 + 互斥钉住 + 接线守卫。
 *
 * 机制参照 oh-my-pi (MIT) session-maintenance.ts（checkCompaction 四 case / #tryContextPromotion /
 * INCOMPLETE_RECOVERY_MAX_RETRIES=3），实现与用例为自撰。执行体（stub runtime）测试在
 * failure-recovery-promotion-executor.test.mjs。
 */

const {
  isContextPromotionEligibleTurn,
  resolveContextPromotionCandidate,
} = await import("../packages/core/src/compact/promotion.ts");
const {
  TRUNCATION_NO_OUTPUT_MAX_RETRIES,
  classifyTruncationRecovery,
  isTruncationWindowExhausted,
} = await import("../packages/core/src/compact/truncation-recovery.ts");
const { getAutoCompactThreshold, getEffectiveContextWindowSize } = await import(
  "../packages/core/src/compact/policy.ts"
);
const { createOutputTokenLimitExhaustedError } = await import(
  "../packages/core/src/runtime/methods/turn-output-token-continuation.ts"
);
const { createModelContextExceededFinishError } = await import(
  "../packages/core/src/runtime/helpers/model-errors.ts"
);
const { projectExecutionErrorPayload } = await import(
  "../packages/core/src/errors/error-payload.ts"
);
const { classifyAutoResumeFailure } = await import(
  "../packages/core/src/runtime/auto-resume/classifier.ts"
);
const { CoreErrorType } = await import("../packages/contracts/src/errors/index.ts");

// ————————————————————————————————————————————————————————————————
// 1. 晋升候选解析（轨道 1 纯策略）
// ————————————————————————————————————————————————————————————————

const current = { providerId: "p1", modelId: "small", contextWindow: 100_000 };

test("(1.1) 同 provider 更大窗口 → 取最小的更大窗口（最小充分跳变）", () => {
  const candidate = resolveContextPromotionCandidate({
    currentModel: current,
    catalog: [
      { providerId: "p1", modelId: "huge", contextWindow: 1_000_000, current: false, reasoningLevels: [] },
      { providerId: "p1", modelId: "mid", contextWindow: 120_000, current: false, reasoningLevels: ["low"] },
    ],
  });
  assert.equal(candidate?.modelId, "mid");
  assert.equal(candidate?.contextWindow, 120_000);
  assert.deepEqual(candidate?.reasoningLevels, ["low"]);
});

test("(1.2) 同窗口按 modelId 字典序，确定性选取", () => {
  const catalog = [
    { providerId: "p1", modelId: "b-model", contextWindow: 200_000, current: false, reasoningLevels: [] },
    { providerId: "p1", modelId: "a-model", contextWindow: 200_000, current: false, reasoningLevels: [] },
  ];
  assert.equal(
    resolveContextPromotionCandidate({ currentModel: current, catalog })?.modelId,
    "a-model",
  );
});

test("(1.3) 无候选一律 undefined：更小窗口/等窗/跨 provider/禁用/current/窗口未知", () => {
  assert.equal(
    resolveContextPromotionCandidate({
      currentModel: current,
      catalog: [{ providerId: "p1", modelId: "tiny", contextWindow: 50_000, current: false }],
    }),
    undefined,
    "更小窗口不是候选",
  );
  assert.equal(
    resolveContextPromotionCandidate({
      currentModel: current,
      catalog: [{ providerId: "p1", modelId: "same-size", contextWindow: 100_000, current: false }],
    }),
    undefined,
    "等窗不满足严格更大",
  );
  assert.equal(
    resolveContextPromotionCandidate({
      currentModel: current,
      catalog: [{ providerId: "p2", modelId: "huge", contextWindow: 1_000_000, current: false }],
    }),
    undefined,
    "跨 provider 不晋升（账号/计费面波外）",
  );
  assert.equal(
    resolveContextPromotionCandidate({
      currentModel: current,
      catalog: [
        {
          providerId: "p1",
          modelId: "huge",
          contextWindow: 1_000_000,
          current: false,
          disabledReason: "no_api_key",
        },
      ],
    }),
    undefined,
    "禁用模型不是候选",
  );
  assert.equal(
    resolveContextPromotionCandidate({
      currentModel: current,
      catalog: [{ providerId: "p1", modelId: "small", contextWindow: 999_999, current: true }],
    }),
    undefined,
    "同 modelId / current 条目不是候选",
  );
  assert.equal(
    resolveContextPromotionCandidate({
      currentModel: current,
      catalog: [{ providerId: "p1", modelId: "unknown-window", current: false }],
    }),
    undefined,
    "候选窗口未知不可证更大",
  );
});

test("(1.4) 当前窗口未知/非正数 → 无候选（fail-safe：无法证明更大就直接压缩）", () => {
  const catalog = [
    { providerId: "p1", modelId: "huge", contextWindow: 1_000_000, current: false },
  ];
  assert.equal(
    resolveContextPromotionCandidate({
      currentModel: { providerId: "p1", modelId: "small", contextWindow: undefined },
      catalog,
    }),
    undefined,
  );
  assert.equal(
    resolveContextPromotionCandidate({
      currentModel: { providerId: "p1", modelId: "small", contextWindow: 0 },
      catalog,
    }),
    undefined,
  );
  assert.equal(
    resolveContextPromotionCandidate({
      currentModel: { providerId: "p1", modelId: "small", contextWindow: Number.NaN },
      catalog,
    }),
    undefined,
  );
});

test("(1.5) 钉住轮/无人值守轮/已晋升轮不具晋升资格", () => {
  const eligible = {
    promotionAttempted: false,
    hasSubagentModelOverride: false,
    isUnattendedTurn: false,
  };
  assert.equal(isContextPromotionEligibleTurn(eligible), true);
  assert.equal(isContextPromotionEligibleTurn({ ...eligible, promotionAttempted: true }), false);
  assert.equal(
    isContextPromotionEligibleTurn({ ...eligible, modelSelectionScope: "execution" }),
    false,
    "execution-scoped 钉住选择不得改写",
  );
  assert.equal(
    isContextPromotionEligibleTurn({ ...eligible, hasSubagentModelOverride: true }),
    false,
    "subagent override 钉住选择",
  );
  assert.equal(
    isContextPromotionEligibleTurn({ ...eligible, isUnattendedTurn: true }),
    false,
    "无人值守轮不能替用户切换计费模型",
  );
});

// ————————————————————————————————————————————————————————————————
// 2. 截断恢复分类器（轨道 2 纯策略）
// ————————————————————————————————————————————————————————————————

// 与 autoCompactIfNeeded 同构的策略配置：窗口 200K、输出预留 21K、buffer 13K。
const truncationConfig = { contextWindow: 200_000, maxOutputTokens: 32_000 };
const threshold = getAutoCompactThreshold(truncationConfig);
const effectiveWindow = getEffectiveContextWindowSize(truncationConfig);

test("(2.1) 窗口未耗尽 + 有产出 → keep_with_warning（保留产出 + 告警，不续写）", () => {
  const decision = classifyTruncationRecovery({
    config: truncationConfig,
    consecutiveLengthRetries: 0,
    hasDeliveredOutput: true,
    outputTokens: 8_000,
    promptTokens: 10_000,
  });
  assert.equal(decision.action, "keep_with_warning");
  assert.equal(decision.windowExhausted, false);
});

test("(2.2) 窗口未耗尽 + 无产出 → discard_and_retry，attempt 递增", () => {
  for (const retries of [0, 1, TRUNCATION_NO_OUTPUT_MAX_RETRIES - 1]) {
    const decision = classifyTruncationRecovery({
      config: truncationConfig,
      consecutiveLengthRetries: retries,
      hasDeliveredOutput: false,
      outputTokens: 0,
      promptTokens: 10_000,
    });
    assert.equal(decision.action, "discard_and_retry", `retries=${retries}`);
    assert.equal(decision.attempt, retries + 1);
  }
});

test("(2.3) 连续无产出达到封顶 3 次 → fail_loud（omp INCOMPLETE_RECOVERY_MAX_RETRIES 同值）", () => {
  assert.equal(TRUNCATION_NO_OUTPUT_MAX_RETRIES, 3);
  const decision = classifyTruncationRecovery({
    config: truncationConfig,
    consecutiveLengthRetries: TRUNCATION_NO_OUTPUT_MAX_RETRIES,
    hasDeliveredOutput: false,
    outputTokens: 0,
    promptTokens: 10_000,
  });
  assert.equal(decision.action, "fail_loud");
  assert.equal(decision.attempt, TRUNCATION_NO_OUTPUT_MAX_RETRIES);
});

test("(2.4) 窗口耗尽 → compact（有产出也一样；交接 loop 边界 threshold 压缩）", () => {
  const byThreshold = classifyTruncationRecovery({
    config: truncationConfig,
    consecutiveLengthRetries: 0,
    hasDeliveredOutput: true,
    outputTokens: 1_000,
    promptTokens: threshold, // ≥ 阈值即耗尽
  });
  assert.equal(byThreshold.action, "compact");
  assert.equal(byThreshold.windowExhausted, true);

  const byWindow = classifyTruncationRecovery({
    config: truncationConfig,
    consecutiveLengthRetries: 0,
    hasDeliveredOutput: true,
    outputTokens: effectiveWindow - 100,
    promptTokens: 200, // prompt+output ≥ 有效窗口
  });
  assert.equal(byWindow.action, "compact");
  assert.equal(byWindow.windowExhausted, true);
});

test("(2.5) 窗口未知 → 按耗尽处理（没有余量证据，保守走压缩，omp 同口径）", () => {
  assert.equal(
    isTruncationWindowExhausted({ config: {}, outputTokens: 0, promptTokens: 0 }),
    true,
  );
  const decision = classifyTruncationRecovery({
    config: {},
    consecutiveLengthRetries: 0,
    hasDeliveredOutput: true,
    outputTokens: 0,
    promptTokens: 0,
  });
  assert.equal(decision.action, "compact");
});

// ————————————————————————————————————————————————————————————————
// 3. 与 auto-resume 的互斥（fail-loud / 溢出都不被跨回合链接管）
// ————————————————————————————————————————————————————————————————

test("(3.1) 输出上限耗尽错误 → attribution.retryable=false → auto-resume permanent", () => {
  const error = createOutputTokenLimitExhaustedError();
  const projection = projectExecutionErrorPayload(error);
  assert.equal(projection.attribution?.retryable, false);
  const classification = classifyAutoResumeFailure({
    coreErrorType: CoreErrorType.ModelError,
    ...(projection.attribution ? { attribution: projection.attribution } : {}),
  });
  assert.equal(classification.kind, "permanent", "封顶终止必须 fail-loud，链不接管");
});

test("(3.2) 溢出错误 → auto-resume permanent（既有互斥事实，回归钉住）", () => {
  const error = createModelContextExceededFinishError({
    finishReason: "model_context_window_exceeded",
    rawFinishReason: undefined,
  });
  const projection = projectExecutionErrorPayload(error);
  const classification = classifyAutoResumeFailure({
    coreErrorType: CoreErrorType.ModelContextExceeded,
    ...(projection.attribution ? { attribution: projection.attribution } : {}),
  });
  assert.equal(classification.kind, "permanent", "溢出在 turn 内轨道处理，auto-resume 不接管");
});

// ————————————————————————————————————————————————————————————————
// 4. 接线守卫（源码断言，compact-invariants.test.mjs 同款手法）
// ————————————————————————————————————————————————————————————————

const coreRoot = new URL("../packages/core/src/", import.meta.url);
const readCore = (path) => readFile(new URL(path, coreRoot), "utf8");

test("(4.1) 溢出恢复：晋升前置于 reactive compaction", async () => {
  const source = await readCore("runtime/methods/turn-model-step.ts");
  const recoverBody = source.slice(source.indexOf("async function recoverModelStepAfterContextExceeded"));
  const promotionAt = recoverBody.indexOf("tryPromoteContextModelForRecovery");
  const compactGuardAt = recoverBody.indexOf("reactiveCompactAttemptedInCurrentModelStep");
  const reactiveAt = recoverBody.indexOf("this.reactiveCompactAfterContextExceeded");
  assert.ok(promotionAt > 0, "recoverModelStepAfterContextExceeded 必须调用晋升执行体");
  assert.ok(promotionAt < compactGuardAt, "晋升必须先于 compaction 守卫");
  assert.ok(promotionAt < reactiveAt, "晋升必须先于 reactive compaction");
});

test("(4.2) 阈值路径：autoCompactIfNeeded 晋升前置并返回 promoted", async () => {
  const source = await readCore("runtime/methods/compact.ts");
  const fnBody = source.slice(source.indexOf("export async function autoCompactIfNeeded"));
  const promotionAt = fnBody.indexOf("tryPromoteContextModelForRecovery");
  const breakerAt = fnBody.indexOf("rapidRefill.shouldBlock");
  const compactAt = fnBody.indexOf("this.compactActiveConversation");
  assert.ok(promotionAt > 0 && promotionAt < breakerAt, "晋升先于 rapid-refill 熔断");
  assert.ok(promotionAt < compactAt, "晋升先于压缩执行");
  assert.match(fnBody.slice(promotionAt, breakerAt), /return "promoted"/);
});

test("(4.3) 截断轨道：keep_with_warning 改道既有续写块", async () => {
  const source = await readCore("runtime/methods/turn-model-step.ts");
  assert.match(source, /classifyTruncationRecovery|shouldKeepTruncatedOutputWithWarning/);
  assert.match(
    source,
    /outputTokenContinuation !== "none" && !truncationKeptWithWarning/,
    "续写块必须被 keep 改道守卫",
  );
});

test("(4.4) 晋升执行体唯一：两个决策点都走 context-promotion.ts", async () => {
  const executor = await readCore("runtime/methods/context-promotion.ts");
  assert.match(executor, /resolveContextPromotionCandidate/);
  assert.match(executor, /isContextPromotionEligibleTurn/);
  assert.match(executor, /emitModelSelected/, "不许静默换模型：必须发 ModelSelected");
  assert.match(executor, /contextPromotionAttempted = true/, "每轮至多一次的占位写点");
  const callers = await Promise.all([
    readCore("runtime/methods/turn-model-step.ts"),
    readCore("runtime/methods/compact.ts"),
  ]);
  for (const source of callers) {
    assert.match(source, /tryPromoteContextModelForRecovery/);
  }
});
