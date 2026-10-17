// 验收场景 2/3/4（apps/acode-cli/specs/turn-auto-resume.md）：退避序列、循环守卫、
// 重置条件、定时器纪律（取消 + 触发前重查会话状态）、命令面 overlay、config 解析回落。
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  AutoResumeCoordinator,
  computeAutoResumeBackoffDelayMs,
} from "../packages/core/src/runtime/auto-resume/coordinator.ts";
import { resolveAutoResumeConfig } from "../packages/core/src/runtime/auto-resume/types.ts";

const TEST_TRACE = { traceId: "trace_test" };

function createHarness(configOverrides, injectImpl) {
  const timers = [];
  const injected = [];
  const emitted = [];
  let nowMs = 1_700_000_000_000;
  let injectable = true;
  const config = resolveAutoResumeConfig(configOverrides);
  const coordinator = new AutoResumeCoordinator({
    emitScheduled: async (input) => {
      emitted.push(input);
    },
    getConfig: () => config,
    inject: async (plan) => {
      injected.push(plan);
      if (injectImpl) await injectImpl(plan, coordinator);
    },
    isChildSession: () => false,
    isSessionInjectable: () => injectable,
    now: () => nowMs,
    scheduler: {
      clear(handle) {
        handle.cleared = true;
      },
      set(delayMs, fire) {
        const entry = { cleared: false, delayMs, fire, fired: false };
        timers.push(entry);
        return entry;
      },
    },
    sessionId: "sess_test",
  });
  return {
    advance(ms) {
      nowMs += ms;
    },
    coordinator,
    emitted,
    injected,
    setInjectable(value) {
      injectable = value;
    },
    timers,
  };
}

function transientFacts(statusCode = 429, providerCode) {
  return {
    attribution: {
      reason: "rate_limit",
      retryable: true,
      statusCode,
      ...(providerCode ? { providerErrorCode: providerCode } : {}),
    },
    coreErrorType: "model_error",
  };
}

function context() {
  return { traceContext: TEST_TRACE };
}

function liveTimers(h) {
  return h.timers.filter((timer) => !timer.cleared && !timer.fired);
}

/** 排定后手动触发唯一存活的定时器（模拟退避到期）。 */
async function firePending(h) {
  const pending = liveTimers(h);
  assert.equal(pending.length, 1, "expected exactly one live timer");
  pending[0].fired = true;
  await pending[0].fire();
}

let harness;
beforeEach(() => {
  harness = createHarness();
});

describe("backoff sequence (scenario 2)", () => {
  it("computes min(base*factor^(n-1), max) with defaults 10s/x2/60s", () => {
    const config = resolveAutoResumeConfig(undefined);
    assert.equal(computeAutoResumeBackoffDelayMs(1, config), 10_000);
    assert.equal(computeAutoResumeBackoffDelayMs(2, config), 20_000);
    assert.equal(computeAutoResumeBackoffDelayMs(3, config), 40_000);
    assert.equal(computeAutoResumeBackoffDelayMs(4, config), 60_000);
    assert.equal(computeAutoResumeBackoffDelayMs(9, config), 60_000);
  });

  it("schedules growing delays across chained transient failures", async () => {
    const expectedDelays = [10_000, 20_000, 40_000];
    for (const [index, expected] of expectedDelays.entries()) {
      await harness.coordinator.notifyTurnFailure(transientFacts(), context());
      const timer = harness.timers.at(-1);
      assert.equal(timer.delayMs, expected);
      await firePending(harness);
      assert.equal(harness.injected.at(-1)?.attempt, index + 1);
    }
    assert.equal(harness.coordinator.getStatus().count, 3);
  });

  it("emits scheduled status at decision time and pre-injection (delayMs=0)", async () => {
    await harness.coordinator.notifyTurnFailure(transientFacts(), context());
    assert.equal(harness.emitted.length, 1);
    assert.equal(harness.emitted[0].delayMs, 10_000);
    assert.equal(harness.emitted[0].plan.attempt, 1);
    await firePending(harness);
    assert.equal(harness.emitted.length, 2);
    assert.equal(harness.emitted[1].delayMs, 0);
    assert.equal(harness.injected.length, 1);
  });

  it("stops at maxResumes and clears the chain", async () => {
    const h = createHarness({ maxResumes: 2 });
    for (let i = 0; i < 2; i++) {
      await h.coordinator.notifyTurnFailure(transientFacts(429, `p${i}`), context());
      await firePending(h);
    }
    assert.equal(h.coordinator.getStatus().count, 2);
    await h.coordinator.notifyTurnFailure(transientFacts(429, "p3"), context());
    assert.equal(liveTimers(h).length, 0);
    assert.equal(h.coordinator.getStatus().count, 0);
  });
});

describe("loop guard (scenario 2)", () => {
  it("stops after the same signature repeats more than loopGuardRepeats times", async () => {
    // 相同 reason+statusCode+providerCode：第 1..3 次排定，第 4 次（repeats>3）停。
    for (let i = 0; i < 3; i++) {
      await harness.coordinator.notifyTurnFailure(transientFacts(429, "3007"), context());
      assert.equal(liveTimers(harness).length, 1, `round ${i}`);
      await firePending(harness);
    }
    assert.equal(harness.coordinator.getStatus().repeats, 3);
    await harness.coordinator.notifyTurnFailure(transientFacts(429, "3007"), context());
    assert.equal(liveTimers(harness).length, 0);
    assert.equal(harness.coordinator.getStatus().count, 0);
  });

  it("signature change resets repeats and keeps resuming", async () => {
    for (let i = 0; i < 3; i++) {
      await harness.coordinator.notifyTurnFailure(transientFacts(429, "same"), context());
      await firePending(harness);
    }
    assert.equal(harness.coordinator.getStatus().repeats, 3);
    // 签名变化（statusCode 不同）→ repeats 归 1，继续排定。
    await harness.coordinator.notifyTurnFailure(transientFacts(500, "same"), context());
    const status = harness.coordinator.getStatus();
    assert.equal(status.repeats, 1);
    assert.equal(status.lastSignature, "rate_limit|500|same");
    assert.equal(status.count, 4);
  });
});

describe("reset conditions (scenario 3)", () => {
  async function scheduleOne() {
    await harness.coordinator.notifyTurnFailure(transientFacts(), context());
    assert.equal(harness.coordinator.getStatus().count, 1);
  }

  it("success settlement resets count and cancels the pending timer", async () => {
    await scheduleOne();
    harness.coordinator.notifyTurnSettled("success");
    assert.equal(harness.coordinator.getStatus().count, 0);
    assert.equal(
      harness.timers.every((t) => t.cleared),
      true,
    );
  });

  it("cancelled settlement resets (user stop is a normal end)", async () => {
    await scheduleOne();
    harness.coordinator.notifyTurnSettled("cancelled");
    assert.equal(harness.coordinator.getStatus().count, 0);
  });

  it("budget settlement gives up and resets", async () => {
    await scheduleOne();
    harness.coordinator.notifyTurnSettled("budget");
    assert.equal(harness.coordinator.getStatus().count, 0);
  });

  it("new user input admission resets and cancels pending", async () => {
    await scheduleOne();
    harness.coordinator.notifyUserInputAdmitted();
    assert.equal(harness.coordinator.getStatus().count, 0);
    assert.equal(
      harness.timers.every((t) => t.cleared),
      true,
    );
  });

  it("permanent classification resets without scheduling", async () => {
    await scheduleOne();
    await harness.coordinator.notifyTurnFailure(
      { attribution: { reason: "auth_error", retryable: false }, coreErrorType: "model_error" },
      context(),
    );
    assert.equal(harness.coordinator.getStatus().count, 0);
    assert.equal(liveTimers(harness).length, 0);
  });
});

describe("timer discipline (scenario 4)", () => {
  it("abortChain cancels the pending timer so it never fires", async () => {
    await harness.coordinator.notifyTurnFailure(transientFacts(), context());
    harness.coordinator.abortChain("stop_command");
    assert.equal(
      harness.timers.every((t) => t.cleared),
      true,
    );
    assert.equal(harness.coordinator.getStatus().pendingResumeAtMs, undefined);
  });

  it("re-checks session state before injecting: busy session skips and resets", async () => {
    await harness.coordinator.notifyTurnFailure(transientFacts(), context());
    harness.setInjectable(false); // 用户已手动续上/新输入在飞
    await firePending(harness);
    assert.equal(harness.injected.length, 0);
    assert.equal(harness.coordinator.getStatus().count, 0);
  });

  it("disable/pause after scheduling blocks the pending injection at fire time", async () => {
    await harness.coordinator.notifyTurnFailure(transientFacts(), context());
    harness.coordinator.applyCommand({ enabled: false, kind: "setEnabled" });
    // setEnabled(false) 立即取消 pending；再验证 pause 挡住新的排定。
    assert.equal(
      harness.timers.every((t) => t.cleared),
      true,
    );
    harness.coordinator.applyCommand({ enabled: true, kind: "setEnabled" });
    await harness.coordinator.notifyTurnFailure(transientFacts(500), context());
    harness.coordinator.applyCommand({ durationMs: 60_000, kind: "pause" });
    assert.equal(liveTimers(harness).length, 0);
    await harness.coordinator.notifyTurnFailure(transientFacts(501), context());
    assert.equal(liveTimers(harness).length, 0);
  });

  it("pause overlay expires lazily and resumes scheduling", async () => {
    harness.coordinator.applyCommand({ durationMs: 30_000, kind: "pause" });
    await harness.coordinator.notifyTurnFailure(transientFacts(), context());
    assert.equal(harness.timers.length, 0);
    harness.advance(30_001);
    assert.equal(harness.coordinator.getStatus().pausedUntilMs, undefined);
    await harness.coordinator.notifyTurnFailure(transientFacts(), context());
    assert.equal(harness.timers.length, 1);
  });

  it("dispose cancels pending and ignores later notifications", async () => {
    await harness.coordinator.notifyTurnFailure(transientFacts(), context());
    harness.coordinator.dispose();
    assert.equal(
      harness.timers.every((t) => t.cleared),
      true,
    );
    await harness.coordinator.notifyTurnFailure(transientFacts(500), context());
    assert.equal(liveTimers(harness).length, 0);
    assert.equal(harness.injected.length, 0);
  });

  it("injected turn failing transiently continues the chain (hook owns state, no double reset)", async () => {
    // 注入 turn 自身失败：turn.ts 挂点先 notify（排定下一级），executeTurn 的 rejection
    // 再传回 #onTimerFire——coordinator 不得把挂点刚排定的链二次清零。
    const h = createHarness(undefined, async (_plan, coordinator) => {
      await coordinator.notifyTurnFailure(transientFacts(500, "next"), context());
      throw new Error("injected turn failed");
    });
    await h.coordinator.notifyTurnFailure(transientFacts(), context());
    await firePending(h);
    const status = h.coordinator.getStatus();
    assert.equal(status.count, 2);
    assert.equal(liveTimers(h).length, 1);
  });

  it("injected turn settling as permanent clears the chain without a second reset", async () => {
    const h = createHarness(undefined, async (_plan, coordinator) => {
      coordinator.notifyTurnSettled("cancelled");
      throw new Error("injected turn cancelled");
    });
    await h.coordinator.notifyTurnFailure(transientFacts(), context());
    await firePending(h);
    assert.equal(h.coordinator.getStatus().count, 0);
    assert.equal(liveTimers(h).length, 0);
  });

  it("injection machinery failure (turn never ran) gives up the chain", async () => {
    // notifySeq 未前进 = 注入机构失败（队列关闭等），没有挂点接管，只能放弃本链。
    const h = createHarness(undefined, async () => {
      throw new Error("command queue closed");
    });
    await h.coordinator.notifyTurnFailure(transientFacts(), context());
    await firePending(h);
    assert.equal(h.coordinator.getStatus().count, 0);
    assert.equal(liveTimers(h).length, 0);
  });
});

describe("gates and command-plane state", () => {
  it("child sessions never schedule (supervisor owns the failure)", async () => {
    const coordinator = new AutoResumeCoordinator({
      emitScheduled: async () => undefined,
      getConfig: () => resolveAutoResumeConfig(undefined),
      inject: async () => undefined,
      isChildSession: () => true,
      isSessionInjectable: () => true,
      now: () => Date.now(),
      sessionId: "sess_child",
    });
    await coordinator.notifyTurnFailure(transientFacts(), context());
    assert.equal(coordinator.getStatus().count, 0);
  });

  it("config enabled=false blocks scheduling; command override re-enables", async () => {
    const h = createHarness({ enabled: false });
    await h.coordinator.notifyTurnFailure(transientFacts(), context());
    assert.equal(h.timers.length, 0);
    h.coordinator.applyCommand({ enabled: true, kind: "setEnabled" });
    assert.equal(h.coordinator.getStatus().enabled, true);
    await h.coordinator.notifyTurnFailure(transientFacts(), context());
    assert.equal(h.timers.length, 1);
  });

  it("status snapshot exposes count/repeats/signature/message overlay", async () => {
    harness.coordinator.applyCommand({
      kind: "setContinueMessage",
      message: " keep going {count} ",
    });
    await harness.coordinator.notifyTurnFailure(transientFacts(429, "3007"), context());
    const status = harness.coordinator.getStatus();
    assert.equal(status.continueMessage, "keep going {count}");
    assert.equal(status.count, 1);
    assert.equal(status.repeats, 1);
    assert.equal(status.lastSignature, "rate_limit|429|3007");
    assert.equal(status.maxResumes, 8);
    assert.ok(status.pendingResumeAtMs && status.pendingResumeAtMs > 0);
    harness.coordinator.applyCommand({ kind: "setContinueMessage", message: null });
    assert.equal(harness.coordinator.getStatus().continueMessage, undefined);
  });
});

describe("resolveAutoResumeConfig", () => {
  it("falls back to spec defaults (true/8/10/2/60/3)", () => {
    const config = resolveAutoResumeConfig(undefined);
    assert.deepEqual(config, {
      cooldownBaseSec: 10,
      cooldownFactor: 2,
      cooldownMaxSec: 60,
      enabled: true,
      loopGuardRepeats: 3,
      maxResumes: 8,
    });
  });

  it("overrides per field and rejects invalid values back to defaults", () => {
    const config = resolveAutoResumeConfig({
      cooldownBaseSec: Number.NaN,
      enabled: false,
      loopGuardRepeats: 0,
      maxResumes: 3,
    });
    assert.equal(config.enabled, false);
    assert.equal(config.maxResumes, 3);
    assert.equal(config.cooldownBaseSec, 10);
    assert.equal(config.loopGuardRepeats, 3);
  });

  it("trims continueMessage and drops blank", () => {
    assert.equal(resolveAutoResumeConfig({ continueMessage: "  go  " }).continueMessage, "go");
    assert.equal(resolveAutoResumeConfig({ continueMessage: "   " }).continueMessage, undefined);
  });
});
