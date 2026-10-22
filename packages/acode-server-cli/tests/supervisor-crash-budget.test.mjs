import assert from "node:assert/strict";
import test from "node:test";

/**
 * Supervisor CrashBudget 守护（review 测试专项 P2：acode-server-cli supervisor 生命周期覆盖偏薄）。
 *
 * CrashBudget 决定 Core 崩溃后是否重启与退避延迟，是「crash-loop-stopped」终态的唯一判据。
 * 用注入的 now()（纯逻辑，无墙钟依赖）钉住：指数退避序列、窗口内计数累积、超限 exhausted、
 * 窗口滑过后自动重置。常量来自 contracts（CRASH_BACKOFF_MS / CRASH_WINDOW_MS）。
 */
const { CrashBudget } = await import("../src/supervisor/crashBudget.ts");
const { CRASH_BACKOFF_MS, CRASH_WINDOW_MS } = await import("../src/contracts.ts");

test("退避序列按 CRASH_BACKOFF_MS 递增，末档封顶", () => {
  let now = 0;
  const budget = new CrashBudget({ now: () => now });
  CRASH_BACKOFF_MS.forEach((expected, index) => {
    assert.equal(budget.recordCrash().delayMs, expected, `第 ${index} 档退避延迟必须匹配常量表`);
  });
});

test("超出退避档数后 exhausted，不再 shouldRestart", () => {
  let now = 0;
  const budget = new CrashBudget({ now: () => now });
  for (let i = 0; i < CRASH_BACKOFF_MS.length; i += 1) {
    assert.equal(budget.recordCrash().shouldRestart, true, `第 ${i} 次应允许重启`);
  }
  const overflow = budget.recordCrash();
  assert.equal(overflow.shouldRestart, false, "退避表用尽后必须停止重启");
  assert.equal(overflow.exhausted, true);
  // 延迟封顶在最后一档（不再增长）。
  assert.equal(overflow.delayMs, CRASH_BACKOFF_MS[CRASH_BACKOFF_MS.length - 1]);
});

test("窗口内计数累积；窗口滑过后自动重置（不永久钉死在 crash-loop-stopped）", () => {
  let now = 0;
  const budget = new CrashBudget({ now: () => now });
  budget.recordCrash();
  budget.recordCrash();
  assert.equal(budget.snapshot().crashCount, 2);

  // 未到窗口边界：计数保持。
  now = CRASH_WINDOW_MS - 1;
  assert.equal(budget.snapshot().crashCount, 2, "窗口内计数不得重置");

  // 越过窗口边界：snapshot 触发 reset。
  now = CRASH_WINDOW_MS + 1;
  const after = budget.snapshot();
  assert.equal(after.crashCount, 0, "窗口滑过必须重置计数");
  assert.equal(after.nextRestartDelayMs, CRASH_BACKOFF_MS[0], "重置后回到首档退避");
  assert.equal(after.exhausted, false);
});

test("recordCrash 跨窗口边界自动开新窗口", () => {
  let now = 0;
  const budget = new CrashBudget({ now: () => now });
  // 在旧窗口内耗尽退避。
  for (let i = 0; i < CRASH_BACKOFF_MS.length + 1; i += 1) budget.recordCrash();
  assert.equal(budget.recordCrash().shouldRestart, false);
  // 推进到新窗口：应重新允许重启并从首档退避开始。
  now += CRASH_WINDOW_MS;
  const fresh = budget.recordCrash();
  assert.equal(fresh.shouldRestart, true, "新窗口必须重新允许重启");
  assert.equal(fresh.delayMs, CRASH_BACKOFF_MS[0]);
});

test("reset 显式清空窗口与计数", () => {
  const budget = new CrashBudget({ now: () => 0 });
  budget.recordCrash();
  budget.recordCrash();
  budget.reset();
  const snap = budget.snapshot();
  assert.equal(snap.crashCount, 0);
  assert.equal(snap.windowStartedAt, undefined, "reset 后窗口起点清空");
});
