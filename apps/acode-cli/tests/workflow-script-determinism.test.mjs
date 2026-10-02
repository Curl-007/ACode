import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * A9 待验证项（docs/cli-dispatch-and-system-prompt-upgrade-plan.md §8.2 #4）：
 * **workflow 脚本确定性约束现状**——harness/engine 是否限制或检测脚本内的非确定性来源，
 * 以及 resume 的前缀比对（script_text / journal / inputHash）在非确定性脚本下的行为。
 *
 * 本文件是**只读核对**的证据：它断言的是当前实现的实际行为（含缺口），不是期望行为。
 * 三组事实：
 *   A 组——编译期：`Date.now()` / `Math.random()` / 无参 `new Date()` **零诊断通过**
 *          （child-source.ts:227 自称「编译诊断是 suspenders」，对这三个源不成立）；
 *          同一套编译环境确实拒 `process`（纯度契约在编译期是真的，只是不含时钟/随机）。
 *   B 组——运行期：沙箱 BOOTSTRAP（child-source.ts:227-247）的三个禁令**确实生效**，
 *          且刻意留住了确定性的 Date 面（`new Date(ms)` / `Date.parse` / `Date.UTC`）。
 *   C 组——残余面：禁令可绕（原型链上溯到 NativeDate），绕过后 run 照常 completed；
 *          沙箱 context 里还有哪些全局，用一次探测把边界钉死。
 *   D 组——resume 前缀比对：script_text 门是**逐字节**的（engine.ts:336-348），
 *          检测不到语义非确定性；journal replay 的 inputHash 门是**按 (siteId, ordinal) 定位**的
 *          （scheduler.ts:128-135），值分歧大声失败，而**站点形状分歧 / 次数分歧静默转 live**。
 */

const {
  analyzeWorkflowScript,
  compileWorkflowScript,
  InMemoryJournalStore,
  validate,
  WorkflowEngine,
  WorkflowError,
} = await import("../packages/dynamic-workflow/src/index.ts");
const { runWorkflowScript } = await import("../packages/dynamic-workflow-runtime/src/index.ts");

/** 一个 ask 站点 + 一个 actor 站点的最小脚本形态（site id 由 lowering 铸造：actor#1 / ask#1）。 */
const ASK_SPECS = new Map([
  ["ask#1", { typed: false }],
  ["ask#2", { typed: false }],
]);
const CAPS = { maxConcurrency: 2 };

/**
 * 「永久停驻」的探测窗口（ms）。它不是超时兜底，而是一次有界观察：窗口内没结算就断言停驻。
 * 取 400 ms 是因为本文件里真派发的 ask 从准入到结算都在个位数 ms（见 D4/D5 的 duration）。
 */
const PARKED_PROBE_MS = 400;

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-a9-determinism-"));
  try {
    return await fn(dir);
  } finally {
    // Windows 实测：沙箱子进程以该目录为 cwd，harness 在 finalize 时 kill 它，但目录句柄的
    // 释放晚于 rmSync——不加 maxRetries 会 EPERM，而那个 EPERM 会盖掉本文件真正要断言的东西
    // （run 的结算形态）。清理失败只留垃圾在 OS 临时目录，不影响结论。
    try {
      rmSync(dir, { force: true, maxRetries: 8, recursive: true, retryDelay: 60 });
    } catch {
      // 交由系统回收临时目录。
    }
  }
}

/**
 * 跑一份脚本过**真 harness**（真子进程 + 真 vm 沙箱），fake driver 只负责把 ask 立刻结算掉。
 * 返回 { settlement, dispatched }：dispatched 记录 driver 真被派发过几次 ask（replay 命中不计）。
 */
async function runScript(cwd, scriptText, { runId = "run-a9", lowered } = {}) {
  const journal = new InMemoryJournalStore();
  const dispatched = [];
  const settlement = await runWorkflowScript({
    ...(lowered === undefined ? { scriptText } : { lowered, scriptText }),
    runId,
    cwd,
    caps: CAPS,
    askSpecs: ASK_SPECS,
    validate,
    scriptHash: "hash-a9",
    makeDriver: (sink) => ({
      journal,
      emit() {},
      createActorSession(actor) {
        return Promise.resolve({ id: `session-${actor.siteId}-${actor.ordinal}` });
      },
      startAsk(_session, instance, message) {
        dispatched.push({ siteId: instance.siteId, ordinal: instance.ordinal, message });
        setTimeout(() => sink.askTurnEnded(instance, "subagent answer"), 0);
      },
      respondToSubmit() {},
      cancelAsk() {},
      executeWorldRead(op, args) {
        return Promise.resolve({ op, args });
      },
    }),
  });
  return { dispatched, journal, settlement };
}

// ————————————————————————————————————————————————————————————————
// A 组：编译期有没有确定性诊断（child-source.ts:227 声称的 "suspenders"）
// ————————————————————————————————————————————————————————————————

test("(A1) Date.now()/Math.random()/无参 new Date() 编译期零诊断——不存在确定性 suspenders", () => {
  const script = [
    "const t = Date.now();",
    "const r = Math.random();",
    "const d = new Date();",
    "log(String(t) + String(r) + d.toISOString());",
  ].join("\n");
  const compiled = compileWorkflowScript(script);
  assert.deepEqual(compiled.diagnostics, []);
  assert.equal(compiled.ok, true);
  // analyze 是「可提交」闸（handler 的 analyze 阶段用它）：同样放行。
  const analyzed = analyzeWorkflowScript(script);
  assert.equal(analyzed.ok, true);
  assert.deepEqual(analyzed.diagnostics, []);
});

test("(A2) 对照：同一套编译环境确实拒 process——纯度契约在编译期是真的，只是不含时钟/随机", () => {
  const compiled = compileWorkflowScript("log(process.cwd());");
  assert.equal(compiled.ok, false);
  assert.ok(compiled.diagnostics.length > 0);
  assert.match(compiled.diagnostics[0].message, /Cannot find name 'process'/);
});

test("(A3) 原型链上溯取 NativeDate 的写法同样编译通过（绕禁令不需要 lowered 注入）", () => {
  const compiled = compileWorkflowScript("const t = Object.getPrototypeOf(Date).now();\nlog(String(t));");
  assert.equal(compiled.ok, true);
  assert.deepEqual(compiled.diagnostics, []);
});

// ————————————————————————————————————————————————————————————————
// B 组：运行期禁令（child-source.ts:227-247 的 belt）是否真生效
// ————————————————————————————————————————————————————————————————

test("(B1) 脚本调 Date.now() → run 以 errored 结算，错误文本就是禁令文本", async () => {
  await withTempDir(async (dir) => {
    const { settlement } = await runScript(dir, "return String(Date.now());");
    assert.equal(settlement.status, "errored");
    assert.match(settlement.error.message, /Date\.now\(\) is disabled in workflows/);
  });
});

test("(B2) 脚本调 Math.random() → 同样 errored", async () => {
  await withTempDir(async (dir) => {
    const { settlement } = await runScript(dir, "return String(Math.random());");
    assert.equal(settlement.status, "errored");
    assert.match(settlement.error.message, /Math\.random\(\) is disabled in workflows/);
  });
});

test("(B3) 无参 new Date() → 同样 errored", async () => {
  await withTempDir(async (dir) => {
    const { settlement } = await runScript(dir, "return new Date().toISOString();");
    assert.equal(settlement.status, "errored");
    assert.match(settlement.error.message, /argless new Date\(\) is disabled in workflows/);
  });
});

test("(B4) 确定性的 Date 面被刻意留住：new Date(ms) / Date.parse / Date.UTC 照常可用", async () => {
  await withTempDir(async (dir) => {
    const { settlement } = await runScript(
      dir,
      [
        "const iso = new Date(0).toISOString();",
        "const parsed = Date.parse('2020-01-01T00:00:00Z');",
        "const utc = Date.UTC(2020, 0, 1);",
        "return `${iso}|${parsed}|${utc}`;",
      ].join("\n"),
    );
    assert.equal(settlement.status, "completed");
    assert.equal(settlement.artifact, "1970-01-01T00:00:00.000Z|1577836800000|1577836800000");
  });
});

// ————————————————————————————————————————————————————————————————
// C 组：禁令的覆盖面——绕过与残余全局面
// ————————————————————————————————————————————————————————————————

test("(C1) 绕过：Object.getPrototypeOf(Date).now() 拿到真时钟，run 照常 completed", async () => {
  await withTempDir(async (dir) => {
    const before = Date.now();
    const { settlement } = await runScript(dir, "return Object.getPrototypeOf(Date).now();");
    const after = Date.now();
    assert.equal(settlement.status, "completed");
    assert.equal(typeof settlement.artifact, "number");
    // 断言它真是**墙钟**（而不是 0 / NaN / 抛错后的兜底）：落在测试自身的取值窗口内。
    assert.ok(
      settlement.artifact >= before && settlement.artifact <= after,
      `expected a real wall-clock reading, got ${settlement.artifact}`,
    );
  });
});

test("(C2) 沙箱 context 的全局面：探测哪些时钟/随机/IO 源实际可达", async () => {
  await withTempDir(async (dir) => {
    const { settlement } = await runScript(
      dir,
      [
        "const names = ['process','require','performance','setTimeout','setInterval','crypto',",
        "  'Math','Date','__NativeDate','__send','__host','__emit','__pending','globalThis'];",
        "const seen: Record<string, string> = {};",
        "for (const n of names) {",
        "  let t = 'absent';",
        "  try { t = eval('typeof ' + n); } catch { t = 'throws'; }",
        "  seen[n] = t;",
        "}",
        "return JSON.stringify(seen);",
      ].join("\n"),
    );
    assert.equal(settlement.status, "completed");
    const seen = JSON.parse(settlement.artifact);
    // 时钟/随机的替代源在裸 vm context 里不可达（这是禁令得以成立的前提）。
    assert.equal(seen.performance, "undefined");
    assert.equal(seen.setTimeout, "undefined");
    assert.equal(seen.setInterval, "undefined");
    assert.equal(seen.crypto, "undefined");
    assert.equal(seen.process, "undefined");
    assert.equal(seen.require, "undefined");
    // 但 BOOTSTRAP 自己的顶层 var 是 context 全局，脚本按名字就够得着原生 Date。
    assert.equal(seen.__NativeDate, "function");
    assert.equal(seen.Math, "object");
    assert.equal(seen.Date, "function");
    // 传输面同样暴露（__send 可直接往父进程写 NDJSON）：这不是安全边界，但它决定了
    // 「运行期禁令」的强度上限——它挡的是脚本作者的直路，不是刻意绕行。
    assert.equal(seen.__send, "function");
  });
});

test("(C3) __NativeDate 直接可用：hand-written lowered 体连原型链都不必走", async () => {
  await withTempDir(async (dir) => {
    const { settlement } = await runScript(dir, "", { lowered: "return __NativeDate.now();" });
    assert.equal(settlement.status, "completed");
    assert.equal(typeof settlement.artifact, "number");
  });
});

// ————————————————————————————————————————————————————————————————
// D 组：resume 前缀比对在非确定性脚本下的行为（engine 结算路径）
//
// 直接驱动引擎而不是过 harness：replay 门只看 (siteId, ordinal, inputHash)，
// 它无从知道分歧来自 Date.now() 还是别的；所以「非确定性脚本」在这层的等价物就是
// 「同一份脚本文本在两世里产生了不同的 host 调用序列/取值」。
// ————————————————————————————————————————————————————————————————

/** 一世引擎：fake driver 把 ask 立刻结算成固定文本；返回引擎与派发记录。 */
function makeLife(journal, { runId, scriptHash, answer = "subagent answer" }) {
  const dispatched = [];
  const holder = {};
  const driver = {
    journal,
    emit() {},
    createActorSession(actor) {
      return Promise.resolve({ id: `session-${actor.siteId}-${actor.ordinal}` });
    },
    startAsk(_session, instance) {
      dispatched.push({ ordinal: instance.ordinal, siteId: instance.siteId });
      setTimeout(() => holder.engine.askTurnEnded(instance, answer), 0);
    },
    respondToSubmit() {},
    cancelAsk() {},
    executeWorldRead(op, args) {
      return Promise.resolve({ op, args });
    },
  };
  const engine = new WorkflowEngine({
    askSpecs: ASK_SPECS,
    caps: CAPS,
    driver,
    runId,
    validate,
    ...(scriptHash === undefined ? {} : { scriptHash }),
  });
  holder.engine = engine;
  return { dispatched, engine };
}

/** 一次 ask 走完（准入 → 派发 → turn 结束结算）。 */
async function askOnce(engine, siteId, actorId, instructions) {
  const promise = engine.ask(siteId, actorId, instructions);
  return promise;
}

test("(D1) resume 的 script_text 门是逐字节的：scriptHash 不符 → 构造期同步抛 ScriptHashMismatch", async () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-d1";
  const first = makeLife(journal, { runId, scriptHash: "hash-v1" });
  const actor = first.engine.createActor("actor#1", "worker");
  await askOnce(first.engine, "ask#1", actor, "A");
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  assert.equal((await first.engine.settled).status, "stopped");

  // 同一 runId、另一份脚本的哈希：这就是「拿另一份脚本复用同一个 runId」。
  assert.throws(
    () => makeLife(journal, { runId, scriptHash: "hash-v2" }),
    (error) => {
      assert.equal(error.code, "ScriptHashMismatch");
      assert.match(error.message, /its script changed/);
      assert.deepEqual(error.mismatch, { expected: "hash-v1", got: "hash-v2" });
      return true;
    },
  );
  // 门是同步抛出、不是 failRun：journal 行仍是 stopped（可 resume），没有被盖成 errored。
  assert.equal(journal.getRun(runId).status, "stopped");
});

test("(D2) 值分歧（同一站点、不同指令）→ replay 命中即 InputHashMismatch，run 大声 errored", async () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-d2";
  const first = makeLife(journal, { runId, scriptHash: "same-bytes" });
  const actor1 = first.engine.createActor("actor#1", "worker");
  await askOnce(first.engine, "ask#1", actor1, "instructions from life 1");
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  await first.engine.settled;

  // 第二世：脚本文本逐字节相同（scriptHash 相同），但脚本内取到的值不同 → ask 指令不同。
  const second = makeLife(journal, { runId, scriptHash: "same-bytes" });
  const actor2 = second.engine.createActor("actor#1", "worker");
  await assert.rejects(
    askOnce(second.engine, "ask#1", actor2, "instructions from life 2"),
    (error) => {
      assert.equal(error.code, "InputHashMismatch");
      assert.match(error.message, /the script is not deterministic, so the journal cannot be replayed/);
      return true;
    },
  );
  const settlement = await second.engine.settled;
  assert.equal(settlement.status, "errored");
  assert.equal(settlement.error.code, "InputHashMismatch");
  // 分歧点之后一次派发都没有：门在准入时就拦下了。
  assert.deepEqual(second.dispatched, []);
});

test("(D3) 站点形状分歧（改走另一个 ask 站点）→ live ask 被 hold 规则**永久停驻**：无报错、无超时、run 卡在 running", async () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-d3";
  const first = makeLife(journal, { runId, scriptHash: "same-bytes" });
  const actor1 = first.engine.createActor("actor#1", "worker");
  await askOnce(first.engine, "ask#1", actor1, "life 1 took the ask#1 branch");
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  await first.engine.settled;

  // 第二世走了另一条分支：ask#1 一行没碰，直接 ask#2（同一个 actor）。
  const second = makeLife(journal, { runId, scriptHash: "same-bytes" });
  const actor2 = second.engine.createActor("actor#1", "worker");
  const pending = askOnce(second.engine, "ask#2", actor2, "life 2 took the ask#2 branch").then(
    () => "settled",
    (error) => `rejected:${error.code ?? error.name}`,
  );
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("parked"), PARKED_PROBE_MS)),
  ]);

  // 实测：这条 ask 永远不结算。机制在 scheduler-types.ts:179——live 节点只在
  // `nextAdmitSeq >= recordedCount` 后才准入，而 nextAdmitSeq 只由**按 seq 到达的记录节点**推进
  // （:171-177）；本 actor 在 journal 里有 1 行 ask（scheduler.ts:86-90 数出来的 recordedCount），
  // 第二世却再也不会重发它 → 记录节点永不释放 → live 节点永久停在 pendingLive。
  assert.equal(outcome, "parked");
  assert.deepEqual(second.dispatched, []);
  // run 既没失败也没停：journal 行还是 running（读面看就是「在跑」）。
  assert.equal(journal.getRun(runId).status, "running");
  // 也没有任何事件说明它卡住了：run-stalled 由 driver 的 stall 时钟驱动，而那只时钟要先见过一次
  // model_retry_scheduled 才上膛（workflow-driver-concurrency.ts:311-315）——这里一次模型请求都没发。
  assert.deepEqual(
    journal.listEvents(runId).filter((e) => e.event.type === "run-stalled"),
    [],
  );

  // 收尾：显式 stop 让 run 结算——但**停驻的那条 ask 不会被释放**。abortInFlight 只遍历
  // liveNodes（scheduler.ts:330-342），而这条 ask 从没被准入成节点，它的 deferred 只活在
  // actor.pendingLive 的闭包里。生产里这不要命（harness 在 engine.settled 之后 kill 子进程，
  // harness.ts:343），但「stop 解不开停驻 ask」这件事本身要钉住：脚本侧的 await 永不返回。
  second.engine.stop("user");
  assert.equal((await second.engine.settled).status, "stopped");
  const afterStop = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("still-parked"), PARKED_PROBE_MS)),
  ]);
  assert.equal(afterStop, "still-parked");
  // 上一世的 ask#1 结果仍躺在 journal 里，永远不会被消费。
  // 序号是**每站点 1 起**（engine.ts:685-691 的 nextOrdinal 先加一再返回），所以第一世的
  // 那条记录是 ask#1@1，不是 @0。
  assert.equal(journal.getNode(runId, "ask#1", 1).status, "completed");
});

test("(D3b) 对照：换一个**新 actor** 走分歧分支就不停驻——停驻是「每 actor 记录节点须先排空」这条规则的产物", async () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-d3b";
  const first = makeLife(journal, { runId, scriptHash: "same-bytes" });
  const actor1 = first.engine.createActor("actor#1", "worker");
  await askOnce(first.engine, "ask#1", actor1, "life 1 on actor#1");
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  await first.engine.settled;

  // 第二世在**另一个 actor 站点**上继续：该 actor 的 recordedCount = 0，hold 规则无话可说。
  const second = makeLife(journal, { runId, scriptHash: "same-bytes" });
  const actor2 = second.engine.createActor("actor#2", "worker-2");
  const value = await askOnce(second.engine, "ask#2", actor2, "life 2 on a fresh actor");
  second.engine.complete({ value });
  assert.equal((await second.engine.settled).status, "completed");
  assert.deepEqual(second.dispatched, [{ ordinal: 1, siteId: "ask#2" }]);
});

test("(D4) 次数分歧（回环多跑一圈）→ 前缀静默复用，超出部分静默转 live，无报错", async () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-d4";
  const first = makeLife(journal, { runId, scriptHash: "same-bytes" });
  const actor1 = first.engine.createActor("actor#1", "worker");
  await askOnce(first.engine, "ask#1", actor1, "same instructions");
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  await first.engine.settled;
  assert.equal(first.dispatched.length, 1);

  // 第二世：同一站点跑三圈（失控回环的等价物）。
  const second = makeLife(journal, { runId, scriptHash: "same-bytes" });
  const actor2 = second.engine.createActor("actor#1", "worker");
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    results.push(await askOnce(second.engine, "ask#1", actor2, "same instructions"));
  }
  second.engine.complete({ results });
  const settlement = await second.engine.settled;

  assert.equal(settlement.status, "completed");
  assert.deepEqual(results, ["subagent answer", "subagent answer", "subagent answer"]);
  // 第 1 圈命中 journal（ask#1@1，零派发），第 2、3 圈（ask#1@2 / @3）没有记录 → live 派发两次。
  // 这条就是 D2 的输入：**replay 门不限制一个 run 累计能烧多少**，次数分歧只花钱不报错。
  assert.deepEqual(second.dispatched, [
    { ordinal: 2, siteId: "ask#1" },
    { ordinal: 3, siteId: "ask#1" },
  ]);
});

test("(D5) 哈希相同即静默复用：replay 命中零派发，且**同一 ordinal 上的不同语义调用**会被当成同一条", async () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-d5";
  const first = makeLife(journal, { runId, scriptHash: "same-bytes", answer: "life 1 answer" });
  const actor1 = first.engine.createActor("actor#1", "worker");
  await askOnce(first.engine, "ask#1", actor1, "identical instructions");
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  await first.engine.settled;

  const second = makeLife(journal, { runId, scriptHash: "same-bytes", answer: "life 2 answer" });
  const actor2 = second.engine.createActor("actor#1", "worker");
  const value = await askOnce(second.engine, "ask#1", actor2, "identical instructions");
  second.engine.complete({ value });
  await second.engine.settled;

  // 拿到的是**上一世**的答案，且第二世一次派发都没有：这是 resume 省钱的那条正路，
  // 也说明门的判据是「站点位置 + 输入哈希」，不是「这次调用在语义上是不是同一件事」。
  assert.equal(value, "life 1 answer");
  assert.deepEqual(second.dispatched, []);
});

test("(D6) world-read 走同一道门：args 分歧 → InputHashMismatch（不是 ask 专属）", async () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-d6";
  const first = makeLife(journal, { runId, scriptHash: "same-bytes" });
  await first.engine.worldRead("world#1", "read", ["a.txt"]);
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  await first.engine.settled;

  const second = makeLife(journal, { runId, scriptHash: "same-bytes" });
  await assert.rejects(second.engine.worldRead("world#1", "read", ["b.txt"]), (error) => {
    assert.equal(error.code, "InputHashMismatch");
    return true;
  });
  assert.equal((await second.engine.settled).status, "errored");
});

test("(D7) scriptHash 双方缺一即不校验：门是「两边都有才比」", async () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-d7";
  // 第一世不落 scriptHash（snippet / 老 journal 行的形状）。
  const first = makeLife(journal, { runId });
  const actor1 = first.engine.createActor("actor#1", "worker");
  await askOnce(first.engine, "ask#1", actor1, "A");
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  await first.engine.settled;
  assert.equal(journal.getRun(runId).scriptHash, undefined);

  // 第二世带着一个「谁的都不像」的哈希来 resume：engine.ts:336-340 的条件要求两边都在场，
  // 于是这里不抛——run 照常起来（后续仍受 inputHash 门约束）。
  const second = makeLife(journal, { runId, scriptHash: "hash-out-of-nowhere" });
  const actor2 = second.engine.createActor("actor#1", "worker");
  await assert.rejects(askOnce(second.engine, "ask#1", actor2, "B"), (error) => {
    assert.equal(error.code, "InputHashMismatch");
    return true;
  });
});
