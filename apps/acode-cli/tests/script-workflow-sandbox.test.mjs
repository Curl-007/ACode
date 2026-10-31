// 脚本工作流沙箱（vm realm）与落盘入口文件的端到端验证。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R4 / R5，验收场景 5 / 5a / 5b / 7 / 8 / 9 / 10。
//
// 这些测试**真的 spawn 子进程**：沙箱的性质（realm 隔离、ALS 跨 realm 传播、确定性禁令、
// 命令行长度）没有一条能靠读源码或 mock 断言出来。每条都跑一次真实的 node 子进程。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { runScriptWorkflowChild } =
  await import("../packages/cli-workflow/src/script-workflow-process.ts");

/**
 * 确定性事件循环屏障（house 惯用法，见 pause-gate.test.mjs:58「有界微任务 flush，绝不轮询真实时钟」）：
 * 有界地推进已就绪的微任务/宏任务轮次，让任何「本可结算」的 promise 反应（如 run 的 .then 里
 * 置位 settled、推 order）在检查前跑到；真正 park 在异步边界上的 promise 再多 flush 也不会结算。
 * 用它替代固定 setTimeout 墙钟窗口——不赌毫秒数，只推进就绪工作，因此在并行负载下不飘。
 */
async function flushLoop(turns = 32) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 造一份最小合法的脚本文档；body 是**已剥掉 meta 头**的正文（与生产一致）。 */
function makeDocument(body, dir) {
  return {
    body,
    content: body,
    hash: "test-hash",
    meta: { description: "d", name: "n", phases: [] },
    path: join(dir, "script.workflow.js"),
  };
}

/**
 * 跑一段脚本，回收它发出的 agent 请求与事件。
 * agentValue 决定每个 agent 请求的返回；缺省回显 prompt，便于断言。
 */
async function runScript(body, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "script-workflow-sandbox-"));
  const agents = [];
  const events = [];
  try {
    const result = await runScriptWorkflowChild({
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.budgetTotal === undefined ? {} : { budgetTotal: options.budgetTotal }),
      document: makeDocument(body, dir),
      handleEvent: (event) => {
        events.push(event);
      },
      handleRequest: async (request) => {
        agents.push(request);
        if (request.type !== "agent") return null;
        const value =
          options.agentValue === undefined ? `ok:${request.payload.prompt}` : options.agentValue;
        return { stats: { tokens: { total: options.tokensPerAgent ?? 10 } }, value };
      },
      runId: options.runId ?? "wf_sandbox-test",
      signal: options.signal,
      workingDirectory: dir,
    });
    return { agents, dir, events, value: result.value };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// R4 基本执行形态
// ---------------------------------------------------------------------------

test("R4: 脚本在沙箱里跑通，agent() 经 stdio 打到父进程并带回结果", async () => {
  const { agents, value } = await runScript(`
    const a = await agent("first");
    const b = await agent("second");
    return { a, b, sum: 1 };
  `);
  assert.deepEqual(value, { a: "ok:first", b: "ok:second", sum: 1 });
  assert.equal(agents.length, 2);
  assert.deepEqual(agents[0].payload.prompt, "first");
  assert.equal(agents[0].payload.callPath, "root/agent0");
  assert.equal(agents[1].payload.callPath, "root/agent1");
});

test("P1 SWF-01: child close 后仍排空已接纳的 agent 请求，再返回脚本结果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "script-workflow-drain-"));
  let requestSeen;
  const seen = new Promise((resolve) => {
    requestSeen = resolve;
  });
  let release;
  let requestDone = false;
  const request = new Promise((resolve) => {
    release = resolve;
  });
  // 事件顺序账本：把「父侧 handler 排空」与「run 结算」两个时刻记成可正断言的序列，
  // 取代原来靠墙钟窗口猜「谁先谁后」。R19.1 的实质就是 handler 必须先于 run 结算。
  const order = [];
  try {
    const run = runScriptWorkflowChild({
      document: makeDocument('void agent("in-flight"); return "done";', dir),
      handleEvent: () => {},
      handleRequest: async () => {
        requestSeen();
        await request;
        requestDone = true;
        order.push("handler-drained");
        return { value: "agent-result" };
      },
      runId: "wf_drain-request",
      workingDirectory: dir,
    });
    // 正向信号：请求已抵达父进程、handler 已进入并 park 在 release 门上（seen 是确定性的，
    // 由 handler 自己 resolve，不赌时间）。此刻脚本正文早已 return，child 即将/已经 close。
    await seen;
    let settled = false;
    void run.finally(() => {
      settled = true;
      order.push("run-settled");
    });
    // 确定性观测屏障（取代原来两处 setTimeout(25) 墙钟窗口）：有界 flush 推进已就绪的事件循环
    // 轮次。作用是「观测」而非「等待」——若 run 已经结算，其 .finally 回调必在下一个微任务里跑，
    // 而 setImmediate（宏任务）边界会先排空整个微任务队列，故 flushLoop 保证任何「已结算」事实
    // 都被 settled=true 记到，assert 才不会因为回调还没排上而假绿。
    //
    // 为什么两条负断言是确定性的、与墙钟无关：requestDone 与 settled 都只能在 release() 之后翻真，
    // 而 release() 在其后才调用——原来的 setTimeout(25) 从未保护任何东西，只是把同步事实包进一个
    // 墙钟窗口（并行负载下 25ms 的长短与结论无关，读起来却像在赌时间，即 C1 flake 根因）。
    // 更深一层：run 的每条结算路径都在 impl 的 `await Promise.allSettled(pendingHandlers)`
    // （script-workflow-process.ts:147）之后——handler 未排空则 run 结构上无法结算。
    //
    // 诚实边界：child 进程的启动 wall-clock（数十 ms）远超本屏障的有界 flush，且
    // runScriptWorkflowChild 未暴露 child-close 事件，故「close 先于 drain 被挡住」这一具体时刻
    // 无法从测试侧确定性观测。本用例的强证明落在 release 之后的 order 账本：它确定性地钉住
    // R19.1「handler 排空必先于 run 结算」，与 child close 的确切时序无关。
    await flushLoop();
    assert.equal(requestDone, false);
    assert.equal(settled, false, "child close 不能越过仍在飞的父侧 request");
    release();
    const result = await run;
    assert.equal(result.value, "done");
    assert.equal(requestDone, true, "终态前必须排空 agent handler");
    assert.deepEqual(
      order,
      ["handler-drained", "run-settled"],
      "R19.1：父侧 request handler 必须先于 run 结算排空",
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("P1 SWF-04: already-aborted signal 在入口落盘与 spawn 前 fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "script-workflow-aborted-"));
  const controller = new AbortController();
  controller.abort(new Error("already aborted"));
  let eventCount = 0;
  let requestCount = 0;
  try {
    await assert.rejects(
      runScriptWorkflowChild({
        document: makeDocument('log("must not run"); return 1;', dir),
        handleEvent: () => {
          eventCount += 1;
        },
        handleRequest: async () => {
          requestCount += 1;
          return null;
        },
        runId: "wf_already-aborted",
        signal: controller.signal,
        workingDirectory: dir,
      }),
      /already aborted/,
    );
    assert.equal(eventCount, 0);
    assert.equal(requestCount, 0);
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(join(dir, ".acode", "workflow-runs", "wf_already-aborted.mjs")));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("R4: ALS 上下文跨 realm 传播——parallel() 的每个 thunk 拿到自己的 callPath", async () => {
  // 这是整个沙箱改造最关键的不变量：八个全局由**外层** realm 实现（AsyncLocalStorage 是
  // Node 能力），脚本体在**内层** realm 执行。若 ALS 的 async context 不能跨 realm 传播，
  // 并发的 agent() 会全部落到同一个 callPath 上，resume 缓存键随之失效——而且是静默失效。
  const { agents, value } = await runScript(`
    return parallel([() => agent("a"), () => agent("b"), () => agent("c")]);
  `);
  assert.deepEqual(value, ["ok:a", "ok:b", "ok:c"]);
  const paths = agents.map((request) => request.payload.callPath).sort();
  assert.deepEqual(paths, [
    "root/parallel0/item0/agent0",
    "root/parallel0/item1/agent0",
    "root/parallel0/item2/agent0",
  ]);
});

test("R4: pipeline() 逐 item 独立流过各 stage，callPath 带 item 与 stage 两段", async () => {
  const { agents, value } = await runScript(`
    return pipeline([1, 2], (x) => agent("s1-" + x), (prev, item, index) => agent("s2-" + prev + "-" + index));
  `);
  assert.deepEqual(value, ["ok:s2-ok:s1-1-0", "ok:s2-ok:s1-2-1"]);
  const paths = agents.map((request) => request.payload.callPath).sort();
  assert.deepEqual(paths, [
    "root/pipeline0/item0/stage0/agent0",
    "root/pipeline0/item0/stage1/agent0",
    "root/pipeline0/item1/stage0/agent0",
    "root/pipeline0/item1/stage1/agent0",
  ]);
});

test("R4: phase() 与 log() 走事件通道，phase 之后的 log 带上当前阶段", async () => {
  const { events } = await runScript(`
    phase("Review");
    log("starting");
    return 1;
  `);
  assert.deepEqual(
    events.map((event) => [event.type, event.payload]),
    [
      ["phase", { title: "Review" }],
      ["log", { message: "starting", phase: "Review" }],
    ],
  );
});

test("R4: console 转发到 log 通道（沙箱里没有 Node 的 console，不注入就是 ReferenceError）", async () => {
  const { events } = await runScript(`
    console.log("via-console");
    return 1;
  `);
  // 没有 phase 键而不是 phase:undefined——事件经 JSON 过线，undefined 值的键会被丢掉。
  // 断言写成"恰好这一个键"，正是为了让"悄悄多了/少了一个字段"变成可见的失败。
  assert.deepEqual(events, [{ payload: { message: "via-console" }, type: "log" }]);
});

test("R4: args 在 realm 内构造且被冻结", async () => {
  const { value } = await runScript(
    `return {
       frozen: Object.isFrozen(args),
       isArray: Array.isArray(args.list),
       length: args.list.length,
       proto: Object.getPrototypeOf(args) === Object.prototype,
     };`,
    { args: { list: [1, 2, 3] } },
  );
  assert.deepEqual(value, { frozen: true, isArray: true, length: 3, proto: true });
});

test("R4: budget 三态——有上限时 spent/remaining 随 agent 结算递增，无上限时 remaining 是 Infinity", async () => {
  const withBudget = await runScript(
    `await agent("x");
     return { remaining: budget.remaining(), spent: budget.spent(), total: budget.total };`,
    { budgetTotal: 1000, tokensPerAgent: 250 },
  );
  assert.deepEqual(withBudget.value, { remaining: 750, spent: 250, total: 1000 });

  // 无上限时 total 是 null、remaining() 是 Infinity。Infinity 必须在 realm **内**断言：
  // 它是 JSON 里没有的字面量，脚本把它 return 出来会经 stdio 序列化变成 null。
  // 这不只是测试技巧，而是一条真实的产品事实（技能 §8 因此要求循环用硬计数上限，
  // 而不是拿 remaining() 当返回值汇报）。
  const noBudget = await runScript(
    `return {
       comparisonWorks: budget.remaining() > 1e9,
       remainingIsInfinity: budget.remaining() === Infinity,
       returnedInfinityBecomes: budget.remaining(),
       spent: budget.spent(),
       total: budget.total,
     };`,
  );
  assert.equal(noBudget.value.remainingIsInfinity, true, "realm 内 remaining() 必须是 Infinity");
  assert.equal(noBudget.value.comparisonWorks, true, "realm 内的比较运算照常工作");
  assert.equal(noBudget.value.spent, 0);
  assert.equal(noBudget.value.total, null);
  assert.equal(
    noBudget.value.returnedInfinityBecomes,
    null,
    "Infinity 过不了 JSON 线；若这条开始失败，说明传输换了编码，技能 §8 的措辞要跟着改",
  );
});

test("R4: 脚本抛错 → run 以该错误结算，不静默成功", async () => {
  await assert.rejects(() => runScript(`throw new Error("boom from script");`), /boom from script/);
});

// ---------------------------------------------------------------------------
// R4 确定性禁令（必须在 realm 内生效——realm 有自己的 Date/Math）
// ---------------------------------------------------------------------------

test("R4: 确定性禁令在 realm 内生效，且刻意保留的三个 Date 入口仍可用", async () => {
  const { value } = await runScript(`
    const probe = (fn) => { try { fn(); return "allowed"; } catch (error) { return error.message; } };
    return {
      dateNow: probe(() => Date.now()),
      dateArgless: probe(() => new Date()),
      dateParse: typeof Date.parse("2020-01-01T00:00:00Z"),
      dateUtc: Date.UTC(2020, 0, 1),
      dateMillis: new Date(0).getUTCFullYear(),
      random: probe(() => Math.random()),
    };
  `);
  assert.match(value.dateNow, /Date\.now\(\) is disabled in workflows/);
  assert.match(value.dateArgless, /argless new Date\(\) is disabled in workflows/);
  assert.match(value.random, /Math\.random\(\) is disabled in workflows/);
  assert.equal(value.dateParse, "number");
  assert.equal(value.dateUtc, 1577836800000);
  assert.equal(value.dateMillis, 1970);
});

// ---------------------------------------------------------------------------
// R4 沙箱逸出：已关闭的与刻意没关的，分开钉
// ---------------------------------------------------------------------------

test("场景5: 已关闭的逸出面确实关闭——脚本拿不到 Node 全局、模块系统与 realm 内 Function", async () => {
  const { value } = await runScript(`
    const probe = async (label, fn) => {
      try {
        const got = await fn();
        return [label, got === undefined ? "undefined" : "REACHABLE:" + typeof got];
      } catch (error) {
        return [label, "blocked:" + error.constructor.name];
      }
    };
    const results = await Promise.all([
      probe("process", async () => process),
      probe("buffer", async () => Buffer),
      probe("require", async () => require),
      probe("globalProcess", async () => globalThis.process),
      probe("realmFunction", async () => Function("return 1")()),
      probe("dynamicImport", async () => await import("node:fs")),
      probe("eval", async () => eval("1")),
    ]);
    return Object.fromEntries(results);
  `);

  // process / Buffer / require 作为**裸标识符**不存在 → ReferenceError。
  assert.equal(value.process, "blocked:ReferenceError");
  assert.equal(value.buffer, "blocked:ReferenceError");
  assert.equal(value.require, "blocked:ReferenceError");
  // 而 globalThis.process 是**属性访问**，缺失的键给出 undefined 而不抛。
  // 两种写法结论相同（都拿不到 Node），机制不同，所以分开断言：把这条也写成
  // ReferenceError 会让测试在"沙箱其实漏了"和"我对 JS 语义记错了"之间无法区分。
  assert.equal(value.globalProcess, "undefined");
  // codeGeneration.strings:false 让 realm 内的 eval / new Function 直接不可用。
  assert.match(value.realmFunction, /^blocked:/, "realm 内 Function 构造器必须被禁");
  assert.match(value.eval, /^blocked:/, "realm 内 eval 必须被禁");
  // 未提供 importModuleDynamically 回调，动态 import 拿不到模块。
  assert.doesNotMatch(String(value.dynamicImport), /^REACHABLE:/, "动态 import 不得拿到 node:fs");
});

test("场景5a: 残余逸出面如实钉住——经注入函数的原型链上溯仍能拿到外层 realm（与 dwf 同姿态）", async () => {
  // 这条断言的是「已知且没关」，不是「已关」。写成期望它成功，是为了让任何人日后
  // 真的把它堵上时这条测试会红——那时应该同步更新 spec R4 而不是悄悄改掉断言。
  // 依据：注入的宿主函数是外层 realm 的对象，.constructor.constructor 就是外层 Function，
  // 而外层 realm 里 process 是真实存在的全局。子进程不是安全边界，alwaysAsk 才是控制点。
  const { value } = await runScript(`
    const outerFunction = agent.constructor.constructor;
    const recovered = outerFunction("return typeof process")();
    return { recovered };
  `);
  assert.equal(
    value.recovered,
    "object",
    "若这条开始失败，说明原型链逸出被堵上了——请同步更新 spec R4 的裁决，别只改断言",
  );
});

// ---------------------------------------------------------------------------
// R5 落盘入口文件
// ---------------------------------------------------------------------------

test("场景7: 接近契约上限的大脚本能跑通（旧写法经 argv 传递，在 Windows 上必然 spawn 失败）", async () => {
  // 契约允许 512KB（WORKFLOW_SCRIPT_MAX_LENGTH），Windows 命令行上限是 32767 字符。
  // 这里造一个约 300KB 的正文：远超命令行上限，落盘之后照常跑。
  const filler = "x".repeat(300_000);
  const body = `const PAD = ${JSON.stringify(filler)};\nreturn PAD.length;`;
  const { value } = await runScript(body, { runId: "wf_large-script" });
  assert.equal(value, 300_000);
});

test("R5: 入口文件落在 .acode/workflow-runs/<runId>.mjs，且目录自带 .gitignore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "script-workflow-entry-"));
  try {
    await runScriptWorkflowChild({
      document: makeDocument("return 1;", dir),
      handleEvent: () => {},
      handleRequest: async () => null,
      runId: "wf_entry-file",
      workingDirectory: dir,
    });
    const { readFile } = await import("node:fs/promises");
    const entry = await readFile(join(dir, ".acode", "workflow-runs", "wf_entry-file.mjs"), "utf8");
    // 自包含：import 与 payload 字面量都在文件里，命令行只剩这条路径。
    assert.match(entry, /import vm from "node:vm";/);
    assert.match(entry, /const payload = \{/);
    assert.match(entry, /return 1;/);
    assert.equal(await readFile(join(dir, ".acode", "workflow-runs", ".gitignore"), "utf8"), "*\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
