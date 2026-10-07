import assert from "node:assert/strict";
import test from "node:test";
import { reduceWorkflowRunsState } from "../../shared/src/acode-protocol-v4/workflow-runs-reducer.js";
import type {
  WorkflowRunState,
  WorkflowRunsState,
} from "../../shared/src/acode-protocol-v4/workflow-runs.js";
import {
  actorStatusToStepStatus,
  buildWorkflowActivityGroups,
  workflowActorStepStatus,
} from "../src/app-shell/workflowRunActivity.js";

/**
 * 侧栏「实时活动」主体的分组规则。
 *
 * run 一律用**真的 reducer** 从信封铸出来，不手搓对象：手搓的 fixture 会与 schema 漂移，
 * 而这里要证的恰恰是「投影里真实存在的那种 run」被折成什么样的清单。信封的形状取自
 * 脚本工作流的适配器（apps/acode-cli/packages/bootstrap/src/app/script-workflow-progress-adapter.ts），
 * 所以这套断言同时钉住了「适配器发的东西」与「侧栏读出来的东西」两端对得上。
 */

const RUN = "wf_activity-test";

function reduce(envelopes: readonly Record<string, unknown>[]): WorkflowRunState {
  let state: WorkflowRunsState | undefined;
  for (const [index, envelope] of envelopes.entries()) {
    const next = reduceWorkflowRunsState(state, {
      ...envelope,
      runId: RUN,
      sequence: index + 1,
    });
    state = next ?? state;
  }
  const run = state?.runs.find((entry) => entry.runId === RUN);
  assert.ok(run, "reducer 必须真的铸出这条 run，否则后面每条断言都是空转");
  return run;
}

const started = { eventType: "run-started", payload: { dialect: "script" } };

function phase(name: string) {
  return { eventType: "phase-entered", payload: { name, ordinal: 1 } };
}

function instance(siteId: string) {
  return { ordinal: 0, siteId };
}

function dispatched(siteId: string, name: string, phaseName?: string) {
  return {
    eventType: "node-dispatched",
    payload: {
      actor: instance(siteId),
      instance: instance(siteId),
      kind: "ask",
      actorName: name,
      ...(phaseName === undefined ? {} : { actorPhaseName: phaseName, phaseName }),
    },
  };
}

function settled(siteId: string, outcome: "ok" | "failed", phaseName?: string, cached = false) {
  return {
    eventType: "node-settled",
    payload: {
      actor: instance(siteId),
      instance: instance(siteId),
      kind: "ask",
      outcome,
      ...(cached ? { cached: true } : {}),
      ...(phaseName === undefined ? {} : { phaseName }),
    },
  };
}

test("按 run.phases 的**实际进入顺序**分组，不是字母序", () => {
  const run = reduce([
    started,
    phase("Zeta"),
    dispatched("root/agent0", "z:1", "Zeta"),
    settled("root/agent0", "ok", "Zeta"),
    phase("Alpha"),
    dispatched("root/agent1", "a:1", "Alpha"),
    settled("root/agent1", "ok", "Alpha"),
  ]);
  const groups = buildWorkflowActivityGroups(run);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["Zeta", "Alpha"],
    "字母序会把 Alpha 排前面，而阶段顺序是观测事实（phase-entered 的到达序）",
  );
  assert.deepEqual(
    groups.map((group) => [group.settled, group.nodes.length, group.status]),
    [
      [1, 1, "done"],
      [1, 1, "done"],
    ],
  );
});

test("actor 自己没有阶段坐标时，退到它名下节点的坐标", () => {
  // 脚本可以给 agent 传 opts.phase 而不打 phase() 标记：于是 actor 上没有 phaseName，
  // 而它的节点有。不归位就会掉进「未分组」，把一个明明属于某阶段的子代理藏起来。
  const run = reduce([
    started,
    phase("Review"),
    // actor-created 不带 phaseName，node 带
    {
      eventType: "actor-created",
      payload: { actor: instance("root/agent0"), name: "review:auth" },
    },
    {
      eventType: "node-dispatched",
      payload: {
        actor: instance("root/agent0"),
        instance: instance("root/agent0"),
        kind: "ask",
        actorName: "review:auth",
        phaseName: "Review",
      },
    },
    settled("root/agent0", "ok", "Review"),
  ]);
  const groups = buildWorkflowActivityGroups(run);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["Review"],
    "不得落进「未分组」桶",
  );
  assert.equal(groups[0].actors[0].name, "review:auth");
});

test("每个节点恰好归属一组：不重复计数，也不漏", () => {
  const run = reduce([
    started,
    phase("P"),
    dispatched("root/parallel0/item0/agent0", "a", "P"),
    dispatched("root/parallel0/item1/agent0", "b", "P"),
    settled("root/parallel0/item0/agent0", "ok", "P"),
    settled("root/parallel0/item1/agent0", "failed", "P"),
  ]);
  const groups = buildWorkflowActivityGroups(run);
  const total = groups.reduce((sum, group) => sum + group.nodes.length, 0);
  assert.equal(total, run.nodes.length, "分组后节点总数必须与投影一致（不重不漏）");
  assert.equal(total, 2);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].settled, 2);
  // 任一 failed → 该组 failed：读者最需要知道的是「这里有活没成」。
  assert.equal(groups[0].status, "failed");
});

test("running 优先于 failed：读者最需要知道的是「还在动吗」", () => {
  const run = reduce([
    started,
    phase("P"),
    dispatched("root/agent0", "a", "P"),
    settled("root/agent0", "failed", "P"),
    dispatched("root/agent1", "b", "P"),
  ]);
  const [group] = buildWorkflowActivityGroups(run);
  assert.equal(group.status, "running");
  assert.equal(group.settled, 1, "已结算计数不受折叠状态影响");
});

test("cached 命中也要坐上表（它从不发 node-dispatched，只有 node-settled）", () => {
  const run = reduce([
    started,
    phase("P"),
    {
      eventType: "actor-created",
      payload: { actor: instance("root/agent0"), name: "cached:1", phaseName: "P" },
    },
    settled("root/agent0", "ok", "P", true),
  ]);
  const [group] = buildWorkflowActivityGroups(run);
  assert.equal(group.nodes.length, 1);
  assert.equal(group.nodes[0].cached, true);
  assert.equal(group.status, "done");
});

test("一个节点都没有的阶段：组仍在场，状态缺席而不是被编造", () => {
  const run = reduce([started, phase("Empty"), phase("P"), dispatched("root/agent0", "a", "P")]);
  const groups = buildWorkflowActivityGroups(run);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["Empty", "P"],
    "进入过但没有活动的阶段也要列出来——它确实是控制流走过的一站",
  );
  assert.equal(groups[0].status, undefined, "空集折叠成 undefined：缺席不是状态，不凭空造一个");
  assert.equal(groups[0].nodes.length, 0);
});

test("空 run 不产出任何组", () => {
  const run = reduce([started]);
  assert.deepEqual(buildWorkflowActivityGroups(run), []);
});

test("actor 三态到四值词汇表的桥接是显式的，不混用", () => {
  assert.equal(actorStatusToStepStatus("running"), "running");
  assert.equal(actorStatusToStepStatus("completed"), "done");
  assert.equal(actorStatusToStepStatus("waiting"), "pending");
});

test("子代理的展示状态：节点是硬事实，压过 actor 自己的三态", () => {
  const run = reduce([
    started,
    phase("P"),
    {
      eventType: "actor-created",
      payload: { actor: instance("root/agent0"), name: "a", phaseName: "P" },
    },
    dispatched("root/agent0", "a", "P"),
    settled("root/agent0", "failed", "P"),
  ]);
  const [group] = buildWorkflowActivityGroups(run);
  const actor = group.actors[0];
  assert.ok(actor, "前提：这条 run 名册上确实有这个子代理");
  // reducer 的 actor 三态里没有 failed（dwf 的派生语义），所以只能显示 completed/waiting；
  // 而节点确实失败了。展示必须听节点的，否则一次失败被画成绿勾。
  assert.notEqual(actor.status, "failed", "前提：actor 三态里没有 failed");
  assert.equal(workflowActorStepStatus(actor, group.nodes), "failed");
});

test("节点有归属但那个 actor 不在名册上时，节点仍然在场（不得静默丢活）", () => {
  // actor 表与 node 表各有自己的界（maxActors / maxNodes），满了各自淘汰，两者不同步；
  // 旧 CLI 也可能压根不发 actor-created。于是「节点带 actorSiteId、但 run.actors 里没有
  // 这个人」是可达状态。只从 actor 那侧收集节点的话，这些活就凭空消失——正是适配器那边
  // 修过的「有活没人干」在渲染层重现。
  const run = reduce([
    started,
    phase("P"),
    dispatched("root/agent0", "ghost", "P"),
    settled("root/agent0", "ok", "P"),
  ]);
  assert.equal(run.actors.length, 0, "前提：名册上确实没有人");
  assert.equal(run.nodes.length, 1, "前提：但节点在");

  const groups = buildWorkflowActivityGroups(run);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "P", "相位仍按节点自己的坐标归组");
  assert.equal(
    groups[0].nodes.length,
    1,
    "节点必须还在组里，否则这次 ask 在任何读面上都不存在",
  );
  assert.equal(groups[0].settled, 1);
  assert.equal(groups[0].status, "done");
});
