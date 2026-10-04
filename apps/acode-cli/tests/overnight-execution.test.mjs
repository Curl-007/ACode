import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * K3「Overnight 挂机执行」测试（第一段纯模块层 + 第二段接线层）。
 *
 * 规格 apps/acode-cli/specs/overnight-execution.md 的验收场景覆盖：
 *   场景 1 时长解析（全形态 + 边界含 12h 整与 13h 拒绝）
 *   场景 2 五相位转移序列纯函数 + duration<2h 时 lead 收缩为 duration/4
 *   场景 3 poke 一次性（跨 handoff-ready 多 tick 恰发一次）+ 晨报文件确认语义（R5 收紧）
 *   场景 4 取消协作式（当前 turn 完整收尾后 completed+cancelled，无 mid-turn kill）
 *   场景 5 monitored 子集（30min 长运行 warn 节奏 + 5min 资源采样节奏 + 落定后无残留 ticker）
 *   场景 6 连续 3 次 turn 失败熔断
 *   场景 7 fork 语义（mock 任务服务断言 create 参数含父 messages 投影与 provider 配置）
 *   场景 8 运营契约在场（首条 prompt 快照含禁止清单与卡片优先声明 + preflight 注入）
 *   场景 9 重启语义（实例销毁 + 时钟推进断言零后续 turn，无自动重启）
 *   场景 10 off-peak/cron/automation 域零命中（源码断言）
 *   入口面：/overnight 结构化动作解析（宿主命令不展开为 prompt 文本）
 *
 * 机制参照 jcode (MIT) crates/jcode-app-core/src/overnight.rs 的时间闸语义，
 * 测试用例为自撰；全部经 FakeClock + fake deps 驱动，无真实 IO（场景 10 只读源码文件）。
 */

const { OVERNIGHT_MIN_MS, OVERNIGHT_MAX_MS, SUPERVISOR_TICK_MS, handoffLeadMs } = await import(
  "../packages/core/src/overnight/constants.ts"
);
const { createOvernightManifest, computeOvernightPhase, selectOvernightPoke, nextPhasePointMs } = await import(
  "../packages/core/src/overnight/manifest.ts"
);
const {
  buildInitialCoordinatorPrompt,
  renderOvernightPokePrompt,
  TASK_CARD_FRONTMATTER_FIELDS,
} = await import("../packages/core/src/overnight/prompts.ts");
const { parseOvernightDuration } = await import("../packages/core/src/overnight/duration.ts");
const { createOvernightSupervisor } = await import("../packages/core/src/overnight/supervisor.ts");
const { startOvernightRun } = await import("../packages/core/src/overnight/runner.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { resolveACodeBuiltinHostCommand } = await import(
  "../packages/bootstrap/src/builtin-prompt-command.ts"
);
const { readFile } = await import("node:fs/promises");

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 时钟桩：now/sleep/schedule 三面共用同一虚拟时间轴。
 * advance() 按到期顺序逐个触发 timer，每个 timer 触发后冲一次宏任务边界，
 * 让 supervisor 的微任务链（turn → 文件探测 → 下一次 sleep 调度）先落地再扫下一轮。
 */
class FakeClock {
  constructor(startMs) {
    this.nowMs = startMs;
    this.timers = [];
    this.sleepDelays = [];
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
    this.sleepDelays.push(ms);
    return new Promise((resolve) => {
      this.schedule(resolve, ms);
    });
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
      if (++guard > 200_000) throw new Error("FakeClock 疑似死循环（timer 链未收敛）");
    }
  }
}

function makeDeps(clock, overrides = {}) {
  return {
    manifest: createOvernightManifest({
      runId: "run-test",
      parentTaskId: "task-parent",
      startedAtMs: T0,
      durationMs: HOUR,
    }),
    runCoordinatorTurn: async () => ({ ok: true }),
    morningReportExists: async () => false,
    cancelRequested: () => false,
    now: () => clock.now(),
    onEvent: () => {},
    sleep: (ms) => clock.sleep(ms),
    schedule: (cb, delay) => clock.schedule(cb, delay),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 场景 1：时长解析
// ---------------------------------------------------------------------------

test("场景 1：时长解析全形态与边界（12h 整合法、13h 拒绝）", () => {
  assert.equal(OVERNIGHT_MIN_MS, 60_000);
  assert.equal(OVERNIGHT_MAX_MS, 12 * HOUR);
  assert.equal(SUPERVISOR_TICK_MS, 60_000);

  const okCase = (input, expectedMs) => {
    const result = parseOvernightDuration(input);
    assert.ok(result.ok, `${input} 应合法，实际错误：${result.ok ? "" : result.error}`);
    assert.equal(result.durationMs, expectedMs, input);
  };
  const badCase = (input) => {
    const result = parseOvernightDuration(input);
    assert.ok(!result.ok, `${input} 应非法`);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0, `${input} 的错误信息非空`);
    return result.error;
  };

  okCase("8h", 8 * HOUR);
  okCase("45m", 45 * MIN);
  okCase("90s", 90_000);
  okCase("8H", 8 * HOUR);
  // 组合形态：紧连 / 空白分隔 / 三单位
  okCase("1h30m", 90 * MIN);
  okCase("1h 30m", 90 * MIN);
  okCase("2h15m30s", 2 * HOUR + 15 * MIN + 30_000);
  // 边界：下限 1 分钟、上限 12 小时（整值合法）
  okCase("60s", MIN);
  okCase("12h", 12 * HOUR);

  const tooLong = badCase("13h");
  assert.match(tooLong, /12 小时/);
  badCase("12h1s");
  const tooShort = badCase("59s");
  assert.match(tooShort, /1 分钟/);
  badCase("0");
  badCase("0s");
  badCase("-5m");
  badCase("abc");
  badCase("30");
  badCase("1h3");
  badCase("");
  badCase("   ");
});

// ---------------------------------------------------------------------------
// 场景 2：相位纯函数
// ---------------------------------------------------------------------------

test("场景 2：五相位转移序列纯函数钉住 + 短 run 的 lead 收缩", () => {
  // 8h run：lead = min(30min, 2h) = 30min
  const m = createOvernightManifest({
    runId: "r2",
    parentTaskId: "p",
    startedAtMs: T0,
    durationMs: 8 * HOUR,
  });
  assert.equal(m.handoffReadyAtMs, T0 + 8 * HOUR - 30 * MIN);
  assert.equal(m.targetWakeAtMs, T0 + 8 * HOUR);
  assert.equal(m.postWakeGraceUntilMs, T0 + 10 * HOUR);

  // running → wind-down：边界值本身触发（>= handoffReadyAtMs）
  assert.equal(computeOvernightPhase(m, T0), "running");
  assert.equal(computeOvernightPhase(m, T0 + 7 * HOUR), "running");
  assert.equal(computeOvernightPhase(m, T0 + 7 * HOUR + 30 * MIN), "wind-down");
  assert.equal(computeOvernightPhase(m, T0 + 8 * HOUR - 1), "wind-down");
  // wind-down → morning-report：到点且未发晨报（边界值触发）
  assert.equal(computeOvernightPhase(m, T0 + 8 * HOUR), "morning-report");
  // morning-report → post-wake：晨报文件确认（R5：以文件为准，而非发过 prompt）
  const posted = { ...m, morningReportPostedAtMs: T0 + 8 * HOUR + 5 * MIN, pokes: { ...m.pokes, morningReport: true } };
  assert.equal(computeOvernightPhase(posted, T0 + 8 * HOUR + 5 * MIN), "post-wake");
  assert.equal(computeOvernightPhase(posted, T0 + 10 * HOUR - 1), "post-wake");
  // post-wake → finalizing：宽限尽（边界值触发）
  assert.equal(computeOvernightPhase(posted, T0 + 10 * HOUR), "finalizing");
  // 墙钟跳进（app 睡眠醒来）：未发晨报但睡过宽限 → 直接 finalizing（R2 认定为正确行为）
  assert.equal(computeOvernightPhase(m, T0 + 10 * HOUR), "finalizing");

  // duration < 2h：lead 收缩为 duration/4（1h → 15min；2h 恰好回到 30min 帽）
  assert.equal(handoffLeadMs(HOUR), 15 * MIN);
  assert.equal(handoffLeadMs(2 * HOUR), 30 * MIN);
  assert.equal(handoffLeadMs(8 * HOUR), 30 * MIN);
  const short = createOvernightManifest({
    runId: "r2s",
    parentTaskId: "p",
    startedAtMs: T0,
    durationMs: HOUR,
  });
  assert.equal(short.handoffReadyAtMs, T0 + 45 * MIN);
  assert.equal(short.postWakeGraceUntilMs, T0 + 3 * HOUR);

  // poke 选择沿时间轴的对应关系（一次性标志置位后回退 continuation）
  assert.equal(selectOvernightPoke(m, T0).kind, "continuation");
  assert.equal(selectOvernightPoke(m, T0 + 7 * HOUR + 30 * MIN).kind, "handoff-ready");
  assert.equal(
    selectOvernightPoke({ ...m, pokes: { ...m.pokes, handoffReady: true } }, T0 + 7 * HOUR + 31 * MIN).kind,
    "continuation",
  );
  const morningPoke = selectOvernightPoke(m, T0 + 8 * HOUR);
  assert.equal(morningPoke.kind, "morning-report");
  assert.equal(morningPoke.resend, false);
  assert.equal(selectOvernightPoke({ ...m, morningReportAttempts: 1 }, T0 + 8 * HOUR + MIN).resend, true);
  assert.equal(selectOvernightPoke(posted, T0 + 8 * HOUR + 6 * MIN).kind, "post-wake-continuation");
  assert.equal(
    selectOvernightPoke({ ...posted, pokes: { ...posted.pokes, postWakeContinuation: true } }, T0 + 8 * HOUR + 7 * MIN)
      .kind,
    "continuation",
  );
  assert.equal(selectOvernightPoke(m, T0 + 10 * HOUR).kind, "final-wrapup");

  // 等待间隔的「下次相位点」：running 期指向 handoff-ready，晨报确认后指向 grace
  assert.equal(nextPhasePointMs(m, T0), T0 + 7 * HOUR + 30 * MIN);
  assert.equal(nextPhasePointMs(posted, T0 + 8 * HOUR + 5 * MIN), T0 + 10 * HOUR);
  assert.equal(nextPhasePointMs(m, T0 + 11 * HOUR), null);
});

// ---------------------------------------------------------------------------
// prompt 模板与首条组装（R3/R5 对齐；对应验收场景 8 的模块层子集）
// ---------------------------------------------------------------------------

test("prompt 模板与首条组装：五种模板互异、运营契约在场、preflight 注入位", () => {
  const runId = "rp";
  const kinds = ["continuation", "handoff-ready", "morning-report", "post-wake-continuation", "final-wrapup"];
  const rendered = kinds.map((kind) => renderOvernightPokePrompt({ kind, resend: false }, { runId }));
  assert.equal(new Set(rendered).size, 5, "五种 poke 模板渲染后互不相同");
  assert.ok(rendered[2].includes(`.acode/overnight/${runId}/morning-report.md`));
  assert.ok(rendered[0].includes(`.acode/overnight/${runId}/cards`));
  // 晨报重发形态 = 前置提醒 + 原模板
  const resend = renderOvernightPokePrompt({ kind: "morning-report", resend: true }, { runId });
  assert.ok(resend.includes("尚未确认存在"));
  assert.ok(resend.endsWith(rendered[2]));

  const first = buildInitialCoordinatorPrompt({
    runId,
    durationMs: 8 * HOUR,
    targetWakeAtMs: T0 + 8 * HOUR,
  });
  // 运营契约禁止清单与「不要等用户 / 卡片先于代码」声明在场
  for (const keyword of [
    "品味类重构",
    "支付",
    "发邮件",
    "推送远端",
    "删除数据",
    "凭据",
    "不要等用户",
    "卡片先于代码",
  ]) {
    assert.ok(first.includes(keyword), `首条 prompt 缺少运营契约关键词：${keyword}`);
  }
  for (const field of TASK_CARD_FRONTMATTER_FIELDS) {
    assert.ok(first.includes(field), `首条 prompt 缺少任务卡片字段：${field}`);
  }
  assert.ok(first.includes("未采集 preflight"), "未传 preflight 时应显式标注缺失");
  const withPreflight = buildInitialCoordinatorPrompt({
    runId,
    durationMs: 8 * HOUR,
    targetWakeAtMs: T0 + 8 * HOUR,
    preflightReport: "RAM 12GB\nos: win32\ngit: dev/0.0.3 dirty",
  });
  assert.ok(withPreflight.includes("RAM 12GB"));
  assert.ok(withPreflight.includes("dev/0.0.3 dirty"));
  assert.ok(!withPreflight.includes("未采集 preflight"));
});

// ---------------------------------------------------------------------------
// 场景 3：poke 一次性 + 晨报文件确认语义（supervisor 全程离线驱动）
// ---------------------------------------------------------------------------

test("场景 3：跨相位多 tick 下 poke 恰发一次；晨报文件不存在不置位、落盘后置位", async () => {
  const clock = new FakeClock(T0);
  const prompts = [];
  const events = [];
  let reportExists = false;
  const deps = makeDeps(clock, {
    // 1h run：handoff 45m，target 60m，grace 180m——一晚压缩进虚拟时钟
    manifest: createOvernightManifest({
      runId: "run-s3",
      parentTaskId: "task-parent",
      startedAtMs: T0,
      durationMs: HOUR,
    }),
    runCoordinatorTurn: async (prompt) => {
      prompts.push(prompt);
      return { ok: true };
    },
    morningReportExists: async () => reportExists,
    onEvent: (event) => events.push(event),
  });
  const supervisor = createOvernightSupervisor(deps);
  const runPromise = supervisor.start();

  const count = (kind, resend = false) =>
    prompts.filter((p) => p === renderOvernightPokePrompt({ kind, resend }, { runId: "run-s3" })).length;

  // 阶段一：跑到 handoff-ready 窗口起点（45m 整触发，边界含）
  await clock.advance(45 * MIN);
  assert.equal(count("handoff-ready"), 1);
  assert.ok(count("continuation") > 40, "running 阶段以常规 continuation 逐轮驱动");
  assert.equal(supervisor.snapshot().status, "running");

  // 阶段二：跨过 target 且晨报文件不存在——首个晨报 poke 发出，但标志不置位
  await clock.advance(20 * MIN); // 时钟到 65m：60m 首发晨报，61-65m 逐轮重发
  const snapMissing = supervisor.snapshot();
  assert.equal(count("morning-report"), 1, "首发形态的晨报 poke 恰一次");
  assert.ok(count("morning-report", true) >= 1, "文件未确认 → 后续轮次带前置提醒重发");
  assert.equal(snapMissing.pokes.morningReport, false, "R5：文件不存在不置位");
  assert.equal(snapMissing.morningReportPostedAtMs, null);
  assert.ok(snapMissing.morningReportAttempts >= 2);

  // 阶段三：晨报文件落盘 → 本轮 turn 后确认置位，相位进 post-wake
  reportExists = true;
  await clock.advance(5 * MIN); // 66m 轮次后的文件探测确认
  const snapPosted = supervisor.snapshot();
  assert.equal(snapPosted.pokes.morningReport, true);
  assert.equal(snapPosted.morningReportPostedAtMs, T0 + 66 * MIN);
  assert.equal(count("morning-report", true) >= 1, true);

  // 阶段四：post-wake 一次性 poke 恰一次，其余为 continuation
  await clock.advance(10 * MIN);
  assert.equal(count("post-wake-continuation"), 1);

  // 阶段五：宽限尽（180m）final-wrapup 恰一次 → 下一轮 completed
  await clock.advance(2 * HOUR + 10 * MIN);
  const result = await runPromise;
  assert.equal(result.status, "completed");
  assert.equal(result.cancelled, false);
  assert.equal(count("final-wrapup"), 1);
  const finalSnap = result.manifest;
  assert.equal(finalSnap.status, "completed");
  assert.equal(finalSnap.pokes.handoffReady, true);
  assert.equal(finalSnap.pokes.postWakeContinuation, true);
  assert.equal(finalSnap.pokes.finalWrapup, true);

  // 相位事件序列：五相位按序各出现一次（相邻去重）
  const phaseSeq = events
    .filter((event) => event.type === "overnight.phase")
    .map((event) => event.phase);
  const deduped = phaseSeq.filter((phase, index) => index === 0 || phase !== phaseSeq[index - 1]);
  assert.deepEqual(deduped, ["running", "wind-down", "morning-report", "post-wake", "finalizing"]);

  // R2 等待间隔不变量：所有循环间 sleep ≤ 60s
  assert.ok(clock.sleepDelays.length > 100, "整晚由逐轮 tick 驱动");
  assert.ok(
    clock.sleepDelays.every((delay) => delay <= SUPERVISOR_TICK_MS),
    `存在超过 60s 的循环等待：${Math.max(...clock.sleepDelays)}`,
  );
  // 晨报确认事件恰一次
  assert.equal(events.filter((event) => event.type === "overnight.morning_report_confirmed").length, 1);
});

// ---------------------------------------------------------------------------
// 场景 4：取消协作式（无 mid-turn kill）
// ---------------------------------------------------------------------------

test("场景 4：取消后当前 turn 完整收尾才终态，completed+cancelled", async () => {
  const clock = new FakeClock(T0);
  let turnCalls = 0;
  let turnFullyFinished = 0;
  let cancelFlag = false;
  const deps = makeDeps(clock, {
    runCoordinatorTurn: async () => {
      turnCalls += 1;
      cancelFlag = true; // turn 进行中收到取消请求
      await flush(); // 模拟 turn 仍在执行
      turnFullyFinished += 1;
      return { ok: true };
    },
    cancelRequested: () => cancelFlag,
  });
  const supervisor = createOvernightSupervisor(deps);
  const runPromise = supervisor.start();
  await clock.advance(5 * MIN);
  const result = await runPromise;

  assert.equal(result.status, "completed");
  assert.equal(result.cancelled, true);
  assert.equal(result.manifest.status, "completed");
  // runCoordinatorTurn 完整调用断言：turn 体内最后一步执行完才终态（无 mid-turn kill）
  assert.equal(turnFullyFinished, 1);
  // 取消生效后不再驱动任何新 turn
  assert.equal(turnCalls, 1);
  assert.equal(clock.sleepDelays.length, 1, "取消在下一轮循环顶即终态，只等待过一次");
});

// ---------------------------------------------------------------------------
// 场景 5 子集：monitored turn 双 ticker 节奏
// ---------------------------------------------------------------------------

test("场景 5（模块层子集）：30min 长运行 warn 每 30min 一次、5min 采样、落定后无残留 ticker", async () => {
  const clock = new FakeClock(T0);
  const events = [];
  const samples = [];
  let resolveTurn;
  const gatedTurn = new Promise((resolve) => {
    resolveTurn = resolve;
  });
  const deps = makeDeps(clock, {
    manifest: createOvernightManifest({
      runId: "run-s5",
      parentTaskId: "task-parent",
      startedAtMs: T0,
      durationMs: 8 * HOUR,
    }),
    runCoordinatorTurn: () => gatedTurn, // 第一轮 turn 一直挂起（长任务）
    onEvent: (event) => events.push(event),
    sampleResource: (atMs) => samples.push(atMs),
  });
  const supervisor = createOvernightSupervisor(deps);
  const runPromise = supervisor.start();

  // 35min：warn 恰一次（30min 处），采样 7 次（5/10/15/20/25/30/35min）
  await clock.advance(35 * MIN);
  assert.equal(events.filter((event) => event.type === "overnight.turn_long_running").length, 1);
  assert.equal(samples.length, 7);
  assert.deepEqual(samples, [5, 10, 15, 20, 25, 30, 35].map((m) => T0 + m * MIN));

  // 到 60min：第二次 warn（每 30min 一次），采样到 12 次
  await clock.advance(25 * MIN);
  const longRuns = events.filter((event) => event.type === "overnight.turn_long_running");
  assert.equal(longRuns.length, 2);
  assert.equal(longRuns[0].level, "warn");
  assert.equal(longRuns[0].elapsedMs, 30 * MIN);
  assert.equal(longRuns[1].elapsedMs, 60 * MIN);
  assert.equal(samples.length, 12);

  // turn 落定：ticker 全部取消，后续快速 turn 不再产生 warn/采样
  resolveTurn({ ok: true });
  await clock.advance(40 * MIN);
  assert.equal(events.filter((event) => event.type === "overnight.turn_long_running").length, 2);
  assert.equal(samples.length, 12);

  // 收尾：取消路径结束本 run，验证 supervisor 仍可正常终态
  deps.cancelRequested = () => true;
  await clock.advance(2 * MIN);
  const result = await runPromise;
  assert.equal(result.status, "completed");
  assert.equal(result.cancelled, true);
});

// ---------------------------------------------------------------------------
// 场景 6：连续失败熔断
// ---------------------------------------------------------------------------

test("场景 6：coordinator turn 连续 3 次失败 → failed，停发后续 poke", async () => {
  const clock = new FakeClock(T0);
  const prompts = [];
  let calls = 0;
  const deps = makeDeps(clock, {
    runCoordinatorTurn: async (prompt) => {
      calls += 1;
      prompts.push(prompt);
      return { ok: false, error: "model unavailable" };
    },
  });
  const supervisor = createOvernightSupervisor(deps);
  const runPromise = supervisor.start();
  await clock.advance(10 * MIN);
  const result = await runPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.cancelled, false);
  assert.equal(result.manifest.status, "failed");
  assert.equal(calls, 3, "第 3 次连续失败即熔断");
  assert.equal(
    supervisor.snapshot().pokes.handoffReady,
    false,
    "失败路径不产生任何一次性 poke 置位（首轮即失败）",
  );

  // 熔断后时钟继续推进也不再发 poke（无残留循环）
  await clock.advance(30 * MIN);
  assert.equal(calls, 3);
  assert.equal(prompts.length, 3);
});

// ---------------------------------------------------------------------------
// 补充：turn 抛错（reject）同样计入熔断，而不是让 supervisor 崩溃
// ---------------------------------------------------------------------------

test("补充：turn 抛错折算为失败计数，3 次后 failed 且 start() 正常 resolve", async () => {
  const clock = new FakeClock(T0);
  let calls = 0;
  const deps = makeDeps(clock, {
    runCoordinatorTurn: async () => {
      calls += 1;
      throw new Error("coordinator crashed");
    },
  });
  const supervisor = createOvernightSupervisor(deps);
  const runPromise = supervisor.start();
  await clock.advance(5 * MIN);
  const result = await runPromise;
  assert.equal(result.status, "failed");
  assert.equal(calls, 3);
});

// ---------------------------------------------------------------------------
// 第二段（接线层）共用 harness：runner + mock 任务服务 + FakeClock + registry
// ---------------------------------------------------------------------------

/**
 * mock 任务服务形态的 runner 装配：coordinator fork 与 turn 驱动全部记账，
 * preflight 写盘落内存数组，runtime-task 用真实 InMemoryRuntimeTaskRegistry
 * （投影语义本身是被测对象，不用桩替身）。
 */
function makeRunnerHarness(overrides = {}) {
  const clock = new FakeClock(T0);
  const registry = new InMemoryRuntimeTaskRegistry();
  const forkRequests = [];
  const turnPrompts = [];
  const writtenPreflight = [];
  const harness = { clock, registry, forkRequests, turnPrompts, writtenPreflight };
  let reportExists = false;
  let cardCount = 0;
  const parentMessages = [
    {
      info: { id: "msg-1", role: "user", time: { created: T0 - 10 * MIN } },
      parts: [{ id: "part-1", type: "text", text: "修复登录超时问题，先复现再修" }],
    },
    {
      info: { id: "msg-2", role: "assistant", time: { created: T0 - 9 * MIN } },
      parts: [{ id: "part-2", type: "text", text: "已定位到重试逻辑的缺陷" }],
    },
    {
      info: { id: "msg-3", role: "user", time: { created: T0 - 5 * MIN } },
      parts: [{ id: "part-3", type: "text", text: "继续，注意回归测试" }],
    },
  ];
  const deps = {
    parentTaskId: "sess-parent",
    durationMs: HOUR,
    coordinator: {
      async forkCoordinatorTask(request) {
        forkRequests.push(request);
        return {
          taskId: `task-${request.runId}`,
          runCoordinatorTurn: async (prompt) => {
            turnPrompts.push(prompt);
            return { ok: true };
          },
        };
      },
    },
    getParentFacts: async () => ({
      parentMessages,
      parentSession: { id: "sess-parent", taskType: "interactive" },
      modelSelection: { providerId: "zai-coding-plan", modelId: "glm-4.7" },
    }),
    writePreflightReport: async (path, content) => {
      writtenPreflight.push({ path, content });
    },
    preflightCollectors: {
      collectMemory: () => ({
        rssBytes: 512 * 1024 * 1024,
        heapUsedBytes: 128 * 1024 * 1024,
        heapTotalBytes: 256 * 1024 * 1024,
        externalBytes: 8 * 1024 * 1024,
      }),
      collectGitStatus: async () => ({ branch: "dev/0.0.3", dirty: true }),
    },
    morningReportExists: async () => reportExists,
    taskRegistry: registry,
    countTaskCards: async () => cardCount,
    collectMemorySample: () => 512 * 1024 * 1024,
    now: () => clock.now(),
    onEvent: () => {},
    sleep: (ms) => clock.sleep(ms),
    schedule: (cb, delay) => clock.schedule(cb, delay),
    ...overrides,
  };
  harness.deps = deps;
  harness.setReportExists = (value) => {
    reportExists = value;
  };
  harness.setCardCount = (value) => {
    cardCount = value;
  };
  return harness;
}

// ---------------------------------------------------------------------------
// 入口面：/overnight 结构化动作解析（宿主命令不展开为 prompt）
// ---------------------------------------------------------------------------

test("入口面：resolveACodeBuiltinHostCommand 解析启动/取消/非法三态，其余输入放行", () => {
  const start = resolveACodeBuiltinHostCommand("/overnight 8h");
  assert.deepEqual(start, { kind: "overnight-start", durationMs: 8 * HOUR });
  assert.deepEqual(resolveACodeBuiltinHostCommand("/OVERNIGHT 1h30m"), {
    kind: "overnight-start",
    durationMs: 90 * MIN,
  });
  assert.deepEqual(resolveACodeBuiltinHostCommand("/overnight cancel"), { kind: "overnight-cancel" });
  const invalid = resolveACodeBuiltinHostCommand("/overnight 13h");
  assert.equal(invalid.kind, "overnight-invalid");
  assert.match(invalid.error, /12 小时/);
  const missing = resolveACodeBuiltinHostCommand("/overnight");
  assert.equal(missing.kind, "overnight-invalid");
  assert.match(missing.error, /用法/);
  // 非宿主命令一律放行（普通 prompt、其他内置命令、自定义命令）
  assert.equal(resolveACodeBuiltinHostCommand("继续当前工作"), undefined);
  assert.equal(resolveACodeBuiltinHostCommand("/init"), undefined);
  assert.equal(resolveACodeBuiltinHostCommand("/workflow xxx"), undefined);
  assert.equal(resolveACodeBuiltinHostCommand(""), undefined);
});

// ---------------------------------------------------------------------------
// 场景 7：fork 语义（mock 任务服务断言 create 参数）
// ---------------------------------------------------------------------------

test("场景 7：coordinator fork 携带父 messages 投影与 provider 配置；runtime-task 投影注册", async () => {
  const harness = makeRunnerHarness();
  const handle = await startOvernightRun(harness.deps);
  await harness.clock.advance(2 * MIN);

  // create 参数断言：唯一一次 fork，父任务身份、隐藏位、投影与选型齐全
  assert.equal(harness.forkRequests.length, 1);
  const request = harness.forkRequests[0];
  assert.equal(request.parentTaskId, "sess-parent");
  assert.equal(request.hidden, true);
  assert.equal(request.targetMessageId, "msg-3", "fork 落点 = 父 active 分支最后一条消息");
  assert.deepEqual(
    request.inheritedMessages.map((message) => ({ id: message.messageId, role: message.role })),
    [
      { id: "msg-1", role: "user" },
      { id: "msg-2", role: "assistant" },
      { id: "msg-3", role: "user" },
    ],
  );
  assert.ok(request.inheritedMessages[0].textPreview.includes("修复登录超时"));
  assert.deepEqual(request.inheritedModelSelection, {
    providerId: "zai-coding-plan",
    modelId: "glm-4.7",
  });
  assert.ok(typeof request.initialPrompt === "string" && request.initialPrompt.length > 0);

  // preflight 工件：路径与内容（进程内存 + git 分支/脏状态）
  assert.equal(harness.writtenPreflight.length, 1);
  assert.equal(harness.writtenPreflight[0].path, `.acode/overnight/${handle.runId}/preflight.md`);
  assert.match(harness.writtenPreflight[0].content, /dev\/0.0.3/);
  assert.match(harness.writtenPreflight[0].content, /dirty: yes/);
  assert.match(harness.writtenPreflight[0].content, /rss:/);

  // runtime-task 投影：type=overnight、running、运行面摘要初值
  const snapshot = harness.registry.get(handle.taskId);
  assert.ok(snapshot, "run 以 taskId 注册进 runtime-task registry");
  assert.equal(snapshot.type, "overnight");
  assert.equal(snapshot.taskType, "overnight");
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.isBackgrounded, true);
  assert.equal(snapshot.overnight.runId, handle.runId);
  assert.equal(snapshot.overnight.phase, "running");

  // 相位推进刷新投影；卡片计数随 poke 事件刷新
  harness.setCardCount(2);
  await harness.clock.advance(43 * MIN); // 至 45m：handoff-ready 边界
  const windDown = harness.registry.get(handle.taskId);
  assert.equal(windDown.overnight.phase, "wind-down");
  assert.equal(windDown.overnight.cardCount, 2);

  // 收尾：dispose 后终态
  handle.dispose();
  await harness.clock.advance(2 * MIN);
  const terminal = harness.registry.get(handle.taskId);
  assert.equal(terminal.status, "cancelled");
});

// ---------------------------------------------------------------------------
// 场景 8：运营契约在场（首条 prompt 快照）
// ---------------------------------------------------------------------------

test("场景 8：首条 turn 输入含运营契约禁止清单、卡片优先声明与 preflight 注入", async () => {
  const harness = makeRunnerHarness();
  const handle = await startOvernightRun(harness.deps);
  await harness.clock.advance(3 * MIN);

  assert.ok(harness.turnPrompts.length >= 2, "至少完成首轮与后续一轮");
  const first = harness.turnPrompts[0];
  for (const keyword of [
    "coordinator",
    "品味类重构",
    "支付",
    "发邮件",
    "推送远端",
    "删除数据",
    "凭据",
    "不要等用户",
    "卡片先于代码",
  ]) {
    assert.ok(first.includes(keyword), `首条 prompt 缺少关键词：${keyword}`);
  }
  // preflight 注入位：分支与脏状态进入首条 prompt（buildInitialCoordinatorPrompt 的 <preflight> 块）
  assert.ok(first.includes("<preflight>"));
  assert.ok(first.includes("dev/0.0.3"));
  assert.ok(first.includes("dirty: yes"));
  assert.ok(first.includes(`.acode/overnight/${handle.runId}/cards`));

  // 后续轮只发 poke 指令：不含 preflight 块、与首条不同
  const second = harness.turnPrompts[1];
  assert.notEqual(second, first);
  assert.ok(!second.includes("<preflight>"), "preflight 只在首条注入");
  handle.dispose();
  await harness.clock.advance(MIN);
});

// ---------------------------------------------------------------------------
// 场景 9：重启语义（实例销毁 + 时钟推进断言零后续 turn）
// ---------------------------------------------------------------------------

test("场景 9：run 实例销毁后零后续 turn、无自动重启，runtime-task 终态", async () => {
  const harness = makeRunnerHarness();
  const handle = await startOvernightRun(harness.deps);
  await harness.clock.advance(5 * MIN);
  const turnsAtDestroy = harness.turnPrompts.length;
  assert.ok(turnsAtDestroy >= 5, "销毁前已驱动多轮 turn");

  // 模拟进程重启（R1：生命周期绑定 app 运行期）——宿主关闭面销毁实例
  handle.dispose();
  await harness.clock.advance(3 * HOUR);

  assert.equal(
    harness.turnPrompts.length,
    turnsAtDestroy,
    "销毁后时钟推进 3 小时不再驱动任何 turn",
  );
  assert.equal(harness.forkRequests.length, 1, "没有自动重启（无第二次 fork）");
  const snapshot = harness.registry.get(handle.taskId);
  assert.equal(snapshot.status, "cancelled");
  assert.ok(snapshot.completedAt instanceof Date, "终态时间已收口");
  // 终态判定可用：waitForTerminal 已结算（实例销毁路径的投影一致性）
  const settled = await harness.registry.waitForTerminal(handle.taskId);
  assert.equal(settled.status, "cancelled");
});

// ---------------------------------------------------------------------------
// 场景 10：off-peak/cron/automation 域零命中（源码断言）
// ---------------------------------------------------------------------------

test("场景 10：overnight 与 off-peak/cron/automation 域互不引用（源码断言）", async () => {
  const testFileUrl = new URL(import.meta.url);
  const readSource = async (pathSegments) =>
    await readFile(new URL([...pathSegments].join("/"), testFileUrl), "utf8");

  // overnight 源文件不得引用 off-peak/cron/automation 域（正交性：spec 红线）
  const overnightFiles = [
    ["..", "packages", "core", "src", "overnight", "constants.ts"],
    ["..", "packages", "core", "src", "overnight", "duration.ts"],
    ["..", "packages", "core", "src", "overnight", "manifest.ts"],
    ["..", "packages", "core", "src", "overnight", "prompts.ts"],
    ["..", "packages", "core", "src", "overnight", "supervisor.ts"],
    ["..", "packages", "core", "src", "overnight", "preflight.ts"],
    ["..", "packages", "core", "src", "overnight", "coordinator.ts"],
    ["..", "packages", "core", "src", "overnight", "runner.ts"],
  ];
  for (const segments of overnightFiles) {
    const source = await readSource(segments);
    assert.ok(
      !/off[-_]?peak|OffPeak|CronCreate|automation/i.test(source),
      `${segments.at(-1)} 不应引用 off-peak/cron/automation 域`,
    );
  }

  // 反向：off-peak/cron/automation 域文件不含 overnight 引用（本批次零改动其语义）
  const domainFiles = [
    ["..", "packages", "core", "src", "tool", "handlers", "cron.ts"],
    ["..", "packages", "core", "src", "tool", "handlers", "off-peak.ts"],
    ["..", "..", "..", "packages", "services", "src", "session", "offPeakTaskService.ts"],
    ["..", "..", "..", "packages", "services", "src", "session", "offPeakTask.ts"],
    ["..", "..", "..", "packages", "services", "src", "session", "automationCron.ts"],
    ["..", "..", "..", "packages", "services", "src", "session", "automationService.ts"],
  ];
  for (const segments of domainFiles) {
    const source = await readSource(segments);
    assert.ok(!/overnight/i.test(source), `${segments.at(-1)} 不应引用 overnight 域`);
  }

  // 入口解析层同样不引入这些域（宿主动作命令与闲时/定时体系正交）
  const builtinCommandSource = await readSource(["..", "packages", "bootstrap", "src", "builtin-prompt-command.ts"]);
  assert.ok(!/off[-_]?peak|OffPeak|CronCreate|automation/i.test(builtinCommandSource));
});

