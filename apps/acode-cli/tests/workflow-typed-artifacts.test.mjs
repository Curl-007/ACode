import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * J2-3 expert workflow 类型化 artifact + critic 点名校验
 * （specs/workflow-typed-artifacts.md 验收场景 A-F；方案文档 §J2-3）。
 *
 * 机制参照 jcode (MIT) crates/jcode-plan/src/dag/{mod.rs,ops.rs}（HandoffArtifact /
 * validate_gate_pass / mentions_node_id / artifact-or-nothing），自撰实现。
 *
 * 覆盖分组：
 *   A —— 契约向后兼容：路径式 artifact 解析不变；typed 段可选、严格校验；definition
 *        gatePolicy 可选（内建 expert definition 无该字段 → light）。
 *   B —— 词边界点名匹配（防短 id 误命中；句尾 ./ : 标点语义）。
 *   C —— evaluateCriticGate 纯函数：橡皮图章拒绝、low-confidence 债务（两档）、
 *        stale scope（deep）、枚举封顶（>20 只放宽 high-confidence）。
 *   D —— artifact-or-nothing（scheduler 端到端）：deep 缺块 requeue 一次、第二次 fail
 *        （封顶计数）；薄 artifact 同样拒绝；light 无块照常完成（零回归）；typed 落 snapshot；
 *        R2 别名登记表逐条生效（含 what_i_didnt_check）；强制范围只到 worker(task) 节点，
 *        回退派发的 phase 容器节点不被强制（提示词无契约段 → 不告知就不判违规）。
 *   E —— critic-loop / 八阶段全流程：light 橡皮图章 pass 零回归（事件序列钉住）；
 *        light low-confidence 未处理 → pass 被拒 + reopen 路由后续工作；deep 橡皮图章 →
 *        拒绝 + 补充要求 + 第二轮点名通过；deep low-confidence 未处理 → gate 不通过；
 *        deep 持续橡皮图章 → maxIterations 封顶；deep + exec 无 task 节点（回退派发
 *        phase 容器节点）→ run 照常完成，不停在 scheduler paused。
 *   F —— 提示词分档回归：light 档三个 prompt builder 与现状逐字节一致（golden 快照）；
 *        deep 档追加契约段/反馈段/补充要求，且为纯追加（前缀不变）。
 *   G —— planner 输出空白 id 防护（R11/对抗复核 F-1）：parseWorkflowPlannerResult 对空白
 *        id 解析报错（fail-loud，不静默丢弃）；schema 层 trim+min(1)；applyPlannerExpansion
 *        可读错误；collection planner E2E（deep/light）→ planner_failed 事件可见、空白节点
 *        从未进图、后续正常扩张跑完；seed 路径既有滤空白行为钉住。
 */

const {
  WorkflowArtifactSchema,
  WorkflowArtifactTypedSchema,
  WorkflowDefinitionSchema,
  WorkflowGraphNodeSchema,
  WorkflowGraphPlannerNodeSchema,
  WorkflowGraphPlannerResultSchema,
  WorkflowGraphSeedSchema,
  WorkflowRunSnapshotSchema,
  WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH,
  WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH,
  WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH,
} = await import("../packages/contracts/src/workflow/index.ts");
const {
  buildCriticSupplementRequest,
  collectCriticAuditScope,
  collectCriticCoverageTexts,
  CRITIC_COVERAGE_ENUMERATION_CAP,
  DEFAULT_MAX_ARTIFACT_REQUEUES,
  deepCriticPromptLines,
  describeCriticGateIssues,
  evaluateCriticGate,
  mentionsNodeId,
  resolveWorkflowGateSettings,
} = await import("../packages/core/src/workflow/artifact-gate.ts");
const {
  extractTypedArtifact,
  TYPED_ARTIFACT_FENCE,
  typedArtifactContractLines,
  validateDeepNodeArtifact,
} = await import("../packages/core/src/workflow/typed-artifact.ts");
const { WorkflowGraphScheduler } = await import("../packages/core/src/workflow/scheduler.ts");
const {
  createExpertWorkflowDefinition,
  DEFAULT_EXPERT_WORKFLOW_STRATEGY,
} = await import("../packages/core/src/workflow/definition.ts");
const { ExpertWorkflowRuntime } = await import(
  "../packages/core/src/workflow/expert/runtime.ts"
);
const { buildDefaultNodePrompt } = await import(
  "../packages/core/src/workflow/scheduler/prompts.ts"
);
const { buildPhasePrompt, buildScheduledNodePrompt, createPhaseGraph } =
  await import("../packages/core/src/workflow/expert/prompts.ts");
const { executableNodeIdsForPhase } = await import("../packages/core/src/workflow/expert/ids.ts");
const { parseWorkflowPlannerResult } = await import(
  "../packages/core/src/workflow/expert/parsers/planner-result.ts"
);
const { parseWorkflowGraphSeed } = await import(
  "../packages/core/src/workflow/expert/parsers/graph-seed.ts"
);
const { applyPlannerExpansion } = await import(
  "../packages/core/src/workflow/scheduler/planner-expansion.ts"
);

const FIXED_NOW = new Date("2026-09-30T00:00:00.000Z");
const DEEP_GATE = { maxArtifactRequeues: DEFAULT_MAX_ARTIFACT_REQUEUES, preset: "deep" };
const LIGHT_GATE = { maxArtifactRequeues: DEFAULT_MAX_ARTIFACT_REQUEUES, preset: "light" };

const VALID_TYPED = {
  confidence: "high",
  evidence: ["src/a.ts:10"],
  findings: "Implemented the change and ran the focused tests.",
  openQuestions: [],
  validation: "node --test tests/x.test.mjs passed",
  whatINotChecked: ["nothing, fully covered"],
};

function typedBlock(payload) {
  return "```" + TYPED_ARTIFACT_FENCE + "\n" + JSON.stringify(payload) + "\n```";
}

function makeTaskNode(id, overrides = {}) {
  return WorkflowGraphNodeSchema.parse({
    dependsOn: [],
    id,
    kind: "task",
    phase: "exec",
    status: "pending",
    title: `Task ${id}`,
    ...overrides,
  });
}

function makeRunSnapshot(graph, overrides = {}) {
  return WorkflowRunSnapshotSchema.parse({
    activities: [],
    artifacts: [],
    createdAt: FIXED_NOW.toISOString(),
    cwd: "/repo",
    graph,
    kind: "expert",
    phaseOrder: ["exec", "final_critic"],
    phases: [
      { phase: "exec", status: "active" },
      { phase: "final_critic", status: "pending" },
    ],
    runId: "wf_test_run",
    schemaVersion: 1,
    status: "running",
    strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
    task: "ship it",
    updatedAt: FIXED_NOW.toISOString(),
    ...overrides,
  });
}

function makeSchedulerHarness(responder) {
  const events = [];
  const graphRecords = [];
  const snapshots = [];
  const artifactsWritten = [];
  const runnerCalls = [];
  let activityCount = 0;
  const deps = {
    appendEvent: async (event) => {
      events.push(event);
    },
    appendGraphRecord: async (_runId, record) => {
      graphRecords.push(record);
    },
    createActivityId: () => `act_${(activityCount += 1)}`,
    now: () => FIXED_NOW,
    runner: {
      run: async (input) => {
        runnerCalls.push(input);
        return { response: responder(input, runnerCalls.length), sessionId: `sess_${input.activityId}` };
      },
    },
    writeArtifact: async (runId, relativePath, content) => {
      artifactsWritten.push({ content, relativePath });
      return { path: `/store/${runId}/${relativePath}`, relativePath };
    },
    writeSnapshot: async (snapshot) => {
      snapshots.push(snapshot);
    },
  };
  return { artifactsWritten, deps, events, graphRecords, runnerCalls, snapshots };
}

function makeStoreHarness() {
  const events = [];
  const graphRecords = [];
  const snapshots = new Map();
  const artifacts = new Map();
  let reportCount = 0;
  const port = {
    appendEvent: async (event) => {
      events.push(event);
    },
    appendGraphRecord: async (_runId, record) => {
      graphRecords.push(record);
    },
    listRuns: async () => [],
    readEvents: async () => events,
    readLatestRun: async () => null,
    readRun: async (runId) => snapshots.get(runId) ?? null,
    writeArtifact: async (runId, relativePath, content) => {
      artifacts.set(relativePath, content);
      return { path: `/store/${runId}/${relativePath}`, relativePath };
    },
    writeReport: async (runId, content) => {
      reportCount += 1;
      artifacts.set("report.md", content);
      return { path: `/store/${runId}/report.md`, relativePath: "report.md" };
    },
    writeSnapshot: async (snapshot) => {
      snapshots.set(snapshot.runId, snapshot);
    },
  };
  return { artifacts, events, graphRecords, port, snapshots };
}

function makeRuntime(store, responder, definition) {
  const prompts = [];
  let activityCount = 0;
  let sessionCount = 0;
  const runtime = new ExpertWorkflowRuntime({
    agentRunner: {
      run: async (input) => {
        prompts.push({ phase: input.phase, prompt: input.prompt });
        return {
          response: responder(input, prompts),
          sessionId: `sess_${(sessionCount += 1)}`,
        };
      },
    },
    createActivityId: () => `act_${(activityCount += 1)}`,
    createRunId: () => "wf_test_e2e",
    definition,
    now: () => FIXED_NOW,
    store: store.port,
  });
  return { prompts, runtime };
}

function makeDeepDefinition() {
  return WorkflowDefinitionSchema.parse({
    ...createExpertWorkflowDefinition(),
    gatePolicy: { preset: "deep" },
  });
}

const SEED_RESPONSE = JSON.stringify({
  nodes: [
    { id: "build_a", prompt: "build the a", title: "Build A" },
    { dependsOn: ["build_a"], id: "verify_b", prompt: "verify the b", title: "Verify B" },
  ],
  reasoning: "two-step plan",
});
const RUBBER_PASS = JSON.stringify({ reasoning: "All good, no gaps.", verdict: "pass" });
const NAMING_PASS = JSON.stringify({
  reasoning: "build_a: reviewed, ships as intended. verify_b: reviewed, focused tests pass.",
  verdict: "pass",
});

function nodePromptFor(prompts, nodeId) {
  return prompts.filter(
    (entry) => entry.phase === "exec" && entry.prompt.includes(`Node id: ${nodeId}`),
  );
}

function eventsOfType(events, type) {
  return events.filter((event) => event.type === type);
}

// ============================================================
// A —— 契约向后兼容（spec R1/R9）
// ============================================================

test("A1: 路径式 artifact 解析结果与现状一致，无 typed 键", () => {
  const legacy = {
    contentType: "text/markdown",
    createdAt: FIXED_NOW.toISOString(),
    label: "Node artifact",
    path: "artifacts/exec/build_a.md",
    phase: "exec",
  };
  assert.deepStrictEqual(WorkflowArtifactSchema.parse(legacy), legacy);
});

test("A2: typed 段可选解析，缺省字段给默认值", () => {
  const parsed = WorkflowArtifactSchema.parse({
    contentType: "text/markdown",
    createdAt: FIXED_NOW.toISOString(),
    label: "Node artifact",
    path: "artifacts/exec/build_a.md",
    typed: { confidence: "low" },
  });
  assert.deepStrictEqual(parsed.typed, {
    confidence: "low",
    evidence: [],
    findings: "",
    openQuestions: [],
    whatINotChecked: [],
  });
});

test("A3: typed 段严格类型——非法 confidence / 非法 evidence 被拒", () => {
  const base = {
    contentType: "text/markdown",
    createdAt: FIXED_NOW.toISOString(),
    label: "L",
    path: "artifacts/x.md",
  };
  assert.throws(() => WorkflowArtifactSchema.parse({ ...base, typed: { confidence: "very high" } }));
  assert.throws(() => WorkflowArtifactSchema.parse({ ...base, typed: { evidence: "src/a.ts:1" } }));
  assert.throws(() => WorkflowArtifactSchema.parse({ ...base, typed: { findings: 42 } }));
});

test("A4: definition gatePolicy 可选——内建 expert definition 不声明（light 的结构性保证）", () => {
  const builtIn = createExpertWorkflowDefinition();
  assert.ok(!("gatePolicy" in builtIn));
  assert.deepStrictEqual(resolveWorkflowGateSettings(builtIn), LIGHT_GATE);
  assert.deepStrictEqual(resolveWorkflowGateSettings({}), LIGHT_GATE);

  const deep = makeDeepDefinition();
  assert.deepStrictEqual(resolveWorkflowGateSettings(deep), DEEP_GATE);

  const explicit = WorkflowDefinitionSchema.parse({
    ...builtIn,
    gatePolicy: { maxArtifactRequeues: 2, preset: "deep" },
  });
  assert.deepStrictEqual(resolveWorkflowGateSettings(explicit), {
    maxArtifactRequeues: 2,
    preset: "deep",
  });

  // gatePolicy 在场但缺省 preset → light（default 只在作者显式声明 gatePolicy 时生效）
  const emptyPolicy = WorkflowDefinitionSchema.parse({ ...builtIn, gatePolicy: {} });
  assert.equal(emptyPolicy.gatePolicy.preset, "light");
});

test("A5: 节点 schema 新增可选 artifactRequeues，历史节点记录解析不变", () => {
  const legacyNode = { dependsOn: [], id: "n1", kind: "task", status: "completed", title: "T" };
  assert.deepStrictEqual(WorkflowGraphNodeSchema.parse(legacyNode), legacyNode);
  assert.equal(WorkflowGraphNodeSchema.parse({ ...legacyNode, artifactRequeues: 1 }).artifactRequeues, 1);
  assert.throws(() => WorkflowGraphNodeSchema.parse({ ...legacyNode, artifactRequeues: -1 }));
});

test("A6: typed 段长度上限（F-4/R1）——超限整块 invalid，限内通过，常量即依据", () => {
  // 单字符串上限（findings/validation ≤ 100_000 字符）
  const oversizedFindings = {
    ...VALID_TYPED,
    findings: "x".repeat(WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH + 1),
  };
  assert.equal(WorkflowArtifactTypedSchema.safeParse(oversizedFindings).success, false);
  assert.equal(
    WorkflowArtifactTypedSchema.safeParse({
      ...VALID_TYPED,
      validation: "y".repeat(WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH + 1),
    }).success,
    false,
  );
  // 恰好在限上 → 通过（上限含边界）
  assert.equal(
    WorkflowArtifactTypedSchema.safeParse({
      ...VALID_TYPED,
      findings: "x".repeat(WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH),
    }).success,
    true,
  );
  // 数组项数 ≤ 200
  assert.equal(
    WorkflowArtifactTypedSchema.safeParse({
      ...VALID_TYPED,
      evidence: Array.from(
        { length: WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH + 1 },
        (_, index) => `ref-${index}`,
      ),
    }).success,
    false,
  );
  // 数组单条目 ≤ 10_000
  assert.equal(
    WorkflowArtifactTypedSchema.safeParse({
      ...VALID_TYPED,
      whatINotChecked: ["z".repeat(WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH + 1)],
    }).success,
    false,
  );
  // core 提取链路（extractTypedArtifact → 同一 schema）同样整块拒绝，且给出可读 reasons
  const extraction = extractTypedArtifact(`x\n${typedBlock(oversizedFindings)}`);
  assert.equal(extraction.kind, "invalid");
  assert.ok(extraction.reasons.some((reason) => reason.includes("findings")));
});

// ============================================================
// B —— 词边界点名匹配（spec R5，jcode mentions_node_id 语义）
// ============================================================

test("B1: 短 id 不误命中长单词（裸 contains 会让橡皮图章蒙混过关）", () => {
  // "a" 只作为 cat/sat/mat 的内部字符出现——裸 contains 会命中，词边界不会
  assert.equal(mentionsNodeId("The cat sat on the mat", "a"), false);
  assert.equal(mentionsNodeId("a stands alone", "a"), true);
  assert.equal(mentionsNodeId("reviewed build_a1 but not build_a", "build_a"), true);
  assert.equal(mentionsNodeId("only build_a1 here", "build_a"), false);
});

test("B2: 结尾 ./ : 是标点还是 id 延伸——后随 id 字符才算延伸", () => {
  assert.equal(mentionsNodeId("checked node.a.", "node.a"), true);
  assert.equal(mentionsNodeId("see node.a.b for details", "node.a"), false);
  assert.equal(mentionsNodeId("see node.a.b for details", "node.a.b"), true);
  assert.equal(mentionsNodeId("build_a: reviewed", "build_a"), true);
  assert.equal(mentionsNodeId("scope phase:exec done", "phase:exec"), true);
});

test("B3: 边界情形——空 id / 空文本 / 精确全串命中 / 连字符 id", () => {
  assert.equal(mentionsNodeId("anything", ""), false);
  assert.equal(mentionsNodeId("", "x"), false);
  assert.equal(mentionsNodeId("build-2", "build-2"), true);
  assert.equal(mentionsNodeId("build-21", "build-2"), false);
  assert.equal(mentionsNodeId("(verify_b)", "verify_b"), true);
});

// ============================================================
// C —— evaluateCriticGate 纯函数（spec R6）
// ============================================================

const doneNode = (id, confidence) => ({
  ...(confidence ? { confidence } : {}),
  id,
  status: "completed",
});

test("C1: light 档——无 typed 数据（既有 run 形态）永远放行", () => {
  assert.deepStrictEqual(
    evaluateCriticGate({
      coverageTexts: ["All good, no gaps."],
      preset: "light",
      scope: [doneNode("build_a"), doneNode("verify_b")],
    }),
    [],
  );
});

test("C2: light 档唯一的轻量规则——low-confidence 未点名 → 拒绝；点名 → 放行", () => {
  const scope = [doneNode("build_a", "low"), doneNode("verify_b")];
  const rejected = evaluateCriticGate({
    coverageTexts: ["All good, no gaps."],
    preset: "light",
    scope,
  });
  assert.deepStrictEqual(rejected, [
    { kind: "unaddressed_low_confidence", nodeIds: ["build_a"] },
  ]);

  const accepted = evaluateCriticGate({
    coverageTexts: ["build_a was shaky; re-verified its risk list and accepted."],
    preset: "light",
    scope,
  });
  assert.deepStrictEqual(accepted, []);
});

test("C3: light 档不做覆盖/stale 检查（零回归边界）", () => {
  assert.deepStrictEqual(
    evaluateCriticGate({
      coverageTexts: ["fine"],
      preset: "light",
      scope: [doneNode("build_a"), { id: "pending_x", status: "pending" }],
    }),
    [],
  );
});

test("C4: deep 档橡皮图章——未点名全部 done 节点 → uncovered_siblings", () => {
  const issues = evaluateCriticGate({
    coverageTexts: ["All good, no gaps."],
    preset: "deep",
    scope: [doneNode("build_a", "high"), doneNode("verify_b", "medium")],
  });
  assert.deepStrictEqual(issues, [
    { kind: "uncovered_siblings", nodeIds: ["build_a", "verify_b"] },
  ]);
});

test("C5: deep 档点名齐全 → 放行；短 id 靠词边界防蒙混", () => {
  assert.deepStrictEqual(
    evaluateCriticGate({
      coverageTexts: ["build_a: ships. verify_b: tests pass."],
      preset: "deep",
      scope: [doneNode("build_a", "high"), doneNode("verify_b", "high")],
    }),
    [],
  );
  // 散文里没有独立 token 的 "a" 就不算点名 id "a"（词边界防短 id 误命中）
  const issues = evaluateCriticGate({
    coverageTexts: ["prose that mentions nothing precisely"],
    preset: "deep",
    scope: [doneNode("a", "high")],
  });
  assert.deepEqual(issues.map((issue) => issue.kind), ["uncovered_siblings"]);
});

test("C6: deep 档 stale scope——范围内存在非 done 节点 → 拒绝（most-specific first）", () => {
  const issues = evaluateCriticGate({
    coverageTexts: ["build_a: ok. drifting: unknown."],
    preset: "deep",
    scope: [doneNode("build_a", "high"), { id: "drifting", status: "active" }],
  });
  assert.equal(issues[0].kind, "stale_gate_scope");
  assert.deepEqual(issues[0].nodeIds, ["drifting"]);
});

test("C7: deep 档置信度债务优先于覆盖债务，且 low 未点名两档都拒绝", () => {
  const issues = evaluateCriticGate({
    coverageTexts: ["All good."],
    preset: "deep",
    scope: [doneNode("build_a", "low"), doneNode("verify_b", "high")],
  });
  assert.deepEqual(
    issues.map((issue) => issue.kind),
    ["unaddressed_low_confidence", "uncovered_siblings"],
  );
  assert.deepEqual(issues[0].nodeIds, ["build_a"]);
});

test("C8: 枚举封顶——范围 > cap 时只放宽 high-confidence 节点", () => {
  assert.equal(CRITIC_COVERAGE_ENUMERATION_CAP, 20);
  const scope = [];
  for (let index = 0; index < CRITIC_COVERAGE_ENUMERATION_CAP; index++) {
    scope.push(doneNode(`high_${index}`, "high"));
  }
  scope.push(doneNode("medium_x", "medium"));
  assert.equal(scope.length, CRITIC_COVERAGE_ENUMERATION_CAP + 1);

  // 只点名 medium_x：high 全豁免 → 放行
  assert.deepStrictEqual(
    evaluateCriticGate({ coverageTexts: ["medium_x: audited."], preset: "deep", scope }),
    [],
  );
  // 谁都不点名：medium 仍在钩上（严谨度不允许在最宽范围静默降级）
  const issues = evaluateCriticGate({ coverageTexts: ["all fine"], preset: "deep", scope });
  assert.deepStrictEqual(issues, [{ kind: "uncovered_siblings", nodeIds: ["medium_x"] }]);
});

test("C9: 审计范围与覆盖文本的机械化投影", () => {
  const snapshot = makeRunSnapshot({
    edges: [],
    nodes: [
      makeTaskNode("build_a", { status: "completed" }),
      makeTaskNode("verify_b", { status: "completed" }),
      WorkflowGraphNodeSchema.parse({ id: "phase:exec", kind: "phase", status: "completed", title: "Execute" }),
    ],
  });
  snapshot.activities = [
    {
      activityId: "act_1",
      artifactPath: "artifacts/exec/build_a.md",
      inputArtifactPaths: [],
      kind: "agent_session",
      nodeId: "build_a",
      outputArtifactPaths: ["artifacts/exec/build_a.md"],
      phase: "exec",
      startedAt: FIXED_NOW.toISOString(),
      status: "completed",
    },
  ];
  snapshot.artifacts = [
    {
      contentType: "text/markdown",
      createdAt: FIXED_NOW.toISOString(),
      label: "Build A",
      path: "artifacts/exec/build_a.md",
      phase: "exec",
      typed: { confidence: "low", evidence: [], findings: "f", openQuestions: [], whatINotChecked: ["x"] },
    },
  ];
  // phase 节点排除；confidence 经 activity → artifact 解析
  assert.deepStrictEqual(collectCriticAuditScope(snapshot), [
    { confidence: "low", id: "build_a", status: "completed" },
    { id: "verify_b", status: "completed" },
  ]);

  const critic = {
    acceptanceGaps: ["gap text"],
    reasoning: "verdict prose",
    reopenProposals: [{ nodeId: "verify_b", reason: "flaky" }],
    verdict: "pass",
  };
  assert.deepStrictEqual(collectCriticCoverageTexts(critic), [
    "verdict prose",
    "gap text",
    "verify_b: flaky",
  ]);
  // reopenProposal 的 nodeId 本身就是显式点名
  assert.deepStrictEqual(
    evaluateCriticGate({
      coverageTexts: collectCriticCoverageTexts(critic),
      preset: "light",
      scope: collectCriticAuditScope(snapshot),
    }),
    [{ kind: "unaddressed_low_confidence", nodeIds: ["build_a"] }],
  );
});

test("C10: 补充要求与 issue 描述携带缺失节点 id 清单", () => {
  const issues = [{ kind: "uncovered_siblings", nodeIds: ["build_a", "verify_b"] }];
  const request = buildCriticSupplementRequest(issues);
  assert.ok(request.includes("rejected your previous pass verdict"));
  assert.ok(request.includes("build_a, verify_b"));
  assert.ok(describeCriticGateIssues(issues).includes("build_a, verify_b"));
});

// ============================================================
// D —— typed artifact 提取 + artifact-or-nothing（spec R2-R4）
// ============================================================

test("D0: extractTypedArtifact——缺块 / 无效块 / 宽容归一化 / 末块生效", () => {
  assert.deepStrictEqual(extractTypedArtifact("plain markdown, no block"), { kind: "absent" });

  const invalidJson = extractTypedArtifact("text\n```acode-artifact\n{not json}\n```");
  assert.equal(invalidJson.kind, "invalid");

  const badConfidence = extractTypedArtifact(`text\n${typedBlock({ confidence: "nope" })}`);
  assert.equal(badConfidence.kind, "invalid");
  assert.ok(badConfidence.reasons.length > 0);

  // snake_case 别名 + confidence 大小写漂移
  const loose = extractTypedArtifact(
    `x\n${typedBlock({
      confidence: "HIGH",
      findings: "f",
      open_questions: ["q"],
      what_i_did_not_check: ["w"],
    })}`,
  );
  assert.equal(loose.kind, "valid");
  assert.equal(loose.typed.confidence, "high");
  assert.deepEqual(loose.typed.openQuestions, ["q"]);
  assert.deepEqual(loose.typed.whatINotChecked, ["w"]);

  // 多个块取最后一个（末态生效）
  const multi = extractTypedArtifact(
    `${typedBlock({ confidence: "low", findings: "first" })}\nnoise\n${typedBlock({ confidence: "high", findings: "second" })}`,
  );
  assert.equal(multi.kind, "valid");
  assert.equal(multi.typed.findings, "second");
});

test("D0b: validateDeepNodeArtifact——薄 artifact 三条必填规则", () => {
  assert.deepStrictEqual(validateDeepNodeArtifact(VALID_TYPED), []);
  const thin = validateDeepNodeArtifact({
    confidence: undefined,
    evidence: [],
    findings: "   ",
    openQuestions: [],
    whatINotChecked: [],
  });
  assert.equal(thin.length, 3);
  assert.ok(thin.some((reason) => reason.includes("findings")));
  assert.ok(thin.some((reason) => reason.includes("whatINotChecked")));
  assert.ok(thin.some((reason) => reason.includes("confidence")));
});

test("D0c: spec R2 登记的键别名逐条生效——含此前漏实现的 what_i_didnt_check", () => {
  // spec workflow-typed-artifacts.md R2 的别名登记表；实现必须与它同名同集。
  // 少一个别名的代价是具体的：deep 档提交该拼写时字段静默变空数组 → R3 判
  // 「must list whatINotChecked」→ 白烧一次 requeue，第二次直接 fail。
  const whatINotCheckedAliases = [
    "whatINotChecked",
    "what_i_not_checked",
    "what_i_did_not_check",
    "what_i_didnt_check",
    // camelCase 拼写由 loose-key 归一化（小写 + 去非字母数字）覆盖同一语义别名。
    "whatIDidNotCheck",
    "whatIDidntCheck",
  ];
  for (const key of whatINotCheckedAliases) {
    const result = extractTypedArtifact(
      `x\n${typedBlock({ confidence: "high", findings: "f", [key]: ["w"] })}`,
    );
    assert.equal(result.kind, "valid", key);
    assert.deepEqual(result.typed.whatINotChecked, ["w"], key);
    assert.deepEqual(validateDeepNodeArtifact(result.typed), [], key);
  }

  // 其余语义别名（R2 同一张表）。
  assert.equal(
    extractTypedArtifact(`x\n${typedBlock({ summary: "s" })}`).typed.findings,
    "s",
    "findings ← summary",
  );
  assert.deepEqual(
    extractTypedArtifact(`x\n${typedBlock({ references: ["r"] })}`).typed.evidence,
    ["r"],
    "evidence ← references",
  );
  assert.equal(
    extractTypedArtifact(`x\n${typedBlock({ verification: "v" })}`).typed.validation,
    "v",
    "validation ← verification",
  );
  assert.deepEqual(
    extractTypedArtifact(`x\n${typedBlock({ open_questions: ["q"] })}`).typed.openQuestions,
    ["q"],
    "openQuestions ← open_questions",
  );

  // 规范名优先于别名（readLooseValue 先按列出顺序做精确匹配）。
  const both = extractTypedArtifact(
    `x\n${typedBlock({
      findings: "canonical",
      summary: "alias",
      what_i_didnt_check: ["alias"],
      whatINotChecked: ["canonical"],
    })}`,
  );
  assert.equal(both.typed.findings, "canonical");
  assert.deepEqual(both.typed.whatINotChecked, ["canonical"]);

  // 负对照：未登记的相似拼写不会被猜成别名（交给 zod 剥离 → 默认空数组）。
  const unregistered = extractTypedArtifact(
    `x\n${typedBlock({ findings: "f", wat_i_not_checked: ["w"] })}`,
  );
  assert.equal(unregistered.kind, "valid");
  assert.deepEqual(unregistered.typed.whatINotChecked, []);
});

test("D1: deep 缺块 → requeue 一次（pending + 计数），第二次缺 → failed（封顶）", async () => {
  const harness = makeSchedulerHarness(() => "turn ended, forgot the artifact block");
  const scheduler = new WorkflowGraphScheduler(harness.deps);
  const result = await scheduler.run({
    artifactGate: DEEP_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });

  assert.equal(harness.runnerCalls.length, 2);
  const finalNode = harness.snapshots.at(-1).graph.nodes.find((node) => node.id === "n1");
  assert.equal(finalNode.status, "failed");
  assert.equal(finalNode.artifactRequeues, 2);
  assert.ok(finalNode.error.includes("Typed artifact rejected"));
  // requeue 不写产物、不新增事件枚举：复用 node_failed，payload 区分修复通道
  assert.equal(harness.artifactsWritten.length, 0);
  const failures = eventsOfType(harness.events, "node_failed");
  assert.equal(failures.length, 2);
  assert.deepEqual(failures[0].payload, { artifactRequeue: true, artifactRequeues: 1, retry: true });
  assert.deepEqual(failures[1].payload, { artifactRequeue: true, artifactRequeues: 2, retry: false });
  // 封顶后 fail 计入 consecutiveErrors；无可派发节点 → deadlock paused（既有语义）
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "deadlock");
  // 重派发的提示词携带上次引擎反馈（修复通道对模型可见）
  assert.ok(harness.runnerCalls[1].prompt.includes("Previous attempt feedback from the workflow engine"));
});

test("D2: deep 有效块 → completed，typed 段随 artifact 落 snapshot", async () => {
  const harness = makeSchedulerHarness(() => `did the work\n${typedBlock(VALID_TYPED)}`);
  const scheduler = new WorkflowGraphScheduler(harness.deps);
  const result = await scheduler.run({
    artifactGate: DEEP_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });

  assert.equal(result.status, "completed");
  assert.equal(harness.runnerCalls.length, 1);
  assert.equal(eventsOfType(harness.events, "node_failed").length, 0);
  const artifact = result.snapshot.artifacts.find((item) => item.label === "Task n1");
  assert.equal(artifact.typed.confidence, "high");
  assert.deepEqual(artifact.typed.evidence, ["src/a.ts:10"]);
});

test("D3: deep 薄 artifact（findings 空）→ requeue；补交合格块 → completed，计数保留", async () => {
  const harness = makeSchedulerHarness((_input, call) =>
    call === 1
      ? `work\n${typedBlock({ ...VALID_TYPED, findings: "" })}`
      : `work\n${typedBlock(VALID_TYPED)}`,
  );
  const scheduler = new WorkflowGraphScheduler(harness.deps);
  const result = await scheduler.run({
    artifactGate: DEEP_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });

  assert.equal(result.status, "completed");
  assert.equal(harness.runnerCalls.length, 2);
  const finalNode = result.snapshot.graph.nodes.find((node) => node.id === "n1");
  assert.equal(finalNode.status, "completed");
  assert.equal(finalNode.artifactRequeues, 1);
  const failure = eventsOfType(harness.events, "node_failed")[0];
  assert.ok(failure.message.includes("findings"));
});

test("D4: light 缺块 → 照常 completed（既有行为零回归）；有效块也接受并挂载", async () => {
  const plain = makeSchedulerHarness(() => "plain markdown artifact");
  const plainResult = await new WorkflowGraphScheduler(plain.deps).run({
    artifactGate: LIGHT_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });
  assert.equal(plainResult.status, "completed");
  assert.equal(eventsOfType(plain.events, "node_failed").length, 0);
  assert.equal(plainResult.snapshot.artifacts[0].typed, undefined);
  assert.ok(!plain.runnerCalls[0].prompt.includes("Typed artifact contract"));

  // 未声明 artifactGate（既有调用方形态）与 light 等价
  const absent = makeSchedulerHarness(() => "plain markdown artifact");
  const absentResult = await new WorkflowGraphScheduler(absent.deps).run({
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });
  assert.equal(absentResult.status, "completed");

  // light 也「接受并校验」：模型自愿提交的有效 typed 段照挂
  const typed = makeSchedulerHarness(
    () => `plain markdown\n${typedBlock({ ...VALID_TYPED, confidence: "low" })}`,
  );
  const typedResult = await new WorkflowGraphScheduler(typed.deps).run({
    artifactGate: LIGHT_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });
  assert.equal(typedResult.status, "completed");
  assert.equal(typedResult.snapshot.artifacts[0].typed.confidence, "low");
});

test("D5: deep 档 artifact-or-nothing 只约束 worker(task) 节点——回退派发的 phase 容器节点不被强制", async () => {
  // 前置事实（评审 J2 的链路第一环）：scheduled 阶段没有 task 节点时，
  // executableNodeIdsForPhase 回退派发 phase 容器节点。
  const definition = makeDeepDefinition();
  const deepExecDefinition = definition.phases.find((phase) => phase.phase === "exec");
  assert.equal(deepExecDefinition.behavior, "scheduled_graph");
  const phaseGraph = createPhaseGraph(definition);
  assert.deepEqual(executableNodeIdsForPhase(phaseGraph, "exec"), ["phase:exec"]);

  // 真实 run 里前序阶段已完成：createPhaseGraph 把 phase 节点串成链，
  // phase:exec 依赖 phase:meta_prompt，先把它标 completed 才可派发。
  const readyGraph = {
    ...phaseGraph,
    nodes: phaseGraph.nodes.map((node) =>
      node.kind === "phase" && node.phase !== "exec" ? { ...node, status: "completed" } : node,
    ),
  };
  const baseSnapshot = makeRunSnapshot(readyGraph, {
    phaseOrder: definition.phaseOrder,
    phases: definition.phaseOrder.map((phase) => ({ phase, status: "pending" })),
    runId: "wf_test_phase_node",
  });
  const buildPrompt = ({ node, snapshot }) =>
    buildScheduledNodePrompt(snapshot, deepExecDefinition, node, DEEP_GATE);

  // 该分支提示词永远不含 typed 契约段与 requeue 反馈段（deep 契约只在 behavior==="critic"
  // 的 buildPhasePrompt 分支追加）——这正是「强制但不告知」的死路成因，钉住因果。
  const phasePrompt = buildPrompt({
    node: readyGraph.nodes.find((n) => n.id === "phase:exec"),
    snapshot: baseSnapshot,
  });
  assert.ok(!phasePrompt.includes("Typed artifact contract"));
  assert.ok(!phasePrompt.includes(TYPED_ARTIFACT_FENCE));
  const taskPrompt = buildScheduledNodePrompt(
    baseSnapshot,
    deepExecDefinition,
    makeTaskNode("t1"),
    DEEP_GATE,
  );
  assert.ok(taskPrompt.includes("Typed artifact contract"));

  // deep 档派发 phase 容器节点：照常完成，不 requeue、不 fail。
  const harness = makeSchedulerHarness(() => "phase-level notes in plain markdown");
  const result = await new WorkflowGraphScheduler(harness.deps).run({
    artifactGate: DEEP_GATE,
    buildPrompt,
    cwd: "/repo",
    executableNodeIds: executableNodeIdsForPhase(readyGraph, "exec"),
    phase: "exec",
    snapshot: baseSnapshot,
  });
  assert.equal(result.status, "completed");
  assert.equal(harness.runnerCalls.length, 1);
  assert.equal(eventsOfType(harness.events, "node_failed").length, 0);
  const phaseNode = harness.snapshots.at(-1).graph.nodes.find((node) => node.id === "phase:exec");
  assert.equal(phaseNode.status, "completed");
  assert.equal(phaseNode.artifactRequeues, undefined);

  // 对照：同一 gate、同一 responder 下 task 节点仍然强制（没有全局关掉 artifact-or-nothing）。
  const taskHarness = makeSchedulerHarness(() => "phase-level notes in plain markdown");
  const taskResult = await new WorkflowGraphScheduler(taskHarness.deps).run({
    artifactGate: DEEP_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });
  assert.equal(taskHarness.runnerCalls.length, 2);
  assert.equal(
    taskHarness.snapshots.at(-1).graph.nodes.find((node) => node.id === "n1").status,
    "failed",
  );
  assert.equal(taskResult.status, "paused");

  // 提取与强制解耦：phase 节点自愿交了合格 typed 块，照样挂载到 artifact（数据不浪费）。
  const typedHarness = makeSchedulerHarness(() => `phase notes\n${typedBlock(VALID_TYPED)}`);
  const typedResult = await new WorkflowGraphScheduler(typedHarness.deps).run({
    artifactGate: DEEP_GATE,
    buildPrompt,
    cwd: "/repo",
    executableNodeIds: executableNodeIdsForPhase(readyGraph, "exec"),
    phase: "exec",
    snapshot: baseSnapshot,
  });
  assert.equal(typedResult.status, "completed");
  assert.equal(typedResult.snapshot.artifacts[0].typed.confidence, "high");
});

test("D6: 超限 typed 块（F-4/R1）——deep 按 invalid 走 artifact-or-nothing；light 整块忽略照常 completed", async () => {
  const oversized = typedBlock({
    ...VALID_TYPED,
    findings: "x".repeat(WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH + 1),
  });

  // deep：超限块 = R2 invalid → 第一次 requeue（修复通道），第二次合格块 → completed
  const deep = makeSchedulerHarness((_input, call) =>
    call === 1 ? `work\n${oversized}` : `work\n${typedBlock(VALID_TYPED)}`,
  );
  const deepResult = await new WorkflowGraphScheduler(deep.deps).run({
    artifactGate: DEEP_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });
  assert.equal(deepResult.status, "completed");
  assert.equal(deep.runnerCalls.length, 2);
  const deepNode = deepResult.snapshot.graph.nodes.find((node) => node.id === "n1");
  assert.equal(deepNode.status, "completed");
  assert.equal(deepNode.artifactRequeues, 1);
  const failure = eventsOfType(deep.events, "node_failed")[0];
  assert.ok(failure.message.includes("Typed artifact rejected"));
  assert.deepEqual(failure.payload, { artifactRequeue: true, artifactRequeues: 1, retry: true });

  // light：超限块忽略（零回归语义），单轮完成、无 node_failed、无 typed 挂载
  const light = makeSchedulerHarness(() => `work\n${oversized}`);
  const lightResult = await new WorkflowGraphScheduler(light.deps).run({
    artifactGate: LIGHT_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });
  assert.equal(lightResult.status, "completed");
  assert.equal(light.runnerCalls.length, 1);
  assert.equal(eventsOfType(light.events, "node_failed").length, 0);
  assert.equal(lightResult.snapshot.artifacts[0].typed, undefined);
});

test("D7: confidence 非枚举自由文本（F-2/R2 登记的后果钉住）——deep 整块 invalid → requeue；light 块忽略", async () => {
  // 「sloppy 但诚实的 low 自报」写成自由文本 → 只做 trim+小写归一，zod 拒绝 → 整块 invalid。
  // 不实现宽容解析（spec R2：映射规则不可审计前宁可拒绝），本测试钉住该取舍的后果。
  const sloppy = typedBlock({ ...VALID_TYPED, confidence: "pretty confident" });

  const deep = makeSchedulerHarness((_input, call) =>
    call === 1 ? `work\n${sloppy}` : `work\n${typedBlock(VALID_TYPED)}`,
  );
  const deepResult = await new WorkflowGraphScheduler(deep.deps).run({
    artifactGate: DEEP_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });
  assert.equal(deepResult.status, "completed");
  assert.equal(deep.runnerCalls.length, 2);
  const deepNode = deepResult.snapshot.graph.nodes.find((node) => node.id === "n1");
  assert.equal(deepNode.status, "completed");
  assert.equal(deepNode.artifactRequeues, 1);
  assert.ok(
    eventsOfType(deep.events, "node_failed")[0].message.includes("confidence"),
    "requeue 反馈应指出 confidence 违规",
  );

  const light = makeSchedulerHarness(() => `work\n${sloppy}`);
  const lightResult = await new WorkflowGraphScheduler(light.deps).run({
    artifactGate: LIGHT_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] }),
  });
  assert.equal(lightResult.status, "completed");
  assert.equal(light.runnerCalls.length, 1);
  assert.equal(eventsOfType(light.events, "node_failed").length, 0);
  assert.equal(lightResult.snapshot.artifacts[0].typed, undefined);
});

// ============================================================
// E —— critic-loop / 八阶段全流程（spec R6-R8）
// ============================================================

test("E1: light 档八阶段端到端——橡皮图章 pass 照过，事件序列与现状一致（零回归钉住）", async () => {
  const store = makeStoreHarness();
  const { prompts, runtime } = makeRuntime(store, (input) => {
    switch (input.phase) {
      case "arch_decompose":
        return SEED_RESPONSE;
      case "exec":
        return input.prompt.includes("Node id: build_a")
          ? "build_a done: changed src/a.ts"
          : "verify_b done: ran focused tests";
      case "final_critic":
        return RUBBER_PASS;
      default:
        return `${input.phase} notes`;
    }
  }, createExpertWorkflowDefinition());

  const result = await runtime.start({ cwd: "/repo", task: "ship it" });

  assert.equal(result.status, "completed");
  const types = store.events.map((event) => event.type);
  assert.equal(eventsOfType(store.events, "critic_passed").length, 1);
  assert.equal(eventsOfType(store.events, "critic_failed").length, 0);
  assert.equal(eventsOfType(store.events, "node_failed").length, 0);
  assert.equal(eventsOfType(store.events, "node_reopened").length, 0);
  assert.equal(eventsOfType(store.events, "critic_started").length, 1);
  assert.ok(types.includes("run_started"));
  assert.ok(types.includes("graph_expanded"));
  assert.ok(types.includes("executor_completed"));
  assert.ok(types.includes("run_completed"));

  const snapshot = store.snapshots.get("wf_test_e2e");
  assert.deepStrictEqual(
    snapshot.phases.map((phase) => [phase.phase, phase.status]),
    [
      ["clarify", "completed"],
      ["task_analysis", "completed"],
      ["arch_decompose", "completed"],
      ["env_setup", "completed"],
      ["meta_prompt", "completed"],
      ["exec", "completed"],
      ["final_critic", "completed"],
      ["complete", "completed"],
    ],
  );

  // light 档提示词零回归：exec 节点与 critic 提示词都不含 deep 契约段
  assert.equal(nodePromptFor(prompts, "build_a").length, 1);
  assert.ok(prompts.every((entry) => !entry.prompt.includes("Typed artifact contract")));
  assert.ok(prompts.every((entry) => !entry.prompt.includes("Critic gate contract")));
  assert.ok(prompts.every((entry) => !entry.prompt.includes(TYPED_ARTIFACT_FENCE)));
});

test("E2: light 档 low-confidence 未处理 → pass 被拒，节点 reopen 路由后续工作，第二轮点名通过", async () => {
  const store = makeStoreHarness();
  const buildACalls = { count: 0 };
  const criticCalls = { count: 0 };
  const { runtime } = makeRuntime(store, (input) => {
    switch (input.phase) {
      case "arch_decompose":
        return SEED_RESPONSE;
      case "exec": {
        if (input.prompt.includes("Node id: build_a")) {
          buildACalls.count += 1;
          const confidence = buildACalls.count === 1 ? "low" : "high";
          return `build_a attempt ${buildACalls.count}\n${typedBlock({ ...VALID_TYPED, confidence })}`;
        }
        return `verify_b done\n${typedBlock(VALID_TYPED)}`;
      }
      case "final_critic":
        criticCalls.count += 1;
        return criticCalls.count === 1 ? RUBBER_PASS : NAMING_PASS;
      default:
        return `${input.phase} notes`;
    }
  }, createExpertWorkflowDefinition());

  const result = await runtime.start({ cwd: "/repo", task: "ship it" });

  assert.equal(result.status, "completed");
  // pass 被拒：critic_failed 携带 gateIssues（置信度债务），light 档唯一的轻量规则
  const criticFailed = eventsOfType(store.events, "critic_failed");
  assert.equal(criticFailed.length, 1);
  assert.equal(criticFailed[0].payload.preset, "light");
  assert.deepStrictEqual(criticFailed[0].payload.gateIssues, [
    { kind: "unaddressed_low_confidence", nodeIds: ["build_a"] },
  ]);
  assert.ok(criticFailed[0].message.includes("rejected by the light gate"));
  // 路由后续工作：reopen build_a → exec 重跑（第二次提交 confidence high）
  const reopened = eventsOfType(store.events, "node_reopened");
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].nodeId, "build_a");
  assert.equal(buildACalls.count, 2);
  assert.equal(eventsOfType(store.events, "critic_started").length, 2);
  assert.equal(eventsOfType(store.events, "critic_passed").length, 1);
});

test("E3: deep 档橡皮图章 → 拒绝 + 补充要求重跑 critic，第二轮点名齐全 → 通过", async () => {
  const store = makeStoreHarness();
  const criticPrompts = [];
  const { prompts, runtime } = makeRuntime(store, (input) => {
    switch (input.phase) {
      case "arch_decompose":
        return SEED_RESPONSE;
      case "exec":
        return input.prompt.includes("Node id: build_a")
          ? `build_a done\n${typedBlock(VALID_TYPED)}`
          : `verify_b done\n${typedBlock(VALID_TYPED)}`;
      case "final_critic": {
        criticPrompts.push(input.prompt);
        return input.prompt.includes("rejected your previous pass verdict")
          ? NAMING_PASS
          : RUBBER_PASS;
      }
      default:
        return `${input.phase} notes`;
    }
  }, makeDeepDefinition());

  const result = await runtime.start({ cwd: "/repo", task: "ship it" });

  assert.equal(result.status, "completed");
  // deep 节点提示词携带 typed artifact 契约
  assert.ok(nodePromptFor(prompts, "build_a")[0].prompt.includes("Typed artifact contract (deep gate)"));
  // 第一轮 critic 提示词携带点名契约与 done 节点清单
  assert.ok(criticPrompts[0].includes("Critic gate contract (deep)"));
  assert.ok(criticPrompts[0].includes("- build_a [completed confidence=high]"));
  assert.ok(criticPrompts[0].includes("- verify_b [completed confidence=high]"));
  // 橡皮图章被拒：critic_failed 携带 uncovered_siblings；不 reopen 节点（薄的是审计不是工作）
  const criticFailed = eventsOfType(store.events, "critic_failed");
  assert.equal(criticFailed.length, 1);
  assert.equal(criticFailed[0].payload.preset, "deep");
  assert.deepStrictEqual(criticFailed[0].payload.gateIssues, [
    { kind: "uncovered_siblings", nodeIds: ["build_a", "verify_b"] },
  ]);
  assert.equal(eventsOfType(store.events, "node_reopened").length, 0);
  // 补充要求注入第二轮提示词（拒绝并要求补充的引擎侧通道）
  assert.equal(criticPrompts.length, 2);
  assert.ok(criticPrompts[1].includes("rejected your previous pass verdict"));
  assert.ok(criticPrompts[1].includes("build_a, verify_b"));
  assert.equal(criticPrompts[1].includes("Critic gate contract (deep)"), true);
  assert.equal(eventsOfType(store.events, "critic_started").length, 2);
  assert.equal(eventsOfType(store.events, "critic_passed").length, 1);
});

test("E4: deep 档 low-confidence 未被 critic 处理 → gate 不通过，优先走 reopen 路由", async () => {
  const store = makeStoreHarness();
  const buildACalls = { count: 0 };
  const criticCalls = { count: 0 };
  const { runtime } = makeRuntime(store, (input) => {
    switch (input.phase) {
      case "arch_decompose":
        return SEED_RESPONSE;
      case "exec": {
        if (input.prompt.includes("Node id: build_a")) {
          buildACalls.count += 1;
          const confidence = buildACalls.count === 1 ? "low" : "high";
          return `build_a attempt ${buildACalls.count}\n${typedBlock({ ...VALID_TYPED, confidence })}`;
        }
        return `verify_b done\n${typedBlock(VALID_TYPED)}`;
      }
      case "final_critic":
        criticCalls.count += 1;
        return criticCalls.count === 1 ? RUBBER_PASS : NAMING_PASS;
      default:
        return `${input.phase} notes`;
    }
  }, makeDeepDefinition());

  const result = await runtime.start({ cwd: "/repo", task: "ship it" });

  assert.equal(result.status, "completed");
  const criticFailed = eventsOfType(store.events, "critic_failed");
  assert.equal(criticFailed.length, 1);
  const kinds = criticFailed[0].payload.gateIssues.map((issue) => issue.kind);
  // 置信度债务 + 覆盖债务同时在场；most-specific first → reopen 路由优先于补充要求
  assert.deepStrictEqual(kinds, ["unaddressed_low_confidence", "uncovered_siblings"]);
  const reopened = eventsOfType(store.events, "node_reopened");
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].nodeId, "build_a");
  assert.equal(buildACalls.count, 2);
  assert.equal(eventsOfType(store.events, "critic_passed").length, 1);
});

test("E5: deep 档持续橡皮图章 → maxIterations 封顶，critic phase failed（不死循环）", async () => {
  const store = makeStoreHarness();
  const { runtime } = makeRuntime(store, (input) => {
    switch (input.phase) {
      case "arch_decompose":
        return SEED_RESPONSE;
      case "exec":
        return `done\n${typedBlock(VALID_TYPED)}`;
      case "final_critic":
        return RUBBER_PASS;
      default:
        return `${input.phase} notes`;
    }
  }, makeDeepDefinition());

  await runtime.start({ cwd: "/repo", task: "ship it" });

  assert.equal(
    eventsOfType(store.events, "critic_started").length,
    DEFAULT_EXPERT_WORKFLOW_STRATEGY.finalCritic.maxIterations,
  );
  assert.equal(eventsOfType(store.events, "critic_iteration_limit_reached").length, 1);
  assert.equal(eventsOfType(store.events, "critic_passed").length, 0);
  const snapshot = store.snapshots.get("wf_test_e2e");
  const criticPhase = snapshot.phases.find((phase) => phase.phase === "final_critic");
  assert.equal(criticPhase.status, "failed");
});

test("E6: deep 档 scheduled 阶段无 task 节点（arch_decompose 未产出可解析图）→ run 照常完成，不停在 scheduler paused", async () => {
  // 评审 J2 的端到端形态：deep definition + exec 阶段回退派发 phase 容器节点。
  // 修复前该分支提示词无契约段却被强制 → requeue 一次 → fail → runScheduledPhase throw
  // 「scheduler paused」→ 整个 run paused（light 档同场景照常完成）。
  const responder = (input) => {
    switch (input.phase) {
      case "arch_decompose":
        // 模型这一轮没给出可解析的图（纯 markdown）→ seedGraphFromPhaseArtifact 原样返回
        // → exec 阶段没有 task 节点 → executableNodeIdsForPhase 回退派发 phase:exec。
        return "I thought about the architecture but produced no JSON graph this round.";
      case "final_critic":
        return RUBBER_PASS;
      default:
        return `${input.phase} notes: did the work and wrote markdown.`;
    }
  };

  const deepStore = makeStoreHarness();
  const { prompts: deepPrompts, runtime: deepRuntime } = makeRuntime(
    deepStore,
    responder,
    makeDeepDefinition(),
  );
  const deepResult = await deepRuntime.start({ cwd: "/repo", task: "ship it" });
  assert.equal(deepResult.status, "completed");
  const deepSnapshot = deepStore.snapshots.get("wf_test_e2e");
  assert.equal(deepSnapshot.phases.find((phase) => phase.phase === "exec").status, "completed");
  const deepPhaseNode = deepSnapshot.graph.nodes.find((node) => node.id === "phase:exec");
  assert.equal(deepPhaseNode.status, "completed");
  assert.equal(deepPhaseNode.artifactRequeues, undefined);
  assert.equal(eventsOfType(deepStore.events, "node_failed").length, 0);
  assert.equal(eventsOfType(deepStore.events, "graph_expanded").length, 0);
  // 回退派发确实发生：exec 阶段只跑了一轮，且提示词是 phase 提示词（无 typed 契约段）。
  const deepExecPrompts = deepPrompts.filter((entry) => entry.phase === "exec");
  assert.equal(deepExecPrompts.length, 1);
  assert.ok(deepExecPrompts[0].prompt.includes("You are running the ACode workflow phase: exec."));
  assert.ok(!deepExecPrompts[0].prompt.includes("Typed artifact contract"));

  // 对照：light 档同一场景（既有行为）同样完成——本次修复没有改变 light 语义。
  const lightStore = makeStoreHarness();
  const { runtime: lightRuntime } = makeRuntime(
    lightStore,
    responder,
    createExpertWorkflowDefinition(),
  );
  const lightResult = await lightRuntime.start({ cwd: "/repo", task: "ship it" });
  assert.equal(lightResult.status, "completed");
  assert.equal(eventsOfType(lightStore.events, "node_failed").length, 0);

  // 对照：deep 档 + 正常 seed 出 task 节点时，worker 强制照旧生效（没有整体放松）。
  const seededStore = makeStoreHarness();
  const { runtime: seededRuntime } = makeRuntime(
    seededStore,
    (input) => {
      switch (input.phase) {
        case "arch_decompose":
          return SEED_RESPONSE;
        case "final_critic":
          return NAMING_PASS;
        default:
          return `${input.phase} notes`;
      }
    },
    makeDeepDefinition(),
  );
  await seededRuntime.start({ cwd: "/repo", task: "ship it" });
  const seededSnapshot = seededStore.snapshots.get("wf_test_e2e");
  const seededTask = seededSnapshot.graph.nodes.find((node) => node.id === "build_a");
  assert.equal(seededTask.status, "failed");
  assert.equal(seededTask.artifactRequeues, 2);
});

// ============================================================
// F —— 提示词分档回归（spec R8）
// ============================================================

const promptSnapshot = makeRunSnapshot({ edges: [], nodes: [makeTaskNode("n1")] });
const promptNode = promptSnapshot.graph.nodes[0];
const execDefinition = createExpertWorkflowDefinition().phases.find(
  (phase) => phase.phase === "exec",
);
const criticDefinition = createExpertWorkflowDefinition().phases.find(
  (phase) => phase.phase === "final_critic",
);

test("F1: light 档 golden 快照——buildDefaultNodePrompt 与现状逐字节一致", () => {
  assert.equal(
    buildDefaultNodePrompt(promptSnapshot, promptNode, "exec"),
    [
      "You are running a ACode workflow node for phase: exec.",
      "Workflow run: wf_test_run",
      "Working directory: /repo",
      "",
      "User task:",
      "ship it",
      "",
      "Node: Task n1",
      "Node id: n1",
      "",
      "No previous artifacts yet.",
      "",
      "Execute only this node's scope. Return a concise Markdown artifact with changes, validation, and residual risk.",
    ].join("\n"),
  );
});

test("F2: light 档 golden 快照——buildScheduledNodePrompt 与现状逐字节一致", () => {
  assert.equal(
    buildScheduledNodePrompt(promptSnapshot, execDefinition, promptNode),
    [
      "You are running a ACode workflow node inside phase: exec.",
      "Workflow run: wf_test_run",
      "Working directory: /repo",
      "",
      "User task:",
      "ship it",
      "",
      "Node: Task n1",
      "Node id: n1",
      "",
      "Scheduling constraints:",
      "- Max concurrent loops: 2",
      "- React loop max rounds: 30",
      "",
      "No previous artifacts yet.",
      "",
      "Execute only this node's scope. Return a concise Markdown artifact with changes, validation, and residual risk.",
    ].join("\n"),
  );
});

test("F3: light 档 golden 快照——buildPhasePrompt（critic 阶段）与现状逐字节一致", () => {
  assert.equal(
    buildPhasePrompt(promptSnapshot, criticDefinition),
    [
      "You are running the ACode workflow phase: final_critic.",
      "Workflow run: wf_test_run",
      "Working directory: /repo",
      "",
      "User task:",
      "ship it",
      "",
      "Scheduling strategy:",
      "- Clarify max rounds: 3, min rounds: 1, confidence threshold: 0.8",
      "- Executor frontier target: 3, max concurrent loops: 2, max planner runs: 10",
      "- React loop max rounds: 30",
      "- Final critic max iterations: 3",
      "",
      "Phase objective:",
      "Review results against acceptance criteria, identify regressions, missing tests, and residual risk.",
      "",
      "No previous artifacts yet.",
      "",
      "Output a concise Markdown artifact for this phase. Preserve concrete file paths, commands, risks, and next actions. If this phase executes code, make the edits and run focused validation when practical.",
    ].join("\n"),
  );
});

test("F4: light gate 显式传入与缺省等价（三个 builder 字节一致）", () => {
  assert.equal(
    buildDefaultNodePrompt(promptSnapshot, promptNode, "exec"),
    buildDefaultNodePrompt(promptSnapshot, promptNode, "exec", LIGHT_GATE),
  );
  assert.equal(
    buildScheduledNodePrompt(promptSnapshot, execDefinition, promptNode),
    buildScheduledNodePrompt(promptSnapshot, execDefinition, promptNode, LIGHT_GATE),
  );
  assert.equal(
    buildPhasePrompt(promptSnapshot, criticDefinition),
    buildPhasePrompt(promptSnapshot, criticDefinition, { gate: LIGHT_GATE }),
  );
});

test("F5: deep 档追加段是纯追加——前缀与 light 逐字节一致，契约/反馈/补充要求在场", () => {
  const lightNodePrompt = buildScheduledNodePrompt(promptSnapshot, execDefinition, promptNode);
  const deepNodePrompt = buildScheduledNodePrompt(promptSnapshot, execDefinition, promptNode, DEEP_GATE);
  assert.ok(deepNodePrompt.startsWith(lightNodePrompt));
  assert.ok(deepNodePrompt.includes("Typed artifact contract (deep gate)"));
  assert.ok(deepNodePrompt.includes(`\`\`\`${TYPED_ARTIFACT_FENCE}`));

  // requeue 反馈：artifactRequeues > 0 且 error 在场（deep 专属）
  const requeuedNode = { ...promptNode, artifactRequeues: 1, error: "Typed artifact rejected: missing findings" };
  const feedbackPrompt = buildScheduledNodePrompt(promptSnapshot, execDefinition, requeuedNode, DEEP_GATE);
  assert.ok(feedbackPrompt.includes("Previous attempt feedback from the workflow engine"));
  assert.ok(feedbackPrompt.includes("missing findings"));
  // light 档不追加反馈（零回归）
  assert.equal(
    buildScheduledNodePrompt(promptSnapshot, execDefinition, requeuedNode),
    buildScheduledNodePrompt(promptSnapshot, execDefinition, requeuedNode, LIGHT_GATE),
  );

  const lightCriticPrompt = buildPhasePrompt(promptSnapshot, criticDefinition);
  const deepCriticPrompt = buildPhasePrompt(promptSnapshot, criticDefinition, { gate: DEEP_GATE });
  assert.ok(deepCriticPrompt.startsWith(lightCriticPrompt));
  assert.ok(deepCriticPrompt.includes("Critic gate contract (deep)"));
  assert.ok(deepCriticPrompt.includes("(no done task nodes)"));

  const supplemented = buildPhasePrompt(promptSnapshot, criticDefinition, {
    gate: DEEP_GATE,
    supplementRequest: "NAME EVERY NODE",
  });
  assert.ok(supplemented.startsWith(deepCriticPrompt));
  assert.ok(supplemented.endsWith("NAME EVERY NODE"));

  // 非 critic 阶段（agent phase）deep 档也不追加 critic 契约
  const clarifyDefinition = createExpertWorkflowDefinition().phases.find(
    (phase) => phase.phase === "clarify",
  );
  assert.equal(
    buildPhasePrompt(promptSnapshot, clarifyDefinition, { gate: DEEP_GATE }),
    buildPhasePrompt(promptSnapshot, clarifyDefinition),
  );
});

test("F6: deepCriticPromptLines 列出 done 节点与 confidence，pending/phase 节点不入清单", () => {
  const snapshot = makeRunSnapshot({
    edges: [],
    nodes: [
      makeTaskNode("build_a", { status: "completed" }),
      makeTaskNode("drifting", { status: "pending" }),
      WorkflowGraphNodeSchema.parse({ id: "phase:exec", kind: "phase", status: "completed", title: "Execute" }),
    ],
  });
  snapshot.activities = [
    {
      activityId: "act_1",
      artifactPath: "artifacts/exec/build_a.md",
      inputArtifactPaths: [],
      kind: "agent_session",
      nodeId: "build_a",
      outputArtifactPaths: ["artifacts/exec/build_a.md"],
      phase: "exec",
      startedAt: FIXED_NOW.toISOString(),
      status: "completed",
    },
  ];
  snapshot.artifacts = [
    {
      contentType: "text/markdown",
      createdAt: FIXED_NOW.toISOString(),
      label: "Build A",
      path: "artifacts/exec/build_a.md",
      typed: { confidence: "low", evidence: [], findings: "f", openQuestions: [], whatINotChecked: ["x"] },
    },
  ];
  const lines = deepCriticPromptLines(snapshot).join("\n");
  assert.ok(lines.includes("- build_a [completed confidence=low]"));
  assert.ok(!lines.includes("drifting"));
  assert.ok(!lines.includes("phase:exec"));
  assert.ok(lines.includes("confidence=low must be explicitly addressed") || lines.includes("must be explicitly addressed"));
});

test("F7: typed 契约段自述后果——requeue 一次、再犯 fail", () => {
  const contract = typedArtifactContractLines().join("\n");
  assert.ok(contract.includes("requeues this node once"));
  assert.ok(contract.includes("second miss fails it"));
  assert.ok(contract.includes("whatINotChecked"));
});

// ============================================================
// G —— planner 输出空白 id 防护（spec R11 / 对抗复核 F-1）
// ============================================================

// 缺陷链（对抗复核实证）：schema 仅 z.string() 时 {"nodes":[{"id":"","title":"x"}]} 直接通过
// direct 解析进图 → deep 档 mentionsNodeId(text, "") 恒 false → 任意 coverageTexts 都
// uncovered_siblings → critic 永不 pass → maxIterations 耗尽 failed（确定性死路）。
// 修复 = schema trim+min(1) + 解析点 fail-loud（错误沿 planner_failed 事件可见）。

const BLANK_ID_PLANNER_RESPONSE = JSON.stringify({ nodes: [{ id: "", title: "x" }] });

function makePlannerHarness(plannerResponse, nodeResponder) {
  const harness = makeSchedulerHarness(nodeResponder);
  const plannerCalls = [];
  harness.deps.plannerRunner = {
    run: async (input) => {
      plannerCalls.push(input);
      const response = plannerResponse(plannerCalls.length, input);
      // 与生产 scheduled-phase.ts 的 plannerRunner 同构：runner 文本 → parseWorkflowPlannerResult
      const plannerResult = parseWorkflowPlannerResult(response, "exec");
      return { ...plannerResult, response, sessionId: `planner_sess_${plannerCalls.length}` };
    },
  };
  return { ...harness, plannerCalls };
}

test("G1: parseWorkflowPlannerResult 对空白节点 id 解析报错（fail-loud，对抗复核原版探针）", () => {
  // 对抗复核原版探针输入：{"nodes":[{"id":"","title":"x"}]} —— 修复前 direct 解析成功进图。
  assert.throws(
    () => parseWorkflowPlannerResult(BLANK_ID_PLANNER_RESPONSE, "exec"),
    /blank node id at nodes\[0\]/,
  );
  // 空白字符串 id 同拒
  assert.throws(
    () => parseWorkflowPlannerResult(JSON.stringify({ nodes: [{ id: "  ", title: "x" }] }), "exec"),
    /blank node id/,
  );
  // 合法节点混空白 id：必须整体报错而不是静默滤掉空白节点（否则缺陷只是换成「静默蒸发」）
  assert.throws(
    () =>
      parseWorkflowPlannerResult(
        JSON.stringify({ nodes: [{ id: "good", title: "g" }, { id: "", title: "x" }] }),
        "exec",
      ),
    /blank node id at nodes\[1\]/,
  );
  // 宽松键（name / newNodes）同样在探测范围（与 seed 归一化键集一致）
  assert.throws(
    () =>
      parseWorkflowPlannerResult(
        JSON.stringify({ newNodes: [{ name: "", title: "x" }] }),
        "exec",
      ),
    /blank node id/,
  );
  // id 键整体缺失仍走既有宽容归一化（乱入 junk 对象，spec R11 边界：不在本条范围）
  const junk = parseWorkflowPlannerResult(
    JSON.stringify({ nodes: [{ title: "no id here" }, { id: "real", title: "R" }] }),
    "exec",
  );
  assert.deepEqual(
    junk.nodes.map((node) => node.id),
    ["real"],
  );
});

test("G2: schema 层空白 id 被拒、两侧空白被 trim（R11，seed schema 复用同一节点 schema）", () => {
  assert.equal(WorkflowGraphPlannerNodeSchema.safeParse({ id: "", title: "x" }).success, false);
  assert.equal(WorkflowGraphPlannerNodeSchema.safeParse({ id: "   ", title: "x" }).success, false);
  assert.equal(WorkflowGraphPlannerResultSchema.safeParse({ nodes: [{ id: "", title: "x" }] }).success, false);
  assert.equal(WorkflowGraphSeedSchema.safeParse({ nodes: [{ id: "", title: "x" }] }).success, false);
  // " abc " trim 为 "abc" 入图——与 seed 路径 stringValue 同口径，id 身份稳定
  assert.equal(
    WorkflowGraphPlannerNodeSchema.parse({ id: "  abc  ", title: "t" }).id,
    "abc",
  );
  // 持久化节点 schema 不受影响：历史数据（含宽松 id）解析不变（消费面核查结论，spec R11）
  assert.equal(
    WorkflowGraphNodeSchema.safeParse({ dependsOn: [], id: "", kind: "task", status: "pending", title: "T" }).success,
    true,
  );
});

test("G3: applyPlannerExpansion 对含空白 id 的扩张抛可读错误（ZodError 包装）", () => {
  const snapshot = makePlannerFailureSnapshot();
  const collection = {
    analyzedNodeIds: [],
    collectionId: "c1",
    errorCount: 0,
    exhausted: false,
    explorable: true,
    nodeIds: ["n1"],
    plannerRuns: 0,
    status: "active",
  };
  assert.throws(
    () =>
      applyPlannerExpansion(
        snapshot,
        collection,
        { edges: [], nodes: [{ id: "", title: "x" }] },
        [],
        FIXED_NOW.toISOString(),
      ),
    /Planner returned an invalid graph expansion/,
  );
});

// planner 扩张的 n2 依赖 seed：串行执行，避开 node-runner 并发完成路径的既有
// 「快照写并发窗口」债务（spec 边界节登记的独立后续项，本项不修 scheduler 并发语义）。
function makePlannerFailureSnapshot() {
  // 只有 collection 内一个已完成节点：planner 触发时没有 in-flight 节点，也无可派发节点。
  // 这是有意的——planner 与 in-flight 节点重叠时会命中 node-runner/scheduler 既有的
  // 「快照写并发窗口」债务（spec 边界节登记的独立后续项，本项不修 scheduler 并发语义）。
  return makeRunSnapshot({
    collections: [{ collectionId: "c1", explorable: true, nodeIds: ["n1"] }],
    edges: [],
    nodes: [makeTaskNode("n1", { collectionId: "c1", status: "completed" })],
  });
}

test("G4: E2E deep——collection planner 回空白 id → planner_failed 事件可见，空白节点从未进图；resume 后正常扩张跑完", async () => {
  // 第一段：空白 id 输出 → 解析报错沿既有 planner_failed 事件可见，无空白节点入图。
  const failing = makePlannerHarness(
    () => BLANK_ID_PLANNER_RESPONSE,
    () => `work\n${typedBlock(VALID_TYPED)}`,
  );
  const failed = await new WorkflowGraphScheduler(failing.deps).run({
    artifactGate: DEEP_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makePlannerFailureSnapshot(),
  });
  // 无可派发节点 → 既有 deadlock paused 语义（planner_failed + 暂停 = fail-loud，非静默）
  assert.equal(failed.status, "paused");
  assert.equal(failed.reason, "deadlock");
  const plannerFailures = eventsOfType(failing.events, "planner_failed");
  assert.equal(plannerFailures.length, 1);
  assert.ok(plannerFailures[0].message.includes("blank node id"));
  assert.equal(plannerFailures[0].payload.collectionId, "c1");
  assert.equal(plannerFailures[0].payload.errorCount, 1);
  // 空白节点从未进图：所有落盘 snapshot 与终态图的节点 id 都 trim 后非空
  for (const snapshot of failing.snapshots) {
    for (const node of snapshot.graph.nodes) {
      assert.ok(node.id.trim().length > 0, `blank id leaked into graph: ${JSON.stringify(node.id)}`);
    }
  }
  assert.deepEqual(
    failed.snapshot.graph.nodes.map((node) => node.id),
    ["n1"],
  );

  // 第二段（resume 语义）：同一 snapshot 继续，planner 正常扩张 → n2 完成、collection
  // exhausted、调度完成——修复前 deep 档该死路会让 critic 永不 pass；现在入口即被切断。
  const recovery = makePlannerHarness(
    () => JSON.stringify({ exhausted: true, nodes: [{ dependsOn: [], id: "n2", title: "N2" }] }),
    () => `work\n${typedBlock(VALID_TYPED)}`,
  );
  const recovered = await new WorkflowGraphScheduler(recovery.deps).run({
    artifactGate: DEEP_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: failed.snapshot,
  });
  assert.equal(recovered.status, "completed");
  assert.deepEqual(
    recovered.snapshot.graph.nodes.map((node) => node.id).sort(),
    ["n1", "n2"],
  );
  const n2 = recovered.snapshot.graph.nodes.find((node) => node.id === "n2");
  assert.equal(n2.collectionId, "c1");
  assert.equal(n2.status, "completed");
  const finalCollection = recovered.snapshot.graph.collections.find(
    (collection) => collection.collectionId === "c1",
  );
  assert.equal(finalCollection.exhausted, true);
  // deep 强制照旧：n2 的合格 typed 块被接受，无 node_failed
  assert.equal(eventsOfType(recovery.events, "node_failed").length, 0);
  assert.equal(eventsOfType(recovery.events, "planner_completed").length, 1);
});

test("G5: E2E light——同一空白 id 输入同样 fail-loud（入口防护与 gate 分档无关），正常扩张零回归", async () => {
  const failing = makePlannerHarness(
    () => BLANK_ID_PLANNER_RESPONSE,
    () => "did the work in plain markdown",
  );
  const failed = await new WorkflowGraphScheduler(failing.deps).run({
    artifactGate: LIGHT_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: makePlannerFailureSnapshot(),
  });
  assert.equal(failed.status, "paused");
  assert.equal(failed.reason, "deadlock");
  const plannerFailures = eventsOfType(failing.events, "planner_failed");
  assert.equal(plannerFailures.length, 1);
  assert.ok(plannerFailures[0].message.includes("blank node id"));
  assert.deepEqual(
    failed.snapshot.graph.nodes.map((node) => node.id),
    ["n1"],
  );

  const recovery = makePlannerHarness(
    () => JSON.stringify({ exhausted: true, nodes: [{ dependsOn: [], id: "n2", title: "N2" }] }),
    () => "did the work in plain markdown",
  );
  const recovered = await new WorkflowGraphScheduler(recovery.deps).run({
    artifactGate: LIGHT_GATE,
    cwd: "/repo",
    phase: "exec",
    snapshot: failed.snapshot,
  });
  assert.equal(recovered.status, "completed");
  assert.deepEqual(
    recovered.snapshot.graph.nodes.map((node) => node.id).sort(),
    ["n1", "n2"],
  );
  assert.equal(eventsOfType(recovery.events, "node_failed").length, 0);
});

test("G6: seed 路径既有防护钉住——空白 id 节点被归一化滤掉，合法节点保留（R11 的参照口径）", () => {
  // seed 路径（parseWorkflowGraphSeed → stringValue trim 滤空白）在修复前就有等价防护；
  // schema min(1) 后该行为不变（滤掉的节点到不了 schema）。这是 R11 选择的「对齐」参照。
  const seed = parseWorkflowGraphSeed(
    JSON.stringify({
      nodes: [{ id: "", title: "blank" }, { id: "  spaced  ", title: "Spaced" }, { id: "keep", title: "Keep" }],
    }),
    "exec",
  );
  assert.ok(seed);
  assert.deepEqual(
    seed.nodes.map((node) => node.id),
    ["spaced", "keep"],
  );
});
