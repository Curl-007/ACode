// 脚本工作流的冷回放：重启后历史 run 必须还能回到 workflowRuns 投影里。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R12 已知边界 1 与 R15。
//
// 这些是**行为级**断言：假 store 只提供回放真正用到的两个读方法，产出的信封再喂进
// **真的** reduceWorkflowRunsState，所以钉住的是「重启后投影里到底有什么」，
// 不是「回放函数有没有被调用」。
//
// 被钉住的缺陷：dwf 的投影有两条来源（实时事件 + 冷启动从 journal 回放），而脚本工作流的
// run 不在那份 journal 里。缺了回放，进程重启后历史脚本 run 就从投影里彻底消失——
// 状态面板不列它、侧栏打不开它，而它的真相一直好好躺在自己的 workflow_run / workflow_event
// 表里。这是 C4 报告里如实登记过的边界，本批把它补掉。

import assert from "node:assert/strict";
import test from "node:test";

const { replayScriptWorkflowRuns } =
  await import("../packages/cli-workflow/src/script-workflow-replay.ts");
const { reduceWorkflowRunsState } =
  await import("../../../packages/shared/src/acode-protocol-v4/workflow-runs-reducer.ts");

const SESSION = "sess_parent-1";

/** 最小假 store：只提供回放用到的两个读方法，其余一律 throw，误用立刻暴露。 */
function fakeStore({ events = {}, failList = false, runs = [] } = {}) {
  const calls = [];
  return {
    calls,
    store: {
      async listScriptWorkflowEvents(input) {
        return events[input.runId] ?? [];
      },
      async listScriptWorkflowRuns(input) {
        calls.push(input);
        if (failList) throw new Error("db locked");
        return runs;
      },
    },
  };
}

function depsFor(store, logger) {
  return { parentSessionId: SESSION, store, ...(logger ? { logger } : {}) };
}

/** 把回放产出喂进真 reducer，返回投影里的 run。 */
function project(payloads) {
  let state;
  for (const envelope of payloads) {
    const next = reduceWorkflowRunsState(state, envelope);
    state = next ?? state;
  }
  return state?.runs ?? [];
}

const event = (type, payload = {}) => ({ id: `e_${type}`, payload, runId: "r", type });

/** 一条跑完了的 run：起跑 → 一个阶段 → 一个 agent → 结算。 */
const COMPLETED_EVENTS = [
  event("workflow_started", { scriptPath: "/tmp/a.workflow.js" }),
  event("script_phase", { title: "Review" }),
  event("activity_started", {
    activityId: "act_1",
    callPath: "root/agent0",
    childSessionId: "sess_child_1",
    label: "review:auth",
    phase: "Review",
  }),
  event("activity_completed", {
    activityId: "act_1",
    callPath: "root/agent0",
    label: "review:auth",
    phase: "Review",
  }),
  event("workflow_completed", { result: { ok: true } }),
];

test("跑完的 run 回放后进投影，方言/阶段/名册/终态一项不少", async () => {
  const { store } = fakeStore({
    events: { "wf_cold-1": COMPLETED_EVENTS },
    runs: [{ id: "wf_cold-1", status: "completed" }],
  });
  const payloads = await replayScriptWorkflowRuns(depsFor(store), {
    excludeRunIds: new Set(),
  });
  assert.ok(payloads.length > 0, "必须真的产出信封");

  const [run] = project(payloads);
  assert.equal(run.runId, "wf_cold-1");
  assert.equal(run.dialect, "script", "冷恢复的 run 也必须带方言，否则侧栏会摆出 dwf 专属按钮");
  assert.equal(run.status, "completed");
  assert.deepEqual(
    run.phases?.map((phase) => phase.name),
    ["Review"],
  );
  assert.equal(run.actors.length, 1);
  assert.equal(run.actors[0].name, "review:auth");
  assert.equal(
    run.actors[0].sessionId,
    "sess_child_1",
    "子代理→转写的钻取靠这一位，冷恢复也不能丢",
  );
  assert.equal(run.nodes.length, 1);
  assert.equal(run.nodes[0].outcome, "ok");
});

test("枚举按会话作用域，且上界与投影的淘汰同一个常量", async () => {
  const { calls, store } = fakeStore({ runs: [] });
  await replayScriptWorkflowRuns(depsFor(store), { excludeRunIds: new Set() });
  assert.equal(calls.length, 1);
  // 会话作用域：一个项目目录被许多会话共用，只按 cwd 过滤会让一个会话看见另一个的工作流。
  assert.equal(calls[0].parentSessionId, SESSION);
  assert.equal(calls[0].limit, 8, "上界必须与 WORKFLOW_RUNS_LIMITS.maxRuns 同源");
});

test("excludeRunIds 跳过本进程已有事件的 run（重放会把相位打回起点）", async () => {
  const { store } = fakeStore({
    events: {
      "wf_cold-1": COMPLETED_EVENTS,
      "wf_live-1": COMPLETED_EVENTS,
    },
    runs: [
      { id: "wf_live-1", status: "completed" },
      { id: "wf_cold-1", status: "completed" },
    ],
  });
  const payloads = await replayScriptWorkflowRuns(depsFor(store), {
    excludeRunIds: new Set(["wf_live-1"]),
  });
  const runIds = new Set(payloads.map((entry) => entry.runId));
  assert.deepEqual([...runIds], ["wf_cold-1"]);
});

test("枚举面最近更新在前，回放必须反过来（最旧优先）", async () => {
  const { store } = fakeStore({
    events: { wf_a: COMPLETED_EVENTS, wf_b: COMPLETED_EVENTS },
    // store 的顺序是 time_updated desc：wf_b 更新，所以在前。
    runs: [
      { id: "wf_b", status: "completed" },
      { id: "wf_a", status: "completed" },
    ],
  });
  const payloads = await replayScriptWorkflowRuns(depsFor(store), {
    excludeRunIds: new Set(),
  });
  const firstRun = payloads.find((entry) => entry.runId !== undefined)?.runId;
  assert.equal(firstRun, "wf_a", "最旧的 run 先回放，reducer 的淘汰才与 live 到达序同形");
});

test("进程死亡留下的非终态行 → 合成 stopped/interrupted，不是永远 running", async () => {
  const { store } = fakeStore({
    // 事件流停在半路：起了跑、派了活，没有任何终态事件。
    events: {
      "wf_dead-1": [
        event("workflow_started"),
        event("script_phase", { title: "P" }),
        event("activity_started", { activityId: "a", callPath: "root/agent0", phase: "P" }),
      ],
    },
    runs: [{ id: "wf_dead-1", status: "running" }],
  });
  const payloads = await replayScriptWorkflowRuns(depsFor(store), {
    excludeRunIds: new Set(),
  });
  const [run] = project(payloads);
  // 原样回放的话投影会永远亮着 running：卡片亮灯、Cancel 可点而后端无事可取消。
  assert.equal(run.status, "stopped");
  assert.equal(run.stopReason, "interrupted", "渲染成「stopped (process exited)」，不是「你停的」");
  // 合成结算只在内存里：回放是读路径，不得有写副作用。
  assert.equal(store.updateScriptWorkflowRun, undefined, "假 store 根本没提供写方法");
});

test("行非终态但事件流已结算 → 不再补第二条结算（以事件为准）", async () => {
  const { store } = fakeStore({
    // 进程可能在写完终态事件与改写行之间死掉：此时行还是 running 而事件已经 errored。
    events: {
      "wf_halfdead-1": [
        ...COMPLETED_EVENTS.slice(0, 4),
        event("workflow_failed", { message: "boom" }),
      ],
    },
    runs: [{ id: "wf_halfdead-1", status: "running" }],
  });
  const payloads = await replayScriptWorkflowRuns(depsFor(store), {
    excludeRunIds: new Set(),
  });
  const settles = payloads.filter((entry) => entry.eventType === "run-settled");
  assert.equal(settles.length, 1, "补出第二条会把一条已经 errored 的 run 改写成 stopped");
  const [run] = project(payloads);
  assert.equal(run.status, "errored");
  assert.equal(run.error, "boom");
});

test("P2 SWF-03：resume 后最新 attempt 没有终态时，旧 attempt 结算不能阻止 interrupted 补偿", async () => {
  const resumedEvents = [
    event("workflow_started", { scriptPath: "/tmp/a.workflow.js" }),
    event("workflow_failed", { message: "first attempt failed" }),
    event("workflow_started", { scriptPath: "/tmp/a.workflow.js" }),
  ];
  const { store } = fakeStore({
    events: { "wf_resume-cold": resumedEvents },
    runs: [
      {
        failure: { code: "ScriptWorkflowInterrupted", message: "owner exited" },
        id: "wf_resume-cold",
        status: "cancelled",
      },
    ],
  });
  const payloads = await replayScriptWorkflowRuns(depsFor(store), { excludeRunIds: new Set() });
  const settles = payloads.filter((entry) => entry.eventType === "run-settled");
  assert.equal(settles.length, 2, "旧失败 + 最新 attempt 的 interrupted 各自结算一次");
  const [run] = project(payloads);
  assert.equal(run.status, "stopped");
  assert.equal(run.stopReason, "interrupted");
});

test("结算以**行**为准：收敛过的行没有终态事件，也必须按行的词投影", async () => {
  // 孤儿收敛只改写行、**不合成事件**（事件表的契约是「运行期真发过什么」，清扫者无权往里写）。
  // 于是收敛后的行事件流里永远没有终态；只看事件的话投影会停在 running——卡片亮灯、
  // Cancel 可点而后端无事可取消。这条与上一条合起来才是完整的「以行为准」：
  // 事件流有终态就听事件，没有就听行。
  const halfRun = [
    event("workflow_started"),
    event("script_phase", { title: "P" }),
    event("activity_started", { activityId: "a", callPath: "root/agent0", phase: "P" }),
  ];
  const cases = [
    // 物理 cancelled + 结构化 code = 宿主死了；物理 cancelled 且无 failure = 用户停的。
    // 两者共用一个物理词（CHECK 约束里没有 interrupted），却必须翻成不同的 dwf 终态。
    [
      { failure: { code: "ScriptWorkflowInterrupted" }, status: "cancelled" },
      "stopped",
      "interrupted",
      undefined,
    ],
    [{ status: "cancelled" }, "stopped", "user", undefined],
    [{ failure: { message: "boom" }, status: "failed" }, "errored", undefined, "boom"],
    [{ status: "completed" }, "completed", undefined, undefined],
    // 收敛还没轮到的遗物：非终态行一律按 interrupted 投影，绝不留在 running。
    [{ status: "running" }, "stopped", "interrupted", undefined],
  ];
  for (const [rowOverrides, status, stopReason, error] of cases) {
    const { store } = fakeStore({
      events: { "wf_row-1": halfRun },
      runs: [{ id: "wf_row-1", ...rowOverrides }],
    });
    const payloads = await replayScriptWorkflowRuns(depsFor(store), {
      excludeRunIds: new Set(),
    });
    const settles = payloads.filter((entry) => entry.eventType === "run-settled");
    assert.equal(settles.length, 1, `行是 ${JSON.stringify(rowOverrides)} 时必须恰好补一条结算`);
    const [projected] = project(payloads);
    assert.equal(projected.status, status, `${JSON.stringify(rowOverrides)} 的终态词`);
    assert.equal(projected.stopReason, stopReason, `${JSON.stringify(rowOverrides)} 的 stopReason`);
    assert.equal(projected.error, error, `${JSON.stringify(rowOverrides)} 的错误文案`);
  }
});

test("枚举失败降级成「没有历史 run」，不抛（冷回放是补齐观察面，不是启动路径）", async () => {
  const warnings = [];
  const { store } = fakeStore({ failList: true });
  const payloads = await replayScriptWorkflowRuns(
    depsFor(store, {
      warn: (message, context) => warnings.push([message, context?.event]),
    }),
    { excludeRunIds: new Set() },
  );
  assert.deepEqual(payloads, []);
  assert.deepEqual(warnings, [
    ["Script workflow run replay enumeration failed", "script_workflow.run.replay_failed"],
  ]);
});

test("单条 run 回放失败不牵连其余（一条损坏的历史不该让整个会话的观察面空白）", async () => {
  const warnings = [];
  const { store } = fakeStore({
    events: { "wf_ok-1": COMPLETED_EVENTS },
    runs: [
      { id: "wf_ok-1", status: "completed" },
      { id: "wf_bad-1", status: "completed" },
    ],
  });
  // 让 wf_bad-1 的事件读取抛错。
  const original = store.listScriptWorkflowEvents.bind(store);
  store.listScriptWorkflowEvents = async (input) => {
    if (input.runId === "wf_bad-1") throw new Error("corrupt row");
    return original(input);
  };
  const payloads = await replayScriptWorkflowRuns(
    depsFor(store, {
      warn: (message, context) => warnings.push([message, context?.runId]),
    }),
    { excludeRunIds: new Set() },
  );
  assert.deepEqual(warnings, [["Script workflow run replay failed for one run", "wf_bad-1"]]);
  const runIds = new Set(payloads.map((entry) => entry.runId));
  assert.deepEqual([...runIds], ["wf_ok-1"], "好的那条照常回放");
});

test("回放产出与 live 同形：同一段事件走两条路得到逐字节相同的信封序列", async () => {
  // 这是「复用同一个适配器而不是为冷态另写一份映射」的可执行版本。两份映射就会漂移：
  // live 时 activity_failed 翻成 node-settled{failed}、冷回放时翻成别的，同一条 run
  // 重启前后于是长得不一样。
  const { createScriptWorkflowProgressAdapter } =
    await import("../packages/cli-workflow/src/script-workflow-progress-adapter.ts");
  const live = [];
  const adapter = createScriptWorkflowProgressAdapter({ emit: (progress) => live.push(progress) });
  adapter.registerRun({ parentSessionId: SESSION, runId: "wf_cold-1" });
  for (const entry of COMPLETED_EVENTS) {
    adapter.onEvent({ payload: entry.payload, runId: "wf_cold-1", type: entry.type });
  }

  const { store } = fakeStore({
    events: { "wf_cold-1": COMPLETED_EVENTS },
    runs: [{ id: "wf_cold-1", status: "completed" }],
  });
  const cold = await replayScriptWorkflowRuns(depsFor(store), { excludeRunIds: new Set() });

  assert.deepEqual(
    cold.map((entry) => [entry.eventType, entry.sequence, JSON.stringify(entry.payload)]),
    live.map((entry) => [entry.eventType, entry.sequence, JSON.stringify(entry.payload)]),
    "冷回放必须与 live 逐条同形，否则同一条 run 重启前后长得不一样",
  );
});
