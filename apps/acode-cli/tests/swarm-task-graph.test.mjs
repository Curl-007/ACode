import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * K2 对话内 Swarm 任务图 第一段：contracts 契约 + 图引擎纯函数
 * （specs/swarm-task-graph.md 验收场景 1-5 + 确定性调度序 + R3 dataflow 裁剪）。
 *
 * 机制参照 jcode (MIT) crates/jcode-plan/src/dag/sim.rs 的「模拟器先行」方法论：调度/失败/
 * gate 序列先在纯函数矩阵里钉住，再接真实子会话（fake runner 端到端是第二段 R4 的形态）。
 *
 * 覆盖分组（对应 spec 验收场景）：
 *   1 —— seed：幂等重放 no-op、deep 强制 root gate 依赖全部 root、re-seed 重开审计、
 *        blank id / duplicate / unknown / cycle / limit 拒绝；
 *   2 —— expand：父 composite 化、children 数据边保留（R3 装配断言）、deep 自动子 gate、
 *        owner 清空、planner 记录、未知依赖/环/blank/duplicate/上限拒绝、gate 不可分解；
 *   3 —— completeWorkerNode：deep 薄 artifact 三要素逐条拒（复用 validateDeepNodeArtifact
 *        口径）、light 任意产出接受、状态/所有权门槛；
 *   4 —— completeGateNode：橡皮图章拒（issue 载荷 + gapProposals 回传）、低置信两档拒、
 *        点名齐全过、stale scope 拒、fail 产 gap 注入（gate 重置 queued 依赖 gap、
 *        parent 依赖 gap）、被拒 pass 的引擎恢复流（error.gapProposals → injectGap）；
 *   5 —— 失败不传播：stalled 推导 + retry 恢复 + artifactRequeues 不清零；
 *   调度确定性：priority 升序 + id 字典序；ready 依赖门槛；
 *   dataflow：单段 2000 截断、总 16000 预算、不可信声明、无 Done 上游不附段、
 *        deep worker 契约段（light/gate 不附）；
 *   契约一致性：引擎产物过 SwarmTaskPlanSchema、status 枚举不含 blocked、常量对表。
 */

const {
  SwarmPlanNodeKindSchema,
  SwarmPlanNodeStatusSchema,
  SwarmTaskPlanSchema,
  SWARM_ARTIFACT_RENDER_MAX_CHARS,
  SWARM_ARTIFACT_RENDER_TOTAL_MAX_CHARS,
  SWARM_DEFAULT_NO_ARTIFACT_REQUEUE_CAP,
  SWARM_MAX_CONCURRENT_WORKERS,
  SWARM_MAX_NODE_DEPENDS,
  SWARM_MAX_PLAN_ITEMS,
} = await import("../packages/contracts/src/swarm/index.ts");
const { completeGateNode, completeWorkerNode, expandNode, injectGap, requeueNode, seedPlan } =
  await import("../packages/core/src/swarm/graph/ops.ts");
const { planTerminalState, readyNodeIds, readyNodes, stalledNodeIds } =
  await import("../packages/core/src/swarm/graph/schedule.ts");
const { assembleNodeInput } = await import("../packages/core/src/swarm/graph/dataflow.ts");
const { validateDeepNodeArtifact } =
  await import("../packages/core/src/workflow/typed-artifact.ts");

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function def(id, content = `work of ${id}`, opts = {}) {
  return {
    id,
    content,
    kind: opts.kind ?? "implement",
    dependsOn: opts.dependsOn ?? [],
    priority: opts.priority ?? 4,
  };
}

function artifact(overrides = {}) {
  return {
    findings: "did the work",
    evidence: ["src/a.ts:10"],
    openQuestions: [],
    whatINotChecked: ["nothing, fully covered"],
    confidence: "medium",
    ...overrides,
  };
}

function okOf(result) {
  assert.ok(result.ok, `expected ok result, got: ${JSON.stringify(result)}`);
  return result.plan;
}

function errOf(result) {
  assert.ok(!result.ok, `expected error result, got: ${result.plan && "ok"}`);
  return result.error;
}

function nodeOf(plan, id) {
  const node = plan.nodes.find((candidate) => candidate.id === id);
  assert.ok(node !== undefined, `node "${id}" missing from plan`);
  return node;
}

// 模拟 R4 runner 派发：置 running + 分配 owner（owner 只由 runner 分配，R6 不变量）。
function claim(plan, id, owner = `exec-${id}`) {
  const next = structuredClone(plan);
  const node = nodeOf(next, id);
  node.status = "running";
  node.owner = owner;
  return next;
}

function runWorker(plan, id, typed, owner = `exec-${id}`) {
  return okOf(completeWorkerNode(claim(plan, id, owner), id, typed, { actor: owner }));
}

// 模拟 R4 runner 失败路径（本段没有 fail op，失败落图归 runner）。
function markFailed(plan, id) {
  const next = structuredClone(plan);
  const node = nodeOf(next, id);
  node.status = "failed";
  node.owner = null;
  return next;
}

// ---------------------------------------------------------------------------
// 契约一致性与常量
// ---------------------------------------------------------------------------

test("常量与 spec 常量表一致（改 contracts 即改协议）", () => {
  assert.equal(SWARM_MAX_PLAN_ITEMS, 1024);
  assert.equal(SWARM_MAX_NODE_DEPENDS, 100);
  assert.equal(SWARM_ARTIFACT_RENDER_MAX_CHARS, 2000);
  assert.equal(SWARM_ARTIFACT_RENDER_TOTAL_MAX_CHARS, 16000);
  assert.equal(SWARM_MAX_CONCURRENT_WORKERS, 4);
  assert.equal(SWARM_DEFAULT_NO_ARTIFACT_REQUEUE_CAP, 1);
});

test("契约：引擎产物过 SwarmTaskPlanSchema；status 枚举不含 blocked（推导不落存储）", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a"), def("b")], "deep", { nowMs: NOW }));
  plan = okOf(expandNode(plan, "a", [def("c")], "main", { nowMs: NOW }));
  plan = runWorker(plan, "b", artifact());
  plan = okOf(
    completeGateNode(plan, "root-gate", {
      pass: false,
      reasoning: "not enough coverage",
      acceptanceGaps: ["missing error handling"],
      gapProposals: [],
    }),
  );
  const parsed = SwarmTaskPlanSchema.safeParse(plan);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues ?? []));
  assert.equal(SwarmPlanNodeStatusSchema.safeParse("blocked").success, false);
  assert.deepEqual(SwarmPlanNodeKindSchema.options, [
    "explore",
    "implement",
    "verify",
    "fix",
    "synthesize",
    "critique",
  ]);
});

// ---------------------------------------------------------------------------
// 场景 1：seed
// ---------------------------------------------------------------------------

test("seed：light 建 queued 根节点，无自动 gate", () => {
  const plan = okOf(
    seedPlan(null, "goal", [def("a"), def("b", undefined, { dependsOn: ["a"] })], "light", {
      nowMs: NOW,
    }),
  );
  assert.equal(plan.mode, "light");
  assert.equal(plan.version, 1);
  assert.deepEqual(
    plan.nodes.map((node) => node.id),
    ["a", "b"],
  );
  const a = nodeOf(plan, "a");
  assert.equal(a.status, "queued");
  assert.equal(a.origin, "seed");
  assert.equal(a.parent, null);
  assert.equal(a.isGate, false);
  assert.equal(a.owner, null);
  assert.equal(a.output, null);
  assert.equal(a.expanded, false);
  assert.deepEqual(nodeOf(plan, "b").dependsOn, ["a"]);
  assert.ok(!plan.nodes.some((node) => node.isGate));
});

test("seed：幂等重放 no-op（防工具重试双写）", () => {
  const defs = [def("a"), def("b", undefined, { dependsOn: ["a"] })];
  const first = okOf(seedPlan(null, "goal", defs, "deep", { nowMs: NOW }));
  const replay = seedPlan(first, "goal", defs, "deep", { nowMs: NOW + 5000 });
  assert.ok(replay.ok && replay.noOp);
  assert.equal(replay.plan, first); // 真 no-op：同引用，version/updatedAtMs 不动
  const replayReordered = seedPlan(first, "goal", [defs[1], defs[0]], "deep", { nowMs: NOW });
  assert.ok(replayReordered.ok && replayReordered.noOp); // defs 集合语义，顺序差不构成新种子
  const replayDifferentGoal = seedPlan(first, "goal-2", defs, "deep", { nowMs: NOW });
  assert.ok(replayDifferentGoal.ok && !replayDifferentGoal.noOp);
});

test("seed：deep 强制 root gate 在场且依赖全部无 parent 节点", () => {
  const plan = okOf(
    seedPlan(
      null,
      "goal",
      [def("a"), def("b"), def("c", undefined, { dependsOn: ["a"] })],
      "deep",
      { nowMs: NOW },
    ),
  );
  const gate = plan.nodes.find((node) => node.isGate);
  assert.ok(gate !== undefined, "deep seed must insert a root gate");
  assert.equal(gate.kind, "critique");
  assert.equal(gate.parent, null);
  assert.equal(gate.origin, "gate");
  assert.equal(gate.status, "queued");
  assert.deepEqual([...gate.dependsOn].sort(), ["a", "b", "c"]);
});

test("seed：re-seed 重开审计——已 done 的 root gate 重置 queued 且纳入新 root", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a"), def("b")], "deep", { nowMs: NOW }));
  plan = runWorker(plan, "a", artifact());
  plan = runWorker(plan, "b", artifact());
  plan = okOf(
    completeGateNode(plan, "root-gate", {
      pass: true,
      reasoning: "a: verified. b: verified.",
      acceptanceGaps: [],
      gapProposals: [],
    }),
  );
  assert.equal(nodeOf(plan, "root-gate").status, "done");
  assert.equal(planTerminalState(plan), "completed");

  const reseeded = okOf(
    seedPlan(plan, "goal", [def("a"), def("b"), def("c")], "deep", { nowMs: NOW + 1000 }),
  );
  const gate = nodeOf(reseeded, "root-gate");
  assert.equal(gate.status, "queued"); // terminal gate 重开审计
  assert.equal(gate.output, null);
  assert.deepEqual([...gate.dependsOn].sort(), ["a", "b", "c"]); // 新 root 纳入依赖
  assert.equal(nodeOf(reseeded, "c").status, "queued");
  assert.equal(nodeOf(reseeded, "a").status, "done"); // 重放不重写已完成工作
  assert.equal(reseeded.version, plan.version + 1);
  assert.equal(planTerminalState(reseeded), "active");
});

test("seed：blank id / duplicate / unknown 引用 / 环 / 上限拒绝", () => {
  assert.equal(errOf(seedPlan(null, "g", [def("  ")], "light")).kind, "blank-id");
  assert.equal(errOf(seedPlan(null, "g", [def("a"), def("a")], "light")).kind, "duplicate-id");
  assert.equal(
    errOf(seedPlan(null, "g", [def("a", undefined, { dependsOn: ["ghost"] })], "light")).kind,
    "unknown-node",
  );
  assert.equal(
    errOf(
      seedPlan(
        null,
        "g",
        [def("a", undefined, { dependsOn: ["b"] }), def("b", undefined, { dependsOn: ["a"] })],
        "light",
      ),
    ).kind,
    "cycle",
  );
  const many = Array.from({ length: SWARM_MAX_PLAN_ITEMS + 1 }, (_, index) => def(`n${index}`));
  const limitError = errOf(seedPlan(null, "g", many, "light"));
  assert.equal(limitError.kind, "limit-exceeded");
  assert.equal(limitError.limit, SWARM_MAX_PLAN_ITEMS);
  assert.equal(limitError.actual, SWARM_MAX_PLAN_ITEMS + 1);
});

// ---------------------------------------------------------------------------
// 场景 2：expand
// ---------------------------------------------------------------------------

test("expand：父 composite 化、保留原 dependsOn、children 数据边、owner 清空、planner 记录", () => {
  let plan = okOf(
    seedPlan(null, "goal", [def("x"), def("a", undefined, { dependsOn: ["x"] })], "light", {
      nowMs: NOW,
    }),
  );
  plan = claim(plan, "a", "w1");
  plan = okOf(expandNode(plan, "a", [def("b"), def("c")], "w1", { nowMs: NOW }));
  const parent = nodeOf(plan, "a");
  assert.equal(parent.expanded, true);
  assert.equal(parent.status, "queued");
  assert.equal(parent.owner, null); // planner 记录后 owner 清空（合成可被任意 worker 领取）
  assert.equal(parent.planner, "w1");
  assert.deepEqual(parent.dependsOn, ["x", "b", "c"]); // 原上游保留 + children 直接数据边
  assert.equal(parent.output, null);
  assert.equal(nodeOf(plan, "b").parent, "a");
  assert.equal(nodeOf(plan, "b").origin, "expand");
  assert.equal(nodeOf(plan, "b").status, "queued");
  assert.deepEqual(nodeOf(plan, "c").dependsOn, []);
  assert.ok(!plan.nodes.some((node) => node.isGate)); // light 不自动插 gate
});

test("expand：children 数据边保留——synthesis 装配能收到子 artifact（R3）", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a")], "light", { nowMs: NOW }));
  plan = okOf(expandNode(plan, "a", [def("b"), def("c")], "main", { nowMs: NOW }));
  plan = runWorker(plan, "b", artifact({ findings: "b-result" }));
  plan = runWorker(plan, "c", artifact({ findings: "c-result" }));
  const input = assembleNodeInput(plan, "a");
  assert.ok(input.includes("b-result"));
  assert.ok(input.includes("c-result"));
});

test("expand：deep 自动子 gate（children 与 parent 之间）", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a")], "deep", { nowMs: NOW }));
  plan = okOf(expandNode(plan, "a", [def("b"), def("c")], "main", { nowMs: NOW }));
  const childGate = plan.nodes.find((node) => node.isGate && node.parent === "a");
  assert.ok(childGate !== undefined, "deep expand must auto-insert a child gate");
  assert.equal(childGate.kind, "critique");
  assert.equal(childGate.origin, "gate");
  assert.deepEqual([...childGate.dependsOn].sort(), ["b", "c"]);
  assert.deepEqual(nodeOf(plan, "a").dependsOn, ["b", "c", childGate.id]);
  // root gate 不受影响（parent===null 区分子 gate）
  assert.ok(plan.nodes.some((node) => node.isGate && node.parent === null));
});

test("expand：所有权与状态门槛（owner-or-unclaimed / 未 expanded / queued|running）", () => {
  const plan = okOf(seedPlan(null, "goal", [def("a")], "light", { nowMs: NOW }));
  assert.equal(errOf(expandNode(plan, "ghost", [def("b")], "main")).kind, "unknown-node");
  const owned = claim(plan, "a", "w1");
  assert.equal(errOf(expandNode(owned, "a", [def("b")], "w2")).kind, "not-owner");
  const done = runWorker(owned, "a", artifact(), "w1");
  assert.equal(errOf(expandNode(done, "a", [def("b")], "w1")).kind, "invalid-state");
  const expanded = okOf(expandNode(claim(plan, "a", "w1"), "a", [def("b")], "w1"));
  assert.equal(errOf(expandNode(expanded, "a", [def("d")], "w1")).kind, "invalid-state");
  // 无主 queued 节点可被任意 actor 分解（unclaimed）
  const unclaimed = okOf(expandNode(plan, "a", [def("e")], "anyone"));
  assert.equal(nodeOf(unclaimed, "e").parent, "a");
});

test("expand：gate 不可分解（补缺口走 gap 注入）", () => {
  const plan = okOf(seedPlan(null, "goal", [def("a")], "deep", { nowMs: NOW }));
  assert.equal(errOf(expandNode(plan, "root-gate", [def("b")], "main")).kind, "invalid-state");
});

test("expand：未知依赖 / 环 / blank / duplicate / 上限拒绝", () => {
  const plan = okOf(seedPlan(null, "goal", [def("a")], "light", { nowMs: NOW }));
  assert.equal(
    errOf(expandNode(plan, "a", [def("b", undefined, { dependsOn: ["ghost"] })], "main")).kind,
    "unknown-node",
  );
  // child 依赖 parent + parent 追加 child 边 → 环（expand 只追加出边时的新环即拒）
  assert.equal(
    errOf(expandNode(plan, "a", [def("b", undefined, { dependsOn: ["a"] })], "main")).kind,
    "cycle",
  );
  assert.equal(errOf(expandNode(plan, "a", [def("  ")], "main")).kind, "blank-id");
  assert.equal(errOf(expandNode(plan, "a", [def("a")], "main")).kind, "duplicate-id");
  const big = okOf(
    seedPlan(
      null,
      "goal",
      Array.from({ length: SWARM_MAX_PLAN_ITEMS - 1 }, (_, index) => def(`n${index}`)),
      "light",
      { nowMs: NOW },
    ),
  );
  const limitError = errOf(expandNode(big, "n0", [def("c1"), def("c2")], "main"));
  assert.equal(limitError.kind, "limit-exceeded");
});

// ---------------------------------------------------------------------------
// 场景 3：completeWorkerNode
// ---------------------------------------------------------------------------

test("completeWorkerNode：deep 薄 artifact 三要素逐条拒（thin-artifact 不落图）", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a")], "deep", { nowMs: NOW }));
  plan = claim(plan, "a");

  const missingFindings = errOf(
    completeWorkerNode(plan, "a", artifact({ findings: "" }), { actor: "exec-a" }),
  );
  assert.equal(missingFindings.kind, "thin-artifact");
  assert.ok(missingFindings.reasons.some((reason) => reason.includes("findings")));

  const missingNotChecked = errOf(
    completeWorkerNode(plan, "a", artifact({ whatINotChecked: [] }), { actor: "exec-a" }),
  );
  assert.equal(missingNotChecked.kind, "thin-artifact");
  assert.ok(missingNotChecked.reasons.some((reason) => reason.includes("whatINotChecked")));

  const missingConfidence = errOf(
    completeWorkerNode(plan, "a", artifact({ confidence: undefined }), { actor: "exec-a" }),
  );
  assert.equal(missingConfidence.kind, "thin-artifact");
  assert.ok(missingConfidence.reasons.some((reason) => reason.includes("confidence")));

  const noArtifact = errOf(completeWorkerNode(plan, "a", null, { actor: "exec-a" }));
  assert.equal(noArtifact.kind, "thin-artifact");

  // clone-stage-commit：被拒的完成不写穿输入图
  assert.equal(nodeOf(plan, "a").status, "running");
});

test("completeWorkerNode：deep 薄校验口径与 validateDeepNodeArtifact 一致（复用不另立）", () => {
  const thin = artifact({ findings: "", confidence: undefined });
  assert.deepEqual(validateDeepNodeArtifact(thin), [
    "deep-mode artifact requires non-empty findings",
    'deep-mode artifact must state a confidence of low, medium, or high (an honest "low" routes follow-up work instead of penalizing you)',
  ]);
  let plan = okOf(seedPlan(null, "goal", [def("a")], "deep", { nowMs: NOW }));
  plan = claim(plan, "a");
  const error = errOf(completeWorkerNode(plan, "a", thin, { actor: "exec-a" }));
  assert.deepEqual(error.reasons, validateDeepNodeArtifact(thin));
});

test("completeWorkerNode：deep 合法 artifact → done + output 落图 + owner 清空（诚实 low 不拒）", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a")], "deep", { nowMs: NOW }));
  const typed = artifact({
    confidence: "low",
    findings: "partial work",
    whatINotChecked: ["edge cases"],
  });
  plan = runWorker(plan, "a", typed);
  const node = nodeOf(plan, "a");
  assert.equal(node.status, "done");
  assert.equal(node.owner, null);
  assert.deepEqual(node.output, typed);
});

test("completeWorkerNode：light 任意产出接受（null / 部分 artifact）", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a"), def("b")], "light", { nowMs: NOW }));
  plan = runWorker(plan, "a", null);
  assert.equal(nodeOf(plan, "a").status, "done");
  assert.equal(nodeOf(plan, "a").output, null);
  plan = runWorker(plan, "b", {
    findings: "",
    evidence: [],
    openQuestions: [],
    whatINotChecked: [],
  });
  assert.equal(nodeOf(plan, "b").status, "done");
  assert.equal(planTerminalState(plan), "completed");
});

test("completeWorkerNode：状态与所有权门槛", () => {
  const plan = okOf(seedPlan(null, "goal", [def("a")], "light", { nowMs: NOW }));
  assert.equal(errOf(completeWorkerNode(plan, "a", null)).kind, "invalid-state"); // queued 未派发
  assert.equal(errOf(completeWorkerNode(plan, "ghost", null)).kind, "unknown-node");
  const claimed = claim(plan, "a", "w1");
  assert.equal(errOf(completeWorkerNode(claimed, "a", null, { actor: "w2" })).kind, "not-owner");
  const deepPlan = okOf(seedPlan(null, "goal", [def("a")], "deep", { nowMs: NOW }));
  assert.equal(
    errOf(completeWorkerNode(deepPlan, "root-gate", null)).kind,
    "invalid-state", // gate 走 completeGateNode
  );
});

// ---------------------------------------------------------------------------
// 场景 4：completeGateNode
// ---------------------------------------------------------------------------

test("completeGateNode：deep 橡皮图章拒（issue 载荷 + gapProposals 回传，不落图）", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a"), def("b")], "deep", { nowMs: NOW }));
  plan = runWorker(plan, "a", artifact({ confidence: "low", findings: "partial" }));
  plan = runWorker(plan, "b", artifact());
  const rejected = errOf(
    completeGateNode(plan, "root-gate", {
      pass: true,
      reasoning: "everything looks fine",
      acceptanceGaps: [],
      gapProposals: [{ id: "gap-1", content: "harden a" }],
    }),
  );
  assert.equal(rejected.kind, "gate-rejected");
  assert.deepEqual(rejected.issues.map((issue) => issue.kind).sort(), [
    "unaddressed_low_confidence",
    "uncovered_siblings",
  ]);
  assert.deepEqual(rejected.gapProposals, [{ id: "gap-1", content: "harden a" }]);
  assert.equal(nodeOf(plan, "root-gate").status, "queued"); // 拒绝不写穿输入图
});

test("completeGateNode：点名齐全 → done → plan completed", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a"), def("b")], "deep", { nowMs: NOW }));
  plan = runWorker(plan, "a", artifact({ confidence: "low", findings: "partial" }));
  plan = runWorker(plan, "b", artifact());
  plan = okOf(
    completeGateNode(plan, "root-gate", {
      pass: true,
      reasoning:
        "a: low confidence acceptable because the scope was narrowed and manually checked. b: verified end to end.",
      acceptanceGaps: [],
      gapProposals: [],
    }),
  );
  const gate = nodeOf(plan, "root-gate");
  assert.equal(gate.status, "done");
  assert.equal(gate.owner, null);
  assert.ok(gate.output.findings.includes("a:"));
  assert.equal(planTerminalState(plan), "completed");
});

test("completeGateNode：审计范围未走完即 pass → gate-scope-stale", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a"), def("b")], "deep", { nowMs: NOW }));
  plan = runWorker(plan, "a", artifact());
  // b 仍是 queued：stale_gate_scope 是更具体的拒绝（most-specific first）
  const stale = errOf(
    completeGateNode(plan, "root-gate", {
      pass: true,
      reasoning: "a: ok. b: ok.",
      acceptanceGaps: [],
      gapProposals: [],
    }),
  );
  assert.equal(stale.kind, "gate-scope-stale");
  assert.deepEqual(stale.issues, [{ kind: "stale_gate_scope", nodeIds: ["b"] }]);
});

test("completeGateNode：低置信未点名两档同拒（deep + light 构造面）", () => {
  // deep 档：低置信债务包含在橡皮图章拒里（unaddressed_low_confidence）
  let deepPlan = okOf(seedPlan(null, "goal", [def("a")], "deep", { nowMs: NOW }));
  deepPlan = runWorker(deepPlan, "a", artifact({ confidence: "low", findings: "partial" }));
  const deepRejected = errOf(
    completeGateNode(deepPlan, "root-gate", {
      pass: true,
      reasoning: "fine",
      acceptanceGaps: [],
      gapProposals: [],
    }),
  );
  assert.ok(deepRejected.issues.some((issue) => issue.kind === "unaddressed_low_confidence"));

  // light 档：seed 不自动建 gate——手工挂一个，验证 light 分支只强制置信度债务
  let lightPlan = okOf(seedPlan(null, "goal", [def("a"), def("b")], "light", { nowMs: NOW }));
  lightPlan = runWorker(lightPlan, "a", artifact({ confidence: "low", findings: "partial" }));
  lightPlan = runWorker(lightPlan, "b", artifact({ confidence: "high" }));
  lightPlan.nodes.push({
    id: "manual-gate",
    content: "audit",
    kind: "critique",
    status: "queued",
    owner: null,
    parent: null,
    dependsOn: ["a", "b"],
    expanded: false,
    isGate: true,
    planner: null,
    priority: 9,
    output: null,
    origin: "gate",
    artifactRequeues: 0,
  });
  const lightRejected = errOf(
    completeGateNode(lightPlan, "manual-gate", {
      pass: true,
      reasoning: "all good",
      acceptanceGaps: [],
      gapProposals: [],
    }),
  );
  assert.equal(lightRejected.kind, "gate-rejected");
  assert.deepEqual(lightRejected.issues, [
    { kind: "unaddressed_low_confidence", nodeIds: ["a"] }, // light 无覆盖/stale 债务
  ]);
  const lightPassed = okOf(
    completeGateNode(lightPlan, "manual-gate", {
      pass: true,
      reasoning: "a: low confidence addressed by a manual cross-check. b: ok.",
      acceptanceGaps: [],
      gapProposals: [],
    }),
  );
  assert.equal(nodeOf(lightPassed, "manual-gate").status, "done");
});

test("completeGateNode：fail 结论 → gap 注入（gate 重置 queued 依赖 gap、parent 依赖 gap）", () => {
  let plan = okOf(seedPlan(null, "goal", [def("p")], "deep", { nowMs: NOW }));
  plan = okOf(expandNode(plan, "p", [def("b"), def("c")], "main", { nowMs: NOW }));
  const childGate = plan.nodes.find((node) => node.isGate && node.parent === "p");
  plan = runWorker(plan, "b", artifact());
  plan = runWorker(plan, "c", artifact());
  assert.ok(readyNodeIds(plan).includes(childGate.id)); // children 全 done → 子 gate ready

  const result = completeGateNode(plan, childGate.id, {
    pass: false,
    reasoning: "error handling for b is not covered",
    acceptanceGaps: [],
    gapProposals: [{ id: "g1", content: "cover error handling for b", kind: "fix" }],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.injectedGapIds, ["g1"]);
  const gate = nodeOf(result.plan, childGate.id);
  assert.equal(gate.status, "queued"); // gate 重置 queued 依赖 gap（re-critique 循环）
  assert.ok(gate.dependsOn.includes("g1"));
  const gap = nodeOf(result.plan, "g1");
  assert.equal(gap.origin, "gap");
  assert.equal(gap.parent, "p"); // gap 挂 gate 的 parent 下作兄弟
  assert.equal(gap.kind, "fix");
  assert.deepEqual(nodeOf(result.plan, "p").dependsOn, [
    "b",
    "c",
    childGate.id,
    "g1", // parent 直接依赖 gap（dataflow 水合只读直接依赖）
  ]);
  // gap 完成后 gate 重新 ready
  const next = runWorker(result.plan, "g1", artifact());
  assert.ok(readyNodeIds(next).includes(childGate.id));
});

test("completeGateNode：fail 无 gapProposals 时从 acceptanceGaps 合成；两者皆空拒绝", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a")], "deep", { nowMs: NOW }));
  plan = runWorker(plan, "a", artifact());
  const synthesized = completeGateNode(plan, "root-gate", {
    pass: false,
    reasoning: "not enough",
    acceptanceGaps: ["missing error handling"],
    gapProposals: [],
  });
  assert.ok(synthesized.ok);
  assert.equal(synthesized.injectedGapIds.length, 1);
  const gap = synthesized.plan.nodes.find((node) => node.origin === "gap");
  assert.ok(gap !== undefined);
  assert.ok(gap.content.includes("error handling"));
  const deadEnd = errOf(
    completeGateNode(plan, "root-gate", {
      pass: false,
      reasoning: "bad",
      acceptanceGaps: [],
      gapProposals: [],
    }),
  );
  assert.equal(deadEnd.kind, "invalid-state");
});

test("completeGateNode：被拒 pass 的引擎恢复流——error.gapProposals → injectGap → 复审通过", () => {
  let plan = okOf(seedPlan(null, "goal", [def("a"), def("b")], "deep", { nowMs: NOW }));
  plan = runWorker(plan, "a", artifact({ confidence: "low", findings: "partial" }));
  plan = runWorker(plan, "b", artifact());
  const rejected = errOf(
    completeGateNode(plan, "root-gate", {
      pass: true,
      reasoning: "all fine",
      acceptanceGaps: [],
      gapProposals: [{ id: "gap-a", content: "harden a" }],
    }),
  );
  assert.equal(rejected.kind, "gate-rejected");

  // 引擎拿错误载荷执行 injectGap（被拒 → 补缺口 → 复审的循环入口）
  const injected = injectGap(plan, "root-gate", rejected.gapProposals);
  assert.ok(injected.ok);
  assert.deepEqual(injected.injectedGapIds, ["gap-a"]);
  assert.equal(nodeOf(injected.plan, "root-gate").status, "queued");
  assert.ok(nodeOf(injected.plan, "root-gate").dependsOn.includes("gap-a"));
  assert.equal(nodeOf(injected.plan, "gap-a").origin, "gap");

  let next = runWorker(injected.plan, "gap-a", artifact());
  assert.ok(readyNodeIds(next).includes("root-gate"));
  // 复审必须点名含 gap 节点在内的全部 done 非 gate 节点（deep 对抗循环）
  const passed = okOf(
    completeGateNode(next, "root-gate", {
      pass: true,
      reasoning: "a: addressed via gap-a hardening. b: verified. gap-a: verified.",
      acceptanceGaps: [],
      gapProposals: [],
    }),
  );
  assert.equal(nodeOf(passed, "root-gate").status, "done");
  assert.equal(planTerminalState(passed), "completed");
});
test("completeGateNode / injectGap：门槛与入参校验", () => {
  const plan = okOf(seedPlan(null, "goal", [def("a")], "deep", { nowMs: NOW }));
  assert.equal(
    errOf(
      completeGateNode(plan, "ghost", {
        pass: true,
        reasoning: "",
        acceptanceGaps: [],
        gapProposals: [],
      }),
    ).kind,
    "unknown-node",
  );
  assert.equal(
    errOf(
      completeGateNode(plan, "a", {
        pass: true,
        reasoning: "",
        acceptanceGaps: [],
        gapProposals: [],
      }),
    ).kind,
    "invalid-state", // 非 gate 节点
  );
  assert.equal(errOf(injectGap(plan, "a", [{ content: "x" }])).kind, "invalid-state");
  assert.equal(errOf(injectGap(plan, "root-gate", [])).kind, "invalid-state");
  assert.equal(errOf(injectGap(plan, "root-gate", [{ content: "  " }])).kind, "invalid-state");
  assert.equal(
    errOf(injectGap(plan, "root-gate", [{ id: "a", content: "x" }])).kind,
    "duplicate-id",
  );
  // 缺省 id 确定性生成且不与既有节点冲突
  const autoId = injectGap(plan, "root-gate", [{ content: "cover x" }]);
  assert.ok(autoId.ok);
  assert.deepEqual(autoId.injectedGapIds, ["gap-root-gate-1"]);
  assert.equal(nodeOf(autoId.plan, "gap-root-gate-1").parent, null); // root gate 无 parent → gap 顶层
});

// ---------------------------------------------------------------------------
// 场景 5：失败不传播
// ---------------------------------------------------------------------------

test("失败不传播：A failed → 依赖 A 的 B stalled；requeue 恢复后 B 回 ready", () => {
  let plan = okOf(
    seedPlan(null, "goal", [def("a"), def("b", undefined, { dependsOn: ["a"] })], "light", {
      nowMs: NOW,
    }),
  );
  plan = markFailed(plan, "a");
  assert.deepEqual(stalledNodeIds(plan), ["b"]); // 失败停住，不传播为 B 的 failed
  assert.equal(planTerminalState(plan), "stalled");

  plan = okOf(requeueNode(plan, "a"));
  const a = nodeOf(plan, "a");
  assert.equal(a.status, "queued");
  assert.equal(a.owner, null);
  assert.deepEqual(stalledNodeIds(plan), []);
  assert.equal(planTerminalState(plan), "active");

  plan = runWorker(plan, "a", artifact());
  assert.deepEqual(readyNodeIds(plan), ["b"]); // A done 后 B 回 ready
  plan = runWorker(plan, "b", artifact());
  assert.equal(planTerminalState(plan), "completed");
});

test("requeueNode：artifactRequeues 不清零；done 拒绝；传递闭包 stalled", () => {
  let plan = okOf(
    seedPlan(
      null,
      "goal",
      [
        def("a"),
        def("b", undefined, { dependsOn: ["a"] }),
        def("c", undefined, { dependsOn: ["b"] }), // 二跳：依赖含 failed 的传递闭包
      ],
      "light",
      { nowMs: NOW },
    ),
  );
  plan = markFailed(plan, "a");
  assert.deepEqual(stalledNodeIds(plan), ["b", "c"]);

  const claimed = claim(plan, "b", "w1");
  nodeOf(claimed, "b").artifactRequeues = 2; // 模拟 R4 no-artifact 路径的累计
  const requeued = okOf(requeueNode(claimed, "b"));
  assert.equal(nodeOf(requeued, "b").artifactRequeues, 2); // 节点级总预算不重置

  const done = runWorker(plan, "b", null);
  assert.equal(errOf(requeueNode(done, "b")).kind, "invalid-state");
  assert.equal(errOf(requeueNode(plan, "ghost")).kind, "unknown-node");
});

// ---------------------------------------------------------------------------
// 调度确定性
// ---------------------------------------------------------------------------

test("调度确定性：priority 升序 + id 字典序", () => {
  const plan = okOf(
    seedPlan(
      null,
      "goal",
      [
        def("n2", undefined, { priority: 2 }),
        def("n1", undefined, { priority: 1 }),
        def("n3", undefined, { priority: 1 }),
        def("n0", undefined, { priority: 0 }),
      ],
      "light",
      { nowMs: NOW },
    ),
  );
  assert.deepEqual(readyNodeIds(plan), ["n0", "n1", "n3", "n2"]);
  assert.deepEqual(
    readyNodes(plan).map((node) => node.id),
    ["n0", "n1", "n3", "n2"],
  );
  // running 不入 ready
  const claimed = claim(plan, "n0");
  assert.ok(!readyNodeIds(claimed).includes("n0"));
});

test("ready 推导：全部依赖 done 才 ready（按 dependsOn 顺序装配）", () => {
  let plan = okOf(
    seedPlan(
      null,
      "goal",
      [def("a"), def("b"), def("c", undefined, { dependsOn: ["a", "b"] })],
      "light",
      { nowMs: NOW },
    ),
  );
  assert.deepEqual(readyNodeIds(plan), ["a", "b"]);
  plan = runWorker(plan, "a", artifact({ findings: "a-first" }));
  assert.deepEqual(readyNodeIds(plan), ["b"]); // c 还在等 b
  plan = runWorker(plan, "b", artifact({ findings: "b-second" }));
  assert.deepEqual(readyNodeIds(plan), ["c"]);
  const input = assembleNodeInput(plan, "c");
  assert.ok(input.indexOf("a-first") < input.indexOf("b-second")); // dependsOn 声明顺序
});

// ---------------------------------------------------------------------------
// dataflow（R3）
// ---------------------------------------------------------------------------

test("dataflow：单 artifact 截 2000；总预算 16000；剩余段丢弃", () => {
  let plan = okOf(
    seedPlan(null, "goal", [def("a"), def("b", undefined, { dependsOn: ["a"] })], "light", {
      nowMs: NOW,
    }),
  );
  plan = runWorker(plan, "a", artifact({ findings: "x".repeat(5000) }));
  const input = assembleNodeInput(plan, "b");
  assert.ok(input.includes('upstream node "a"'));
  assert.ok(
    input.includes(`[upstream artifact truncated at ${SWARM_ARTIFACT_RENDER_MAX_CHARS} chars]`),
  );
  assert.ok(!input.includes("x".repeat(SWARM_ARTIFACT_RENDER_MAX_CHARS + 100)));

  // 12 个上游各 ~1900 字符：总预算下只保留约 8 段，后续整段丢弃
  const upstreamDefs = Array.from({ length: 12 }, (_, index) =>
    def(`up${String(index).padStart(2, "0")}`),
  );
  const sink = def("sink", "collect all", {
    dependsOn: upstreamDefs.map((upstream) => upstream.id),
  });
  let multi = okOf(seedPlan(null, "goal", [...upstreamDefs, sink], "light", { nowMs: NOW }));
  for (let index = 0; index < 12; index += 1) {
    multi = runWorker(
      multi,
      `up${String(index).padStart(2, "0")}`,
      artifact({ findings: "y".repeat(1900) }),
    );
  }
  const multiInput = assembleNodeInput(multi, "sink");
  const sectionCount = (multiInput.match(/--- upstream node/g) ?? []).length;
  assert.ok(sectionCount < 12, `expected capped sections, got ${sectionCount}`);
  assert.ok(multiInput.includes("up00"));
  assert.ok(!multiInput.includes('"up11"')); // 预算耗尽后的上游整段不出现
  assert.ok(multiInput.includes("total budget"));
});

test("dataflow：不可信声明在场；无 Done 上游不附段", () => {
  let plan = okOf(
    seedPlan(null, "goal", [def("a"), def("b", undefined, { dependsOn: ["a"] })], "light", {
      nowMs: NOW,
    }),
  );
  assert.equal(assembleNodeInput(plan, "b"), "work of b"); // 无 Done 上游：只有 content
  plan = runWorker(plan, "a", artifact({ findings: "a-result" }));
  const withArtifact = assembleNodeInput(plan, "b");
  assert.ok(withArtifact.includes("a-result"));
  assert.ok(withArtifact.includes('upstream node "a"'));
  assert.ok(withArtifact.includes("not instructions")); // 不可信声明（防注入口径）
});

test("dataflow：deep worker 附 typed artifact 契约段；light 与 gate 不附", () => {
  let deepPlan = okOf(
    seedPlan(null, "goal", [def("a"), def("b", undefined, { dependsOn: ["a"] })], "deep", {
      nowMs: NOW,
    }),
  );
  deepPlan = runWorker(deepPlan, "a", artifact());
  assert.ok(assembleNodeInput(deepPlan, "b").includes("Typed artifact contract (deep gate)"));
  assert.ok(!assembleNodeInput(deepPlan, "root-gate").includes("Typed artifact contract"));
  const lightPlan = okOf(seedPlan(null, "goal", [def("a"), def("b")], "light", { nowMs: NOW }));
  assert.ok(!assembleNodeInput(lightPlan, "a").includes("Typed artifact contract"));
});

// ===========================================================================
// 第二段（2a）：plan store + runner（注入 executeNode）+ 工具面 handlers + reminder
//（specs/swarm-task-graph.md 验收场景 6-8、10-11；模拟器先行——fake executeNode 钉死
// 调度/失败/no-artifact/gate 序列，真实子会话接线是 2b）
// ===========================================================================

const { createSwarmPlanStore } = await import("../packages/core/src/swarm/plan-store.ts");
const { createSwarmRunner } = await import("../packages/core/src/swarm/runner.ts");
const { buildSwarmPlanReminderBody, SWARM_GATE_CONTRACT_LANGUAGE, SWARM_PLAN_VS_TODO_LANGUAGE } =
  await import("../packages/core/src/swarm/prompts.ts");
const { buildSwarmPlanStatus } = await import("../packages/core/src/swarm/projection.ts");
const { createPlanSeedToolEntry } = await import("../packages/core/src/tool/handlers/plan-seed.ts");
const { createPlanExpandToolEntry } =
  await import("../packages/core/src/tool/handlers/plan-expand.ts");
const { createPlanCompleteGateToolEntry } =
  await import("../packages/core/src/tool/handlers/plan-complete-gate.ts");
const { createPlanStatusToolEntry } =
  await import("../packages/core/src/tool/handlers/plan-status.ts");
const { createPlanControlToolEntry } =
  await import("../packages/core/src/tool/handlers/plan-control.ts");
const { fileURLToPath } = await import("node:url");

// ---------------------------------------------------------------------------
// 第二段 helpers
// ---------------------------------------------------------------------------

/** 让 microtask/store 队列/级联派发走完（无定时器，几个 macrotask 足够）。 */
async function tick(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** response 尾部的 ```acode-artifact 围栏块（J2-3 传输形态）。 */
function typedBlock(typed) {
  return `work finished\n\`\`\`acode-artifact\n${JSON.stringify(typed)}\n\`\`\``;
}

/** 可控 fake executeNode：测试逐个 resolve 每次执行（FIFO），钉住批派发/级联时序。 */
function controlledExecute() {
  const calls = [];
  const resolvers = [];
  const executeNode = async (request) => {
    calls.push({ ...request });
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  };
  return {
    calls,
    executeNode,
    pending: () => resolvers.length,
    resolveNext: (value) => {
      const resolve = resolvers.shift();
      if (resolve === undefined) throw new Error("no pending execution to resolve");
      resolve(value);
    },
  };
}

function fakeToolContext(overrides = {}) {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "session-main",
    toolCallId: "call-1",
    traceId: "trace-1",
    workingDirectory: "/tmp/wd",
    workspaceRoot: "/tmp/wd",
    ...overrides,
  };
}

async function assertThrowsMessage(fn, substring) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      message.includes(substring),
      `expected error message to include "${substring}", got: ${message}`,
    );
    return error;
  }
  assert.fail(`expected an error containing "${substring}"`);
}

async function seedStore(defs, mode, options = {}) {
  const store = createSwarmPlanStore();
  const outcome = await store.mutate((current) =>
    seedPlan(current, options.goal ?? "goal", defs, mode, { nowMs: NOW }),
  );
  assert.ok(outcome.ok);
  return store;
}

// ---------------------------------------------------------------------------
// 场景 6：turn 后调度点批派发（R4）
// ---------------------------------------------------------------------------

test("场景6：批派发按 priority+id 确定性序、并发上限 4、第 5 个等位、完成释放槽位级联", async () => {
  const store = await seedStore(
    [
      def("a", undefined, { priority: 0 }),
      def("b", undefined, { priority: 1 }),
      def("c", undefined, { priority: 1 }),
      def("d", undefined, { priority: 2 }),
      def("e", undefined, { priority: 2 }),
      def("f", undefined, { priority: 3 }),
    ],
    "light",
  );
  const exec = controlledExecute();
  const dispatches = [];
  const runner = createSwarmRunner({
    executeNode: exec.executeNode,
    onDispatch: (event) => dispatches.push(event),
    store,
  });
  await runner.dispatchReadyNodes();
  assert.equal(runner.activeWorkerCount(), SWARM_MAX_CONCURRENT_WORKERS); // 4
  assert.deepEqual(
    dispatches.map((event) => event.node.id),
    ["a", "b", "c", "d"],
  ); // priority 升序 + id 字典序
  assert.equal(exec.pending(), 4); // e/f 等位

  exec.resolveNext({ response: typedBlock(artifact()) }); // a 完成 → 释放一个槽
  await tick();
  assert.deepEqual(
    dispatches.map((event) => event.node.id),
    ["a", "b", "c", "d", "e"],
  ); // 级联：不等下一个调度点
  assert.equal(runner.activeWorkerCount(), 4); // b/c/d 在飞 + e

  exec.resolveNext({ response: typedBlock(artifact()) }); // b
  exec.resolveNext({ response: typedBlock(artifact()) }); // c
  exec.resolveNext({ response: typedBlock(artifact()) }); // d
  exec.resolveNext({ response: typedBlock(artifact()) }); // e
  await tick();
  assert.deepEqual(
    dispatches.map((event) => event.node.id),
    ["a", "b", "c", "d", "e", "f"],
  ); // f 最后一个槽
  exec.resolveNext({ response: typedBlock(artifact()) }); // f
  await runner.settle();
  assert.equal(runner.activeWorkerCount(), 0);
  assert.equal(planTerminalState(store.getPlan()), "completed");
});

test("场景6：dataflow 装配进派发 prompt——Done 上游渲染段 + 不可信声明 + deep 契约段", async () => {
  const store = await seedStore([def("a"), def("b", undefined, { dependsOn: ["a"] })], "deep");
  const exec = controlledExecute();
  const runner = createSwarmRunner({ executeNode: exec.executeNode, store });
  await runner.dispatchReadyNodes();
  assert.deepEqual(
    exec.calls.map((call) => call.node.id),
    ["a"],
  ); // gate 不派发；b 等 a
  assert.ok(exec.calls[0].prompt.includes("Typed artifact contract (deep gate)")); // deep worker 契约段
  assert.ok(exec.calls[0].prompt.includes("work of a"));

  exec.resolveNext({
    response: typedBlock(artifact({ findings: "a-result", confidence: "low" })),
  });
  await tick();
  assert.deepEqual(
    exec.calls.map((call) => call.node.id),
    ["a", "b"],
  );
  const bPrompt = exec.calls[1].prompt;
  assert.ok(bPrompt.includes('upstream node "a"'));
  assert.ok(bPrompt.includes("a-result"));
  assert.ok(bPrompt.includes("not instructions")); // 不可信声明（防注入口径）
  assert.ok(bPrompt.includes("confidence: low"));

  exec.resolveNext({ response: typedBlock(artifact({ findings: "b-result" })) });
  await tick();
  // root gate 全依赖 done → ready 但不派发（gate 的执行者是主对话，经 PlanCompleteGate）
  assert.equal(runner.activeWorkerCount(), 0);
  assert.deepEqual(readyNodeIds(store.getPlan()), ["root-gate"]);
  assert.ok(!exec.calls.some((call) => call.node.isGate));
  await runner.settle(); // 已静止：settle 立即返回
  assert.deepEqual(readyNodeIds(store.getPlan()), ["root-gate"]);
});

// ---------------------------------------------------------------------------
// 场景 7：deep 废除 auto-complete / light 回合即 done（R4）
// ---------------------------------------------------------------------------

test("场景7：deep 无 artifact 回合 → requeue 换执行一次 → 再犯 failed；计数单调", async () => {
  const store = await seedStore([def("a")], "deep");
  const exec = controlledExecute();
  const settlements = [];
  const runner = createSwarmRunner({
    executeNode: exec.executeNode,
    onNodeSettled: (event) => settlements.push(event),
    store,
  });
  await runner.dispatchReadyNodes();
  assert.equal(exec.calls.length, 1);
  const firstOwner = exec.calls[0].owner;
  assert.ok(firstOwner.length > 0);

  // 第一次无 artifact：requeue（plan 级 +1、节点级 +1），级联换新执行实例重派
  exec.resolveNext({ response: "i finished the work, trust me" });
  await tick();
  assert.equal(exec.calls.length, 2);
  assert.notEqual(exec.calls[1].owner, firstOwner); // 换执行实例（requeue 换执行）
  let plan = store.getPlan();
  const requeuedNode = nodeOf(plan, "a");
  assert.equal(requeuedNode.status, "running"); // 已被新执行实例认领（owner 只由 runner 分配）
  assert.equal(requeuedNode.owner, exec.calls[1].owner);
  assert.equal(requeuedNode.artifactRequeues, 1); // 节点级预算（J2-3 同款，不重置）
  assert.equal(plan.noArtifactRequeues, 1); // plan 级单调计数

  // 第二次仍无 artifact：封顶 fail（deep 唯一的 done 路径必须经过 typed artifact）
  exec.resolveNext({ response: "still no artifact" });
  await tick();
  plan = store.getPlan();
  const failedNode = nodeOf(plan, "a");
  assert.equal(failedNode.status, "failed");
  assert.equal(failedNode.artifactRequeues, 2);
  assert.equal(plan.noArtifactRequeues, 2); // 单调递增不重置（R6 不变量）
  assert.deepEqual(
    settlements.map((event) => event.kind),
    ["requeued-no-artifact", "failed-no-artifact"],
  );
  // deep 之外的 gate 不受影响（root gate 仍 queued——审计范围里有 failed 节点，永远待办）
  assert.equal(nodeOf(plan, "root-gate").status, "queued");
});

test("场景7：deep 合法 artifact → done；light 回合结束即 done（无 artifact 也 done）", async () => {
  const deepStore = await seedStore([def("a")], "deep");
  const deepExec = controlledExecute();
  const deepRunner = createSwarmRunner({
    executeNode: deepExec.executeNode,
    store: deepStore,
  });
  await deepRunner.dispatchReadyNodes();
  deepExec.resolveNext({ response: typedBlock(artifact()) });
  await tick();
  assert.equal(nodeOf(deepStore.getPlan(), "a").status, "done");
  assert.equal(deepStore.getPlan().noArtifactRequeues, 0);

  const lightStore = await seedStore([def("x"), def("y")], "light");
  const lightExec = controlledExecute();
  const lightRunner = createSwarmRunner({
    executeNode: lightExec.executeNode,
    store: lightStore,
  });
  await lightRunner.dispatchReadyNodes();
  lightExec.resolveNext({ response: "plain text, no artifact block" });
  lightExec.resolveNext({ response: "plain text either" });
  await tick();
  const plan = lightStore.getPlan();
  assert.equal(nodeOf(plan, "x").status, "done");
  assert.equal(nodeOf(plan, "y").status, "done");
  assert.equal(nodeOf(plan, "x").output, null); // 宽纵：无产物也 done
  await lightRunner.settle();
  assert.equal(planTerminalState(plan), "completed");
});

test("场景7：executeNode 崩溃 → 节点 failed（失败不传播，无 requeue 计数）", async () => {
  const store = await seedStore([def("a"), def("b", undefined, { dependsOn: ["a"] })], "light");
  const settlements = [];
  const runner = createSwarmRunner({
    executeNode: async () => {
      throw new Error("child session crashed");
    },
    onNodeSettled: (event) => settlements.push(event),
    store,
  });
  await runner.dispatchReadyNodes();
  await runner.settle();
  const plan = store.getPlan();
  assert.equal(nodeOf(plan, "a").status, "failed");
  assert.deepEqual(stalledNodeIds(plan), ["b"]); // 失败不传播：b stalled 而不是 failed
  assert.equal(plan.noArtifactRequeues, 0); // 崩溃不是 no-artifact 路径
  assert.deepEqual(
    settlements.map((event) => event.kind),
    ["failed-error"],
  );
});

test("场景7：迟到 no-artifact 结算不覆写新 owner 的 claim（M1）", async () => {
  const { cancelSwarmNode } = await import("../packages/core/src/swarm/control.ts");
  const base = await seedStore([def("a")], "deep");
  const exec = controlledExecute();
  const settlements = [];
  // 注入式互叠 store：settle 面外层 owner 检查与结算闭包执行之间存在排队窗口（外层检查
  // 读的是提交快照，闭包读的是 mutate 时的最新图）——生产里 cancel+retry+换 owner 恰好
  // 落进这个窗口时，闭包必须靠自己的 owner 门槛丢弃迟到结算。测试在第二次 mutate（A 的
  // no-artifact 结算；第一次是 A 的 claim）转发前先把 cancel→retry→B 认领提交进图，
  // 确定性复现「外层检查通过、闭包执行时图已换 owner」的交错。
  let runnerMutateCount = 0;
  const store = {
    clear: () => base.clear(),
    getPlan: () => base.getPlan(),
    hydrate: () => base.hydrate(),
    mutate: (mutation) => {
      runnerMutateCount += 1;
      if (runnerMutateCount !== 2) return base.mutate(mutation);
      return (async () => {
        const cancelled = await base.mutate((current) => cancelSwarmNode(current, "a", NOW + 1));
        assert.ok(cancelled.ok);
        const requeued = await base.mutate((current) => requeueNode(current, "a"));
        assert.ok(requeued.ok);
        const reclaimed = await base.mutate((current) => {
          const staged = structuredClone(current);
          const node = staged.nodes.find((candidate) => candidate.id === "a");
          node.status = "running";
          node.owner = "owner-B";
          return { ok: true, plan: staged };
        });
        assert.ok(reclaimed.ok);
        return base.mutate(mutation);
      })();
    },
  };
  const runner = createSwarmRunner({
    executeNode: exec.executeNode,
    onNodeSettled: (event) => settlements.push(event),
    store,
  });
  // A 认领（owner 是 runner 铸造的第一个执行实例）
  await runner.dispatchReadyNodes();
  assert.equal(exec.calls.length, 1);
  const ownerA = exec.calls[0].owner;
  assert.notEqual(ownerA, "owner-B");

  // A 的回合以 no-artifact 收尾：结算闭包执行时图已被 cancel+retry+认领 B 改写。
  exec.resolveNext({ response: "plain text, no artifact block" });
  await tick();

  // A 的迟到结算被闭包内的 owner 校验丢弃（dropped-stale），B 的 claim 完好，双计数器
  // 都没有被死执行实例污染。
  const plan = store.getPlan();
  const node = nodeOf(plan, "a");
  assert.equal(node.status, "running", "B's claim must survive A's late settlement");
  assert.equal(node.owner, "owner-B");
  assert.equal(node.artifactRequeues, 0);
  assert.equal(plan.noArtifactRequeues, 0);
  assert.deepEqual(
    settlements.map((event) => event.kind),
    ["dropped-stale"],
  );
});

// ---------------------------------------------------------------------------
// 场景 8：整图终态 + reminder 渲染 + deep 对抗循环（经工具面端到端）
// ---------------------------------------------------------------------------

test("场景8：deep 全链路——并行执行→gate 拒→gap 注入→gap 执行→复审过→completed + reminder 演进", async () => {
  const store = await seedStore(
    [
      def("a", "explore the area"),
      def("b", "implement the thing"),
      def("c", undefined, { dependsOn: ["a"] }),
    ],
    "deep",
    { goal: "ship the feature" },
  );
  const exec = controlledExecute();
  const runner = createSwarmRunner({ executeNode: exec.executeNode, store });

  // reminder 零注入基线：无 plan → null
  assert.equal(buildSwarmPlanReminderBody(null), null);

  await runner.dispatchReadyNodes();
  assert.deepEqual(
    exec.calls.map((call) => call.node.id),
    ["a", "b"],
  ); // c 等 a；root gate 不派发
  exec.resolveNext({ response: typedBlock(artifact({ findings: "explored", confidence: "low" })) });
  exec.resolveNext({ response: typedBlock(artifact({ findings: "implemented" })) });
  await tick();
  // a/b 完成 → c（依赖 a）级联认领
  assert.deepEqual(
    exec.calls.map((call) => call.node.id),
    ["a", "b", "c"],
  );
  exec.resolveNext({ response: typedBlock(artifact({ findings: "c done" })) });
  await tick();

  const plan0 = store.getPlan();
  assert.equal(runner.activeWorkerCount(), 0); // gate 不派发
  assert.deepEqual(readyNodeIds(plan0), ["root-gate"]);

  // reminder：图摘要 + gate 待办（deep 模式不可绕过的收尾义务）
  const pendingGateReminder = buildSwarmPlanReminderBody(plan0);
  assert.ok(pendingGateReminder.includes("3/4 done"));
  assert.ok(pendingGateReminder.includes("1 gate(s) awaiting"));
  assert.ok(pendingGateReminder.includes("root-gate"));
  assert.ok(pendingGateReminder.includes("PlanCompleteGate"));

  // 工具面：橡皮图章 pass → 结构化拒绝（含 issue 列表；不抛裸枚举）
  const completeGate = createPlanCompleteGateToolEntry({ store }).handler;
  const rubberStamp = await completeGate(
    {
      gateId: "root-gate",
      verdict: { pass: true, reasoning: "all fine", acceptanceGaps: [], gapProposals: [] },
    },
    fakeToolContext(),
  );
  assert.equal(rubberStamp.outcome, "rejected");
  assert.ok(rubberStamp.issues.some((issue) => issue.kind === "uncovered_siblings"));
  assert.equal(nodeOf(store.getPlan(), "root-gate").status, "queued");

  // 工具面：fail 裁决 + gap 提案 → gap 注入（gate 重置 queued 依赖 gap）
  const failVerdict = await completeGate(
    {
      gateId: "root-gate",
      verdict: {
        pass: false,
        reasoning: "a reported low confidence without hardening",
        acceptanceGaps: [],
        gapProposals: [{ id: "gap-harden-a", content: "harden a manually", kind: "fix" }],
      },
    },
    fakeToolContext(),
  );
  assert.equal(failVerdict.outcome, "failed-verdict-gaps-injected");
  assert.deepEqual(failVerdict.injectedGapIds, ["gap-harden-a"]);

  // gap 节点作为普通 worker 被调度点派发
  await runner.dispatchReadyNodes();
  assert.deepEqual(exec.calls.map((call) => call.node.id).slice(-1), ["gap-harden-a"]);
  exec.resolveNext({ response: typedBlock(artifact({ findings: "hardened" })) });
  await tick();
  assert.deepEqual(readyNodeIds(store.getPlan()), ["root-gate"]); // gap done → gate 复审 ready

  // 复审点名全部 done 非 gate 节点（含 gap）→ pass → plan completed
  const passed = await completeGate(
    {
      gateId: "root-gate",
      verdict: {
        pass: true,
        reasoning:
          "a: low accepted after manual check. b: verified. c: verified. gap-harden-a: verified.",
        acceptanceGaps: [],
        gapProposals: [],
      },
    },
    fakeToolContext(),
  );
  assert.equal(passed.outcome, "passed");
  const finalPlan = store.getPlan();
  assert.equal(planTerminalState(finalPlan), "completed");
  const completedReminder = buildSwarmPlanReminderBody(finalPlan);
  assert.ok(completedReminder.includes("Plan completed"));
  assert.ok(!completedReminder.includes("gate(s) awaiting"));
});

test("场景8：stalled 终态 + reminder 告警 + PlanControl.retry 恢复（经工具面）", async () => {
  const crashStore = await seedStore(
    [def("a"), def("b", undefined, { dependsOn: ["a"] })],
    "light",
    { goal: "recover me" },
  );
  const crashRunner = createSwarmRunner({
    executeNode: async () => {
      throw new Error("worker exploded");
    },
    store: crashStore,
  });
  await crashRunner.dispatchReadyNodes();
  await crashRunner.settle();
  let plan = crashStore.getPlan();
  assert.equal(planTerminalState(plan), "stalled");
  const stalledReminder = buildSwarmPlanReminderBody(plan);
  assert.ok(stalledReminder.includes("Stalled"));
  assert.ok(stalledReminder.includes(": b."));
  assert.ok(stalledReminder.includes("PlanControl retry"));

  // PlanStatus 投影（只读工具面）：stalled/failed 计数与节点状态
  const status = await createPlanStatusToolEntry({ store: crashStore }).handler(
    {},
    fakeToolContext(),
  );
  assert.equal(status.plan.terminalState, "stalled");
  assert.equal(status.plan.counts.failed, 1);
  assert.deepEqual(status.plan.stalledNodeIds, ["b"]);

  // PlanControl.retry：a 回 queued → 调度点换执行 → done → b 回 ready
  const control = createPlanControlToolEntry({ store: crashStore }).handler;
  const retry = await control({ action: "retry", nodeId: "a" }, fakeToolContext());
  assert.equal(retry.action, "retry");
  assert.equal(nodeOf(crashStore.getPlan(), "a").status, "queued");
  assert.equal(nodeOf(crashStore.getPlan(), "a").artifactRequeues, 0); // retry 不动 requeue 预算

  const recoverExec = controlledExecute();
  const recoverRunner = createSwarmRunner({
    executeNode: recoverExec.executeNode,
    store: crashStore,
  });
  await recoverRunner.dispatchReadyNodes();
  recoverExec.resolveNext({ response: typedBlock(artifact({ findings: "a recovered" })) });
  await tick();
  // a done 后 b 回 ready（失败不传播的恢复面）并被级联认领为 running
  plan = crashStore.getPlan();
  assert.equal(nodeOf(plan, "b").status, "running");
  assert.equal(nodeOf(plan, "a").artifactRequeues, 0);
  recoverExec.resolveNext({ response: typedBlock(artifact({ findings: "b done" })) });
  await tick();
  assert.equal(planTerminalState(crashStore.getPlan()), "completed");
});

// ---------------------------------------------------------------------------
// 场景 10：工具面行为 + 注册形态 + 源码断言（R5）
// ---------------------------------------------------------------------------

test("场景10：PlanSeed——建图回执、deep root gate、幂等重放 noOp、可读错误投影", async () => {
  const store = createSwarmPlanStore();
  const seed = createPlanSeedToolEntry({ store }).handler;
  const seeded = await seed(
    {
      goal: "build the thing",
      mode: "deep",
      nodes: [
        { id: "a", content: "first" },
        { id: "b", content: "second", dependsOn: ["a"], kind: "verify", priority: 8 },
      ],
    },
    fakeToolContext(),
  );
  assert.equal(seeded.version, 1);
  assert.equal(seeded.mode, "deep");
  assert.equal(seeded.rootGateId, "root-gate");
  assert.equal(seeded.nodeCount, 3); // a + b + root gate
  // 缺省 kind/priority 由 contracts schema 补齐（parse 后落图）
  const plan = store.getPlan();
  assert.equal(nodeOf(plan, "a").kind, "implement");
  assert.equal(nodeOf(plan, "a").priority, 4);
  assert.equal(nodeOf(plan, "b").kind, "verify");

  const replay = await seed(
    {
      goal: "build the thing",
      mode: "deep",
      nodes: [
        { id: "a", content: "first" },
        { id: "b", content: "second", dependsOn: ["a"], kind: "verify", priority: 8 },
      ],
    },
    fakeToolContext(),
  );
  assert.equal(replay.noOp, true); // 工具重试不双写

  await assertThrowsMessage(
    () => seed({ goal: "", nodes: [{ id: "a", content: "x" }] }, fakeToolContext()),
    '"goal" must be a non-empty string',
  );
  await assertThrowsMessage(
    () => seed({ goal: "g", nodes: [{ id: "   ", content: "x" }] }, fakeToolContext()),
    "node id must contain non-whitespace characters",
  );
  await assertThrowsMessage(
    () => seed({ goal: "g", mode: "bogus", nodes: [{ id: "a", content: "x" }] }, fakeToolContext()),
    '"mode" must be "light" or "deep"',
  );
});

test("场景10：PlanExpand——分解回执与用户可读错误（不裸抛枚举名）", async () => {
  const store = await seedStore([def("a"), def("b")], "light");
  const expand = createPlanExpandToolEntry({ store }).handler;
  const expanded = await expand(
    {
      nodeId: "a",
      children: [
        { id: "a1", content: "sub one" },
        { id: "a2", content: "sub two" },
      ],
    },
    fakeToolContext(),
  );
  assert.deepEqual(expanded.childIds, ["a1", "a2"]);
  assert.equal(expanded.version, 2);

  const error = await assertThrowsMessage(
    () => expand({ nodeId: "ghost", children: [{ id: "g1", content: "x" }] }, fakeToolContext()),
    'unknown node "ghost"',
  );
  assert.ok(!/unknown-node/.test(error.message)); // 错误是用户可读投影，不裸抛枚举 kind
  await assertThrowsMessage(
    () => expand({ nodeId: "a", children: [] }, fakeToolContext()),
    '"children" must be a non-empty array',
  );
});

test("场景10：PlanStatus——无 plan 空读、上游 artifact 摘要、ready/stalled 推导", async () => {
  const emptyStore = createSwarmPlanStore();
  const status = createPlanStatusToolEntry({ store: emptyStore }).handler;
  assert.deepEqual(await status({}, fakeToolContext()), { plan: null });

  let plan = okOf(
    seedPlan(null, "goal", [def("a"), def("b", undefined, { dependsOn: ["a"] })], "deep", {
      nowMs: NOW,
    }),
  );
  plan = runWorker(plan, "a", artifact({ findings: "a did this and that", confidence: "low" }));
  const store = createSwarmPlanStore();
  await store.mutate(() => ({ ok: true, plan }));
  const view = await createPlanStatusToolEntry({ store }).handler({}, fakeToolContext());
  assert.equal(view.plan.mode, "deep");
  assert.equal(view.plan.terminalState, "active");
  assert.deepEqual(view.plan.readyWorkerIds, ["b"]);
  assert.deepEqual(view.plan.readyGateIds, []); // gate 等 b，不在待办
  const bView = view.plan.nodes.find((node) => node.id === "b");
  assert.deepEqual(bView.upstreamArtifacts, [
    { confidence: "low", id: "a", summary: "a did this and that" },
  ]);
  assert.equal(view.plan.counts.done, 1);
  assert.equal(view.plan.counts.gates, 1);
});

test("场景10：PlanControl——retry/cancel-node/cancel-plan 行为与门槛", async () => {
  const store = await seedStore(
    [def("a"), def("b", undefined, { dependsOn: ["a"] }), def("c")],
    "light",
  );
  const control = createPlanControlToolEntry({ store }).handler;

  await assertThrowsMessage(
    () => control({ action: "bogus" }, fakeToolContext()),
    '"action" must be one of',
  );
  await assertThrowsMessage(
    () => control({ action: "retry" }, fakeToolContext()),
    '"nodeId" is required for action "retry"',
  );
  await assertThrowsMessage(
    () => control({ action: "retry", nodeId: "ghost" }, fakeToolContext()),
    'unknown node "ghost"',
  );

  // 手工落一个 done 节点验证 cancel-node 的 done 拒绝（取消不是重开通道）
  await store.mutate((current) => {
    const staged = structuredClone(current);
    const node = staged.nodes.find((candidate) => candidate.id === "c");
    node.status = "running";
    node.owner = "w";
    return { ok: true, plan: staged };
  });
  await store.mutate((current) => completeWorkerNode(current, "c", null, { actor: "w" }));
  await assertThrowsMessage(
    () => control({ action: "cancel-node", nodeId: "c" }, fakeToolContext()),
    "cancellabl",
  );

  const cancelled = await control({ action: "cancel-node", nodeId: "a" }, fakeToolContext());
  assert.equal(cancelled.action, "cancel-node");
  assert.equal(nodeOf(store.getPlan(), "a").status, "failed");
  assert.deepEqual(stalledNodeIds(store.getPlan()), ["b"]); // b 因 a 失败而 stalled

  const cancelPlan = await control({ action: "cancel-plan" }, fakeToolContext());
  assert.equal(cancelPlan.action, "cancel-plan");
  const plan = store.getPlan();
  assert.equal(nodeOf(plan, "a").status, "failed");
  assert.equal(nodeOf(plan, "b").status, "failed");
  assert.equal(nodeOf(plan, "c").status, "done"); // done 事实保留
  // 全部终态且无 running/queued 可推进 → stalled 终态
  assert.equal(planTerminalState(plan), "stalled");
});

test("场景10：PlanCompleteGate——verdict 校验、未知 gate、被拒 pass 无提案时不注入", async () => {
  const store = await seedStore([def("a")], "deep");
  await store.mutate((current) => {
    const staged = structuredClone(current);
    const node = staged.nodes.find((candidate) => candidate.id === "a");
    node.status = "running";
    node.owner = "w";
    return { ok: true, plan: staged };
  });
  await store.mutate((current) => completeWorkerNode(current, "a", artifact(), { actor: "w" }));
  const completeGate = createPlanCompleteGateToolEntry({ store }).handler;

  await assertThrowsMessage(
    () => completeGate({ gateId: "nope", verdict: { pass: true } }, fakeToolContext()),
    'unknown gate "nope"',
  );
  await assertThrowsMessage(
    () => completeGate({ gateId: "root-gate", verdict: { pass: "yes" } }, fakeToolContext()),
    '"verdict" is invalid',
  );
  const rejected = await completeGate(
    { gateId: "root-gate", verdict: { pass: true, reasoning: "looks good" } },
    fakeToolContext(),
  );
  assert.equal(rejected.outcome, "rejected"); // 无 gapProposals：不注入，模型复审或改提 fail
  assert.ok(rejected.issues.length > 0);
  assert.equal(store.getPlan().nodes.filter((node) => node.origin === "gap").length, 0);
});

test("场景10：PlanCompleteGate——超限 verdict 在入参层拿可读错误（M2，对齐 J2-3 上限）", async () => {
  const store = await seedStore([def("a")], "deep");
  await store.mutate((current) => {
    const staged = structuredClone(current);
    const node = staged.nodes.find((candidate) => candidate.id === "a");
    node.status = "running";
    node.owner = "w";
    return { ok: true, plan: staged };
  });
  await store.mutate((current) => completeWorkerNode(current, "a", artifact(), { actor: "w" }));
  const completeGate = createPlanCompleteGateToolEntry({ store }).handler;

  // reasoning 超 100_000：入参层可读错误——不再是落图后 plan-store safeParse 边界的
  // 「不变量破裂」内部错误。
  await assertThrowsMessage(
    () =>
      completeGate(
        { gateId: "root-gate", verdict: { pass: true, reasoning: "x".repeat(100_001) } },
        fakeToolContext(),
      ),
    '"verdict" is invalid — reasoning',
  );
  // acceptanceGaps 超 200 项
  await assertThrowsMessage(
    () =>
      completeGate(
        {
          gateId: "root-gate",
          verdict: {
            pass: true,
            reasoning: "a: verified.",
            acceptanceGaps: Array.from({ length: 201 }, () => "gap"),
          },
        },
        fakeToolContext(),
      ),
    '"verdict" is invalid — acceptanceGaps',
  );
  // 单条 gap 超 10_000 字符
  await assertThrowsMessage(
    () =>
      completeGate(
        {
          gateId: "root-gate",
          verdict: {
            pass: true,
            reasoning: "a: verified.",
            acceptanceGaps: ["g".repeat(10_001)],
          },
        },
        fakeToolContext(),
      ),
    '"verdict" is invalid — acceptanceGaps',
  );
  // 上限内的 verdict 照常进裁决（上限只拒超限，不误伤边界值）
  const atLimit = await completeGate(
    {
      gateId: "root-gate",
      verdict: { pass: true, reasoning: "x".repeat(100_000), acceptanceGaps: [] },
    },
    fakeToolContext(),
  );
  assert.equal(atLimit.outcome, "rejected"); // 裁决仍由 evaluateCriticGate 做出（未点名 a）

  // 工具 JSON schema 与 zod 上限同步（同一组 contracts 导出常量）
  const entry = createPlanCompleteGateToolEntry({ store });
  const verdictSchema = entry.inputSchema.properties.verdict;
  assert.equal(verdictSchema.properties.reasoning.maxLength, 100_000);
  assert.equal(verdictSchema.properties.acceptanceGaps.maxItems, 200);
  assert.equal(verdictSchema.properties.acceptanceGaps.items.maxLength, 10_000);
});

test("场景10：工具面注册形态——PlanStatus 只读、其余状态写面低风险档；模型面无 owner 写路径（源码断言）", async () => {
  const store = createSwarmPlanStore();
  const entries = {
    seed: createPlanSeedToolEntry({ store }),
    expand: createPlanExpandToolEntry({ store }),
    completeGate: createPlanCompleteGateToolEntry({ store }),
    status: createPlanStatusToolEntry({ store }),
    control: createPlanControlToolEntry({ store }),
  };
  assert.equal(entries.seed.metadata.name, "PlanSeed");
  assert.equal(entries.expand.metadata.name, "PlanExpand");
  assert.equal(entries.completeGate.metadata.name, "PlanCompleteGate");
  assert.equal(entries.status.metadata.name, "PlanStatus");
  assert.equal(entries.control.metadata.name, "PlanControl");
  // PlanStatus 只读（todo.read 同档）；其余是 session 域状态写面（todo.write 同档低风险）
  assert.equal(entries.status.metadata.readOnly, true);
  assert.equal(entries.status.metadata.concurrentSafe, true);
  assert.equal(entries.status.metadata.sideEffectScope, "none");
  assert.equal(entries.status.permission.permission, "swarm.plan.read");
  for (const key of ["seed", "expand", "completeGate", "control"]) {
    assert.equal(entries[key].metadata.readOnly, false, `${key} is a write face`);
    assert.equal(entries[key].metadata.sideEffectScope, "session");
    assert.equal(entries[key].metadata.riskLevel, "low");
    assert.equal(entries[key].metadata.needsApproval, false);
    assert.ok(entries[key].permission.permission.startsWith("swarm.plan."));
  }
  // 提示词契约：PlanSeed/PlanExpand 描述含 plan-vs-todo 分工与 gate 契约话术（R7）
  for (const key of ["seed", "expand"]) {
    assert.ok(entries[key].metadata.description.includes("engine-owned"));
    assert.ok(entries[key].metadata.description.includes("a growing graph is the system working"));
  }
  assert.ok(SWARM_PLAN_VS_TODO_LANGUAGE.includes("engine-owned coordination state"));
  assert.ok(SWARM_GATE_CONTRACT_LANGUAGE.includes("rejected verdict is a success path"));

  // 源码断言：owner 只由 runner 分配/清空（R6）——工具 handlers 不写 owner；
  // plan 与 todo 域独立（不 import todo 模块）。
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const planHandlerFiles = [
    "plan-seed.ts",
    "plan-expand.ts",
    "plan-complete-gate.ts",
    "plan-status.ts",
    "plan-control.ts",
    "plan-shared.ts",
  ];
  const handlersDir = path.resolve(packageRoot(), "packages/core/src/tool/handlers");
  for (const file of planHandlerFiles) {
    const source = await fs.readFile(path.join(handlersDir, file), "utf8");
    assert.ok(
      !/\.owner\s*=/.test(source),
      `${file} must not assign node.owner (owner 只由 runner 分配/清空，R6)`,
    );
    assert.ok(
      !/handlers\/todo|from "\.\/todo\.js"/.test(source),
      `${file} must not depend on the todo domain`,
    );
  }
  const swarmFiles = ["runner.ts", "plan-store.ts", "control.ts", "prompts.ts", "projection.ts"];
  const swarmDir = path.resolve(packageRoot(), "packages/core/src/swarm");
  for (const file of swarmFiles) {
    const source = await fs.readFile(path.join(swarmDir, file), "utf8");
    assert.ok(!/handlers\/todo|from "\.\/todo\.js"/.test(source), `${file} stays todo-free`);
  }
});

function packageRoot() {
  // fileURLToPath 处理 Windows 盘符（URL pathname 的 /C:/ 形态不可直接进 path API）。
  return fileURLToPath(new URL("..", import.meta.url));
}

// ---------------------------------------------------------------------------
// 场景 11：零回归接线断言（expert 全量重跑在 workflow-typed-artifacts.test.mjs）
// ---------------------------------------------------------------------------

test("场景11：expert node-runner 消费共享原语（结构移动，无第二份提取实现）", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const nodeRunnerSource = await fs.readFile(
    path.resolve(packageRoot(), "packages/core/src/workflow/scheduler/node-runner.ts"),
    "utf8",
  );
  assert.ok(nodeRunnerSource.includes("executeNodeSubsession"), "node-runner 必须经共享原语执行");
  assert.ok(
    !nodeRunnerSource.includes("extractTypedArtifact"),
    "response→typed 提取已移入原语，node-runner 不得保留第二份",
  );
  assert.ok(
    !nodeRunnerSource.includes("validateDeepNodeArtifact"),
    "deep 薄校验已移入原语（与 swarm runner 同一份语义）",
  );
});

// ---------------------------------------------------------------------------
// plan store：持久化 seam 与快照隔离（R6）
// ---------------------------------------------------------------------------

test("plan-store：快照深拷贝隔离、mutate 串行、持久化 seam 写穿与恢复", async () => {
  const writes = [];
  let persisted = null;
  const persistence = {
    clearPlan: async () => {
      persisted = null;
    },
    readPlan: async () => persisted,
    writePlan: async (plan) => {
      writes.push(plan.version);
      persisted = structuredClone(plan);
    },
  };
  const store = createSwarmPlanStore({ persistence });
  assert.deepEqual(await store.hydrate(), { adopted: false }); // 空存储
  const outcome = await store.mutate((current) =>
    seedPlan(current, "goal", [def("a")], "light", { nowMs: NOW }),
  );
  assert.ok(outcome.ok);
  assert.equal(writes.length, 1); // 写穿
  assert.equal(persisted.version, 1);

  // 读者快照不写穿 store
  const snapshot = store.getPlan();
  snapshot.nodes[0].status = "failed";
  assert.equal(store.getPlan().nodes[0].status, "queued");

  // 并发 mutate 串行：全部基于最新图提交，无后写覆盖前写
  await Promise.all([
    store.mutate((current) =>
      seedPlan(current, "goal", [def("a"), def("b")], "light", { nowMs: NOW }),
    ),
    store.mutate((current) =>
      seedPlan(current, "goal", [def("a"), def("b"), def("c")], "light", { nowMs: NOW }),
    ),
  ]);
  assert.deepEqual(
    store
      .getPlan()
      .nodes.map((node) => node.id)
      .sort(),
    ["a", "b", "c"],
  );

  // 恢复：新 store 从持久化行 hydrate（跨 runtime 生命周期的单任务单图）
  const restored = createSwarmPlanStore({ persistence });
  const hydrated = await restored.hydrate();
  assert.equal(hydrated.adopted, true);
  assert.deepEqual(
    restored
      .getPlan()
      .nodes.map((node) => node.id)
      .sort(),
    ["a", "b", "c"],
  );

  // 坏行不采用（存储边界过 SwarmTaskPlanSchema 校验）
  persisted = { version: "not-a-number" };
  const corrupt = createSwarmPlanStore({ persistence });
  const corruptResult = await corrupt.hydrate();
  assert.equal(corruptResult.adopted, false);
  assert.ok(corruptResult.error.includes("schema validation"));

  // 清除
  await restored.clear();
  assert.equal(restored.getPlan(), null);
});

test("plan-store hydrate：崩溃残留 running 复位 queued 可被首调度点认领 + warn 恰一次（H2）", async () => {
  // 持久化行模拟崩溃现场：a/b 停在 running（owner 指向死执行实例、expanded 合成中途态、
  // no-artifact 计数已累计），c 已 done（终态事实不是执行中间态，不动）。
  let persisted = runWorker(
    okOf(seedPlan(null, "goal", [def("a"), def("b"), def("c")], "light", { nowMs: NOW })),
    "c",
    artifact(),
  );
  persisted = structuredClone(persisted);
  for (const nodeId of ["a", "b"]) {
    const node = persisted.nodes.find((candidate) => candidate.id === nodeId);
    node.status = "running";
    node.owner = `dead-exec-${nodeId}`;
    node.expanded = true;
    node.artifactRequeues = 1;
  }
  const warnings = [];
  const persistence = {
    clearPlan: async () => {},
    readPlan: async () => persisted,
    writePlan: async () => {},
  };
  const store = createSwarmPlanStore({
    logger: {
      warn: (message, context) => warnings.push({ context, message }),
    },
    persistence,
  });

  // 修复前：running 原样采纳 → readyNodes 只选 queued（永不重派）、planTerminalState 恒 active。
  const hydrated = await store.hydrate();
  assert.equal(hydrated.adopted, true);
  for (const nodeId of ["a", "b"]) {
    const node = nodeOf(store.getPlan(), nodeId);
    assert.equal(node.status, "queued");
    assert.equal(node.owner, null);
    assert.equal(node.expanded, false);
    assert.equal(node.artifactRequeues, 1); // 累计预算保留不重置
  }
  assert.equal(nodeOf(store.getPlan(), "c").status, "done");

  // warn 恰一次：含复位节点数、不含节点 id 列表（plan 可达 1024 节点，id 列表会写爆日志）
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].context?.event, "swarm.plan.hydrate_reset");
  assert.equal(warnings[0].context?.resetRunningNodes, 2);
  assert.ok(!("nodeIds" in warnings[0].context));

  // 首调度点认领（fake runner 断言认领发生）：a/b 全部可被 claim。
  const exec = controlledExecute();
  const runner = createSwarmRunner({ executeNode: exec.executeNode, store });
  await runner.dispatchReadyNodes();
  assert.deepEqual(
    exec.calls.map((call) => call.node.id).sort(),
    ["a", "b"],
  );
  assert.equal(runner.activeWorkerCount(), 2);
});

// ===========================================================================
// 第三段（2b）：统一接线——注册门 / turn 后调度点 / reminder 载体 / SQLite 行绑定 /
// runtime-task 投影 / cancel abort 推导（specs/swarm-task-graph.md R4/R5/R6/R7 的
// 接线面；真实子会话执行闭包在 bootstrap 装配层，此处以源码断言钉住其消费形态）
// ===========================================================================

const { dispatchSwarmPlanReadyNodes, buildSwarmPlanTurnReminderBody } = await import(
  "../packages/core/src/runtime/helpers/swarm-plan-turn.ts"
);
const { registerBuiltInTools } = await import("../packages/core/src/tool/handlers/index.ts");
const {
  bindSwarmPlanPersistenceFromSessionStore,
  deriveSwarmAbortedNodeIds,
  syncSwarmPlanRuntimeTask,
} = await import("../packages/core/src/swarm/runtime-binding.ts");
const { cancelSwarmNode } = await import("../packages/core/src/swarm/control.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);
const sourceModule = await import("../packages/core/src/system-reminder/source.ts");

// ---------------------------------------------------------------------------
// 2b helpers
// ---------------------------------------------------------------------------

function fakeRunnerForSwarm() {
  const calls = [];
  return {
    calls,
    dispatchReadyNodes: async () => {
      calls.push(calls.length);
    },
  };
}

function fakeRuntimeForSwarm(options = {}) {
  const warnings = [];
  return {
    warnings,
    config: { taskType: options.taskType },
    swarmPlanPort: options.port,
    logger: {
      warn: (message, context) => warnings.push({ context, message }),
    },
  };
}

function captureRegistry() {
  const names = [];
  return {
    names,
    registry: {
      register: (entry) => names.push(entry.metadata.name),
    },
  };
}

const PLAN_TOOL_NAMES = ["PlanSeed", "PlanExpand", "PlanCompleteGate", "PlanStatus", "PlanControl"];

// ---------------------------------------------------------------------------
// 场景 10（2b）：swarmPlanPort 注册门——主对话五工具 / workflow_child 只读 / 缺席不注册
// ---------------------------------------------------------------------------

test("2b 注册门：主对话注册全部五工具，workflow_child 只读面只有 PlanStatus，端口缺席不注册", () => {
  const store = createSwarmPlanStore();
  const port = { runner: fakeRunnerForSwarm(), store };

  const main = captureRegistry();
  registerBuiltInTools(main.registry, { swarmPlanPort: port });
  for (const name of PLAN_TOOL_NAMES) {
    assert.ok(main.names.includes(name), `main conversation must register ${name}`);
  }

  const child = captureRegistry();
  registerBuiltInTools(child.registry, { swarmPlanPort: port, swarmPlanReadOnly: true });
  for (const name of PLAN_TOOL_NAMES) {
    if (name === "PlanStatus") {
      assert.ok(child.names.includes(name), "workflow child keeps read-only PlanStatus");
    } else {
      assert.ok(!child.names.includes(name), `workflow child must not see ${name} (R5)`);
    }
  }

  const absent = captureRegistry();
  registerBuiltInTools(absent.registry, {});
  for (const name of PLAN_TOOL_NAMES) {
    assert.ok(!absent.names.includes(name), `no port means no ${name}`);
  }
});

test("2b 注册门：runtime-tools 的 taskType 推导与 includeAutomation 同款（源码断言）", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const source = await fs.readFile(
    path.resolve(packageRoot(), "packages/core/src/runtime/helpers/runtime-tools.ts"),
    "utf8",
  );
  // 端口透传 + 只读推导在调用方（runtime-tools.ts），handlers/index.ts 不做 runtime 配置推断。
  assert.match(source, /swarmPlanPort: deps\.swarmPlanPort/u);
  assert.match(source, /swarmPlanReadOnly: runtime\.config\.taskType === "workflow_child"/u);
  // subagent 子会话整体不暴露（封闭域）：缺席推导与 includeAutomation 的排除先例同位。
  assert.match(source, /deps\.swarmPlanPort === undefined \|\| runtime\.config\.taskType === "subagent_child"/u);
});

// ---------------------------------------------------------------------------
// 场景 6（2b）：turn 后调度点触发 dispatch（fake runner 断言）
// ---------------------------------------------------------------------------

test("2b 调度点：成功 Main turn 挂点触发 dispatchReadyNodes；失败只 warn；子会话身份不驱动", async () => {
  const runner = fakeRunnerForSwarm();
  dispatchSwarmPlanReadyNodes(fakeRuntimeForSwarm({ port: { runner, store: null } }), {
    traceContext: { traceId: "t-1" },
  });
  await tick();
  assert.equal(runner.calls.length, 1); // 不 await 也已触发（fire-and-forget）

  // 派发失败：warn 不上抛、不产生 unhandled rejection
  const failing = {
    dispatchReadyNodes: async () => {
      throw new Error("dispatch exploded");
    },
  };
  const runtime = fakeRuntimeForSwarm({ port: { runner: failing, store: null } });
  dispatchSwarmPlanReadyNodes(runtime, { traceContext: { traceId: "t-2" } });
  await tick();
  assert.equal(runtime.warnings.length, 1);
  assert.equal(runtime.warnings[0].message, "Swarm plan dispatch failed after turn");
  assert.equal(runtime.warnings[0].context.event, "swarm.plan.dispatch_failed");

  // worker 子会话（workflow_child）不驱动引擎；端口缺席静默返回
  const childRunner = fakeRunnerForSwarm();
  dispatchSwarmPlanReadyNodes(
    fakeRuntimeForSwarm({ port: { runner: childRunner, store: null }, taskType: "workflow_child" }),
    { traceContext: { traceId: "t-3" } },
  );
  dispatchSwarmPlanReadyNodes(fakeRuntimeForSwarm({}), { traceContext: { traceId: "t-4" } });
  await tick();
  assert.equal(childRunner.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 场景 12（2b）：reminder 载体（swarm_plan_status per-request 动态段）与零注入
// ---------------------------------------------------------------------------

test("2b reminder：plan 在场注入图摘要；无 plan / 子会话身份 / 无端口零注入", async () => {
  const store = await seedStore([def("a"), def("b", undefined, { dependsOn: ["a"] })], "deep", {
    goal: "wire the swarm",
  });
  const withPlan = fakeRuntimeForSwarm({ port: { runner: fakeRunnerForSwarm(), store } });
  const body = buildSwarmPlanTurnReminderBody(withPlan);
  assert.ok(body.includes("wire the swarm"));
  assert.ok(body.includes("0/3 done")); // a + b + root gate
  assert.ok(body.includes("deep"));

  // 空 store（plan→null 零注入）
  const empty = fakeRuntimeForSwarm({
    port: { runner: fakeRunnerForSwarm(), store: createSwarmPlanStore() },
  });
  assert.equal(buildSwarmPlanTurnReminderBody(empty), null);
  // 子会话身份与端口缺席
  const child = fakeRuntimeForSwarm({
    port: { runner: fakeRunnerForSwarm(), store },
    taskType: "workflow_child",
  });
  assert.equal(buildSwarmPlanTurnReminderBody(child), null);
  assert.equal(buildSwarmPlanTurnReminderBody(fakeRuntimeForSwarm({})), null);
});

test("2b reminder 载体：swarm_plan_status 是 per-request 动态段；turn.ts 注入与调度点在位（源码断言）", async () => {
  // source.ts 档位（K1 memory_semantic_recall 同款）：per-request 名单、不进 persisted。
  assert.ok(sourceModule.SYSTEM_REMINDER_PER_REQUEST_SOURCES.includes("swarm_plan_status"));
  assert.ok(!sourceModule.SYSTEM_REMINDER_PERSISTED_SOURCES.includes("swarm_plan_status"));
  assert.deepEqual(
    { ...sourceModule.getSystemReminderDescriptor("swarm_plan_status") },
    {
      channel: "current_turn",
      evidenceLabel: "sr.swarm_plan_status",
      isMeta: true,
      lifecycle: "per_current_turn",
      providerVisibility: "provider_visible",
      source: "swarm_plan_status",
    },
  );

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const turnSource = await fs.readFile(
    path.resolve(packageRoot(), "packages/core/src/runtime/methods/turn.ts"),
    "utf8",
  );
  // reminder：loop 起步前以 per-request 动态段 commit（不落 session store）。
  assert.match(turnSource, /systemReminderAttachmentEntry\("swarm_plan_status", swarmPlanReminderBody\)/u);
  assert.match(turnSource, /buildSwarmPlanTurnReminderBody\(this\)/u);
  // 调度点：memory extraction 同位（成功 Main turn 后），不 await、失败 warn 在 helper 内。
  const dispatchIndex = turnSource.indexOf("dispatchSwarmPlanReadyNodes(this");
  const memoryIndex = turnSource.indexOf("scheduleProjectMemoryExtraction(this");
  assert.ok(dispatchIndex > memoryIndex, "swarm dispatch hooks after memory extraction (same site)");
});

// ---------------------------------------------------------------------------
// R6（2b）：SQLite 行绑定 round-trip + duck-typing seam + hydrate 恢复
// ---------------------------------------------------------------------------

test("2b 持久化：SQLite swarm_plan 行 round-trip、跨 store hydrate、clear 删行", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "swarm-plan-2b-"));
  const dbPath = join(dir, "session.db");
  try {
    const sqlite = createSqliteSessionStore({ dbPath });
    await sqlite.createSession({
      id: "ses_swarm_2b",
      projectID: "prj_swarm",
      slug: "swarm",
      directory: dir,
      title: "swarm plan wiring",
      version: "0.16.9",
    });

    // duck-typing seam：SqliteSessionStore 的三方法齐备 → 绑定成功
    const persistence = bindSwarmPlanPersistenceFromSessionStore(sqlite, {
      sessionID: "ses_swarm_2b",
    });
    assert.ok(persistence !== undefined, "sqlite store must satisfy the swarm plan seam");

    const store = createSwarmPlanStore({ persistence });
    const outcome = await store.mutate((current) =>
      seedPlan(current, "persist me", [def("a"), def("b", undefined, { dependsOn: ["a"] })], "deep", {
        nowMs: NOW,
      }),
    );
    assert.ok(outcome.ok);
    // 行内是 SwarmTaskPlan 的 JSON 序列化（round-trip 深等价）
    const raw = await sqlite.readSwarmPlan({ sessionID: "ses_swarm_2b" });
    assert.deepEqual(raw, store.getPlan());

    // 跨 store 生命周期恢复：新 store（新 runtime 形态）从同一行 hydrate
    const restored = createSwarmPlanStore({ persistence });
    const hydrated = await restored.hydrate();
    assert.equal(hydrated.adopted, true);
    assert.deepEqual(
      restored
        .getPlan()
        .nodes.map((node) => node.id)
        .sort(),
      ["a", "b", "root-gate"],
    );

    // clear 删行（cancel-plan 的存储面收口）
    await restored.clear();
    assert.equal(await sqlite.readSwarmPlan({ sessionID: "ses_swarm_2b" }), null);

    sqlite.close();
    // 迁移落位：重开 db 后表结构仍在（0026_swarm_plan_row）
    const reopened = createSqliteSessionStore({ dbPath });
    const afterReopen = await reopened.readSwarmPlan({ sessionID: "ses_swarm_2b" });
    assert.equal(afterReopen, null); // 无行但表可读（迁移已跑）
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("2b 持久化：duck-typing 缺席降级——测试替身/部分能力 store 不绑定", () => {
  assert.equal(bindSwarmPlanPersistenceFromSessionStore({}, { sessionID: "s" }), undefined);
  const readOnly = {
    readSwarmPlan: async () => null,
  };
  assert.equal(
    bindSwarmPlanPersistenceFromSessionStore(readOnly, { sessionID: "s" }),
    undefined,
    "缺 write/clear 的只读绑定比没有持久化更糟，必须整体降级",
  );
  assert.equal(
    bindSwarmPlanPersistenceFromSessionStore(null, { sessionID: "s" }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// R4（2b）：runtime-task 投影 + store onChange（cancel abort 推导的观测源）
// ---------------------------------------------------------------------------

test("2b 投影：plan 活跃注册 runtime task（type swarm_plan，摘要含计数）；终态映射与清除", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const taskId = "swarm-plan:ses_x";

  const store = await seedStore([def("a"), def("b", undefined, { dependsOn: ["a"] })], "light");
  syncSwarmPlanRuntimeTask({ plan: store.getPlan(), registry, taskId });
  const active = registry.get(taskId);
  assert.ok(active !== undefined, "active plan registers a runtime task");
  assert.equal(active.type, "swarm_plan");
  assert.equal(active.status, "running");
  assert.ok(active.description.includes("0/2 done"));
  assert.ok(active.description.includes("light"));

  // 状态推进：update 路径刷新摘要与状态（claim 后 complete——owner 只由执行侧写入）
  for (const nodeId of ["a", "b"]) {
    await store.mutate((current) => {
      const staged = structuredClone(current);
      const node = staged.nodes.find((candidate) => candidate.id === nodeId);
      node.status = "running";
      node.owner = "w";
      return { ok: true, plan: staged };
    });
    await store.mutate((current) => completeWorkerNode(current, nodeId, null, { actor: "w" }));
  }
  syncSwarmPlanRuntimeTask({ plan: store.getPlan(), registry, taskId });
  const completed = registry.get(taskId);
  assert.equal(completed.status, "completed");
  assert.ok(completed.description.includes("2/2 done"));
  assert.ok(completed.completedAt instanceof Date);

  // stalled → failed（需要干预的终局）。用新 registry：registry 的终态 first-wins 守卫
  // （既有语义）会拦下 completed→failed 的直改——真实生命周期里 plan 重开必经 active
  // （re-seed 重置 gate / expand / gap 注入都让 terminalState 回 active），不存在
  // completed 直跳 stalled 的提交路径。
  const stalledRegistry = new InMemoryRuntimeTaskRegistry();
  const stalledStore = await seedStore([def("x")], "light");
  await stalledStore.mutate((current) => {
    const staged = structuredClone(current);
    const node = staged.nodes.find((candidate) => candidate.id === "x");
    node.status = "failed";
    node.owner = null;
    return { ok: true, plan: staged };
  });
  syncSwarmPlanRuntimeTask({ plan: stalledStore.getPlan(), registry: stalledRegistry, taskId });
  assert.equal(stalledRegistry.get(taskId).status, "failed");

  // plan 清除 → 条目收口
  syncSwarmPlanRuntimeTask({ plan: null, registry, taskId });
  assert.equal(registry.get(taskId), undefined);
});

test("2b onChange：提交观测恰好派发一次（previous 快照）；cancel 推导读出被取消的在飞节点", async () => {
  const events = [];
  const store = createSwarmPlanStore({
    onChange: (event) => events.push(event),
  });
  await store.mutate((current) =>
    seedPlan(current, "goal", [def("a"), def("b")], "light", { nowMs: NOW }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].previous, null);
  assert.equal(events[0].plan.nodes.length, 2);

  // claim a（running）后 cancel-node：观测到 previous(a=running) → plan(a=failed)
  await store.mutate((current) => {
    const staged = structuredClone(current);
    const node = staged.nodes.find((candidate) => candidate.id === "a");
    node.status = "running";
    node.owner = "w1";
    return { ok: true, plan: staged };
  });
  await store.mutate((current) => cancelSwarmNode(current, "a", NOW + 1));
  const cancelEvent = events.at(-1);
  assert.deepEqual(deriveSwarmAbortedNodeIds(cancelEvent.previous, cancelEvent.plan), ["a"]);
  // 非 cancel 的提交（b 的 claim）不产生伪阳性
  await store.mutate((current) => {
    const staged = structuredClone(current);
    const node = staged.nodes.find((candidate) => candidate.id === "b");
    node.status = "running";
    node.owner = "w2";
    return { ok: true, plan: staged };
  });
  assert.deepEqual(deriveSwarmAbortedNodeIds(events.at(-1).previous, events.at(-1).plan), []);
  // plan 清除：全部在飞执行被推导取消（b 此刻 running）
  await store.clear();
  const clearEvent = events.at(-1);
  assert.deepEqual(deriveSwarmAbortedNodeIds(clearEvent.previous, clearEvent.plan), ["b"]);
});

// ---------------------------------------------------------------------------
// 2b 装配面：bootstrap executeNode 闭包的源码钉子（真实子会话执行归 bootstrap 层）
// ---------------------------------------------------------------------------

test("2b 装配：bootstrap 闭包消费共享原语与端口透传；create-app 注入/绑定/hydrate/dispose（源码断言）", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const wiring = await fs.readFile(
    path.resolve(packageRoot(), "packages/bootstrap/src/app/swarm-plan-runtime.ts"),
    "utf8",
  );
  // 子会话执行走共享原语（enforce 归 runner settle——见文件头论证）
  assert.ok(wiring.includes("executeNodeSubsession"), "bootstrap executeNode must consume the shared primitive");
  assert.ok(wiring.includes("enforce: false"));
  // worker 子会话经 createScriptWorkflowAgentRuntime（taskType=workflow_child 语义）
  assert.ok(wiring.includes("createScriptWorkflowAgentRuntime"));
  // worker 注入同一 port（注册面推导成只读 PlanStatus）+ cancel abort 面
  assert.ok(wiring.includes("swarmPlanPort: port"));
  assert.ok(wiring.includes("deriveSwarmAbortedNodeIds"));
  assert.ok(wiring.includes("syncSwarmPlanRuntimeTask"));

  const createApp = await fs.readFile(
    path.resolve(packageRoot(), "packages/bootstrap/src/app/create-app.ts"),
    "utf8",
  );
  assert.ok(createApp.includes("swarmPlanPort: swarmPlanWiring.port"), "port injected into runtime deps");
  assert.ok(createApp.includes("swarmPlanWiring.bindRuntime(runtime)"), "late runtime binding after construction");
  assert.ok(createApp.includes("await swarmPlanWiring.hydrate(traceContext)"), "hydrate before first turn");
  assert.ok(createApp.includes("swarmPlanWiring.dispose()"), "dispose wired into app close");
});

test("2b 装配：worker 子会话继承父会话 mode——configOverrides 显式 mode（H3 源码钉子）", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const wiring = await fs.readFile(
    path.resolve(packageRoot(), "packages/bootstrap/src/app/swarm-plan-runtime.ts"),
    "utf8",
  );
  // 工厂缺省 yolo 是 dwf actor 的信任假设；swarm worker 的 configOverrides 必须显式
  // 继承父会话 mode（overnight-controller fork 的同款先例），build 模式下不得经免审批
  // worker 获得无审批执行面。
  assert.ok(
    wiring.includes("mode: deps.runtimeConfig.mode"),
    "swarm worker configOverrides must explicitly inherit the parent session mode",
  );
  // 工厂本身不动（dwf actor 的 yolo 假设属 dynamic-workflow 域，越界不改）。
  const factory = await fs.readFile(
    path.resolve(packageRoot(), "packages/bootstrap/src/app/script-workflow-child-runtime.ts"),
    "utf8",
  );
  assert.ok(
    factory.includes('mode: "yolo"'),
    "script-workflow-child-runtime factory default must stay untouched (dwf domain)",
  );
});
