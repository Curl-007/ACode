// Overnight（K3）完成信号的 bootstrap 发射测试（specs/overnight-completion-notify.md §7）。
//
// 被测事实分两层，都用真实生产代码：
//   ① 纯投影 toOvernightCompletionSignal（从真实 overnight-controller.ts 导入）：
//      outcome 三态来自 status × cancelled；morningReportReady 来自 manifest.morningReportPostedAtMs；
//      parentTaskId 取可见发起会话（非 coordinator id）。
//   ② 发射接线的「一 run 一信号」语义：用真实 startOvernightRun（controller.start 内部调的同一函数）
//      驱动到三种终态，按 controller 的 `handle.completion.then(emit(mapper(result)))` 同款接线
//      断言——每个 run 恰发一条，且 outcome/morningReportReady 与真实 manifest 一致，
//      即使 onEvent 期间收到多条事件也不重复发射（发射点在 completion promise，非事件回调）。
//
// 说明（诚实登记）：controller.start() 的 fork 分支内部构造真实 createScriptWorkflowAgentRuntime
// （@acode/cli-workflow），本 Node 版本无 mock.module，故不直接驱动 controller 的 fork 到终态；
// 发射逻辑的 payload 正确性由 ① 覆盖，completion-once 语义由 ② 覆盖（② 用的正是 controller 发射点
// 依赖的同一 handle.completion + 同一 mapper）。house style：FakeClock + fake deps，无真实 IO。
import assert from "node:assert/strict";
import test from "node:test";

const { toOvernightCompletionSignal } = await import(
  "../packages/bootstrap/src/app/overnight-controller.ts"
);
const { createOvernightManifest } = await import("../packages/core/src/overnight/manifest.ts");
const { startOvernightRun } = await import("../packages/core/src/overnight/runner.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

const flush = () => new Promise((resolve) => setImmediate(resolve));

// 时钟桩：now/sleep/schedule 三面共用虚拟时间轴（同 overnight-execution.test.mjs 的 FakeClock）。
class FakeClock {
  constructor(startMs) {
    this.nowMs = startMs;
    this.timers = [];
  }
  now() {
    return this.nowMs;
  }
  schedule(callback, delayMs) {
    const timer = { at: this.nowMs + Math.max(0, delayMs), callback, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  sleep(ms) {
    return new Promise((resolve) => this.schedule(resolve, ms));
  }
  nextDue(target) {
    let earliest = null;
    for (const timer of this.timers) {
      if (timer.cancelled || timer.at > target) continue;
      if (earliest === null || timer.at < earliest.at) earliest = timer;
    }
    return earliest;
  }
  async advance(ms) {
    const target = this.nowMs + ms;
    let guard = 0;
    for (;;) {
      await flush();
      const due = this.nextDue(target);
      if (!due) {
        if (this.nowMs < target) {
          this.nowMs = target;
          continue;
        }
        break;
      }
      if (due.at > this.nowMs) this.nowMs = due.at;
      due.cancelled = true;
      due.callback();
      if (++guard > 200_000) throw new Error("FakeClock 疑似死循环");
    }
  }
}

/** 构造一个 OvernightRunResult（mapper 的直接输入），manifest 用真实工厂建。 */
function makeResult(overrides = {}) {
  const manifest = createOvernightManifest({
    runId: overrides.runId ?? "run-m1",
    parentTaskId: overrides.parentTaskId ?? "sess-visible-parent",
    startedAtMs: T0,
    durationMs: HOUR,
  });
  return {
    status: overrides.status ?? "completed",
    cancelled: overrides.cancelled ?? false,
    manifest: { ...manifest, ...(overrides.manifestPatch ?? {}) },
  };
}

// ── ① 纯投影 toOvernightCompletionSignal ──────────────────────────────
test("mapper：completed（未取消）→ outcome completed；runId/parentTaskId 取自 manifest", () => {
  const signal = toOvernightCompletionSignal(makeResult({ status: "completed", cancelled: false }));
  assert.equal(signal.outcome, "completed");
  assert.equal(signal.runId, "run-m1");
  // 点击直达目标必须是可见发起会话，绝非 coordinator id。
  assert.equal(signal.parentTaskId, "sess-visible-parent");
});

test("mapper：completed + cancelled → outcome cancelled（取消优先于 completed）", () => {
  const signal = toOvernightCompletionSignal(makeResult({ status: "completed", cancelled: true }));
  assert.equal(signal.outcome, "cancelled");
});

test("mapper：failed → outcome failed（cancelled 为 false）", () => {
  const signal = toOvernightCompletionSignal(makeResult({ status: "failed", cancelled: false }));
  assert.equal(signal.outcome, "failed");
});

test("mapper：failed 即便 cancelled 也为 true 仍报 failed（失败终态优先呈现）", () => {
  // 语义：cancelled 只在 completed 分支下改判为 cancelled；failed 是硬失败终态，
  // 与 Main 侧 outcomeToNotificationStatus（failed→"failed"）一致。
  const signal = toOvernightCompletionSignal(makeResult({ status: "failed", cancelled: true }));
  assert.equal(signal.outcome, "failed");
});

test("mapper：morningReportReady 反映真实 morningReportPostedAtMs（置位/未置位两向）", () => {
  const posted = toOvernightCompletionSignal(
    makeResult({ manifestPatch: { morningReportPostedAtMs: T0 + 66 * MIN } }),
  );
  assert.equal(posted.morningReportReady, true, "文件已确认（标志置位）→ true");

  const missing = toOvernightCompletionSignal(
    makeResult({ manifestPatch: { morningReportPostedAtMs: null } }),
  );
  assert.equal(missing.morningReportReady, false, "文件未确认（标志为 null）→ false");
});

test("mapper：morningReportReady 不接受 truthy 替身——0 时间戳仍视为未置位？（0 是合法 epoch，按已置位）", () => {
  // morningReportPostedAtMs 类型是 number | null；0 是合法 epoch 毫秒（!== null）→ 视为已置位。
  // 这条钉住「判据是 !== null 而非 truthy」，防止有人改成 Boolean(x) 把 0 误判为未就绪。
  const zero = toOvernightCompletionSignal(
    makeResult({ manifestPatch: { morningReportPostedAtMs: 0 } }),
  );
  assert.equal(zero.morningReportReady, true, "0 是合法时间戳，!== null → true");
});

// ── ② 发射接线：真实 startOvernightRun + controller 同款 completion.then(emit) ──

/**
 * 用真实 runner 驱动到终态，按 controller 的发射接线（completion.then → mapper → emit）收集信号。
 * 同时记录 onEvent 收到的事件，用于断言「多条事件 ≠ 多条信号」（发射点在 completion，非事件回调）。
 */
async function driveRunAndCollectEmissions({ cancelled, failed, morningReportExists }) {
  const clock = new FakeClock(T0);
  const registry = new InMemoryRuntimeTaskRegistry();
  const emitted = [];
  const events = [];
  let turnCalls = 0;

  const parentMessages = [
    {
      info: { id: "msg-1", role: "user", time: { created: T0 - 5 * MIN } },
      parts: [{ id: "p1", type: "text", text: "父会话消息" }],
    },
  ];

  const handle = await startOvernightRun({
    parentTaskId: "sess-visible-parent",
    durationMs: HOUR,
    coordinator: {
      async forkCoordinatorTask(request) {
        return {
          taskId: `coordinator-${request.runId}`,
          runCoordinatorTurn: async () => {
            turnCalls += 1;
            if (failed) return { ok: false, error: "model unavailable" };
            return { ok: true };
          },
        };
      },
    },
    getParentFacts: async () => ({
      parentMessages,
      parentSession: { id: "sess-visible-parent", taskType: "interactive" },
      modelSelection: undefined,
    }),
    writePreflightReport: async () => {},
    preflightCollectors: {
      collectMemory: () => ({ rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1 }),
      collectGitStatus: async () => ({ branch: "main", dirty: false }),
    },
    morningReportExists: async () => morningReportExists,
    taskRegistry: registry,
    collectMemorySample: () => 1,
    now: () => clock.now(),
    onEvent: (event) => events.push(event),
    sleep: (ms) => clock.sleep(ms),
    schedule: (cb, delay) => clock.schedule(cb, delay),
  });

  // controller 的发射接线（overnight-controller.ts start() 内）：completion 每 run 恰 resolve 一次，
  // 在此把 OvernightRunResult 经 mapper 投影后发射。这里逐字复刻那段 .then(emit)。
  handle.completion.then((result) => {
    emitted.push(toOvernightCompletionSignal(result));
  });

  // 推进时钟到终态。取消经 handle.requestCancel()（runner 级取消的真实入口——runner.ts:187
  // 把 supervisor 的 cancelRequested 绑到内部 cancelRequestedFlag，只有 requestCancel/dispose 写它，
  // 故不能靠注入 cancelRequested dep 触发；这正是 /overnight cancel 走的路径）。
  if (failed) {
    await clock.advance(10 * MIN); // 连续 3 次失败熔断
  } else if (cancelled) {
    handle.requestCancel();
    await clock.advance(5 * MIN); // 协作式取消：当前 turn 收尾后终态
  } else {
    // completed：需跨过 target（1h）+ post-wake 宽限（2h，manifest.postWakeGraceUntilMs）后
    // finalWrapup 才发出，再下一轮才落 completed 终态。推进到宽限尽之后（对齐场景 2 的推进量）。
    await clock.advance(3 * HOUR + 15 * MIN);
  }
  await handle.completion; // 等终态落定
  await flush();
  await flush();

  return { emitted, events, handle };
}

test("发射：failed run → 恰一条信号，outcome failed", async () => {
  const { emitted, events } = await driveRunAndCollectEmissions({ failed: true });
  assert.equal(emitted.length, 1, "一个 run 恰发一条完成信号");
  assert.equal(emitted[0].outcome, "failed");
  assert.equal(emitted[0].parentTaskId, "sess-visible-parent");
  // 负向对照：事件回调收到多条（turn_failed 等），但发射只在 completion 发生一次。
  assert.ok(
    events.length > 1,
    `onEvent 应收到多条事件（实际 ${events.length}），证明「多事件 ≠ 多信号」`,
  );
});

test("发射：cancelled run → 恰一条信号，outcome cancelled", async () => {
  const { emitted } = await driveRunAndCollectEmissions({ cancelled: true });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].outcome, "cancelled");
});

test("发射：completed run → 恰一条信号，outcome completed，morningReportReady 反映真实文件探测", async () => {
  // 晨报文件存在：supervisor 会在晨报相位确认后写 morningReportPostedAtMs，信号应为 true。
  const withReport = await driveRunAndCollectEmissions({ morningReportExists: true });
  assert.equal(withReport.emitted.length, 1);
  assert.equal(withReport.emitted[0].outcome, "completed");
  assert.equal(
    withReport.emitted[0].morningReportReady,
    true,
    "晨报文件存在 → morningReportReady true（来自 manifest 权威标志）",
  );
});

test("发射：completed run 但晨报文件始终缺席 → morningReportReady false（不猜测、不硬编码 true）", async () => {
  const noReport = await driveRunAndCollectEmissions({ morningReportExists: false });
  assert.equal(noReport.emitted.length, 1);
  assert.equal(noReport.emitted[0].outcome, "completed");
  assert.equal(
    noReport.emitted[0].morningReportReady,
    false,
    "晨报文件未确认 → morningReportReady false（fail-safe 方向，R5）",
  );
});
