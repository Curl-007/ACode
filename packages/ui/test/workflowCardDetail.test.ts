import assert from "node:assert/strict";
import test from "node:test";
import { reduceWorkflowRunsState } from "../../shared/src/acode-protocol-v4/workflow-runs-reducer.js";
import type {
  WorkflowRunState,
  WorkflowRunsState,
} from "../../shared/src/acode-protocol-v4/workflow-runs.js";
import { projectionOnlyCardDetail } from "../src/components/workflow-timeline/card-detail.js";

/**
 * 摘要卡在没有静态因果图时的表头细节串。
 *
 * 被钉住的缺陷：`workflowCardDetail` 在 `model === undefined` 时整块返回 undefined，而模型
 * 只有拿到静态因果图才建得出来。脚本工作流不编译、不做静态分析，永远没有图，于是对话里
 * 那张轮尾摘要卡上只剩一个状态词——连「这条 run 有几个阶段、几个子代理」都说不出来，
 * 而这些数字投影里一直都有。
 *
 * 关键约束是**复用同一批 i18n 键**：同一个 run 在「有图」与「没图」两种情况下必须说同一种话，
 * 所以这里断言的是键名而不只是文案——键换了就等于两套措辞各自漂移。
 */

const RUN = "wf_card-detail";

/** 记录用到了哪些键与哪些插值，以便断言措辞来源而不只是结果字符串。 */
function recordingFormat() {
  const calls: Array<{ id: string; values?: Record<string, string | number> }> = [];
  const format = (
    descriptor: { id: string },
    values?: Record<string, string | number>,
  ): string => {
    calls.push({ id: descriptor.id, values });
    return descriptor.id.split(".").pop() ?? descriptor.id;
  };
  return { calls, format };
}

function reduce(envelopes: readonly Record<string, unknown>[]): WorkflowRunState {
  let state: WorkflowRunsState | undefined;
  for (const [index, envelope] of envelopes.entries()) {
    const next = reduceWorkflowRunsState(state, { ...envelope, runId: RUN, sequence: index + 1 });
    state = next ?? state;
  }
  const run = state?.runs.find((entry) => entry.runId === RUN);
  assert.ok(run, "reducer 必须真的铸出这条 run");
  return run;
}

const started = { eventType: "run-started", payload: { dialect: "script" } };

/** 两个阶段、两个子代理、一个已结算一个在飞。 */
function twoPhaseRun(status: "running" | "completed") {
  return reduce([
    started,
    { eventType: "phase-entered", payload: { name: "Review", ordinal: 1 } },
    {
      eventType: "actor-created",
      payload: { actor: { ordinal: 0, siteId: "root/agent0" }, name: "finder:1", phaseName: "Review" },
    },
    {
      eventType: "node-dispatched",
      payload: {
        actor: { ordinal: 0, siteId: "root/agent0" },
        instance: { ordinal: 0, siteId: "root/agent0" },
        kind: "ask",
      },
    },
    {
      eventType: "node-settled",
      payload: {
        actor: { ordinal: 0, siteId: "root/agent0" },
        instance: { ordinal: 0, siteId: "root/agent0" },
        kind: "ask",
        outcome: "ok",
      },
    },
    { eventType: "phase-entered", payload: { name: "Verify", ordinal: 2 } },
    {
      eventType: "actor-created",
      payload: { actor: { ordinal: 0, siteId: "root/agent1" }, name: "verifier:1", phaseName: "Verify" },
    },
    ...(status === "completed"
      ? [
          {
            eventType: "node-dispatched",
            payload: {
              actor: { ordinal: 0, siteId: "root/agent1" },
              instance: { ordinal: 0, siteId: "root/agent1" },
              kind: "ask",
            },
          },
          {
            eventType: "node-settled",
            payload: {
              actor: { ordinal: 0, siteId: "root/agent1" },
              instance: { ordinal: 0, siteId: "root/agent1" },
              kind: "ask",
              outcome: "ok",
            },
          },
          { eventType: "run-settled", payload: { status: "completed" } },
        ]
      : [
          {
            eventType: "node-dispatched",
            payload: {
              actor: { ordinal: 0, siteId: "root/agent1" },
              instance: { ordinal: 0, siteId: "root/agent1" },
              kind: "ask",
            },
          },
        ]),
  ]);
}

test("没有图也报得出阶段数与子代理数（此前整块缺席）", () => {
  const { calls, format } = recordingFormat();
  const detail = { detail: projectionOnlyCardDetail(format, twoPhaseRun("completed")) };
  
  assert.equal(detail.detail, "phases · agents");
  // 复用既有键，而不是新造一套措辞：同一个 run 在两张卡上必须说同一种话。
  assert.deepEqual(
    calls.map((call) => call.id),
    ["chat.toolCall.workflow.card.phases", "chat.toolCall.workflow.card.agents"],
  );
  assert.deepEqual(
    calls.map((call) => call.values?.count),
    ["2", "2"],
  );
});

test("跑着时数「工作中的」，与有图那条路同一条规则", () => {
  const { calls, format } = recordingFormat();
  const detail = projectionOnlyCardDetail(format, twoPhaseRun("running"));

  assert.deepEqual(
    calls.map((call) => call.id),
    ["chat.toolCall.workflow.card.phases", "chat.toolCall.workflow.card.agentsWorking"],
    "running 的 run 该说「几个在工作中」，不是总数",
  );
  // 这一段是**无条件**出现的（与有图那条路的 agentsPart 同规）：0 个在工作中就说 0 个。
  // 加「大于零才出」的守卫就是多一处会漂移的分叉，同一个 run 在两张卡上会少一段话。
  assert.equal(detail, "phases · agentsWorking");
});

test("计数为零的那一段不出现（「0 phases」是噪音不是信息）", () => {
  const { format } = recordingFormat();
  // 只有 run-started：没有阶段、没有子代理。
  const bare = reduce([started, { eventType: "run-settled", payload: { status: "completed" } }]);
  const detail = { detail: projectionOnlyCardDetail(format, bare) };
  
  // 终态下子代理段照旧出现（说清「一个都没有」是有话可说的），阶段段缺席。
  assert.equal(detail.detail, "agents");
});

test("子代理模型名跟在最后一段，与有图那条路同位置", () => {
  const { format } = recordingFormat();
  const withModel = projectionOnlyCardDetail(format, twoPhaseRun("completed"), "GLM-4.6");
  assert.equal(withModel, "phases · agents · GLM-4.6");
  const without = projectionOnlyCardDetail(format, twoPhaseRun("completed"));
  assert.equal(without, "phases · agents", "没指定过模型的 run 不该凭空多一段");
});

test("单数用单数键：1 个阶段不能说成 phases", () => {
  const { calls, format } = recordingFormat();
  const single = reduce([
    started,
    { eventType: "phase-entered", payload: { name: "Only", ordinal: 1 } },
    {
      eventType: "actor-created",
      payload: { actor: { ordinal: 0, siteId: "root/agent0" }, name: "solo", phaseName: "Only" },
    },
    { eventType: "run-settled", payload: { status: "completed" } },
  ]);
  assert.equal(projectionOnlyCardDetail(format, single), "phase · agent");
  assert.equal(calls[0].id, "chat.toolCall.workflow.card.phase", "1 个阶段走单数键");
  assert.equal(calls[1].id, "chat.toolCall.workflow.card.agent", "1 个子代理也走单数键");
});
