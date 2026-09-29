import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * D2 预算保险丝（specs/workflow-budget-fuses.md R1–R7；方案文档 §3 D2：P1 双 ask 闸 + P2 token 硬顶）。
 *
 * 两道 ask 闸是**节点级拒绝**（`AgentBudgetExceeded`，脚本可 catch——ask 返回 PromiseLike，
 * 拒绝通道存在，按 world-read/artifact 内容成员先例）；只有脚本没 catch 让它冒到顶层时，
 * 才由既有结算路径把 run 落成 errored，且 failure_json 保住原码（harness 侧 script-error.ts
 * 按词汇表 guard 重建）。**绝不静默截断**：被拒的 ask 拿到结构化 rejection，不落行、不派发。
 * token 闸（R4）走另一条拒绝通道论证：累计发生在 ask 结算之后、不在任何调用的返回通道上，
 * 脚本无处 catch，所以是 run 级 failRun（`TokenBudgetExceeded`，report-caps 的 void 先例）。
 *
 * 覆盖（对齐 spec 验收场景）：
 *   A 组——R2 总量闸：触发形态（details.limit:"total"）、拒绝后可 report 收尾、
 *          resume 预算连续（场景 3）、反复 resume 不刷新（场景 4）。
 *   B 组——R3 积压闸：liveNodes 现值判定（details.limit:"pending"）、无 promise 悬挂（场景 2）。
 *   D 组——amend 记账回归（场景 5）：inheritedTokens 起账与 ask 计数并存；导入命中每行
 *          恰好计一次，不从「前驱计数 + 本 run 行」双重累加（F' 起账法，论证回写在 spec R5）。
 *   E 组——显式 caps 成员只允许更严（宽松值被常量压回）、事件字段不回退（场景 7）、
 *          缺省路径由 BUDGET_CAPS 常量兜底（场景 9：本文件不复制数字）。
 *   F 组——计数纯由 journal 行派生（场景 8：给空 journal + 节点行即可重建，无 migration）。
 *   H 组——真 harness（真子进程 + 真 vm 沙箱）端到端：扇出被拒不悬挂、未捕获 → errored +
 *          failure_json.code 保真、普通脚本抛错仍归 DriverError、编造的码过不了词汇表 guard。
 *   T 组——R4 token 硬顶（场景 6）：事后判定、恰等不触发、缺省常量兜底、阈值随 run-started
 *          落 journal、resume 读回且**拒绝调用方新阈值**、amend lineage 累计、retune 不丢成员、
 *          straggler 只记账、harness tokenBudget 端到端。
 *   S 组——常量单一来源自检（三道闸的数字只从 BUDGET_CAPS 读）。
 */

const { BUDGET_CAPS, InMemoryJournalStore, inputHash, validate, WorkflowEngine, WorkflowError } =
  await import("../packages/dynamic-workflow/src/index.ts");
const { runWorkflowScript } = await import("../packages/dynamic-workflow-runtime/src/index.ts");

/** 引擎级测试共用的站点规格（untyped：turnEnded 即以末轮文本结算）。 */
const ASK_SPECS = new Map([
  ["ask#1", { typed: false }],
  ["ask#2", { typed: false }],
]);

/** 触发总量闸的显式 caps 一律用**小数字**（更严方向合法）；缺省方向的断言只经 BUDGET_CAPS。 */
const askRows = (journal, runId) => journal.listNodes(runId).filter((n) => n.kind === "ask").length;

/** 事件轨（StoredEvent → 事件本体）。 */
const eventsOf = (journal, runId) => journal.listEvents(runId).map((e) => e.event);

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-d2-budget-"));
  try {
    return await fn(dir);
  } finally {
    // Windows：harness finalize kill 子进程后目录句柄释放晚于 rmSync，重试而不是让 EPERM
    // 盖掉真正要断言的东西（与 workflow-script-determinism.test.mjs 同一处理）。
    try {
      rmSync(dir, { force: true, maxRetries: 8, recursive: true, retryDelay: 60 });
    } catch {
      // 交由系统回收临时目录。
    }
  }
}

/**
 * 一世引擎 + fake driver。settle 三态：
 *   "timeout"（缺省）——startAsk 后 setTimeout(0) 结算（既有测试的先例姿态）；
 *   "sync"——startAsk 内同步结算（大循环用，全微任务、无墙钟等待）；
 *   "never"——不结算（积压闸用：liveNodes 只进不出）。
 */
function makeLife(journal, options) {
  const {
    runId,
    caps = { maxConcurrency: 2 },
    scriptHash,
    answer = "subagent answer",
    settle = "timeout",
    inheritedTokens,
    tokenBudget,
    resumedFrom,
    importedCache,
  } = options;
  const dispatched = [];
  const holder = {};
  const driver = {
    journal,
    emit() {},
    createActorSession(actor) {
      return Promise.resolve({ id: `session-${actor.siteId}-${actor.ordinal}` });
    },
    startAsk(_session, instance) {
      dispatched.push({ siteId: instance.siteId, ordinal: instance.ordinal });
      if (settle === "sync") holder.engine.askTurnEnded(instance, answer);
      else if (settle === "timeout") {
        setTimeout(() => holder.engine.askTurnEnded(instance, answer), 0);
      }
    },
    respondToSubmit() {},
    cancelAsk() {},
    executeWorldRead(op, args) {
      return Promise.resolve({ op, args });
    },
  };
  const engine = new WorkflowEngine({
    askSpecs: ASK_SPECS,
    caps,
    driver,
    runId,
    validate,
    ...(scriptHash === undefined ? {} : { scriptHash }),
    ...(inheritedTokens === undefined ? {} : { inheritedTokens }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(importedCache === undefined ? {} : { importedCache }),
  });
  holder.engine = engine;
  return { dispatched, engine };
}

/** 断言一个 rejection 是结构化的预算拒绝（码 + details 三元组），不匹配 message 文本。 */
function assertBudgetRejection(error, limit, cap, actual) {
  assert.ok(error instanceof WorkflowError, `expected WorkflowError, got ${error}`);
  assert.equal(error.code, "AgentBudgetExceeded");
  assert.deepEqual(error.details, { limit, cap, actual });
  assert.equal(error.toJSON().details.limit, limit);
}

// ————————————————————————————————————————————————————————————————
// A 组：R2 总量闸（run 级连续计数）
// ————————————————————————————————————————————————————————————————

test("(A1) 总量闸：第 N+1 个 ask 被节点级拒绝，不留行不派发；catch 后 report/complete 照常（场景 1）", async () => {
  const journal = new InMemoryJournalStore();
  const life = makeLife(journal, {
    runId: "run-a1",
    caps: { maxConcurrency: 2, maxAsksPerRun: 2 },
  });
  const actor = life.engine.createActor("actor#1", "worker");
  await life.engine.ask("ask#1", actor, "task 1");
  await life.engine.ask("ask#1", actor, "task 2");

  await assert.rejects(life.engine.ask("ask#1", actor, "task 3"), (error) => {
    assertBudgetRejection(error, "total", 2, 2);
    return true;
  });
  // 被拒的 ask：没有 journal 行（拒绝可由计数在 resume 时确定性复现，无需行）、没有派发。
  assert.equal(journal.getNode("run-a1", "ask#1", 3), undefined);
  assert.equal(life.dispatched.length, 2);
  // 节点级拒绝**不结算 run**：脚本 catch 之后的收尾动作（report 已完成部分）仍然可用。
  life.engine.report("report#1", { note: "wound down after the budget fuse tripped" });
  life.engine.complete("partial");
  assert.equal((await life.engine.settled).status, "completed");
  assert.equal(journal.listNodes("run-a1").filter((n) => n.kind === "report").length, 1);
  assert.equal(askRows(journal, "run-a1"), 2);
});

test("(A2) resume 预算连续：计数按 journal 行数恢复，不是从零起（场景 3）", async () => {
  const journal = new InMemoryJournalStore();
  const caps = { maxConcurrency: 2, maxAsksPerRun: 2 };
  const first = makeLife(journal, { runId: "run-a2", caps, scriptHash: "h" });
  const actor1 = first.engine.createActor("actor#1", "worker");
  await first.engine.ask("ask#1", actor1, "task A");
  await first.engine.ask("ask#1", actor1, "task B");
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  assert.equal((await first.engine.settled).status, "stopped");
  assert.equal(askRows(journal, "run-a2"), 2);

  const second = makeLife(journal, { runId: "run-a2", caps, scriptHash: "h" });
  const actor2 = second.engine.createActor("actor#1", "worker");
  // replay 前缀：命中行短路结算——既不派发，也**不吃预算**（行已计在恢复的计数里）。
  assert.equal(await second.engine.ask("ask#1", actor2, "task A"), "subagent answer");
  assert.equal(await second.engine.ask("ask#1", actor2, "task B"), "subagent answer");
  // 新 ask：闸仍是关的——计数器恢复到停之前的值（内存计数与 journal 行数一致的直接后果）。
  await assert.rejects(second.engine.ask("ask#1", actor2, "task C"), (error) => {
    assertBudgetRejection(error, "total", 2, 2);
    return true;
  });
  assert.deepEqual(second.dispatched, []);
  assert.equal(askRows(journal, "run-a2"), 2);
  second.engine.stop("user");
  await second.engine.settled;
});

test("(A3) 反复 resume 不刷新预算：连 resume 三次，每次都触发同一道闸（场景 4）", async () => {
  const journal = new InMemoryJournalStore();
  const caps = { maxConcurrency: 2, maxAsksPerRun: 2 };
  const first = makeLife(journal, { runId: "run-a3", caps, scriptHash: "h" });
  const actor1 = first.engine.createActor("actor#1", "worker");
  await first.engine.ask("ask#1", actor1, "task A");
  await first.engine.ask("ask#1", actor1, "task B");
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  await first.engine.settled;

  for (let life = 2; life <= 4; life += 1) {
    const next = makeLife(journal, { runId: "run-a3", caps, scriptHash: "h" });
    const actor = next.engine.createActor("actor#1", "worker");
    await next.engine.ask("ask#1", actor, "task A");
    await next.engine.ask("ask#1", actor, "task B");
    await assert.rejects(
      next.engine.ask("ask#1", actor, `task C of life ${life}`),
      (error) => {
        assertBudgetRejection(error, "total", 2, 2);
        return true;
      },
      `life ${life}: the fuse must stay closed`,
    );
    assert.equal(askRows(journal, "run-a3"), 2, `life ${life}: rejected asks write no rows`);
    next.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
    await next.engine.settled;
  }
});

// ————————————————————————————————————————————————————————————————
// B 组：R3 积压闸（fan-out 宽度）
// ————————————————————————————————————————————————————————————————

test("(B1) 积压闸：liveNodes 到达上界后超出的 ask 被显式拒绝，没有任何 promise 悬挂（场景 2）", async () => {
  const journal = new InMemoryJournalStore();
  const life = makeLife(journal, {
    runId: "run-b1",
    caps: { maxConcurrency: 2, maxPendingAsks: 3 },
    settle: "never",
  });
  const actor = life.engine.createActor("actor#1", "worker");
  const asks = [];
  for (let i = 1; i <= 6; i += 1) asks.push(life.engine.ask("ask#1", actor, `fan ${i}`));

  // 准入是同步的：第 4–6 条在 engine.ask 调用当刻就拿到结构化拒绝（不是静默丢弃）。
  const tail = await Promise.allSettled(asks.slice(3));
  for (const outcome of tail) {
    assert.equal(outcome.status, "rejected");
    assertBudgetRejection(outcome.reason, "pending", 3, 3);
  }
  assert.equal(askRows(journal, "run-b1"), 3);

  // 前 3 条 live 且 driver 永不结算：run 停下时 abortInFlight 兑现它们——每个元素都有结果，
  // Promise.all 语义不被截断破坏（脚本能在有限时间内结算）。
  life.engine.stop("user");
  const head = await Promise.allSettled(asks.slice(0, 3));
  assert.ok(head.every((o) => o.status === "rejected" && o.reason.code === "Cancelled"));
  assert.equal((await life.engine.settled).status, "stopped");
});

// ————————————————————————————————————————————————————————————————
// D 组：amend 记账回归（场景 5）
// ————————————————————————————————————————————————————————————————

test("(D1) amend：inheritedTokens 起账与 ask 计数并存；导入命中的行恰好计一次、不双重累加", async () => {
  const journal = new InMemoryJournalStore();
  // 后继 run：caps 显式收紧到 2。导入缓存按引擎的注入契约手工构建（纯数据；生产中由
  // run service 读前驱 journal 构建）。前驱做过 task-0 / task-1 两问。
  const succ = makeLife(journal, {
    runId: "run-succ",
    caps: { maxConcurrency: 2, maxAsksPerRun: 2 },
    inheritedTokens: 1234,
    resumedFrom: "run-pred",
    importedCache: {
      actors: new Map([
        [
          "worker",
          {
            persona: { name: "worker" },
            entries: [
              { inputHash: inputHash("task-0"), result: "answer-0", messageBoundary: 2 },
              { inputHash: inputHash("task-1"), result: "answer-1", messageBoundary: 4 },
            ],
            transcriptSourceSessionId: "session-pred-worker",
          },
        ],
      ]),
      world: new Map(),
    },
  });
  // token 面：前驱累计随 createRun 起账（既有 inheritedTokens 纪律，零回归）。
  assert.equal(journal.getRun("run-succ").spentTokens, 1234);
  assert.equal(journal.getRun("run-succ").resumedFrom, "run-pred");

  const actor = succ.engine.createActor("actor#1", "worker");
  // 两条导入命中：零派发、各物化一行真 dwf_node、各计一次数。
  assert.equal(await succ.engine.ask("ask#1", actor, "task-0"), "answer-0");
  assert.equal(await succ.engine.ask("ask#1", actor, "task-1"), "answer-1");
  assert.deepEqual(succ.dispatched, []);
  assert.equal(askRows(journal, "run-succ"), 2);

  // 计数 = 本 run 自己的行数（2）⇒ 闸此刻关闭。若实现是「前驱计数 + 本 run 行」双重累加，
  // 第一条 ask 就会被拒；若是「amend 全额刷新」，下面这条会被放行——两个都错，这里钉住 F'。
  await assert.rejects(succ.engine.ask("ask#1", actor, "task-2"), (error) => {
    assertBudgetRejection(error, "total", 2, 2);
    return true;
  });
  assert.equal(askRows(journal, "run-succ"), 2);
  succ.engine.complete("done");
  assert.equal((await succ.engine.settled).status, "completed");
});

// ————————————————————————————————————————————————————————————————
// E 组：caps 显式成员、事件面不回退、缺省常量兜底
// ————————————————————————————————————————————————————————————————

test("(E1) 显式 caps 成员生效（更严方向）：maxAsksPerRun:1 时第二个 ask 即被拒", async () => {
  const journal = new InMemoryJournalStore();
  const life = makeLife(journal, {
    runId: "run-e1",
    caps: { maxConcurrency: 2, maxAsksPerRun: 1 },
  });
  const actor = life.engine.createActor("actor#1", "worker");
  await life.engine.ask("ask#1", actor, "only one");
  await assert.rejects(life.engine.ask("ask#1", actor, "one too many"), (error) => {
    assertBudgetRejection(error, "total", 1, 1);
    return true;
  });
  life.engine.stop("user");
  await life.engine.settled;
});

test("(E2) 事件字段不回退：run-started/run-caps-changed/usage-updated 键集合不变，retune 不丢预算成员（场景 7）", async () => {
  const journal = new InMemoryJournalStore();
  const events = (runId) => journal.listEvents(runId).map((e) => e.event);
  const life = makeLife(journal, {
    runId: "run-e2",
    caps: { maxConcurrency: 2, maxAsksPerRun: 5, maxPendingAsks: 4 },
  });
  const started = events("run-e2").find((e) => e.type === "run-started");
  assert.deepEqual(Object.keys(started).sort(), ["caps", "runId", "type"]);
  // token 阈值缺省 = 常量：creationCaps 把生效值折进 caps，随 run-started 落 journal（R4）。
  assert.deepEqual(started.caps, {
    maxConcurrency: 2,
    maxAsksPerRun: 5,
    maxPendingAsks: 4,
    maxTokensPerRun: BUDGET_CAPS.maxTokensPerRun,
  });

  assert.equal(life.engine.setMaxConcurrency(4), true);
  const changed = events("run-e2").find((e) => e.type === "run-caps-changed");
  assert.deepEqual(Object.keys(changed).sort(), ["caps", "previous", "runId", "type"]);
  // 整份换掉 caps 只改并发：预算成员原样带走（构造与 retune 都不得丢显式字段）。
  assert.deepEqual(changed.caps, {
    maxConcurrency: 4,
    maxAsksPerRun: 5,
    maxPendingAsks: 4,
    maxTokensPerRun: BUDGET_CAPS.maxTokensPerRun,
  });
  assert.deepEqual(changed.previous, {
    maxConcurrency: 2,
    maxAsksPerRun: 5,
    maxPendingAsks: 4,
    maxTokensPerRun: BUDGET_CAPS.maxTokensPerRun,
  });

  life.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: 100, toolCalls: 0, turns: 1 });
  const usage = events("run-e2").find((e) => e.type === "usage-updated");
  assert.deepEqual(Object.keys(usage).sort(), ["spentTokens", "type"]);
  assert.equal(usage.spentTokens, 100);

  // retune 之后显式总量上界仍被强制（成员没有在换 caps 时丢失的直接行为证明）。
  const actor = life.engine.createActor("actor#1", "worker");
  for (let i = 1; i <= 5; i += 1) await life.engine.ask("ask#1", actor, `t${i}`);
  await assert.rejects(life.engine.ask("ask#1", actor, "t6"), (error) => {
    assertBudgetRejection(error, "total", 5, 5);
    return true;
  });
  life.engine.complete("x");
  assert.equal((await life.engine.settled).status, "completed");
});

test("(E3) 积压闸缺省由 BUDGET_CAPS 兜底，宽松显式值被常量压回（只能收紧）", async () => {
  const journal = new InMemoryJournalStore();
  const life = makeLife(journal, {
    runId: "run-e3",
    // 显式值比常量宽松：生效的仍是常量（stricterCap 取较小者）。
    caps: { maxConcurrency: 2, maxPendingAsks: 1e9 },
    settle: "never",
  });
  const actor = life.engine.createActor("actor#1", "worker");
  const width = BUDGET_CAPS.maxPendingAsks + 2;
  const asks = [];
  for (let i = 1; i <= width; i += 1) asks.push(life.engine.ask("ask#1", actor, `burst ${i}`));

  const tail = await Promise.allSettled(asks.slice(BUDGET_CAPS.maxPendingAsks));
  assert.equal(tail.length, 2);
  for (const outcome of tail) {
    assert.equal(outcome.status, "rejected");
    assertBudgetRejection(
      outcome.reason,
      "pending",
      BUDGET_CAPS.maxPendingAsks,
      BUDGET_CAPS.maxPendingAsks,
    );
  }
  assert.equal(askRows(journal, "run-e3"), BUDGET_CAPS.maxPendingAsks);
  life.engine.stop("user");
  await Promise.allSettled(asks);
  await life.engine.settled;
});

test("(E4) 总量闸缺省由 BUDGET_CAPS 兜底：失控回环在常量处止步（场景 9——数字只从常量读）", async () => {
  const journal = new InMemoryJournalStore();
  const life = makeLife(journal, {
    runId: "run-e4",
    caps: { maxConcurrency: 2, maxAsksPerRun: 1e9 },
    settle: "sync",
  });
  const actor = life.engine.createActor("actor#1", "worker");
  // while(true){ ask(...) } 的等价物：不设上限地顺序派发，唯一的刹车是总量闸。
  for (let i = 1; i <= BUDGET_CAPS.maxAsksPerRun; i += 1) {
    await life.engine.ask("ask#1", actor, `loop ${i}`);
  }
  await assert.rejects(life.engine.ask("ask#1", actor, "loop overflow"), (error) => {
    assertBudgetRejection(error, "total", BUDGET_CAPS.maxAsksPerRun, BUDGET_CAPS.maxAsksPerRun);
    return true;
  });
  assert.equal(askRows(journal, "run-e4"), BUDGET_CAPS.maxAsksPerRun);
  life.engine.complete("done");
  assert.equal((await life.engine.settled).status, "completed");
});

// ————————————————————————————————————————————————————————————————
// F 组：计数纯由 journal 行派生（无 migration、无隐藏状态）
// ————————————————————————————————————————————————————————————————

test("(F1) 场景 8：给一个既有 run 行 + 若干 ask 节点行，恢复出的计数与引擎判定一致", async () => {
  const journal = new InMemoryJournalStore();
  const runId = "run-f1";
  // 手工铺 journal（不经任何引擎）：预算事实的所有者是 journal，计数器只是派生投影。
  journal.createRun({ runId, caps: { maxConcurrency: 2 }, spentTokens: 0, status: "stopped" });
  for (const ordinal of [1, 2]) {
    journal.putNode({
      runId,
      siteId: "ask#9",
      ordinal,
      kind: "ask",
      actorSiteId: "actor#9",
      actorOrdinal: 1,
      actorSeq: ordinal - 1,
      inputHash: `h${ordinal}`,
      status: "completed",
      result: "old",
    });
  }
  const life = makeLife(journal, { runId, caps: { maxConcurrency: 2, maxAsksPerRun: 2 } });
  const actor = life.engine.createActor("actor#1", "worker");
  await assert.rejects(life.engine.ask("ask#1", actor, "fresh"), (error) => {
    assertBudgetRejection(error, "total", 2, 2);
    return true;
  });
  life.engine.stop("user");
  await life.engine.settled;
});

// ————————————————————————————————————————————————————————————————
// H 组：真 harness 端到端（真子进程 + vm 沙箱 + NDJSON 桥）
// ————————————————————————————————————————————————————————————————

async function runScript(cwd, scriptText, { runId, caps, askSpecs = ASK_SPECS, lowered }) {
  const journal = new InMemoryJournalStore();
  const dispatched = [];
  const settlement = await runWorkflowScript({
    ...(lowered === undefined ? { scriptText } : { lowered, scriptText }),
    runId,
    cwd,
    caps,
    askSpecs,
    validate,
    scriptHash: `hash-${runId}`,
    makeDriver: (sink) => ({
      journal,
      emit() {},
      createActorSession(actor) {
        return Promise.resolve({ id: `session-${actor.siteId}-${actor.ordinal}` });
      },
      startAsk(_session, instance) {
        dispatched.push({ siteId: instance.siteId, ordinal: instance.ordinal });
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

test("(H1) 端到端扇出：宽度超过积压闸 → 每个被拒元素拿到显式 rejection，脚本 catch 后 report+return 照常 completed", async () => {
  await withTempDir(async (dir) => {
    const script = [
      'const a = agent("worker");',
      "const outcomes = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => a.ask(`task ${i}`)));",
      'const rejected = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason] : []));',
      'const codes = rejected.map((r) => String(r.code)).join(",");',
      "report({ rejected: rejected.length });",
      "return `settled:${outcomes.length},rejected:${rejected.length},codes:${codes}`;",
    ].join("\n");
    const { journal, settlement } = await runScript(dir, script, {
      runId: "run-h1",
      caps: { maxConcurrency: 2, maxPendingAsks: 2 },
      askSpecs: new Map([["ask#1", { typed: false }]]),
    });
    assert.equal(settlement.status, "completed");
    const expectedCodes = Array(4).fill("AgentBudgetExceeded").join(",");
    assert.equal(settlement.artifact, `settled:6,rejected:4,codes:${expectedCodes}`);
    // 只有被准入的 2 条落了行；4 条被拒的一个都没被静默塞进行程（无行、无派发、有结果）。
    assert.equal(askRows(journal, "run-h1"), 2);
    // catch 之后的 report 照常落 journal（dts.ts 对 report 存在意义的说明在此成立）。
    assert.equal(journal.listNodes("run-h1").filter((n) => n.kind === "report").length, 1);
  });
});

test("(H2) 端到端未捕获：拒绝冒到顶层 → run 结算 errored，failure_json 保住 AgentBudgetExceeded（场景 1 后半）", async () => {
  await withTempDir(async (dir) => {
    const script = [
      'const a = agent("worker");',
      'const first = await a.ask("first task");',
      'const second = await a.ask("second task");',
      "return `${first}|${second}`;",
    ].join("\n");
    const { dispatched, journal, settlement } = await runScript(dir, script, {
      runId: "run-h2",
      caps: { maxConcurrency: 1, maxAsksPerRun: 1 },
      // 两个 await 语句 = 两个 ask 站点（站点 id 由 lowering 按调用点铸造：ask#1 / ask#2）。
      askSpecs: new Map([
        ["ask#1", { typed: false }],
        ["ask#2", { typed: false }],
      ]),
    });
    assert.equal(settlement.status, "errored");
    // 码保真：harness 的 scriptThrowError 按词汇表 guard 用原码重建，而不是一律折 DriverError。
    assert.equal(settlement.error.code, "AgentBudgetExceeded");
    assert.match(settlement.error.message, /budget exhausted/i);
    assert.equal(dispatched.length, 1);
    const record = journal.getRun("run-h2");
    assert.equal(record.status, "errored");
    assert.equal(record.failure.code, "AgentBudgetExceeded");
    assert.match(record.failure.message, /budget exhausted/i);
    // 现状钉住：details 不过沙箱线（WireError 只带 code/violations/finalText），三个数在
    // message 文本里存活。要结构化 details 直达 failure_json 得加宽线协议——刻意不在本项做。
    assert.equal(record.failure.details, undefined);
  });
});

test("(H3) 回归：普通脚本抛错仍归 DriverError（码保真没有扩大化）", async () => {
  await withTempDir(async (dir) => {
    const { settlement } = await runScript(dir, 'throw new Error("plain boom");', {
      runId: "run-h3",
      caps: { maxConcurrency: 1 },
      askSpecs: new Map(),
    });
    assert.equal(settlement.status, "errored");
    assert.equal(settlement.error.code, "DriverError");
    assert.match(settlement.error.message, /plain boom/);
  });
});

test("(H4) 词汇表 guard：脚本编造的 code 不进 failure_json 的稳定词汇表", async () => {
  await withTempDir(async (dir) => {
    // hand-written lowered 体（raw JS，绕开编译期类型面——被测对象是 harness 的归一，不是编译器）。
    const { settlement } = await runScript(dir, "", {
      runId: "run-h4",
      caps: { maxConcurrency: 1 },
      askSpecs: new Map(),
      lowered: 'const e = new Error("forged"); e.code = "Banana"; throw e;',
    });
    assert.equal(settlement.status, "errored");
    assert.equal(settlement.error.code, "DriverError");
    assert.match(settlement.error.message, /forged/);
  });
});

test("(H4b) 边界如实钉住：编造一个**词汇表内**的码与真拒绝不可区分（沙箱不是安全边界）", async () => {
  await withTempDir(async (dir) => {
    const { settlement } = await runScript(dir, "", {
      runId: "run-h4b",
      caps: { maxConcurrency: 1 },
      askSpecs: new Map(),
      lowered:
        'const e = new Error("forged but in-vocabulary"); e.code = "AgentBudgetExceeded"; throw e;',
    });
    assert.equal(settlement.status, "errored");
    // guard 挡的是词汇表污染，不是脚本伪造（脚本是调用方给的代码，威胁模型里不是对手；
    // 与 child-source.ts 对 args freeze 的自我定位一致）。
    assert.equal(settlement.error.code, "AgentBudgetExceeded");
  });
});

// ————————————————————————————————————————————————————————————————
// T 组：R4 token 预算硬顶（P2 已落地）——事后判定、failRun、阈值落 journal、resume 沿用
// ————————————————————————————————————————————————————————————————

test("(T1) 显式阈值：事后判定 → run 整体 errored；越顶那笔 usage-updated 照常发出（R6 不多发不少发）", async () => {
  const journal = new InMemoryJournalStore();
  const life = makeLife(journal, {
    runId: "run-t1",
    caps: { maxConcurrency: 2 },
    tokenBudget: 100,
  });
  // 阈值落 journal 的载体 = run-started 事件的 caps 成员（零 SQL，事件即锚点）。
  const started = eventsOf(journal, "run-t1").find((e) => e.type === "run-started");
  assert.equal(started.caps.maxTokensPerRun, 100);

  const stats = (tokens) => ({ tokens, toolCalls: 0, turns: 1 });
  life.engine.askStats({ siteId: "ask#1", ordinal: 1 }, stats(60));
  assert.equal(journal.getRun("run-t1").status, "running"); // 60 ≤ 100：未越顶
  life.engine.askStats({ siteId: "ask#1", ordinal: 1 }, stats(50)); // 110 > 100：越顶
  const settlement = await life.engine.settled;
  assert.equal(settlement.status, "errored");
  assert.equal(settlement.error.code, "TokenBudgetExceeded");
  assert.match(settlement.error.message, /token budget exhausted/i);
  // 上账先于失败：spent_tokens 列 = 越顶值，failure_json 带码（原因入 journal）。
  assert.equal(journal.getRun("run-t1").spentTokens, 110);
  assert.equal(journal.getRun("run-t1").failure.code, "TokenBudgetExceeded");
  // 事件序：越顶那笔 usage-updated 照发，run-settled 收尾（run-settled 必须是最后一条）。
  const events = eventsOf(journal, "run-t1");
  const last = events[events.length - 1];
  assert.equal(last.type, "run-settled");
  assert.equal(last.error.code, "TokenBudgetExceeded");
  const beforeLast = events[events.length - 2];
  assert.equal(beforeLast.type, "usage-updated");
  assert.equal(beforeLast.spentTokens, 110);
});

test("(T2) 判定边界：spent == budget 不触发（严格大于才越顶），下一笔 +1 才触发", async () => {
  const journal = new InMemoryJournalStore();
  const life = makeLife(journal, {
    runId: "run-t2",
    caps: { maxConcurrency: 2 },
    tokenBudget: 100,
  });
  life.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: 100, toolCalls: 0, turns: 1 });
  assert.equal(journal.getRun("run-t2").status, "running");
  life.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: 1, toolCalls: 0, turns: 1 });
  const settlement = await life.engine.settled;
  assert.equal(settlement.status, "errored");
  assert.equal(settlement.error.code, "TokenBudgetExceeded");
});

test("(T3) 缺省由 BUDGET_CAPS.maxTokensPerRun 兜底；宽松显式值被常量压回（只能收紧）", async () => {
  const journal = new InMemoryJournalStore();
  const cap = BUDGET_CAPS.maxTokensPerRun;
  // 缺省：run-started 的 caps 携带常量；恰在常量不触发，+1 就地结算。
  const dflt = makeLife(journal, { runId: "run-t3a", caps: { maxConcurrency: 2 } });
  const started = eventsOf(journal, "run-t3a").find((e) => e.type === "run-started");
  assert.equal(started.caps.maxTokensPerRun, cap);
  dflt.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: cap, toolCalls: 0, turns: 1 });
  assert.equal(journal.getRun("run-t3a").status, "running");
  dflt.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: 1, toolCalls: 0, turns: 1 });
  const a = await dflt.engine.settled;
  assert.equal(a.status, "errored");
  assert.equal(a.error.code, "TokenBudgetExceeded");
  // 宽松显式值（常量 × 2）被压回常量：生效阈值仍是常量。
  const loose = makeLife(journal, {
    runId: "run-t3b",
    caps: { maxConcurrency: 2 },
    tokenBudget: cap * 2,
  });
  const startedB = eventsOf(journal, "run-t3b").find((e) => e.type === "run-started");
  assert.equal(startedB.caps.maxTokensPerRun, cap);
  loose.engine.askStats(
    { siteId: "ask#1", ordinal: 1 },
    { tokens: cap + 1, toolCalls: 0, turns: 1 },
  );
  const b = await loose.engine.settled;
  assert.equal(b.status, "errored");
  assert.equal(b.error.code, "TokenBudgetExceeded");
});

test("(T4) 阈值随第一世 run-started 落 journal；resume 读回原值、拒绝调用方给的新阈值（场景 6）", async () => {
  const journal = new InMemoryJournalStore();
  const caps = { maxConcurrency: 2 };
  const first = makeLife(journal, { runId: "run-t4", caps, tokenBudget: 500, scriptHash: "h" });
  first.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: 400, toolCalls: 0, turns: 1 });
  first.engine.stop("interrupted", new WorkflowError("Interrupted", "test: host died"));
  assert.equal((await first.engine.settled).status, "stopped");
  assert.equal(journal.getRun("run-t4").spentTokens, 400);

  // 第二世：调用方给了一个更松的新阈值——必须被忽略，沿用 journal 里的 500；
  // spentTokens 从 400 续（剩余预算 100 随 journal 落库、resume 沿用的直接后果）。
  const second = makeLife(journal, {
    runId: "run-t4",
    caps,
    tokenBudget: 999999,
    scriptHash: "h",
  });
  const starts = eventsOf(journal, "run-t4").filter((e) => e.type === "run-started");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].caps.maxTokensPerRun, 500); // 第二世 run-started 带的是读回值
  second.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: 200, toolCalls: 0, turns: 1 });
  const settlement = await second.engine.settled;
  assert.equal(settlement.status, "errored"); // 600 > 500（若按 999999 则不会触发）
  assert.equal(settlement.error.code, "TokenBudgetExceeded");
  assert.equal(journal.getRun("run-t4").spentTokens, 600);
});

test("(T5) amend 记账：inheritedTokens 计入本 run 预算——判定基于 lineage 累计用量（R5）", async () => {
  const journal = new InMemoryJournalStore();
  const succ = makeLife(journal, {
    runId: "run-t5",
    caps: { maxConcurrency: 2 },
    tokenBudget: 500,
    inheritedTokens: 450,
    resumedFrom: "run-pred",
  });
  assert.equal(journal.getRun("run-t5").spentTokens, 450);
  succ.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: 100, toolCalls: 0, turns: 1 });
  const settlement = await succ.engine.settled; // 450 + 100 = 550 > 500
  assert.equal(settlement.status, "errored");
  assert.equal(settlement.error.code, "TokenBudgetExceeded");
});

test("(T6) 并发 retune 不丢 token 阈值成员，retune 后阈值仍被强制（R6/场景 7）", async () => {
  const journal = new InMemoryJournalStore();
  const life = makeLife(journal, {
    runId: "run-t6",
    caps: { maxConcurrency: 2 },
    tokenBudget: 500,
  });
  assert.equal(life.engine.setMaxConcurrency(4), true);
  const changed = eventsOf(journal, "run-t6").find((e) => e.type === "run-caps-changed");
  assert.equal(changed.caps.maxConcurrency, 4);
  assert.equal(changed.caps.maxTokensPerRun, 500);
  assert.equal(changed.previous.maxTokensPerRun, 500);
  life.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: 501, toolCalls: 0, turns: 1 });
  const settlement = await life.engine.settled;
  assert.equal(settlement.status, "errored");
  assert.equal(settlement.error.code, "TokenBudgetExceeded");
});

test("(T7) 结算后到达的越顶 stats：只记账、不发事件、不判定——stopped 语义不被盖写（first-wins）", async () => {
  const journal = new InMemoryJournalStore();
  const life = makeLife(journal, {
    runId: "run-t7",
    caps: { maxConcurrency: 2 },
    tokenBudget: 100,
  });
  life.engine.stop("user");
  assert.equal((await life.engine.settled).status, "stopped");
  const eventsBefore = eventsOf(journal, "run-t7").length;
  life.engine.askStats({ siteId: "ask#1", ordinal: 1 }, { tokens: 900, toolCalls: 0, turns: 1 });
  // 账仍要入（可 resume 的 run 用量跨生命周期连续），但 run 保持 stopped、事件流不再生长。
  assert.equal(journal.getRun("run-t7").status, "stopped");
  assert.equal(journal.getRun("run-t7").spentTokens, 900);
  assert.equal(eventsOf(journal, "run-t7").length, eventsBefore);
});

test("(T8) 端到端：harness tokenBudget verbatim 透传 → 真实 sink 路径越顶 → errored + failure_json 码保真", async () => {
  await withTempDir(async (dir) => {
    const script = ['const a = agent("worker");', 'return await a.ask("only task");'].join("\n");
    const journal = new InMemoryJournalStore();
    const settlement = await runWorkflowScript({
      scriptText: script,
      runId: "run-t8",
      cwd: dir,
      caps: { maxConcurrency: 1 },
      askSpecs: new Map([["ask#1", { typed: false }]]),
      validate,
      scriptHash: "hash-t8",
      tokenBudget: 10,
      makeDriver: (sink) => ({
        journal,
        emit() {},
        createActorSession(actor) {
          return Promise.resolve({ id: `s-${actor.siteId}-${actor.ordinal}` });
        },
        startAsk(_session, instance) {
          // 用量在 turn 结算前回报（真实 driver 的 askStats 时序同族）：引擎当场越顶
          // （50 > 10）→ failRun → abortInFlight 拒绝在飞 ask → 脚本未 catch → 顶层
          // → complete 带码回传 → harness 按原码重建（first-wins 下不重复结算）。
          sink.askStats(instance, { tokens: 50, toolCalls: 0, turns: 1 });
        },
        respondToSubmit() {},
        cancelAsk() {},
        executeWorldRead(op, args) {
          return Promise.resolve({ op, args });
        },
      }),
    });
    assert.equal(settlement.status, "errored");
    assert.equal(settlement.error.code, "TokenBudgetExceeded");
    assert.equal(journal.getRun("run-t8").failure.code, "TokenBudgetExceeded");
    assert.equal(journal.getRun("run-t8").spentTokens, 50);
  });
});

// ————————————————————————————————————————————————————————————————
// S 组：常量单一来源（场景 9）
// ————————————————————————————————————————————————————————————————

test("(S1) 常量单一来源：本文件不复制 BUDGET_CAPS 的数字；三道闸的常量都有值（P2 已落地）", () => {
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const value of [
    BUDGET_CAPS.maxAsksPerRun,
    BUDGET_CAPS.maxPendingAsks,
    BUDGET_CAPS.maxTokensPerRun,
  ]) {
    assert.equal(typeof value, "number");
    assert.ok(Number.isInteger(value) && value > 0);
    assert.ok(!self.includes(String(value)), `test file must not hardcode the cap value ${value}`);
  }
  // 积压上界必须严格小于总量上界：否则 R3 永远不会先于 R2 触发，单 burst 的行洪峰失去刹车。
  assert.ok(BUDGET_CAPS.maxPendingAsks < BUDGET_CAPS.maxAsksPerRun);
});
