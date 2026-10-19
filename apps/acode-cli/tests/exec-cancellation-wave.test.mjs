import assert from "node:assert/strict";
import { test } from "node:test";

// specs/fs-hotpath-mechanisms.md R4：取消波次（桩进程树）与输出有界队列。
// 波次：wave1 优雅终止立即触发 → 宽限（POSIX 2s / Windows 5s）→ wave2 强制。
// 结构化取消三因：timeout / user / output_limit。

const {
  startCancellationWave,
  cancellationGraceMs,
  cancellationCauseFromStopReason,
  CANCEL_WAVE_GRACE_MS,
  CANCEL_WAVE_GRACE_MS_WINDOWS,
} = await import("../packages/adapters/src/exec/cancellation-wave.ts");
const { createBoundedOutputPump, OUTPUT_PUMP_MAX_QUEUE } = await import(
  "../packages/adapters/src/exec/output-pump.ts"
);

/** 虚拟时钟：scheduleTimer 注入用（带累计时间）。 */
function virtualClock() {
  const pending = new Map();
  let nextId = 1;
  let nowMs = 0;
  return {
    schedule: (callback, ms) => {
      const id = nextId++;
      pending.set(id, { callback, at: nowMs + ms });
      return { cancel: () => pending.delete(id) };
    },
    advance: async (ms) => {
      nowMs += ms;
      // 按调度序触发已到期回调（测试用例只排一个波次定时器）。
      for (const [id, timer] of [...pending]) {
        if (timer.at <= nowMs) {
          pending.delete(id);
          timer.callback();
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    },
    size: () => pending.size,
  };
}

function stubTree() {
  const calls = [];
  return {
    calls,
    deps: {
      gracefulStop: async () => calls.push("graceful"),
      forceStop: async () => calls.push("force"),
    },
  };
}

test("cancellation wave: graceful first, force after grace, completion resolves after force", async () => {
  const clock = virtualClock();
  const tree = stubTree();
  const wave = startCancellationWave(
    { ...tree.deps, scheduleTimer: clock.schedule },
    { cause: "timeout", graceMs: 2_000 },
  );
  assert.equal(wave.cause, "timeout");
  assert.deepEqual(tree.calls, ["graceful"], "wave1 必须立即触发");

  let completed = false;
  void wave.completion.then(() => {
    completed = true;
  });
  await clock.advance(1_999);
  assert.deepEqual(tree.calls, ["graceful"], "宽限期内不得强制");
  assert.equal(completed, false);

  await clock.advance(1);
  assert.deepEqual(tree.calls, ["graceful", "force"], "宽限到期必须 wave2 强制");
  await wave.completion;
  assert.equal(completed, true);
});

test("cancellation wave: dispose cancels pending force and resolves completion", async () => {
  const clock = virtualClock();
  const tree = stubTree();
  const wave = startCancellationWave(
    { ...tree.deps, scheduleTimer: clock.schedule },
    { cause: "user", graceMs: 5_000 },
  );
  wave.dispose();
  await wave.completion;
  await clock.advance(10_000);
  assert.deepEqual(tree.calls, ["graceful"], "自然退出后不得再强制杀树");
});

test("cancellation wave: forceStop failure still resolves completion", async () => {
  const clock = virtualClock();
  const wave = startCancellationWave(
    {
      gracefulStop: async () => undefined,
      forceStop: async () => {
        throw new Error("taskkill failed");
      },
      scheduleTimer: clock.schedule,
    },
    { cause: "output_limit", graceMs: 10 },
  );
  await clock.advance(20);
  await wave.completion;
});

test("cancellation wave: grace constants and cause mapping match the omp contract", () => {
  assert.equal(CANCEL_WAVE_GRACE_MS, 2_000);
  assert.equal(CANCEL_WAVE_GRACE_MS_WINDOWS, 5_000);
  assert.equal(cancellationGraceMs("linux"), 2_000);
  assert.equal(cancellationGraceMs("darwin"), 2_000);
  assert.equal(cancellationGraceMs("win32"), 5_000);

  // StopReason → 三因映射：Timeout / User / OutputLimit。
  assert.equal(cancellationCauseFromStopReason("timeout"), "timeout");
  assert.equal(cancellationCauseFromStopReason("cancelled"), "user");
  assert.equal(cancellationCauseFromStopReason("output_limit"), "output_limit");
});

test("output pump: coalesces when queue is full without losing text, flushes in batches", async () => {
  const flushed = [];
  const pump = createBoundedOutputPump({
    flush: (items) => flushed.push(...items),
    decode: (buffer) => buffer.toString("utf8"),
  });

  // 64 之内逐条入队（合并为一次批量 flush）。
  for (let index = 0; index < OUTPUT_PUMP_MAX_QUEUE + 10; index += 1) {
    pump.append("stdout", Buffer.from(`c${index};`));
  }
  assert.equal(pump.debugQueueLength(), OUTPUT_PUMP_MAX_QUEUE, "队列不得超出上限");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pump.debugQueueLength(), 0, "微任务批量派发必须清空队列");

  const text = flushed.map((item) => item.text).join("");
  const expected = Array.from({ length: OUTPUT_PUMP_MAX_QUEUE + 10 }, (_, index) => `c${index};`).join("");
  assert.equal(text, expected, "coalesce 不丢文本");
  assert.ok(flushed.every((item) => item.stream === "stdout"));
});

test("output pump: flushSync drains immediately and interleaves stream order", async () => {
  const flushed = [];
  const pump = createBoundedOutputPump({
    flush: (items) => flushed.push(...items),
    decode: (buffer) => buffer.toString("utf8"),
  });
  pump.append("stdout", Buffer.from("out1"));
  pump.append("stderr", Buffer.from("err1"));
  pump.flushSync();
  assert.deepEqual(
    flushed.map((item) => `${item.stream}:${item.text}`),
    ["stdout:out1", "stderr:err1"],
    "flushSync 立即按序派发",
  );
  assert.equal(pump.debugQueueLength(), 0);
  pump.flushSync();
  assert.equal(flushed.length, 2, "空队列 flushSync 不重复派发");
});
