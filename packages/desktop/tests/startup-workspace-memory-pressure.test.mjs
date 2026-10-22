// 预热让路钩子验收（apps/acode-cli/specs/cli-governor.md 场景 13 / R8）：
// 阈值判定（5%/2%，desktop 侧独立实现同阈值）、压力时只留 primary、无压力
// 全放行、空/单 target 原样、per-level 60s 日志抑制、Electron
// process.getSystemMemoryInfo 的 swap-aware ratio（非 Electron 环境 fail-open=1）。
import assert from "node:assert/strict";
import test from "node:test";

const {
  applyMemoryPressureToWarmupTargets,
  evaluateWarmupPressureLevel,
  getDesktopFreeMemoryRatio,
  resetWarmupPressureLogSuppressionForTest,
} = await import("../src/main/startupWorkspace.ts");

function makeTargets(count) {
  return Array.from({ length: count }, (_, index) => ({
    workspacePath: `/repo/ws-${index}`,
  }));
}

function makeLogger() {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args.join(" ")) };
}

test("evaluateWarmupPressureLevel: 5%/2% thresholds", () => {
  assert.equal(evaluateWarmupPressureLevel(0.03), "warning");
  assert.equal(evaluateWarmupPressureLevel(0.01), "critical");
  assert.equal(evaluateWarmupPressureLevel(0.5), null);
  assert.equal(evaluateWarmupPressureLevel(Number.NaN), null);
  assert.equal(evaluateWarmupPressureLevel(0.05), null, "边界：恰 5% 不算 warning");
  assert.equal(evaluateWarmupPressureLevel(0.02), "warning", "边界：恰 2% 不算 critical");
});

test("pressure yields non-primary warmup targets, keeps primary", () => {
  resetWarmupPressureLogSuppressionForTest();
  const logger = makeLogger();
  const targets = makeTargets(3);
  const kept = applyMemoryPressureToWarmupTargets(targets, {
    getFreeMemoryRatio: () => 0.03,
    logger,
    now: () => 1_000_000,
  });
  assert.deepEqual(kept, [targets[0]], "只留 primary（活动窗口 workspace 永不 yield）");
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /warning/);
  assert.match(logger.warnings[0], /yielding 2 warmup target/);
});

test("no pressure passes all targets through", () => {
  resetWarmupPressureLogSuppressionForTest();
  const logger = makeLogger();
  const targets = makeTargets(3);
  const kept = applyMemoryPressureToWarmupTargets(targets, {
    getFreeMemoryRatio: () => 0.5,
    logger,
    now: () => 1_000_000,
  });
  assert.deepEqual([...kept], targets);
  assert.equal(logger.warnings.length, 0);
});

test("undefined and single-target lists pass through untouched", () => {
  resetWarmupPressureLogSuppressionForTest();
  assert.equal(
    applyMemoryPressureToWarmupTargets(undefined, { getFreeMemoryRatio: () => 0.01 }),
    undefined,
  );
  const single = makeTargets(1);
  const kept = applyMemoryPressureToWarmupTargets(single, {
    getFreeMemoryRatio: () => 0.01,
    logger: makeLogger(),
    now: () => 1_000_000,
  });
  assert.deepEqual([...kept], single, "单 target = primary，压力再高也不 yield");
});

test("per-level 60s log suppression, levels tracked independently", () => {
  resetWarmupPressureLogSuppressionForTest();
  const logger = makeLogger();
  const targets = makeTargets(2);
  const deps = { getFreeMemoryRatio: () => 0.03, logger };
  applyMemoryPressureToWarmupTargets(targets, { ...deps, now: () => 1_000_000 });
  applyMemoryPressureToWarmupTargets(targets, { ...deps, now: () => 1_030_000 });
  assert.equal(logger.warnings.length, 1, "同 level 60s 内只记一次");
  // critical 独立计时：同刻也记。
  applyMemoryPressureToWarmupTargets(targets, {
    getFreeMemoryRatio: () => 0.01,
    logger,
    now: () => 1_030_000,
  });
  assert.equal(logger.warnings.length, 2);
  applyMemoryPressureToWarmupTargets(targets, { ...deps, now: () => 1_061_000 });
  assert.equal(logger.warnings.length, 3, "61s 后同 level 再记");
  resetWarmupPressureLogSuppressionForTest();
});

test("getDesktopFreeMemoryRatio: swap-aware min, fail-open without Electron", () => {
  // 非 Electron（单测进程）：无 getSystemMemoryInfo → 1（无压力，fail-open）。
  if (typeof process.getSystemMemoryInfo !== "function") {
    assert.equal(getDesktopFreeMemoryRatio(), 1);
  }
  const original = process.getSystemMemoryInfo;
  try {
    process.getSystemMemoryInfo = () => ({
      total: 100,
      free: 10,
      swapTotal: 100,
      swapFree: 1,
    });
    assert.equal(getDesktopFreeMemoryRatio(), 0.01, "min(free/total, swapFree/swapTotal)");
    process.getSystemMemoryInfo = () => ({ total: 100, free: 10 });
    assert.equal(getDesktopFreeMemoryRatio(), 0.1, "无 swap 字段 → free/total");
    process.getSystemMemoryInfo = () => ({ total: 0, free: 0 });
    assert.equal(getDesktopFreeMemoryRatio(), 1, "total<=0 fail-open");
    process.getSystemMemoryInfo = () => {
      throw new Error("boom");
    };
    assert.equal(getDesktopFreeMemoryRatio(), 1, "读取抛错 fail-open");
  } finally {
    if (original === undefined) {
      delete process.getSystemMemoryInfo;
    } else {
      process.getSystemMemoryInfo = original;
    }
  }
});
