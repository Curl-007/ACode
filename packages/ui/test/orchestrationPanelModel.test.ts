import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { reduceSwarmPlanState } from "../../shared/src/acode-protocol-v4/swarm-plan.js";
import type { SwarmPlanState } from "../../shared/src/acode-protocol-v4/swarm-plan.js";
import { reduceWorkflowRunsState } from "../../shared/src/acode-protocol-v4/workflow-runs-reducer.js";
import type {
  WorkflowRunState,
  WorkflowRunsState,
} from "../../shared/src/acode-protocol-v4/workflow-runs.js";
import { workflowRunStepCounts } from "../../shared/src/acode-protocol-v4/workflow-runs-caps.js";
import {
  buildOrchestrationPanelModel,
  ORCHESTRATION_SWARM_LAMP_CLASS,
  ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT,
} from "../src/app-shell/orchestrationPanelModel.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";

/**
 * 统一编排 side pane 的模型验收（packages/ui/specs/orchestration-side-pane.md 场景 1-7）。
 *
 * fixture 用 shared 的**真 reducer** 铸（workflowRunActivity.test.ts 同款纪律）：
 * swarmPlan 走 reduceSwarmPlanState、workflowRuns 走 reduceWorkflowRunsState——手搓
 * 对象会与 schema 漂移，而这里要证的恰恰是「投影里真实存在的那种状态」被折成什么视图。
 */

const uiRoot = new URL("../", import.meta.url);
const read = (path: string) =>
  readFile(new URL(path, uiRoot), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

const RUN = "wf_orchestration-test";

function reduceRun(envelopes: readonly Record<string, unknown>[]): WorkflowRunState {
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

function swarmEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createdAtMs: 1_000,
    goal: "Audit the orchestration surface",
    mode: "deep",
    version: 3,
    noArtifactRequeues: 0,
    terminalState: "active",
    counts: { done: 1, failed: 0, gates: 1, queued: 1, running: 1, stalled: 0 },
    readyGateIds: [],
    readyWorkerIds: ["w1"],
    stalledNodeIds: [],
    nodes: [
      {
        id: "g1",
        kind: "critique",
        status: "done",
        isGate: true,
        origin: "seed",
        owner: null,
        priority: 4,
        dependsOn: [],
        expanded: false,
        artifactRequeues: 0,
        contentPreview: "root gate",
      },
      {
        id: "w1",
        kind: "implement",
        status: "running",
        isGate: false,
        origin: "seed",
        owner: "agent_x",
        priority: 4,
        dependsOn: ["g1"],
        expanded: false,
        artifactRequeues: 0,
      },
    ],
    updatedAtMs: 2_000,
    ...overrides,
  };
}

function mintSwarm(overrides: Record<string, unknown> = {}): SwarmPlanState {
  const state = reduceSwarmPlanState(undefined, swarmEnvelope(overrides));
  assert.ok(state && state !== null, "swarm reducer 必须铸出状态");
  return state as SwarmPlanState;
}

const subagentsFixture = {
  revision: 7,
  childSessionIds: ["sess_c1", "sess_c2"],
  running: [
    {
      childSessionId: "sess_c1",
      agentId: "agent_a",
      subagentType: "general-purpose",
      title: "probe agent",
      status: "waiting" as const,
      startedAt: 1_500,
    },
  ],
  endedTotal: 2,
};

test("(场景1) 三键齐备：三段视图齐、字段与事实一致", () => {
  const run = reduceRun([{ eventType: "run-started", payload: { dialect: "script" } }]);
  const model = buildOrchestrationPanelModel({
    backgroundWorks: [
      {
        workId: RUN,
        kind: "workflow",
        title: "Nightly build",
        status: "running",
        startedAt: 1_000,
        anchorRowId: null,
      },
    ],
    subagents: subagentsFixture,
    swarmPlan: mintSwarm(),
    workflowRuns: { revision: 1, runs: [run] },
  });

  assert.equal(model.empty, false);
  // Agents：running 事实透传（含 waiting 状态——pane 不重推导，场景 4/6）。
  assert.equal(model.agents?.running.length, 1);
  assert.equal(model.agents?.running[0]?.status, "waiting");
  assert.equal(model.agents?.endedTotal, 2);
  // Workflows：status 是投影派生事实（reducer 只搬运），步数走 shared 唯一实现，
  // 题名来自 workId≡runId 联接（与状态坞同一规则）。
  const row = model.workflows?.rows[0];
  assert.equal(row?.runId, RUN);
  assert.equal(row?.status, run.status);
  assert.equal(row?.title, "Nightly build");
  assert.equal(row?.dialect, "script");
  const steps = workflowRunStepCounts(run);
  assert.equal(row?.nodesSettled, steps.settled);
  assert.equal(row?.nodesTotal, steps.total);
  // Swarm：goal/mode/counts/节点行映射。
  assert.equal(model.swarm?.goal, "Audit the orchestration surface");
  assert.equal(model.swarm?.mode, "deep");
  assert.equal(model.swarm?.counts.running, 1);
  assert.deepEqual(
    model.swarm?.nodes.map((node) => node.id),
    ["g1", "w1"],
  );
  assert.equal(model.swarm?.nodes[0]?.isGate, true);
  assert.equal(model.swarm?.nodes[1]?.dependsOnCount, 1);
  assert.equal(model.swarm?.nodes[0]?.contentPreview, "root gate");
  assert.equal(model.swarm?.nodes[1]?.contentPreview, undefined);
  assert.equal(model.swarm?.nodeDisplayTruncated, false);
  assert.equal(model.swarm?.wireTruncated, false);
});

test("(场景2) 键缺席 / swarmPlan=null / 空值 → 对应段 null；全空 → empty", () => {
  const all = buildOrchestrationPanelModel({});
  assert.equal(all.agents, null);
  assert.equal(all.workflows, null);
  assert.equal(all.swarm, null);
  assert.equal(all.empty, true);

  const cleared = buildOrchestrationPanelModel({ swarmPlan: null });
  assert.equal(cleared.swarm, null);

  // running 空 + endedTotal 0 = 无可展示事实 → 段隐藏（不渲染空框）。
  const idleAgents = buildOrchestrationPanelModel({
    subagents: { revision: 1, childSessionIds: [], running: [], endedTotal: 0 },
  });
  assert.equal(idleAgents.agents, null);
  // endedTotal > 0 时段保留（已结束目录是跳转价值所在）。
  const endedOnly = buildOrchestrationPanelModel({
    subagents: { revision: 1, childSessionIds: [], running: [], endedTotal: 3 },
  });
  assert.equal(endedOnly.agents?.endedTotal, 3);
  // runs 空数组 → 段隐藏。
  const noRuns = buildOrchestrationPanelModel({ workflowRuns: { revision: 1, runs: [] } });
  assert.equal(noRuns.workflows, null);
});

test("(场景3) swarm 节点渲染上限 200 + wire truncated 如实透传", () => {
  const nodes = Array.from({ length: ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT + 5 }, (_, index) => ({
    id: `n${index}`,
    kind: "implement",
    status: "queued",
    isGate: false,
    origin: "seed",
    owner: null,
    priority: 4,
    dependsOn: [],
    expanded: false,
    artifactRequeues: 0,
  }));
  const model = buildOrchestrationPanelModel({
    swarmPlan: mintSwarm({ nodes, truncated: true }),
  });
  assert.equal(model.swarm?.nodes.length, ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT);
  assert.equal(model.swarm?.nodeTotal, ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT + 5);
  assert.equal(model.swarm?.nodeDisplayTruncated, true);
  assert.equal(model.swarm?.wireTruncated, true);
});

test("(场景4) 状态灯映射单点：四态全部落语义 token（无一次性颜色）", () => {
  assert.equal(ORCHESTRATION_SWARM_LAMP_CLASS.done, "bg-success");
  assert.equal(ORCHESTRATION_SWARM_LAMP_CLASS.running, "bg-warning");
  assert.equal(ORCHESTRATION_SWARM_LAMP_CLASS.failed, "bg-destructive");
  assert.equal(ORCHESTRATION_SWARM_LAMP_CLASS.queued, "border-foreground-subtlest");
});

test("(场景5) 联接规则：bash 类 work 与错 id 的 work 都不进 workflow 行", () => {
  const run = reduceRun([{ eventType: "run-started", payload: { dialect: "script" } }]);
  const model = buildOrchestrationPanelModel({
    backgroundWorks: [
      {
        workId: RUN,
        kind: "bash",
        title: "not joined",
        status: "running",
        startedAt: 1,
        anchorRowId: null,
      },
      {
        workId: "wf_other",
        kind: "workflow",
        title: "wrong id",
        status: "running",
        startedAt: 1,
        anchorRowId: null,
      },
    ],
    workflowRuns: { revision: 1, runs: [run] },
  });
  assert.equal(model.workflows?.rows.length, 1);
  assert.equal(model.workflows?.rows[0]?.title, undefined);
});

test("(场景7) 守护：面板分支带 visible 门；双词典 orchestration 键集合一致；状态坞入口在位", async () => {
  const panel = await read("src/app-shell/AnimatedSidePanePanel.tsx");
  const branchStart = panel.indexOf('tab.type === "orchestration"');
  assert.ok(branchStart !== -1, "orchestration 渲染分支缺失");
  const branch = panel.slice(branchStart, branchStart + 600);
  assert.ok(
    branch.includes("visible={isVisible && tab.id === visibleActiveTabId}"),
    "orchestration 分支必须透传 visible（R4：lease 以可见性为门）",
  );

  const orchestrationKeys = (messages: Record<string, string>) =>
    Object.keys(messages)
      .filter((key) => key.startsWith("orchestration.") || key === "sidePane.orchestration")
      .sort();
  const zhKeys = orchestrationKeys(zhCN);
  const enKeys = orchestrationKeys(enUS);
  assert.ok(zhKeys.length >= 12, `zh-CN 缺 orchestration 文案（${zhKeys.length}）`);
  assert.deepEqual(enKeys, zhKeys, "两份词典的 orchestration 键集合必须一致（R6）");

  const statusPanel = await read("src/v4/ConversationStatusPanel.tsx");
  assert.ok(statusPanel.includes("onOpenOrchestration({ parentSessionId })"), "状态坞菜单入口缺失");
});
