// 脚本工作流事件 → dwf 投影的适配器。
// 依据：apps/acode-cli/specs/script-workflow-revival.md 批次 C4（实时进度）。
//
// 这里最值钱的断言不是「适配器发了什么」，而是**把它发的东西喂进真实的共享 reducer**，
// 看投影状态是否真的长出来。payload 形状只要猜错一个键，reducer 就静默返回原状态——
// 不报错、不告警，UI 就是一片空。所以每条映射都用 reduceWorkflowRunsState 收口。

import assert from "node:assert/strict";
import test from "node:test";

const { createScriptWorkflowProgressAdapter } = await import(
  "../packages/cli-workflow/src/script-workflow-progress-adapter.ts"
);
const { reduceWorkflowRunsState } = await import(
  "../../../packages/shared/src/acode-protocol-v4/workflow-runs-reducer.ts"
);

/** 收集适配器发出的信封。 */
function collector() {
  const sent = [];
  const emit = (progress, routing) => sent.push({ progress, routing });
  return { emit, sent };
}

/**
 * 造适配器 + 一个把发出的信封喂进**真实 reducer** 的投影累加器。
 * `drain()` 把尚未归约的信封全部喂进去并返回最新投影——一条脚本事件可能翻译成两条信封
 * （activity_started），所以按游标逐条消费而不是只看最后一条。
 */
function harness() {
  const { emit, sent } = collector();
  const adapter = createScriptWorkflowProgressAdapter({ emit });
  let state;
  let drained = 0;
  return {
    adapter,
    sent,
    drain() {
      while (drained < sent.length) {
        const envelope = sent[drained].progress;
        drained += 1;
        state = reduceWorkflowRunsState(state, envelope) ?? state;
      }
      return state;
    },
  };
}

const RUN = "wf_projection-test";

test("workflow_started → run-started，且带上 dialect: script（整套门控的支点）", () => {
  const h = harness();
  h.adapter.registerRun({ parentSessionId: "sess_parent", runId: RUN, toolCallId: "tc_1" });
  h.adapter.onEvent({ payload: { scriptPath: "/x/s.workflow.js" }, runId: RUN, type: "workflow_started" });

  assert.equal(h.sent.length, 1);
  const envelope = h.sent[0].progress;
  assert.equal(envelope.eventType, "run-started");
  assert.equal(envelope.runId, RUN);
  assert.equal(envelope.sequence, 1);
  assert.equal(envelope.toolCallId, "tc_1", "缺了它 run 卡就联接到聊天里那一行");
  assert.deepEqual(envelope.payload, { dialect: "script" });
  // 身份闸门要靠它：投错会话是那种不报错、只让事件出现在错误对话里的 bug。
  assert.deepEqual(h.sent[0].routing, { parentSessionId: "sess_parent" });

  const state = h.drain();
  const run = state.runs.find((entry) => entry.runId === RUN);
  assert.equal(run.status, "running");
  assert.equal(run.dialect, "script", "dialect 必须真的落进投影，否则侧栏无法门掉 dwf 专属按钮");
  assert.equal(run.toolCallId, "tc_1");
});

test("script_phase → phase-entered，ordinal 每 run 各自递增", () => {
  const h = harness();
  h.adapter.registerRun({ runId: RUN });
  h.adapter.onEvent({ payload: { title: "Review" }, runId: RUN, type: "script_phase" });
  h.adapter.onEvent({ payload: { title: "Verify" }, runId: RUN, type: "script_phase" });

  assert.deepEqual(
    h.sent.map((entry) => [entry.progress.eventType, entry.progress.payload]),
    [
      ["phase-entered", { name: "Review", ordinal: 1 }],
      ["phase-entered", { name: "Verify", ordinal: 2 }],
    ],
  );
  const run = h.drain().runs.find((entry) => entry.runId === RUN);
  assert.deepEqual(
    (run.phases ?? []).map((phase) => phase.name),
    ["Review", "Verify"],
  );
  assert.equal(run.currentPhase, "Verify");
});

test("script_phase 缺 title 时不发信封（reducer 对空名会直接忽略，白发一条只抬水位）", () => {
  const h = harness();
  h.adapter.onEvent({ payload: {}, runId: RUN, type: "script_phase" });
  h.adapter.onEvent({ payload: { title: "" }, runId: RUN, type: "script_phase" });
  assert.deepEqual(h.sent, []);
});

test("activity_started → actor-created + node-dispatched 两条（dwf 里 actor 与 node 是分开的实体）", () => {
  const h = harness();
  h.adapter.registerRun({ runId: RUN });
  h.adapter.onEvent({ payload: { title: "Review" }, runId: RUN, type: "script_phase" });
  h.adapter.onEvent({
    payload: {
      activityId: "act_1",
      callPath: "root/parallel0/item2/agent0",
      childSessionId: "sess_child_1",
      label: "review:auth",
      phase: "Review",
    },
    runId: RUN,
    type: "activity_started",
  });

  assert.deepEqual(
    h.sent.map((entry) => entry.progress.eventType),
    ["phase-entered", "actor-created", "node-dispatched"],
  );
  const [, actorCreated, dispatched] = h.sent.map((entry) => entry.progress.payload);
  // siteId 用 callPath：它本身就是这次调用的唯一身份，且与 resume 缓存键同源，
  // 于是不会出现「缓存认得、投影认不得」的裂缝。ordinal 恒 0——一次 agent() 就是一个
  // 子会话一条活动，没有 dwf 那种「同一 actor 上多次 ask」。
  assert.deepEqual(actorCreated.actor, { ordinal: 0, siteId: "root/parallel0/item2/agent0" });
  assert.equal(actorCreated.name, "review:auth");
  assert.equal(actorCreated.phaseName, "Review");
  // 子代理会话 id 必须挂在**信封顶层**而不是 payload 里：reducer 只从
  // `envelope.actorSessionId` 取（→ derived.actorSessionId → workflowActorEntry）。
  // 这条断言此前查的是 payload 里那份，于是挂错层级也能过——投影里其实一个 sessionId 都没有。
  assert.equal(
    actorCreated.actorSessionId,
    undefined,
    "payload 里不该有它；挂在这里 reducer 读不到",
  );
  const [, actorEnvelope, dispatchedEnvelope] = h.sent;
  assert.equal(actorEnvelope.progress.actorSessionId, "sess_child_1");
  // node-dispatched 也带上：reducer 在派发那一刻会用它重铸 actor 条目（dispatchActor），
  // 于是 actor-created 因表满被拒时，派活仍能连人带活回到表上。
  assert.equal(dispatchedEnvelope.progress.actorSessionId, "sess_child_1");
  assert.deepEqual(dispatched.instance, actorCreated.actor);
  assert.deepEqual(dispatched.actor, actorCreated.actor);
  assert.equal(dispatched.kind, "ask");
  assert.equal(dispatched.actorName, "review:auth");

  const run = h.drain().runs.find((entry) => entry.runId === RUN);
  assert.equal(run.actors.length, 1, "actor 必须真的坐上表，否则时间线是空的");
  assert.equal(run.actors[0].name, "review:auth");
  // 归约**之后**的 sessionId 才是真正被消费的那一份：桌面侧栏的 handleOpenActor 读
  // `instance.sessionId` 来打开子代理转写，缺席就只剩一个点不动的名字。
  assert.equal(
    run.actors[0].sessionId,
    "sess_child_1",
    "子代理→转写的钻取靠这一位，挂错层级它就是空的",
  );
  assert.equal(run.nodes.length, 1, "node 同理");
});

test("activity_completed / failed / cached → node-settled，outcome 与 cached 各自正确", () => {
  const h = harness();
  h.adapter.registerRun({ runId: RUN });
  h.adapter.onEvent({
    payload: { activityId: "a", callPath: "root/agent0", phase: "P" },
    runId: RUN,
    type: "activity_started",
  });
  h.adapter.onEvent({
    payload: { activityId: "a", callPath: "root/agent0", phase: "P" },
    runId: RUN,
    type: "activity_completed",
  });
  h.adapter.onEvent({
    payload: { activityId: "b", callPath: "root/agent1", phase: "P" },
    runId: RUN,
    type: "activity_failed",
  });
  // cached 的节点没经过 activity_started（缓存命中直接返回），而 reducer 把
  // node-settled { cached: true } 当**出生事件**，所以它自己就能把节点放上表。
  h.adapter.onEvent({
    payload: { activityId: "c", callPath: "root/agent2", phase: "P" },
    runId: RUN,
    type: "activity_cached",
  });

  const settled = h.sent
    .map((entry) => entry.progress)
    .filter((envelope) => envelope.eventType === "node-settled")
    .map((envelope) => envelope.payload);
  assert.deepEqual(
    settled.map((payload) => [payload.instance.siteId, payload.outcome, payload.cached === true]),
    [
      ["root/agent0", "ok", false],
      ["root/agent1", "failed", false],
      ["root/agent2", "ok", true],
    ],
  );

  const run = h.drain().runs.find((entry) => entry.runId === RUN);
  const bySiteId = new Map(run.nodes.map((node) => [node.siteId, node]));
  assert.equal(bySiteId.get("root/agent0").outcome, "ok");
  assert.equal(bySiteId.get("root/agent1").outcome, "failed");
  assert.equal(bySiteId.get("root/agent2").cached, true);
  // 三个都要在子代理名册上。agent1 与 agent2 从没发过 activity_started
  // （failed 可能发生在子会话铸造之前，cached 是缓存命中直接返回），
  // 所以结算事件必须自带一条 actor-created——否则时间线会出现「有活没人干」：
  // 节点坐上了表，名册上却没有这个人。
  // agent0 **已经** started 过，所以结算时不再补：那条补发不带 actorSessionId，
  // 而 reducer 的 upsert 是整条替换，补一次就把 sessionId 抹掉（见下一条用例）。
  assert.deepEqual(
    run.actors.map((actor) => actor.siteId).sort(),
    ["root/agent0", "root/agent1", "root/agent2"],
  );
  // 刻意**不**断言 actor.status：那是 dwf 的派生语义（workflow-runs-actor-status.ts 只有
  // running / waiting / completed 三态，节点级的成败落在 nodes[].outcome 上，actor 三态里
  // 没有 failed）。在这里断言它等于把别人的规则抄成我的契约，那边一改这条就红，
  // 而红的原因与适配器无关。节点级成败上面已经断言过了。
});

test("结算事件不得抹掉 started 带来的 sessionId（started 过就不补 actor-created）", () => {
  const h = harness();
  h.adapter.registerRun({ runId: RUN });
  h.adapter.onEvent({
    payload: {
      activityId: "a",
      callPath: "root/agent0",
      childSessionId: "sess_child_a",
      label: "finder",
      phase: "P",
    },
    runId: RUN,
    type: "activity_started",
  });
  h.adapter.onEvent({
    payload: { activityId: "a", callPath: "root/agent0", label: "finder", phase: "P" },
    runId: RUN,
    type: "activity_completed",
  });

  // 只允许一条 actor-created。第二条不带 actorSessionId（子会话 id 只在 started 的载荷里），
  // 而 reducer 的 actor upsert 是**整条替换**不是字段合并（workflowActorEntry 每次造新对象），
  // 于是补发会把 sessionId 抹掉——名册上点不开任何转写。
  const births = h.sent.filter((entry) => entry.progress.eventType === "actor-created");
  assert.equal(births.length, 1, "started 过的实例，结算时不该再补一条 actor-created");

  const run = h.drain().runs.find((entry) => entry.runId === RUN);
  assert.equal(run.actors.length, 1);
  assert.equal(
    run.actors[0].sessionId,
    "sess_child_a",
    "走完 started → completed 的完整生命周期后，子代理会话 id 必须还在",
  );

  // 反过来的那半仍然成立：从没 started 过的实例，结算是它唯一的出生事实。
  const orphan = harness();
  orphan.adapter.registerRun({ runId: RUN });
  orphan.adapter.onEvent({
    payload: { activityId: "c", callPath: "root/cached0", label: "cached", phase: "P" },
    runId: RUN,
    type: "activity_cached",
  });
  assert.equal(
    orphan.sent.filter((entry) => entry.progress.eventType === "actor-created").length,
    1,
    "cached 从不发 activity_started，结算必须补上出生，否则名册上没人",
  );
  assert.equal(orphan.drain().runs.find((entry) => entry.runId === RUN).actors.length, 1);
});

test("workflow_completed / workflow_failed → run-settled 的两个终态词", () => {
  const completed = harness();
  completed.adapter.onEvent({ payload: { result: 1 }, runId: RUN, type: "workflow_completed" });
  assert.deepEqual(completed.sent[0].progress.payload, { status: "completed" });
  assert.equal(
    completed.drain().runs.find((entry) => entry.runId === RUN).status,
    "completed",
  );

  const failed = harness();
  failed.adapter.onEvent({
    payload: { message: "boom", stack: "…" },
    runId: RUN,
    type: "workflow_failed",
  });
  // dwf 的终态词是 errored，不是 failed——两套系统的状态词表在这里必须对齐，
  // 否则闭集校验会把整帧丢掉。
  assert.deepEqual(failed.sent[0].progress.payload, {
    error: { message: "boom" },
    status: "errored",
  });
  const failedRun = failed.drain().runs.find((entry) => entry.runId === RUN);
  assert.equal(failedRun.status, "errored");
  assert.equal(failedRun.error, "boom");
});

test("workflow_cancelled → stopped(by you)，而不是 errored", () => {
  const h = harness();
  h.adapter.onEvent({
    payload: { message: "Workflow script run cancelled" },
    runId: RUN,
    type: "workflow_cancelled",
  });

  // 用户停下与脚本崩了是两笔事实：TUI 按 status + stopReason 决定颜色与文案
  // （stopped 是 muted 的「stopped (by you)」，errored 是 danger 的错误卡）。
  assert.deepEqual(h.sent[0].progress.payload, { status: "stopped", stopReason: "user" });
  const run = h.drain().runs.find((entry) => entry.runId === RUN);
  assert.equal(run.status, "stopped");
  assert.equal(run.stopReason, "user");
  // 刻意不带 resumable：脚本工作流能按 resumeFromRunId 续跑，但那是模型经 RunWorkflow 走的路，
  // 用户面前没有对应的命令。亮一个按不动的 Resume 比不亮更糟。
  assert.notEqual(
    run.resumable,
    true,
    "亮起一个点了必被拒的 Resume，比不显示更坏",
  );
});

test("workflow_usage → usage-updated，携带累计总量而不是增量", () => {
  const h = harness();
  h.adapter.registerRun({ runId: RUN });
  h.adapter.onEvent({ payload: { spentTokens: 1200 }, runId: RUN, type: "workflow_usage" });
  h.adapter.onEvent({ payload: { spentTokens: 5000 }, runId: RUN, type: "workflow_usage" });

  assert.deepEqual(h.sent.map((entry) => entry.progress.eventType), [
    "usage-updated",
    "usage-updated",
  ]);
  // reducer 直接覆写 usage.spentTokens，所以发的必须是总量：发增量会让读数翻倍。
  const run = h.drain().runs.find((entry) => entry.runId === RUN);
  assert.equal(run.usage.spentTokens, 5000);

  // 残缺与非法值不发信封（也不吃序号）：reducer 对非数字本来就整条忽略。
  const bad = harness();
  bad.adapter.registerRun({ runId: RUN });
  bad.adapter.onEvent({ payload: {}, runId: RUN, type: "workflow_usage" });
  bad.adapter.onEvent({ payload: { spentTokens: "12" }, runId: RUN, type: "workflow_usage" });
  bad.adapter.onEvent({ payload: { spentTokens: Infinity }, runId: RUN, type: "workflow_usage" });
  assert.deepEqual(bad.sent, []);
});

test("script_log → log 信封：两端的日志读面都只认这个 eventType", () => {
  const h = harness();
  h.adapter.registerRun({ runId: RUN });
  h.adapter.onEvent({ payload: { message: "hi", phase: "P" }, runId: RUN, type: "script_log" });

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].progress.eventType, "log");
  // 只搬 message：dwf 的 log 行不带相位，多塞一个键会让两端的行形状不一致。
  assert.deepEqual(h.sent[0].progress.payload, { message: "hi" });

  // 空消息不发：TUI 的 logMessage() 与桌面面板都会把空串丢掉，发过去只是白吃一个序号。
  h.adapter.onEvent({ payload: { message: "   " }, runId: RUN, type: "script_log" });
  h.adapter.onEvent({ payload: {}, runId: RUN, type: "script_log" });
  assert.equal(h.sent.length, 1, "空白与缺席的 message 都不该产信封");
});

test("无对应物的事件静默丢弃，且不吃序号", () => {
  const h = harness();
  h.adapter.registerRun({ runId: RUN });
  h.adapter.onEvent({ payload: {}, runId: RUN, type: "entry_file_fallback" });
  h.adapter.onEvent({ payload: {}, runId: RUN, type: "some_future_type" });
  assert.deepEqual(h.sent, [], "reducer 对未知 eventType 只抬水位，发过去也是白发");

  // 丢弃之后序号仍然连续：跳号会让 reducer 的水位判定误以为中间有事件没到。
  h.adapter.onEvent({ payload: { title: "P" }, runId: RUN, type: "script_phase" });
  assert.equal(h.sent[0].progress.sequence, 1);
});

test("序号每 run 各自单调递增；forgetRun 之后重新起算", () => {
  const h = harness();
  h.adapter.registerRun({ runId: RUN });
  h.adapter.registerRun({ runId: "wf_other-run" });
  h.adapter.onEvent({ payload: { title: "A" }, runId: RUN, type: "script_phase" });
  h.adapter.onEvent({ payload: { title: "B" }, runId: RUN, type: "script_phase" });
  h.adapter.onEvent({ payload: { title: "C" }, runId: "wf_other-run", type: "script_phase" });
  assert.deepEqual(
    h.sent.map((entry) => [entry.progress.runId, entry.progress.sequence]),
    [
      [RUN, 1],
      [RUN, 2],
      ["wf_other-run", 1],
    ],
    "两个 run 的序号互不干扰",
  );

  h.adapter.forgetRun(RUN);
  h.adapter.onEvent({ payload: { title: "D" }, runId: RUN, type: "script_phase" });
  assert.equal(h.sent.at(-1).progress.sequence, 1, "结算即清项，长会话不会无限攒 Map");
});

test("未登记就收到事件也能投影（宁可少一个 toolCallId 联接，也不要丢掉整条 run 的进度）", () => {
  const h = harness();
  h.adapter.onEvent({ payload: { title: "P" }, runId: RUN, type: "script_phase" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].progress.toolCallId, undefined);
  assert.equal(h.sent[0].routing, undefined);
  assert.equal(h.drain().runs.find((entry) => entry.runId === RUN).currentPhase, "P");
});

test("callPath 缺席时退回 activityId 当 siteId（投影宁可粗一点也不要没有）", () => {
  const h = harness();
  h.adapter.onEvent({
    payload: { activityId: "act_9", label: "x" },
    runId: RUN,
    type: "activity_started",
  });
  const actorPayload = h.sent[0].progress.payload;
  assert.deepEqual(actorPayload.actor, { ordinal: 0, siteId: "act_9" });
});
