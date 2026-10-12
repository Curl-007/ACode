import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

/**
 * 挖洞-填充（specs/workflow-holes.md）的验收测试。分组对齐 spec「验收场景」：
 *   C 组——编译面：干净洞过编译、fan-out 回调 / 非语句位 / 非字面量为 9005、snippet 拒绝、
 *          lowering 打桩与 site-id stability（场景 5/6）。
 *   S 组——splice：AST 级替换 + 重打印、坏 fill 拒绝、未知站点、嵌套生长（场景 1/2 的纯函数半边）。
 *   E 组——引擎停靠：hole-reached 事件（holeId/ordinal/askedAt）、结算撤下（Cancelled）。
 *   F 组——服务端 fillHole 的拒绝路径：hole_not_waiting 的三种形态与 fill_compile_failed
 *          （被拒时零副作用：草稿未变、洞仍等待、无 hole-filled）（场景 2）。
 *   T 组——工具面：技能门、resolveInput 落定 spliced_script、fill_unchanged、确认窗重算
 *          （含新 world.run 命令集，场景 2/3）、不确认不 splice。
 *   X 组——端到端（真子进程 + 真 vm 沙箱）：尾洞停靠 → supersede 续跑终态正确；循环内洞
 *          首轮停靠、fill 后每轮执行不再停靠（场景 1/4）。
 *   R 组——注册点：灰度名单 + actor 工具面禁用（场景 7）。
 *   P 组——shared reducer：hole-reached upsert / hole-filled 划掉 / run-settled 清空 /
 *          重放幂等（场景 8 的 shared 单测半边）。
 */

const dwf = await import("../packages/dynamic-workflow/src/index.ts");
const {
  analyzeWorkflowScript,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  HOLE_CALL_CODE,
  lowerWorkflowScript,
  SNIPPET_FACADE_DTS,
  spliceWorkflowHole,
  InMemoryJournalStore,
  WorkflowEngine,
} = dwf;
const { runWorkflowScript } = await import("../packages/dynamic-workflow-runtime/src/index.ts");
const { fillWorkflowHole } = await import("../packages/cli-workflow/src/dynamic-workflow-hole-fill.ts");
const { toProgressPayload } = await import("../packages/cli-workflow/src/dynamic-workflow-run-launch.ts");
const { createWorkflowRunControl } = await import("../packages/cli-workflow/src/workflow-run-control.ts");
const { createWorkflowEscalationRegistry } = await import(
  "../packages/cli-workflow/src/workflow-escalation-registry.ts"
);
const { workflowActorToolPolicy } = await import("../packages/cli-workflow/src/workflow-actor-tools.ts");
const { DYNAMIC_WORKFLOW_TOOL_NAMES, GATED_WORKFLOW_TOOL_NAMES } = await import(
  "../packages/core/src/tool/handlers/workflow-tool-names.ts"
);
const { fillWorkflowHoleToolEntry, validateFillWorkflowHoleSource } = await import(
  "../packages/core/src/tool/handlers/fill-workflow-hole.ts"
);
const { FILL_WORKFLOW_HOLE_TOOL_NAME } = await import(
  "../packages/contracts/src/tools/fill-workflow-hole.ts"
);
const { reduceWorkflowRunsState } = await import(
  "../../../packages/shared/src/acode-protocol-v4/workflow-runs-reducer.ts"
);

// ————————————————————————————————————————————————————————————————
// 语料
// ————————————————————————————————————————————————————————————————

/** 尾洞种子：world.run 门 + 尾洞（场景 1 的形状）。 */
const SEED_TAIL = [
  'phase("准备");',
  'const gate = await world.run("echo", ["ready"]);',
  'log("gate:" + gate.exitCode);',
  'return await hole<string>("第1步：决定导览结构", "盘点：空");',
].join("\n");

/** 循环内洞：for-of 体不是函数作用域（funcDepth 0），合法；fill 后每轮直接执行（场景 4）。 */
const SEED_LOOP = [
  'phase("逐项处理");',
  'let out = "";',
  'for (const item of ["a", "b", "c"]) {',
  '  const v = await hole<string>("每项怎么处理", "逐项的处置只有看到首项才知道");',
  '  await world.run("echo", [v]);',
  '  out += v;',
  "}",
  'return out;',
].join("\n");

const askSpecs = new Map();
const validate = () => [];

/** 事件轨（StoredEvent → 事件本体）。 */
const eventsOf = (journal, runId) => journal.listEvents(runId).map((stored) => stored.event);

/** 引擎级与 E2E 共用的 fake driver：world.run 全部兑现为退出码 0；ask 站点本文件不用。 */
const makeDriver = (journal) => ({
  journal,
  emit() {},
  createActorSession: async () => ({ id: "actor-session" }),
  startAsk() {},
  respondToSubmit() {},
  cancelAsk() {},
  executeWorldRead: async (_op, args) => ({
    exitCode: 0,
    stdout: `ran:${(args ?? []).join(",")}`,
    stderr: "",
  }),
});

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-holes-"));
  return Promise.resolve(fn(dir)).finally(() => {
    // Windows：kill 子进程后目录句柄释放晚于 rmSync，重试而不是让 EPERM 盖掉断言。
    try {
      rmSync(dir, { force: true, maxRetries: 8, recursive: true, retryDelay: 60 });
    } catch {
      // 交由系统回收临时目录。
    }
  });
}

async function waitFor(predicate, { timeoutMs = 20_000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await delay(stepMs);
  }
}

/** 服务端 fillHole 单测的最小 ctx（拒绝路径在 amend 链之前收口，不需要 launch 依赖）。 */
function makeFillCtx(journal) {
  return {
    deps: { journal },
    runs: new Map(),
    resumeAdmissions: new Set(),
    escalations: createWorkflowEscalationRegistry(),
    caps: () => ({ maxConcurrency: 2 }),
    trackSettlement: async (_runId, _entry, launched) => launched,
  };
}

function makeRegistryEntry(scriptText, cwd) {
  return {
    controller: new AbortController(),
    control: createWorkflowRunControl(),
    startedAt: new Date(),
    cwd,
    scriptText,
    maxConcurrency: 2,
    settlement: Promise.resolve({ status: "stopped", reason: "user" }),
  };
}

/** journal 里伪造一条「在飞且停在该洞」的 run（引擎正常路径产出的最小事实集）。 */
function seedParkedRun(journal, runId, scriptText) {
  journal.createRun({
    runId,
    caps: { maxConcurrency: 2 },
    spentTokens: 0,
    status: "running",
    scriptText,
  });
  journal.appendEvent(runId, {
    type: "hole-reached",
    holeId: "hole#1@1",
    siteId: "hole#1",
    ordinal: 1,
    stage: "第1步：决定导览结构",
    prompt: "盘点：空",
    askedAt: 1_700_000_000_000,
  });
}

const TRACE = { traceId: "t", spanId: "s", sessionId: "sess" };

// ————————————————————————————————————————————————————————————————
// C 组：编译面（场景 5/6）
// ————————————————————————————————————————————————————————————————

test("WH-C1: 尾洞脚本干净过编译，站点表登记 hole#1（stage/prompt 字面量读得出）", () => {
  const analysis = analyzeWorkflowScript(SEED_TAIL);
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  const table = collectSites(createWorkflowProgram(SEED_TAIL));
  assert.equal(table.holes.length, 1);
  assert.equal(table.holes[0].id, "hole#1");
  assert.equal(table.holes[0].stage, "第1步：决定导览结构");
  assert.equal(table.holes[0].prompt, "盘点：空");
  assert.equal(table.holes[0].funcDepth, 0);
});

test("WH-C2: fan-out 回调内的洞被 9005 拒绝（场景 5）", () => {
  const script = [
    'phase("扫一遍");',
    'const xs = await files.glob("*.ts");',
    'const vs = await Promise.all(xs.map(async (p) => await hole<string>("逐个", p)));',
    "return vs;",
  ].join("\n");
  const analysis = analyzeWorkflowScript(script);
  assert.equal(analysis.ok, false);
  assert.ok(
    analysis.diagnostics.some((d) => d.code === HOLE_CALL_CODE),
    JSON.stringify(analysis.diagnostics),
  );
});

test("WH-C3: 非 await 语句位的洞（读它的值）被 9005 拒绝", () => {
  const script = [
    'phase("读值");',
    'const gate = await world.run("echo", ["x"]);',
    'const v = hole<string>("不该是洞", "缺数据用 ask");',
    "const n = (await v).length;",
    "return gate.exitCode + n;",
  ].join("\n");
  const analysis = analyzeWorkflowScript(script);
  assert.equal(analysis.ok, false, JSON.stringify(analysis.diagnostics));
  assert.ok(analysis.diagnostics.some((d) => d.code === HOLE_CALL_CODE));
});

test("WH-C4: 非字面量 stage 被9005 拒绝（停靠站没有可展示的对象）", () => {
  const script = [
    'phase("门");',
    'const name = "runtime-" + 1;',
    'await world.run("echo", ["x"]);',
    'await hole<string>(name, "p");',
  ].join("\n");
  const analysis = analyzeWorkflowScript(script);
  assert.equal(analysis.ok, false);
  assert.ok(analysis.diagnostics.some((d) => d.code === HOLE_CALL_CODE));
});

test("WH-C6: snippet facade 不含 hole：TS2304 编译期拒绝（场景 6）", () => {
  const workflow = createWorkflowProgram('await hole<string>("a", "b");', {
    facadeDts: SNIPPET_FACADE_DTS,
  });
  const diagnostics = collectDiagnostics(workflow.program);
  assert.ok(
    diagnostics.some((d) => d.code === 2304 && d.message.includes("hole")),
    JSON.stringify(diagnostics),
  );
});

test("WH-C7: lowering 打桩 __host.hole；hole 用独立计数器，既有站点 id 不动（site-id stability）", () => {
  const result = lowerWorkflowScript(SEED_TAIL);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.match(result.lowered.code, /__host\.hole\("hole#1", "第1步：决定导览结构", "盘点：空"\)/);
  assert.ok(result.lowered.siteIds.includes("hole#1"));
  // 同一脚本里 ask / world-read / hole 的 per-kind 计数器互不干扰。
  const mixed = [
    'phase("混合");',
    'const a = await agent("worker").ask<string>("q1");',
    'await hole<string>("洞一", "p1");',
    'const b = await agent("worker2").ask<string>("q2");',
    'await hole<string>("洞二", "p2");',
    'return a.length + b.length;',
  ].join("\n");
  const mixedResult = lowerWorkflowScript(mixed);
  assert.equal(mixedResult.ok, true, JSON.stringify(mixedResult.diagnostics));
  const table = collectSites(createWorkflowProgram(mixed));
  assert.deepEqual(
    table.asks.map((site) => site.id),
    ["ask#1", "ask#2"],
  );
  assert.deepEqual(
    table.holes.map((site) => site.id),
    ["hole#1", "hole#2"],
  );
});

// ————————————————————————————————————————————————————————————————
// S 组：splice（纯函数半边）
// ————————————————————————————————————————————————————————————————

test("WH-S1: 尾洞 splice 为 await IIFE，产物重分析干净且不再有洞", () => {
  const spliced = spliceWorkflowHole(SEED_TAIL, "hole#1", 'return "filled";');
  assert.equal(spliced.ok, true);
  assert.match(spliced.scriptText, /await \(async \(\) => \{/);
  assert.match(spliced.scriptText, /return "filled";/);
  const analysis = analyzeWorkflowScript(spliced.scriptText);
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  assert.equal(collectSites(createWorkflowProgram(spliced.scriptText)).holes.length, 0);
});

test("WH-S2: 语法不成立的 fill 被拒（fill_invalid），洞原样（场景 2 的纯函数半边）", () => {
  const spliced = spliceWorkflowHole(SEED_TAIL, "hole#1", "return (((");
  assert.equal(spliced.ok, false);
  assert.equal(spliced.reason, "fill_invalid");
  assert.ok(spliced.diagnostics.length > 0);
});

test("WH-S3: 未知站点 id 被拒（hole_not_found）", () => {
  const spliced = spliceWorkflowHole(SEED_TAIL, "hole#9", 'return "x";');
  assert.equal(spliced.ok, false);
  assert.equal(spliced.reason, "hole_not_found");
});

test("WH-S4: fill 里允许再留尾洞（嵌套生长），新洞拿自己的站点 id", () => {
  const nested = 'const next = await hole<string>("第2步：审读", "初稿已就绪");\nreturn next;';
  const spliced = spliceWorkflowHole(SEED_TAIL, "hole#1", nested);
  assert.equal(spliced.ok, true);
  const analysis = analyzeWorkflowScript(spliced.scriptText);
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  const table = collectSites(createWorkflowProgram(spliced.scriptText));
  assert.equal(table.holes.length, 1);
  assert.equal(table.holes[0].stage, "第2步：审读");
});

test("WH-S5: 循环内洞 splice 后 IIFE 位于原洞位（fill 后每轮直接执行的静态前提）", () => {
  const spliced = spliceWorkflowHole(SEED_LOOP, "hole#1", "return item.toUpperCase();");
  assert.equal(spliced.ok, true);
  const analysis = analyzeWorkflowScript(spliced.scriptText);
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  assert.equal(collectSites(createWorkflowProgram(spliced.scriptText)).holes.length, 0);
});

// ————————————————————————————————————————————————————————————————
// E 组：引擎停靠与撤下
// ————————————————————————————————————————————————————————————————

test("WH-E1: engine.hole 双轨发 hole-reached（holeId=site@ordinal、askedAt 透传），promise 挂起，结算撤下以 Cancelled 拒绝", async () => {
  const journal = new InMemoryJournalStore();
  const engine = new WorkflowEngine({
    runId: "park",
    caps: { maxConcurrency: 1 },
    askSpecs,
    validate,
    driver: makeDriver(journal),
  });
  const askedAt = 1_700_000_012_345;
  const parked = engine.hole("hole#1", "第1步", "盘点：空", askedAt);
  let settled = false;
  void parked.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await delay(10);
  assert.equal(settled, false);

  const events = eventsOf(journal, "park");
  const reached = events.find((event) => event.type === "hole-reached");
  assert.ok(reached !== undefined);
  assert.equal(reached.holeId, "hole#1@1");
  assert.equal(reached.siteId, "hole#1");
  assert.equal(reached.ordinal, 1);
  assert.equal(reached.stage, "第1步");
  assert.equal(reached.prompt, "盘点：空");
  assert.equal(reached.askedAt, askedAt);

  // 撤下钩子随结算触发：先停，再断言停靠 promise 以 Cancelled 被拒绝（顺序反了会死锁）。
  engine.stop("user");
  await assert.rejects(parked, (error) => error.code === "Cancelled");
  const outcome = await engine.settled;
  assert.equal(outcome.status, "stopped");
  // 撤下是幂等收尾：结算后的第二次停靠直接拒绝，不再新增事件。
  await assert.rejects(engine.hole("hole#1", "later", "p", 1), (error) => error.code !== undefined);
  assert.equal(eventsOf(journal, "park").filter((e) => e.type === "hole-reached").length, 1);
});

test("WH-E2: 同一站点的第二次到达拿新 ordinal（身份 per reach），不同 holeId", async () => {
  const journal = new InMemoryJournalStore();
  const engine = new WorkflowEngine({
    runId: "twice",
    caps: { maxConcurrency: 1 },
    askSpecs,
    validate,
    driver: makeDriver(journal),
  });
  void engine.hole("hole#1", "s", "p1", 1).catch(() => undefined);
  void engine.hole("hole#1", "s", "p2", 2).catch(() => undefined);
  const reached = eventsOf(journal, "twice").filter((event) => event.type === "hole-reached");
  assert.deepEqual(
    reached.map((event) => event.holeId),
    ["hole#1@1", "hole#1@2"],
  );
  engine.stop("user");
  await engine.settled;
});

// ————————————————————————————————————————————————————————————————
// F 组：服务端 fillHole 的拒绝路径（被拒 = 零副作用）
// ————————————————————————————————————————————————————————————————

test("WH-F1: 未注册 / 已结算 / 未到达 / 畸形 hole_ref 都得到 hole_not_waiting", async () => {
  await withTempDir(async (cwd) => {
    const journal = new InMemoryJournalStore();
    const ctx = makeFillCtx(journal);

    const unknown = await fillWorkflowHole(ctx, {
      runId: "ghost",
      holeId: "hole#1@1",
      fill: 'return "x";',
      cwd,
      trace: TRACE,
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, "hole_not_waiting");

    const entry = makeRegistryEntry(SEED_TAIL, cwd);
    entry.terminal = { status: "completed", artifact: "done" };
    ctx.runs.set("settled-run", entry);
    const settled = await fillWorkflowHole(ctx, {
      runId: "settled-run",
      holeId: "hole#1@1",
      fill: 'return "x";',
      cwd,
      trace: TRACE,
    });
    assert.equal(settled.ok, false);
    assert.equal(settled.reason, "hole_not_waiting");

    const liveEntry = makeRegistryEntry(SEED_TAIL, cwd);
    ctx.runs.set("live-run", liveEntry);
    journal.createRun({
      runId: "live-run",
      caps: { maxConcurrency: 2 },
      spentTokens: 0,
      status: "running",
      scriptText: SEED_TAIL,
    });
    const notReached = await fillWorkflowHole(ctx, {
      runId: "live-run",
      holeId: "hole#1@1",
      fill: 'return "x";',
      cwd,
      trace: TRACE,
    });
    assert.equal(notReached.ok, false);
    assert.equal(notReached.reason, "hole_not_waiting");

    const malformed = await fillWorkflowHole(ctx, {
      runId: "live-run",
      holeId: "hole#1",
      fill: 'return "x";',
      cwd,
      trace: TRACE,
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.reason, "hole_not_waiting");
  });
});

test("WH-F2: 坏 fill（语法 / 类型）在停前驱之前被拒：fill_compile_failed、洞仍等待、草稿未变、无 hole-filled（场景 2）", async () => {
  await withTempDir(async (cwd) => {
    for (const [label, fill] of [
      ["syntax", "return ((("],
      ["type", "return undefinedVariable;"],
    ]) {
      const journal = new InMemoryJournalStore();
      const ctx = makeFillCtx(journal);
      const entry = makeRegistryEntry(SEED_TAIL, cwd);
      ctx.runs.set("parked", entry);
      seedParkedRun(journal, "parked", SEED_TAIL);

      const refused = await fillWorkflowHole(ctx, {
        runId: "parked",
        holeId: "hole#1@1",
        fill,
        cwd,
        trace: TRACE,
      });
      assert.equal(refused.ok, false, label);
      assert.equal(refused.reason, "fill_compile_failed", label);
      assert.match(refused.message, /still waiting/u);

      // 零副作用：事件轨没有 hole-filled，注册表条目还在（未停），草稿字节未动。
      assert.equal(
        eventsOf(journal, "parked").some((event) => event.type === "hole-filled"),
        false,
      );
      assert.equal(ctx.runs.get("parked").terminal, undefined);
      assert.equal(ctx.runs.get("parked").scriptText, SEED_TAIL);
      assert.equal(journal.getRun("parked").scriptText, SEED_TAIL);
    }
  });
});

test("WH-F3: resume 后重新到达的洞仍可填——等待闸与投影 reducer 在跨代事件流上判定一致", async () => {
  await withTempDir(async (cwd) => {
    // 跨代事件流（park → stop → resume → re-park），逐条对齐 engine 正常路径产出的事实：
    //   gen1: run-started, hole-reached(hole#1@1)
    //   stop: run-settled(stopped, user)   ← 可恢复（isResumableRecord = stopped && !superseded）
    //   gen2: run-started, hole-reached(hole#1@1)  ← resume 同 runId、确定性 ordinal 复算同 holeId
    // 关键：run-settled 之后**还有**一条同 id 的 hole-reached。等待窗必须重新打开。
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: "resumed",
      caps: { maxConcurrency: 2 },
      spentTokens: 0,
      status: "running",
      scriptText: SEED_TAIL,
    });
    const reached = (askedAt) => ({
      type: "hole-reached",
      holeId: "hole#1@1",
      siteId: "hole#1",
      ordinal: 1,
      stage: "第1步：决定导览结构",
      prompt: "盘点：空",
      askedAt,
    });
    journal.appendEvent("resumed", { type: "run-started", runId: "resumed", caps: { maxConcurrency: 2 } });
    journal.appendEvent("resumed", reached(1_700_000_000_000));
    journal.appendEvent("resumed", { type: "run-settled", status: "stopped", stopReason: "user" });
    journal.appendEvent("resumed", { type: "run-started", runId: "resumed", caps: { maxConcurrency: 2 } });
    journal.appendEvent("resumed", reached(1_700_000_000_999));

    const stored = journal.listEvents("resumed", {});

    // 发现面（权威）：GetWorkflowRun.pendingHoles 就是 reduceRunState 的产物，喂同一份
    // journal 字节（经 toProgressPayload 铸成信封，与线上投影同一条链）。
    let projected;
    for (const item of stored) {
      const envelope = toProgressPayload({ event: item.event, runId: "resumed", sequence: item.sequence });
      projected = reduceWorkflowRunsState(projected, envelope) ?? projected;
    }
    const run = projected.runs.find((entry) => entry.runId === "resumed");
    assert.equal(run.status, "running");
    assert.equal(run.pendingHoles.length, 1);
    assert.equal(run.pendingHoles[0].holeId, "hole#1@1");

    // 填充面：注册表条目 resume 后是活的（terminal===undefined），洞在 journal 里等待中。
    // 用一个坏 fill 做零副作用探针——若等待闸**放行**，它会在停前驱之前撞上重编译闸
    // （fill_compile_failed，WH-F2 同型）；若闸门错误地在 gen1 的 run-settled 上早拒，
    // 得到的是 hole_not_waiting（bug 面）。修复前这里是 hole_not_waiting，测试因此变红。
    const ctx = makeFillCtx(journal);
    ctx.runs.set("resumed", makeRegistryEntry(SEED_TAIL, cwd));
    const admitted = await fillWorkflowHole(ctx, {
      runId: "resumed",
      holeId: "hole#1@1",
      fill: "return (((",
      cwd,
      trace: TRACE,
    });
    assert.equal(admitted.ok, false);
    assert.equal(
      admitted.reason,
      "fill_compile_failed",
      `等待闸应放行 resume 后重新到达的洞（reducer 说它在等），却得到 ${admitted.reason}`,
    );
    // 放行但被编译闸挡下：零副作用（前驱未停、草稿未变、无 hole-filled）。
    assert.equal(eventsOf(journal, "resumed").some((event) => event.type === "hole-filled"), false);
    assert.equal(ctx.runs.get("resumed").terminal, undefined);
    assert.equal(ctx.runs.get("resumed").scriptText, SEED_TAIL);

    // 正向对照：最后一条 hole-reached 之后再补一条 run-settled（没有更晚的 reached），
    // 洞就不再等待——证明修复不是简单地删掉 run-settled 判定，而是「只看最后一段」。
    journal.appendEvent("resumed", { type: "run-settled", status: "stopped", stopReason: "user" });
    const closed = await fillWorkflowHole(ctx, {
      runId: "resumed",
      holeId: "hole#1@1",
      fill: 'return "filled";',
      cwd,
      trace: TRACE,
    });
    assert.equal(closed.ok, false);
    assert.equal(closed.reason, "hole_not_waiting");

    // 正向对照：一条更晚的 hole-filled 同样终结等待窗（每 run 每洞至多一次 fill）。
    journal.appendEvent("resumed", reached(1_700_000_002_000));
    journal.appendEvent("resumed", {
      type: "hole-filled",
      holeId: "hole#1@1",
      succeededBy: "resumed-successor",
    });
    const filled = await fillWorkflowHole(ctx, {
      runId: "resumed",
      holeId: "hole#1@1",
      fill: 'return "filled";',
      cwd,
      trace: TRACE,
    });
    assert.equal(filled.ok, false);
    assert.equal(filled.reason, "hole_not_waiting");
  });
});

// ————————————————————————————————————————————————————————————————
// T 组：工具面（resolveInput / 确认窗 / fill_unchanged）
// ————————————————————————————————————————————————————————————————

/** 工具层单测的假端口：草稿可读、停驻事实可查、fillHole 计数不真跑。 */
function makeToolPort(draft) {
  const calls = { fillHole: 0 };
  return {
    calls,
    async getScript() {
      return draft;
    },
    async getRunDetail() {
      return {
        label: "seed",
        status: "running",
        usage: { spentTokens: 0, nodesObserved: 0, nodesRunning: 0, nodesCompleted: 0, nodesFailed: 0 },
        actors: [],
        logTail: [],
        subagents: [],
        health: { moving: true },
        pendingHoles: [{ holeId: "hole#1@1", ordinal: 1, stage: "第1步：决定导览结构", prompt: "盘点：空" }],
      };
    },
    async fillHole() {
      calls.fillHole += 1;
      return { ok: true, runId: "run-b", supersededRunId: "parked", cacheImported: true };
    },
  };
}

function toolContext(port, extra = {}) {
  return {
    dynamicWorkflowRunPort: port,
    workingDirectory: ".",
    sessionId: "sess",
    ...extra,
  };
}

test("WH-T1: 技能门（428 族）先于一切解析", async () => {
  const port = makeToolPort(SEED_TAIL);
  const refused = await fillWorkflowHoleToolEntry.resolveInput(
    { run_id: "parked", hole_ref: "hole#1@1", script: 'return "x";' },
    toolContext(port, { hasLoadedSkill: () => false }),
  );
  assert.equal(refused.result, false);
  assert.equal(refused.errorCode, 428);
  assert.match(refused.message, /dynamic-workflows/u);
});

test("WH-T2: resolveInput 落定 spliced_script（确认窗与 handler 读同一份），服务端未被触碰（不确认不 splice）", async () => {
  const port = makeToolPort(SEED_TAIL);
  const resolved = await fillWorkflowHoleToolEntry.resolveInput(
    { run_id: "parked", hole_ref: "hole#1@1", script: 'return "filled";' },
    toolContext(port, { hasLoadedSkill: () => true }),
  );
  assert.equal(resolved.result, true);
  assert.match(resolved.input.spliced_script, /await \(async \(\) => \{/u);
  assert.equal(resolved.input.fill, 'return "filled";');
  assert.equal(port.calls.fillHole, 0);
});

test("WH-T3: 同字节重提被拒为 fill_unchanged（场景 2），改过的字节重新进入正常流程", async () => {
  const port = makeToolPort(SEED_TAIL);
  const context = toolContext(port, { hasLoadedSkill: () => true });
  const input = { run_id: "parked", hole_ref: "hole#1@1", script: "return undefinedVariable;" };
  const first = await fillWorkflowHoleToolEntry.resolveInput(input, context);
  assert.equal(first.result, false);
  assert.match(first.message, /does not hold|compile/u);
  const second = await fillWorkflowHoleToolEntry.resolveInput(input, context);
  assert.equal(second.result, false);
  assert.equal(second.errorCode, 34);
  assert.match(second.message, /workflow_fill_unchanged/u);
  const third = await fillWorkflowHoleToolEntry.resolveInput(
    { run_id: "parked", hole_ref: "hole#1@1", script: 'return "fixed";' },
    context,
  );
  assert.equal(third.result, true);
});

test("WH-T4: 确认窗重算：splice 后的分析进 display；fill 引入的新 world.run 命令进新命令集（场景 3）", async () => {
  const port = makeToolPort(SEED_TAIL);
  const context = toolContext(port, { hasLoadedSkill: () => true });
  const fill = 'const r = await world.run("brandnewcmd", []);\nreturn r.stdout;';
  const resolved = await fillWorkflowHoleToolEntry.resolveInput(
    { run_id: "parked", hole_ref: "hole#1@1", script: fill },
    context,
  );
  assert.equal(resolved.result, true, JSON.stringify(resolved));
  const spliced = resolved.input.spliced_script;

  // 新命令集：确认窗展示的命令集合因 fill 扩了（授权面重算的静态事实）。
  const workflow = createWorkflowProgram(spliced);
  const commands = collectWorldRunCommands(workflow, collectSites(workflow));
  assert.equal(commands.diagnostics.length, 0);
  assert.ok(commands.commands.includes("brandnewcmd"));
  assert.ok(commands.commands.includes("echo"));

  // 窗本身：gate=ask 且带 display（编不过/字段缺席才放行——这里必须弹）。
  const gate = fillWorkflowHoleToolEntry.prepareApproval(resolved.input);
  assert.equal(gate.gate, "ask");
  assert.ok(gate.display !== undefined);
  // 审批前服务端零调用：不确认 = 不 splice。
  assert.equal(port.calls.fillHole, 0);
});

test("WH-T5: script/path XOR 在 validateInput 层拒绝（同给）", () => {
  const both = validateFillWorkflowHoleSource({
    run_id: "r",
    hole_ref: "hole#1@1",
    script: 'return "x";',
    path: "fill.ts",
  });
  assert.equal(both.result, false);
  assert.equal(both.errorCode, 400);
});

test("WH-T6: 不在该洞等待时 resolveInput 早拒（hole_not_waiting）", async () => {
  const port = makeToolPort(SEED_TAIL);
  port.getRunDetail = async () => ({
    label: "seed",
    status: "running",
    usage: { spentTokens: 0, nodesObserved: 0, nodesRunning: 0, nodesCompleted: 0, nodesFailed: 0 },
    actors: [],
    logTail: [],
    subagents: [],
    health: { moving: true },
  });
  const refused = await fillWorkflowHoleToolEntry.resolveInput(
    { run_id: "parked", hole_ref: "hole#7@1", script: 'return "x";' },
    toolContext(port, { hasLoadedSkill: () => true }),
  );
  assert.equal(refused.result, false);
  assert.match(refused.message, /workflow_hole_not_waiting/u);
});

// ————————————————————————————————————————————————————————————————
// X 组：端到端（真子进程 + 真 vm 沙箱；场景 1/4）
// ————————————————————————————————————————————————————————————————

test(
  "WH-X1: 尾洞停靠 → supersede 停旧 run → splice 后续跑至 completed（journal 有 hole-reached；场景 1 的引擎半边）",
  { timeout: 60_000 },
  async () => {
    await withTempDir(async (cwd) => {
      const journal = new InMemoryJournalStore();
      const controller = new AbortController();
      const runA = runWorkflowScript({
        runId: "hole-e2e-a",
        scriptText: SEED_TAIL,
        cwd,
        caps: { maxConcurrency: 1 },
        askSpecs,
        validate,
        makeDriver: () => makeDriver(journal),
        signal: controller.signal,
      });
      // 停靠：journal 双轨里出现 hole-reached（UI waiting 行与 FillWorkflowHole 定位读的同一事实）。
      const reached = await waitFor(() =>
        eventsOf(journal, "hole-e2e-a").find((event) => event.type === "hole-reached"),
      );
      assert.equal(reached.holeId, "hole#1@1");
      assert.equal(reached.stage, "第1步：决定导览结构");

      // fill：一步语句 splice 进草稿（确认窗链在工具层，本组只验引擎语义）。
      const spliced = spliceWorkflowHole(SEED_TAIL, "hole#1", 'return "filled";');
      assert.equal(spliced.ok, true);

      // supersede：amend 链对前驱做的事——abort({superseded}) → stopped(superseded, supersededBy)。
      controller.abort({ superseded: "hole-e2e-b" });
      const settlementA = await runA;
      assert.equal(settlementA.status, "stopped");
      assert.equal(settlementA.reason, "superseded");
      assert.equal(settlementA.supersededBy, "hole-e2e-b");

      // 续跑：新 run 用 splice 后的脚本，从空 journal 起跑（导入缓存是 amend 既有链，另行覆盖）。
      const settlementB = await runWorkflowScript({
        runId: "hole-e2e-b",
        scriptText: spliced.scriptText,
        cwd,
        caps: { maxConcurrency: 1 },
        askSpecs,
        validate,
        makeDriver: () => makeDriver(journal),
      });
      assert.equal(settlementB.status, "completed");
      assert.equal(settlementB.artifact, "filled");
      const eventsB = eventsOf(journal, "hole-e2e-b");
      assert.ok(eventsB.some((event) => event.type === "run-settled" && event.status === "completed"));
      // filled-once-run-per-reach：splice 后的新脚本没有洞，也就没有停靠。
      assert.equal(eventsB.some((event) => event.type === "hole-reached"), false);
    });
  },
);

test(
  "WH-X2: 循环内洞——首轮停靠，fill 后每轮直接执行 body、不再停靠（场景 4）",
  { timeout: 60_000 },
  async () => {
    await withTempDir(async (cwd) => {
      const journal = new InMemoryJournalStore();
      const controller = new AbortController();
      const runA = runWorkflowScript({
        runId: "hole-loop-a",
        scriptText: SEED_LOOP,
        cwd,
        caps: { maxConcurrency: 1 },
        askSpecs,
        validate,
        makeDriver: () => makeDriver(journal),
        signal: controller.signal,
      });
      const reached = await waitFor(() =>
        eventsOf(journal, "hole-loop-a").find((event) => event.type === "hole-reached"),
      );
      assert.equal(reached.holeId, "hole#1@1");
      // 首轮停靠、且只有一次：第二轮从未到达（脚本停在 await 上）。
      await delay(250);
      assert.equal(
        eventsOf(journal, "hole-loop-a").filter((event) => event.type === "hole-reached").length,
        1,
      );

      const spliced = spliceWorkflowHole(SEED_LOOP, "hole#1", "return item.toUpperCase();");
      assert.equal(spliced.ok, true);
      controller.abort({ superseded: "hole-loop-b" });
      assert.equal((await runA).reason, "superseded");

      const settlementB = await runWorkflowScript({
        runId: "hole-loop-b",
        scriptText: spliced.scriptText,
        cwd,
        caps: { maxConcurrency: 1 },
        askSpecs,
        validate,
        makeDriver: () => makeDriver(journal),
      });
      // 每轮都执行了 body：out = "A" + "B" + "C"，world.run 每轮一条。
      assert.equal(settlementB.status, "completed");
      assert.equal(settlementB.artifact, "ABC");
      assert.equal(
        eventsOf(journal, "hole-loop-b").some((event) => event.type === "hole-reached"),
        false,
      );
      const worldRuns = journal
        .listNodes("hole-loop-b")
        .filter((node) => node.kind === "world-run");
      assert.equal(worldRuns.length, 3);
    });
  },
);

// ————————————————————————————————————————————————————————————————
// R 组：注册点与 actor 工具面（场景 7）
// ————————————————————————————————————————————————————————————————

test("WH-R1: FillWorkflowHole 进 dwf 灰度名单与总门控集合（includeDynamicWorkflow=false 时下架）", () => {
  assert.equal(FILL_WORKFLOW_HOLE_TOOL_NAME, "FillWorkflowHole");
  assert.ok(DYNAMIC_WORKFLOW_TOOL_NAMES.has("FillWorkflowHole"));
  assert.ok(GATED_WORKFLOW_TOOL_NAMES.has("FillWorkflowHole"));
});

test("WH-R2: 子代理工具面禁用 FillWorkflowHole（子代理不得填洞；场景 7）", () => {
  const policy = workflowActorToolPolicy();
  assert.ok(policy.toolDisallowlist.includes("FillWorkflowHole"));
  // 既有禁用项不回归。
  assert.ok(policy.toolDisallowlist.includes("ResolveWorkflowQuestion"));
  assert.ok(policy.toolDisallowlist.includes("CreateWorkflow"));
});

// ————————————————————————————————————————————————————————————————
// P 组：shared reducer（场景 8 的 shared 单测半边）
// ————————————————————————————————————————————————————————————————

test("WH-P1: hole-reached upsert、重放幂等、hole-filled 划掉、run-settled 清空", () => {
  const started = { runId: "r1", sequence: 1, eventType: "run-started", payload: { runId: "r1" } };
  let state = reduceWorkflowRunsState(undefined, started);
  assert.ok(state !== null);

  const reached = {
    runId: "r1",
    sequence: 2,
    eventType: "hole-reached",
    payload: {
      holeId: "hole#1@1",
      ordinal: 1,
      stage: "第1步",
      prompt: "盘点",
      askedAt: 1_700_000_000_000,
    },
  };
  state = reduceWorkflowRunsState(state, reached);
  const run = state.runs.find((entry) => entry.runId === "r1");
  assert.deepEqual(run.pendingHoles, [
    { holeId: "hole#1@1", ordinal: 1, stage: "第1步", prompt: "盘点", askedAt: 1_700_000_000_000 },
  ]);

  // 重放同一条：语义无变化（null），revision 不抬。
  assert.equal(reduceWorkflowRunsState(state, reached), null);

  const filled = {
    runId: "r1",
    sequence: 3,
    eventType: "hole-filled",
    payload: { holeId: "hole#1@1", succeededBy: "r2" },
  };
  state = reduceWorkflowRunsState(state, filled);
  assert.equal(state.runs.find((entry) => entry.runId === "r1").pendingHoles, undefined);

  // 再次到达（resume 后重新询问）：upsert 回表，ordinal 是新的实例。
  state = reduceWorkflowRunsState(state, {
    runId: "r1",
    sequence: 4,
    eventType: "hole-reached",
    payload: { holeId: "hole#1@1", ordinal: 1, stage: "第1步", prompt: "盘点" },
  });
  assert.equal(state.runs.find((entry) => entry.runId === "r1").pendingHoles.length, 1);

  // 终态清空（真实路径上 hole-filled 随 supersede 记在前驱、run-settled 随后收尾）。
  state = reduceWorkflowRunsState(state, {
    runId: "r1",
    sequence: 5,
    eventType: "run-settled",
    payload: { status: "stopped", stopReason: "superseded", supersededBy: "r2" },
  });
  const settledRun = state.runs.find((entry) => entry.runId === "r1");
  assert.equal(settledRun.status, "stopped");
  assert.equal(settledRun.stopReason, "superseded");
  assert.equal(settledRun.supersededBy, "r2");
  assert.equal(settledRun.pendingHoles, undefined);
});

test("WH-P2: golden——同一事件序对空态两次归约（冷回放）得到逐字节相同的状态", () => {
  const envelopes = [
    { runId: "g1", sequence: 1, eventType: "run-started", payload: { runId: "g1" } },
    {
      runId: "g1",
      sequence: 2,
      eventType: "hole-reached",
      payload: { holeId: "hole#1@1", ordinal: 1, stage: "s", prompt: "p" },
    },
    {
      runId: "g1",
      sequence: 3,
      eventType: "hole-filled",
      payload: { holeId: "hole#1@1", succeededBy: "g2" },
    },
    {
      runId: "g1",
      sequence: 4,
      eventType: "run-settled",
      payload: { status: "stopped", stopReason: "superseded", supersededBy: "g2" },
    },
  ];
  const reduceAll = () => {
    let state;
    for (const envelope of envelopes) state = reduceWorkflowRunsState(state, envelope) ?? state;
    return state;
  };
  const first = reduceAll();
  const run = first.runs.find((entry) => entry.runId === "g1");
  assert.equal(run.status, "stopped");
  assert.equal(run.supersededBy, "g2");
  assert.equal(run.pendingHoles, undefined);
  // 冷回放：同一事件序对空态再归约一遍，状态（含 revision）逐字节相同。
  const replayed = reduceAll();
  assert.equal(JSON.stringify(replayed), JSON.stringify(first));
});
