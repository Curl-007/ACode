import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SWARM_PLAN_LIMITS,
  reduceSwarmPlanState,
  swarmPlanStateSchema,
  type SwarmPlanState,
} from "../src/acode-protocol-v4/swarm-plan.js";

/**
 * swarm 专用状态键族的归约验收（apps/acode-cli/specs/swarm-observability-projection.md
 * R3/R7 + 验收场景 4）：代际+版本去重、清除语义、坏载荷不产 delta、wire 上限。
 */

const nodeView = (id: string) => ({
  artifactRequeues: 0,
  dependsOn: [],
  expanded: false,
  id,
  isGate: false,
  kind: "implement" as const,
  origin: "seed" as const,
  owner: null,
  priority: 4,
  status: "queued" as const,
});

const baseState = (overrides: Partial<SwarmPlanState> = {}): SwarmPlanState => ({
  counts: { done: 0, failed: 0, gates: 0, queued: 1, running: 0, stalled: 0 },
  createdAtMs: 1_000,
  goal: "test goal",
  mode: "light",
  noArtifactRequeues: 0,
  nodes: [nodeView("n1")],
  readyGateIds: [],
  readyWorkerIds: ["n1"],
  stalledNodeIds: [],
  terminalState: "active",
  updatedAtMs: 1_000,
  version: 1,
  ...overrides,
});

test("schema accepts a valid state and rejects over-limit nodes", () => {
  assert.ok(swarmPlanStateSchema.safeParse(baseState()).success);
  const overLimit = baseState({
    nodes: Array.from({ length: SWARM_PLAN_LIMITS.maxNodes + 1 }, (_, i) => nodeView(`n${i}`)),
  });
  assert.equal(swarmPlanStateSchema.safeParse(overLimit).success, false);
});

test("reduce accepts the first state of a generation", () => {
  const next = reduceSwarmPlanState(undefined, baseState());
  assert.ok(next);
  assert.equal(next.version, 1);
  // zod strip：未知键不进状态（信封来自跨端口载荷，防御面在 safeParse 收口）
  const withJunk = reduceSwarmPlanState(undefined, { ...baseState(), someExtra: "x" });
  assert.ok(withJunk && !("someExtra" in withJunk));
});

test("reduce dedupes same-generation replays and out-of-order frames (scenario 4)", () => {
  const prior = baseState({ version: 5 });
  // 同代际 version <= prior：乱序/重复/冷回放重叠 → 无变化
  assert.equal(reduceSwarmPlanState(prior, baseState({ version: 5 })), undefined);
  assert.equal(reduceSwarmPlanState(prior, baseState({ version: 4 })), undefined);
  // 同代际前进 → 接受
  const advanced = reduceSwarmPlanState(prior, baseState({ version: 6 }));
  assert.ok(advanced && advanced.version === 6);
  // 新代际（清除后重 seed）：即使 version 更小也接受
  const regenerated = reduceSwarmPlanState(prior, baseState({ createdAtMs: 2_000, version: 0 }));
  assert.ok(regenerated && regenerated.createdAtMs === 2_000);
});

test("cleared is a generation finale: null regardless of prior or extra fields", () => {
  assert.equal(reduceSwarmPlanState(baseState({ version: 9 }), { cleared: true }), null);
  assert.equal(reduceSwarmPlanState(null, { cleared: true }), null);
  assert.equal(reduceSwarmPlanState(undefined, { cleared: true }), null);
});

test("malformed envelopes produce no delta", () => {
  assert.equal(reduceSwarmPlanState(baseState(), { version: 99 }), undefined);
  assert.equal(reduceSwarmPlanState(baseState(), { ...baseState(), goal: 42 }), undefined);
  assert.equal(reduceSwarmPlanState(baseState(), {}), undefined);
  assert.equal(
    reduceSwarmPlanState(baseState(), {
      ...baseState(),
      nodes: [{ ...nodeView("n1"), kind: "not-a-kind" }],
    }),
    undefined,
  );
});

test("reduce output is schema-stable (cold replay byte-identity premise, scenario 2)", () => {
  const envelope = baseState({ version: 3 });
  const once = reduceSwarmPlanState(undefined, envelope);
  const twice = reduceSwarmPlanState(once ?? null, { ...envelope, version: 4 });
  assert.ok(once && twice);
  // 同一 reducer 归约同一载荷 → 逐字节一致（冷回放与 live 投影共用实现的前提）
  assert.equal(JSON.stringify(reduceSwarmPlanState(undefined, envelope)), JSON.stringify(once));
  assert.equal(twice.version, 4);
});
