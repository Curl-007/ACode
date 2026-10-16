// 回合收尾协议（apps/acode-cli/specs/turn-wrap-up.md）验收场景 1/2/3/8 + R4 契约守护。
//
// 覆盖：
//   - 收尾载荷 schema 校验（producer 镜像，zod v3）：闭集、上限、拒绝语义；
//   - schema parity：contracts 镜像与 shared v4 wire schema 对同一 fixtures 同接受/同拒绝，
//     名字与上限常量同源（场景 8）；
//   - 义务语义触发条件（场景 2）：工作信号判别、事实记录、missing/recorded/stale 评估；
//   - 评估范围门（场景 3）：child/side-chat/无人值守轮不评估；
//   - 工具 entry 契约（R4）：协议档元数据 + handler 成功/拒绝两面。
import assert from "node:assert/strict";
import test from "node:test";

const {
  TURN_WRAP_UP_LIMITS,
  TURN_WRAP_UP_TOOL_NAME,
  TurnWrapUpInputSchema,
  TurnWrapUpOutputSchema,
} = await import("../packages/contracts/src/tools/turn-wrap-up.ts");
const sharedWrapUp = await import("../../../packages/shared/src/acode-protocol-v4/turn-wrap-up.ts");
const { turnWrapUpToolEntry } = await import("../packages/core/src/tool/handlers/turn-wrap-up.ts");
const {
  evaluateTurnWrapUpObligation,
  isTurnWrapUpWorkSignalTool,
  recordTurnWrapUpToolResults,
  shouldEvaluateTurnWrapUpObligation,
} = await import("../packages/core/src/runtime/methods/turn-wrap-up.ts");

const validMinimal = {
  recap: "Refactored the parser hot path and refreshed its tests.",
  nextStep: "Run the package test suite to confirm the refactor.",
};
const validWithFollowUp = {
  ...validMinimal,
  followUpSuggestion: {
    title: "Add parser benchmarks",
    tldr: "Guard the new hot path with benchmarks wired into CI.",
    prompt:
      "Add benchmarks for the parser hot path, wire them into CI, and report regressions against the current baseline.",
  },
};

// ── 场景 1：载荷 schema 校验（拒绝而不是截断） ──

test("input schema accepts the minimal and follow-up payloads", () => {
  assert.equal(TurnWrapUpInputSchema.safeParse(validMinimal).success, true);
  assert.equal(TurnWrapUpInputSchema.safeParse(validWithFollowUp).success, true);
});

test("input schema rejects over-limit, empty, whitespace-only and unknown keys", () => {
  const overLimitRecap = {
    ...validMinimal,
    recap: "x".repeat(TURN_WRAP_UP_LIMITS.recapMaxChars + 1),
  };
  assert.equal(TurnWrapUpInputSchema.safeParse(overLimitRecap).success, false);

  const atLimitRecap = { ...validMinimal, recap: "x".repeat(TURN_WRAP_UP_LIMITS.recapMaxChars) };
  assert.equal(TurnWrapUpInputSchema.safeParse(atLimitRecap).success, true);

  assert.equal(TurnWrapUpInputSchema.safeParse({ ...validMinimal, nextStep: "" }).success, false);
  assert.equal(
    TurnWrapUpInputSchema.safeParse({ ...validMinimal, nextStep: "   " }).success,
    false,
  );
  assert.equal(
    TurnWrapUpInputSchema.safeParse({ ...validMinimal, extra: "no" }).success,
    false,
    "strict object must reject unknown keys",
  );
});

test("follow-up suggestion schema is strict and requires all three fields", () => {
  const followUp = validWithFollowUp.followUpSuggestion;
  assert.equal(
    TurnWrapUpInputSchema.safeParse({ ...validMinimal, followUpSuggestion: followUp }).success,
    true,
  );
  const { prompt: _prompt, ...missingPrompt } = followUp;
  assert.equal(
    TurnWrapUpInputSchema.safeParse({ ...validMinimal, followUpSuggestion: missingPrompt }).success,
    false,
  );
  assert.equal(
    TurnWrapUpInputSchema.safeParse({
      ...validMinimal,
      followUpSuggestion: { ...followUp, extra: 1 },
    }).success,
    false,
  );
  assert.equal(
    TurnWrapUpInputSchema.safeParse({
      ...validMinimal,
      followUpSuggestion: {
        ...followUp,
        title: "t".repeat(TURN_WRAP_UP_LIMITS.followUpTitleMaxChars + 1),
      },
    }).success,
    false,
  );
});

// ── 场景 8：contracts 镜像 ↔ shared v4 wire schema parity ──

test("contracts mirror and shared wire schema agree on the fixture matrix", () => {
  const fixtures = [
    validMinimal,
    validWithFollowUp,
    { ...validMinimal, recap: "x".repeat(TURN_WRAP_UP_LIMITS.recapMaxChars + 1) },
    { ...validMinimal, nextStep: "" },
    { ...validMinimal, nextStep: "  " },
    { ...validMinimal, unknownKey: true },
    { ...validMinimal, followUpSuggestion: { title: "t", tldr: "d" } },
    { ...validMinimal, followUpSuggestion: { ...validWithFollowUp.followUpSuggestion, extra: 1 } },
    { recap: "only recap" },
    "not-an-object",
    null,
    [],
  ];
  for (const fixture of fixtures) {
    const producer = TurnWrapUpInputSchema.safeParse(fixture).success;
    const wire = sharedWrapUp.turnWrapUpPayloadSchema.safeParse(fixture).success;
    assert.equal(
      producer,
      wire,
      `schema parity violated for fixture: ${JSON.stringify(fixture)?.slice(0, 120)}`,
    );
  }
});

test("tool name and limits have a single source of truth in shared v4", () => {
  assert.equal(TURN_WRAP_UP_TOOL_NAME, "TurnWrapUp");
  assert.equal(TURN_WRAP_UP_TOOL_NAME, sharedWrapUp.TURN_WRAP_UP_TOOL_NAME);
  assert.deepEqual(TURN_WRAP_UP_LIMITS, sharedWrapUp.TURN_WRAP_UP_LIMITS);
  assert.equal(sharedWrapUp.isTurnWrapUpToolName("TurnWrapUp"), true);
  // 近名不劫持身份：判别只认 canonical 常量，大小写/分词变体一律 false。
  assert.equal(sharedWrapUp.isTurnWrapUpToolName("turnwrapup"), false);
});

// ── 场景 2：义务语义触发条件 ──

const capabilities = {
  Edit: { readOnly: false, sideEffectScope: "workspace" },
  Bash: { readOnly: false, sideEffectScope: "system" },
  Write: { readOnly: false, sideEffectScope: "workspace" },
  Read: { readOnly: true, sideEffectScope: "none" },
  Grep: { readOnly: true, sideEffectScope: "none" },
  TodoWrite: { readOnly: true, sideEffectScope: "session" },
  TurnWrapUp: { readOnly: true, sideEffectScope: "session" },
};
const capabilityOf = (toolName) => capabilities[toolName];

test("work signal classification follows the closed set (spec R2)", () => {
  assert.equal(isTurnWrapUpWorkSignalTool("Edit", capabilityOf("Edit")), true);
  assert.equal(isTurnWrapUpWorkSignalTool("Bash", capabilityOf("Bash")), true);
  assert.equal(isTurnWrapUpWorkSignalTool("Write", capabilityOf("Write")), true);
  assert.equal(isTurnWrapUpWorkSignalTool("TodoWrite", capabilityOf("TodoWrite")), true);
  assert.equal(isTurnWrapUpWorkSignalTool("Read", capabilityOf("Read")), false);
  assert.equal(isTurnWrapUpWorkSignalTool("Grep", capabilityOf("Grep")), false);
  assert.equal(isTurnWrapUpWorkSignalTool("TurnWrapUp", capabilityOf("TurnWrapUp")), false);
  // 能力缺席按会改写处理（isWorkspaceMutatingToolCall 的保守规则同源）。
  assert.equal(isTurnWrapUpWorkSignalTool("SomeMcpTool", undefined), true);
});

test("obligation outcomes: not_required / missing / recorded / stale", () => {
  // 纯只读轮：无义务。
  const readOnlyState = {};
  recordTurnWrapUpToolResults(
    readOnlyState,
    [
      { toolName: "Read", success: true },
      { toolName: "Grep", success: true },
    ],
    capabilityOf,
  );
  assert.deepEqual(evaluateTurnWrapUpObligation(readOnlyState.turnWrapUp), {
    outcome: "not_required",
    required: false,
    workSignalCount: 0,
  });

  // 零工具轮（undefined state）同样 not_required。
  assert.equal(evaluateTurnWrapUpObligation(undefined).outcome, "not_required");

  // 有写信号、从未调用 → missing。
  const workState = {};
  recordTurnWrapUpToolResults(
    workState,
    [
      { toolName: "Read", success: true },
      { toolName: "Edit", success: true },
    ],
    capabilityOf,
  );
  assert.deepEqual(evaluateTurnWrapUpObligation(workState.turnWrapUp), {
    outcome: "missing",
    required: true,
    workSignalCount: 1,
  });

  // 失败的写尝试也是工作上下文；失败的 TurnWrapUp 不算记录。
  recordTurnWrapUpToolResults(
    workState,
    [
      { toolName: "Bash", success: false },
      { toolName: "TurnWrapUp", success: false },
    ],
    capabilityOf,
  );
  assert.equal(evaluateTurnWrapUpObligation(workState.turnWrapUp).outcome, "missing");
  assert.equal(evaluateTurnWrapUpObligation(workState.turnWrapUp).workSignalCount, 2);

  // 成功调用 → recorded；调用后再出现工作信号 → stale。
  recordTurnWrapUpToolResults(workState, [{ toolName: "TurnWrapUp", success: true }], capabilityOf);
  assert.deepEqual(evaluateTurnWrapUpObligation(workState.turnWrapUp), {
    outcome: "recorded",
    required: true,
    workSignalCount: 2,
  });
  recordTurnWrapUpToolResults(workState, [{ toolName: "Write", success: true }], capabilityOf);
  assert.deepEqual(evaluateTurnWrapUpObligation(workState.turnWrapUp), {
    outcome: "stale",
    required: true,
    workSignalCount: 3,
  });

  // TodoWrite 单列信号。
  const todoState = {};
  recordTurnWrapUpToolResults(todoState, [{ toolName: "TodoWrite", success: true }], capabilityOf);
  assert.equal(evaluateTurnWrapUpObligation(todoState.turnWrapUp).outcome, "missing");
});

// ── 场景 3：评估范围门 ──

test("obligation is evaluated only for attended main-conversation turns", () => {
  const baseState = {};
  const runtime = (taskType) => ({ config: taskType === undefined ? {} : { taskType } });
  assert.equal(shouldEvaluateTurnWrapUpObligation(runtime("interactive"), baseState), true);
  assert.equal(shouldEvaluateTurnWrapUpObligation(runtime(undefined), baseState), true);
  for (const taskType of [
    "subagent_child",
    "workflow_child",
    "nested_workflow_child",
    "selection_side_chat",
  ]) {
    assert.equal(shouldEvaluateTurnWrapUpObligation(runtime(taskType), baseState), false, taskType);
  }
  assert.equal(
    shouldEvaluateTurnWrapUpObligation(runtime("interactive"), { automationId: "auto-1" }),
    false,
  );
  assert.equal(
    shouldEvaluateTurnWrapUpObligation(runtime("interactive"), { offPeakTaskId: "op-1" }),
    false,
  );
  assert.equal(
    shouldEvaluateTurnWrapUpObligation(runtime("interactive"), { automationId: "   " }),
    true,
    "blank automation id must not disable evaluation",
  );
});

// ── R4：工具 entry 契约与 handler 两面 ──

test("tool entry declares the protocol-only session scope without approval", () => {
  assert.equal(turnWrapUpToolEntry.metadata.name, "TurnWrapUp");
  assert.equal(turnWrapUpToolEntry.metadata.readOnly, true);
  assert.equal(turnWrapUpToolEntry.metadata.destructive, false);
  assert.equal(turnWrapUpToolEntry.metadata.sideEffectScope, "session");
  assert.equal(turnWrapUpToolEntry.metadata.riskLevel, "low");
  assert.equal(turnWrapUpToolEntry.metadata.needsApproval, false);
  assert.equal(turnWrapUpToolEntry.permission.permission, "turn.wrapup");
  assert.equal(turnWrapUpToolEntry.permission.needsApproval, false);
  // entry 的 runtime schema 来自 @acode/contracts 的包解析实例，与本测试直接加载的
  // src 模块不是同一对象引用；按行为断言（同一份契约的接受/拒绝语义）。
  assert.equal(turnWrapUpToolEntry.runtimeInputSchema.safeParse(validMinimal).success, true);
  assert.equal(
    turnWrapUpToolEntry.runtimeInputSchema.safeParse({ ...validMinimal, extra: 1 }).success,
    false,
  );
  assert.equal(
    turnWrapUpToolEntry.runtimeOutputSchema.safeParse({ status: "recorded", message: "m" }).success,
    true,
  );
  // 义务文本必须写在工具描述里（本波不改系统提示词，spec §2.1）。
  assert.match(turnWrapUpToolEntry.metadata.description, /MUST call this tool/i);
  assert.match(turnWrapUpToolEntry.metadata.description, /BEFORE your final message/i);
});

test("handler records the payload and answers with a model-facing close instruction", async () => {
  const output = await turnWrapUpToolEntry.handler(validWithFollowUp, {});
  assert.equal(TurnWrapUpOutputSchema.safeParse(output).success, true);
  assert.equal(output.status, "recorded");
  assert.ok(output.message.length > 0);

  const plain = await turnWrapUpToolEntry.handler(validMinimal, {});
  assert.equal(plain.status, "recorded");
});

test("handler rejects invalid payloads with zero side effects", async () => {
  await assert.rejects(() => turnWrapUpToolEntry.handler({ recap: "" }, {}));
  await assert.rejects(() => turnWrapUpToolEntry.handler({ ...validMinimal, extra: 1 }, {}));
});
