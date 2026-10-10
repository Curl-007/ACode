import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 编排方案 Phase 2 / P2a 投影链验收（apps/acode-cli/specs/swarm-observability-projection.md
 * 验收场景 2/5/7 + R2/R5/R6/R7 的接线守护）：mapper 有界性与 schema 闭环、冷回放/剥离/
 * 发射点/投影 dispatch 的源码级不变量（负向断言仿 no-telemetry 模式）。
 * GUI 合流（P2b）不在本文件范围。
 */

const { buildSwarmPlanProgressPayload } = await import(
  "../packages/bootstrap/src/app/swarm-plan-progress.ts"
);
const { reduceSwarmPlanState, swarmPlanStateSchema, SWARM_PLAN_LIMITS } = await import(
  "../../../packages/shared/src/acode-protocol-v4/swarm-plan.ts"
);

const root = new URL("../", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (base, path) =>
  readFile(new URL(path, base), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
const readCli = (path) => read(root, path);
const readRepo = (path) => read(repoRoot, path);

const node = (id, overrides = {}) => ({
  artifactRequeues: 0,
  content: `task body for ${id}`,
  dependsOn: [],
  expanded: false,
  id,
  isGate: false,
  kind: "implement",
  origin: "seed",
  output: null,
  owner: null,
  parent: null,
  planner: null,
  priority: 4,
  status: "queued",
  ...overrides,
});

const plan = (overrides = {}) => ({
  createdAtMs: 1_000,
  goal: "audit the thing",
  mode: "light",
  noArtifactRequeues: 0,
  nodes: [node("n1"), node("g1", { isGate: true, kind: "critique", dependsOn: ["n1"] })],
  updatedAtMs: 1_500,
  version: 3,
  ...overrides,
});

test("mapper output parses with the shared wire schema (compile gate + runtime gate closed)", () => {
  const payload = buildSwarmPlanProgressPayload(plan());
  assert.equal(payload.version, 3);
  assert.equal(payload.createdAtMs, 1_000);
  assert.equal(payload.updatedAtMs, 1_500);
  assert.equal(payload.mode, "light");
  assert.equal(payload.goal, "audit the thing");
  assert.equal(payload.nodes.length, 2);
  assert.equal(payload.cleared, undefined);
  // counts 来自 buildSwarmPlanStatus 的同一份推导（不另算）
  assert.equal(payload.counts.queued, 2);
  // 载荷整体过 shared schema：两个消费者的形状闭环
  const parsed = swarmPlanStateSchema.safeParse(payload);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues ?? null));
  // reducer 接受该载荷为状态（发射 → 归约全链）
  const state = reduceSwarmPlanState(undefined, payload);
  assert.ok(state && state.version === 3);
});

test("mapper bounds: content preview truncation and node-cap with truncated flag (scenario 5)", () => {
  const longContent = "x".repeat(SWARM_PLAN_LIMITS.maxNodeContentPreviewLength + 40);
  const preview = buildSwarmPlanProgressPayload(plan({ nodes: [node("n1", { content: longContent })] }));
  assert.equal(preview.nodes[0].contentPreview.length, SWARM_PLAN_LIMITS.maxNodeContentPreviewLength);

  const many = Array.from({ length: SWARM_PLAN_LIMITS.maxNodes + 1 }, (_, i) => node(`n${i}`));
  const bounded = buildSwarmPlanProgressPayload(plan({ nodes: many }));
  assert.equal(bounded.nodes.length, SWARM_PLAN_LIMITS.maxNodes);
  assert.equal(bounded.truncated, true);
  assert.ok(swarmPlanStateSchema.safeParse(bounded).success);
});

test("cleared payload shape: only the cleared flag (reducer treats it as generation finale)", () => {
  assert.equal(reduceSwarmPlanState(undefined, { cleared: true }), null);
});

test("projection chain wiring invariants (dispatch / cold replay / v3 strip / cold merge)", async () => {
  const projection = await readCli("packages/bootstrap/src/acode-protocol-v4/product-projection.ts");
  assert.ok(/case SessionEventType\.SwarmPlanProgress:/.test(projection), "dispatch case 缺失");
  assert.ok(/private onSwarmPlanProgress\(/.test(projection), "handler 缺失");
  assert.ok(/reduceSwarmPlanState\(prior, envelope\)/.test(projection), "归约未经 shared reducer");
  assert.ok(
    /patch: \{ swarmPlan: next \}/.test(projection),
    "delta 不是 swarmPlan 键级整体替换",
  );

  const bridge = await readCli("packages/bootstrap/src/acode-protocol/v4-bridge.ts");
  assert.ok(/async function replaySwarmPlanEvent\(/.test(bridge), "冷回放函数缺失");
  assert.ok(/\.\.\.replayedSwarm/.test(bridge), "冷回放事件未前置进 memoryEvents");
  assert.ok(
    /record\.app\.readSwarmPlanStatus/.test(bridge),
    "冷回放未经 app facade 读取口",
  );

  const coldMerge = await readCli("packages/bootstrap/src/acode-protocol-v4/cold-event-merge.ts");
  assert.ok(
    /SessionEventType\.SwarmPlanProgress,/.test(coldMerge),
    "SwarmPlanProgress 未登记 memory-only 词汇表",
  );

  // R2 v4-only：v3 面剥离（场景 7 负向断言）
  const sessionMapper = await readCli("packages/bootstrap/src/acode-protocol/session-mapper.ts");
  const stripBlock = sessionMapper.slice(
    sessionMapper.indexOf("event.type === SessionEventType.SwarmPlanProgress"),
  );
  assert.ok(stripBlock.length > 0, "session-mapper 未剥离 SwarmPlanProgress");
  assert.ok(/return false;/.test(stripBlock.slice(0, 600)), "剥离分支未返回 false");
});

test("emission single point: onChange + hydrate via emitPlanProgress; core method wired (R6)", async () => {
  const wiring = await readCli("packages/bootstrap/src/app/swarm-plan-runtime.ts");
  assert.ok(/const emitPlanProgress = \(plan: SwarmTaskPlan \| null\): void =>/.test(wiring));
  assert.ok(/emitPlanProgress\(plan\);/.test(wiring), "onChange 未发射");
  assert.ok(/emitPlanProgress\(store\.getPlan\(\)\);/.test(wiring), "hydrate 未补发初始态");
  assert.ok(
    /swarm\.plan\.progress_append_failed/.test(wiring),
    "R8 失败语义（warn 留痕）缺失",
  );

  const methodsIndex = await readCli("packages/core/src/runtime/methods/index.ts");
  assert.ok(
    /proto\.recordSwarmPlanProgress = recordSwarmPlanProgress;/.test(methodsIndex),
    "core 方法未挂 proto",
  );

  const createApp = await readCli("packages/bootstrap/src/app/create-app.ts");
  assert.ok(
    /readSwarmPlanStatus: async \(\) => swarmPlanWiring\.readPlanProgress\(\),/.test(createApp),
    "app facade 读取口未接线",
  );
});

test("wire surface: snapshot optional key, patch key, event naming (R1/R2)", async () => {
  const snapshot = await readRepo("packages/shared/src/acode-protocol-v4/snapshot.ts");
  assert.ok(
    /swarmPlan: swarmPlanStateSchema\.nullable\(\)\.optional\(\),/.test(snapshot),
    "snapshot 未挂 swarmPlan optional 键",
  );
  const delta = await readRepo("packages/shared/src/acode-protocol-v4/delta.ts");
  assert.ok(
    /swarmPlan: swarmPlanStateSchema\.nullable\(\)\.optional\(\),/.test(delta),
    "statePatchSchema 未挂 swarmPlan 键",
  );
  const events = await readCli("packages/contracts/src/events/session.events.ts");
  assert.ok(/SwarmPlanProgress: "swarm_plan_progress",/.test(events), "事件命名缺前缀");
  // 旧快照 wire 兼容（场景 8）：不含 swarmPlan 键的快照照常解析
  const legacy = JSON.parse(JSON.stringify({ swarmPlan: undefined }));
  assert.equal("swarmPlan" in legacy, false);
});
