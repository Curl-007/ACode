// 会话舰队批 2 验收·initiation 与提案面（apps/acode-cli/specs/session-fleet.md
// 第二批 R11/R12）：offer 阻塞卡能力位、own_initiative 提案卡（预算·判重·过期·
// 消费·所有权封闭）、无人值守全拒维持。上下文契约/短名/描述面验收在
// session-fleet-batch2-context.test.mjs。全程走工具 handler 面 + 替身端口，
// 不起真实 child runtime。
import assert from "node:assert/strict";
import test from "node:test";

const { createStartSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/start-session.ts"
);
const { createHandOffToSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/hand-off-to-session.ts"
);
const { createListSessionsToolEntry } = await import(
  "../packages/core/src/tool/handlers/list-sessions.ts"
);
const { FleetRegistry } = await import("../packages/core/src/fleet/registry.ts");
const proposals = await import("../packages/core/src/fleet/proposals.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { PermissionService } = await import("../packages/core/src/permission/service.ts");

// ── 替身面（沿 session-fleet-ownership.test.mjs 夹具模式） ──────────

let agentCounter = 0;

function createFakeSubagentPort(taskRegistry) {
  return {
    launchCalls: [],
    async launch(request) {
      this.launchCalls.push(request);
      agentCounter += 1;
      const agentId = `agent_test-${agentCounter}`;
      const childSessionId = `sess_subagent_${agentId}`;
      taskRegistry.register({
        taskId: agentId,
        agentId,
        agentType: request.agentType,
        description: request.description,
        status: "running",
        startedAt: new Date(),
        type: "local_agent",
        childSessionId,
        isBackgrounded: true,
        parentSessionId: request.sessionId,
      });
      return {
        status: "async_launched",
        isAsync: true,
        agentId,
        agentType: request.agentType,
        description: request.description,
        prompt: request.prompt,
        childSessionId,
        backgroundTaskId: agentId,
        outputFile: `/tmp/fake/${agentId}/output.txt`,
        canReadOutputFile: true,
      };
    },
    async sendMessage(request) {
      return {
        status: "success",
        messageId: `msg_${agentCounter}`,
        delivery: "queued",
        agentId: request.to,
        taskId: request.to,
      };
    },
  };
}

function makeContext(overrides = {}) {
  return {
    toolCallId: "tc-fleet-batch2",
    traceId: "trace-fleet-batch2",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp/fleet-wd",
    workspaceRoot: "/tmp/fleet-wd",
    sessionId: "sess_launcher",
    sessionModePort: {
      getMode: () => "build",
      isPlanEnabled: () => false,
      getPrePlanMode: () => undefined,
      supportsPermissionFullAccess: () => false,
      enterPlanMode: async () => {},
      exitPlanMode: async () => {},
    },
    ...overrides,
  };
}

function makeHarness(contextOverrides = {}) {
  const registry = new FleetRegistry();
  const taskRegistry = new InMemoryRuntimeTaskRegistry();
  const subagentPort = createFakeSubagentPort(taskRegistry);
  const sessionStore = {
    updates: [],
    async updateSession(input) {
      this.updates.push(input);
      return { id: input.id };
    },
    async saveSessionEntry() {},
  };
  const deps = { registry };
  return {
    registry,
    taskRegistry,
    subagentPort,
    startEntry: createStartSessionToolEntry(deps),
    handoffEntry: createHandOffToSessionToolEntry(deps),
    listEntry: createListSessionsToolEntry(deps),
    context: makeContext({
      subagentPort,
      sessionStore,
      runtimeTaskRegistry: taskRegistry,
      ...contextOverrides,
    }),
  };
}

// ── 场景 11：offer 阻塞卡能力位 ────────────────────────────────────

test("(场景11) offer → requiresUserInteraction 能力位；user_asked/缺席不置位", async () => {
  const h = makeHarness();
  const resolve = h.startEntry.resolvePermissionCapability;
  assert.ok(typeof resolve === "function");
  assert.deepEqual(
    resolve({ title: "T", prompt: "P", initiation: "offer" }),
    { requiresUserInteraction: true },
  );
  assert.equal(resolve({ title: "T", prompt: "P", initiation: "user_asked" }), undefined);
  assert.equal(resolve({ title: "T", prompt: "P" }), undefined);
  assert.equal(resolve({ initiation: "offer" }), undefined, "坏输入不置位（拒绝面归 handler）");

  // 既有 bypass 免疫通道：yolo 下 requiresUserInteraction 仍是 ask（阻塞卡语义）
  const service = new PermissionService({
    allowedTools: new Set(),
    disallowedTools: new Set(),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  });
  const decision = service.checkPermission(
    {
      toolName: "StartSession",
      input: { title: "T", prompt: "P", initiation: "offer" },
      riskLevel: "low",
      mode: "yolo",
    },
    { requiresUserInteraction: true, sideEffectScope: "session", riskLevel: "low" },
  );
  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "tool.userInteraction");

  // handler 面：offer 批准后（ask 已过）照常启动
  const started = await h.startEntry.handler(
    { title: "Offered task", prompt: "work", initiation: "offer" },
    h.context,
  );
  assert.equal(started.outcome, "started");
  assert.ok(started.message.includes("user approved"), "offer 启动文案注明用户已确认");
});

// ── 场景 12：own_initiative 提案卡 ─────────────────────────────────

test("(场景12) own_initiative → proposed：不 launch、无舰队记录、提案入库", async () => {
  const h = makeHarness({ turnId: "turn_a" });
  const output = await h.startEntry.handler(
    { title: "Migrate cache layer", prompt: "Do the migration.", initiation: "own_initiative" },
    h.context,
  );
  assert.equal(output.outcome, "proposed", JSON.stringify(output));
  assert.match(output.proposal_id, /^prop_/);
  assert.ok(output.proposal_expires_at);
  assert.equal(h.subagentPort.launchCalls.length, 0, "提案不启动任何东西");
  assert.equal(h.registry.listByLauncher("sess_launcher").length, 0, "无舰队记录");
  const stored = h.registry.getProposal(output.proposal_id);
  assert.ok(stored);
  assert.equal(stored.title, "Migrate cache layer");
  assert.equal(stored.turnKey, "turn_a");
  assert.ok(
    Math.abs(stored.expiresAt - stored.createdAt - proposals.FLEET_PROPOSAL_TTL_MS) < 1000,
    "一周过期",
  );
  // 消息纪律：不等待提案（回合继续）
  assert.ok(output.message.includes("do not wait"), "提案后继续回合的行为规定");
});

test("(场景12) 提案预算：同回合第 4 张拒绝；换回合重置；同事项判重跨回合生效", async () => {
  const h = makeHarness({ turnId: "turn_a" });
  for (const title of ["Task one", "Task two", "Task three"]) {
    const output = await h.startEntry.handler(
      { title, prompt: "work", initiation: "own_initiative" },
      h.context,
    );
    assert.equal(output.outcome, "proposed", title);
  }
  const fourth = await h.startEntry.handler(
    { title: "Task four", prompt: "work", initiation: "own_initiative" },
    h.context,
  );
  assert.equal(fourth.outcome, "rejected");
  assert.equal(fourth.reason, "proposal_budget_exceeded");
  assert.equal(proposals.FLEET_PROPOSAL_MAX_PER_TURN, 3);

  // 换回合：预算重置
  const nextTurn = await h.startEntry.handler(
    { title: "Task four", prompt: "work", initiation: "own_initiative" },
    makeContext({
      subagentPort: h.subagentPort,
      runtimeTaskRegistry: h.taskRegistry,
      turnId: "turn_b",
      sessionId: "sess_launcher",
    }),
  );
  assert.equal(nextTurn.outcome, "proposed", "预算按 launcher+turnId 计");

  // 同事项判重跨回合生效（归一 title：大小写/空白折叠）
  const duplicate = await h.startEntry.handler(
    { title: "  migrate   CACHE layer ", prompt: "again", initiation: "own_initiative" },
    makeContext({
      subagentPort: h.subagentPort,
      runtimeTaskRegistry: h.taskRegistry,
      turnId: "turn_c",
      sessionId: "sess_launcher",
    }),
  );
  // turn_c 里没有同名开放提案（前面是 Task one/two/three/four）→ 应成功；
  // 重复判定用 turn_a 的既有提案验证：
  assert.equal(duplicate.outcome, "proposed");
  const dup2 = await h.startEntry.handler(
    { title: "TASK ONE", prompt: "again", initiation: "own_initiative" },
    makeContext({
      subagentPort: h.subagentPort,
      runtimeTaskRegistry: h.taskRegistry,
      turnId: "turn_c",
      sessionId: "sess_launcher",
    }),
  );
  assert.equal(dup2.outcome, "rejected");
  assert.equal(dup2.reason, "proposal_duplicate");
});

test("(场景12) proposal_id 消费启动：brief 来自提案、成功即删、失败保留", async () => {
  const h = makeHarness({ turnId: "turn_a" });
  const proposed = await h.startEntry.handler(
    {
      title: "Ship the report",
      prompt: "Build the report pipeline.",
      background: "x".repeat(100),
      initiation: "own_initiative",
    },
    h.context,
  );
  assert.equal(proposed.outcome, "proposed");
  const started = await h.startEntry.handler(
    { proposal_id: proposed.proposal_id, initiation: "user_asked" },
    h.context,
  );
  assert.equal(started.outcome, "started", JSON.stringify(started));
  assert.equal(started.title, "Ship the report");
  assert.equal(h.registry.getProposal(proposed.proposal_id), undefined, "成功即消费");
  const childPrompt = h.subagentPort.launchCalls[0].prompt;
  assert.ok(childPrompt.includes("Build the report pipeline."), "提案 brief 原样进 child");
  assert.ok(childPrompt.includes("x".repeat(100)), "提案 background 随启动注入");

  // 编造 id / 他会话 id → proposal_unknown
  const fabricated = await h.startEntry.handler(
    { proposal_id: "prop_made-up" },
    h.context,
  );
  assert.equal(fabricated.outcome, "rejected");
  assert.equal(fabricated.reason, "proposal_unknown");
});

test("(场景12) 提案过期 → proposal_expired 且除名；他会话提案不可消费", async () => {
  const h = makeHarness();
  const expired = proposals.buildFleetProposal({
    launcherSessionId: "sess_launcher",
    turnKey: "turn_old",
    title: "Old idea",
    prompt: "old work",
    now: Date.now() - proposals.FLEET_PROPOSAL_TTL_MS - 60_000,
  });
  h.registry.registerProposal(expired);
  const output = await h.startEntry.handler({ proposal_id: expired.id }, h.context);
  assert.equal(output.outcome, "rejected");
  assert.equal(output.reason, "proposal_expired");
  assert.equal(h.registry.getProposal(expired.id), undefined, "过期提案顺手除名");

  const foreign = proposals.buildFleetProposal({
    launcherSessionId: "sess_other",
    turnKey: "turn_x",
    title: "Other session idea",
    prompt: "work",
    now: Date.now(),
  });
  h.registry.registerProposal(foreign);
  const crossSession = await h.startEntry.handler({ proposal_id: foreign.id }, h.context);
  assert.equal(crossSession.outcome, "rejected");
  assert.equal(crossSession.reason, "proposal_unknown", "所有权封闭：他会话提案 = unknown");
});

test("(场景12) start_needs_brief：无 proposal_id 且缺 title/prompt；own_initiative 缺 brief", async () => {
  const h = makeHarness();
  const noBrief = await h.startEntry.handler({}, h.context);
  assert.equal(noBrief.outcome, "rejected");
  assert.equal(noBrief.reason, "start_needs_brief");
  const noPrompt = await h.startEntry.handler({ title: "T" }, h.context);
  assert.equal(noPrompt.reason, "start_needs_brief");
  const proposalNoBrief = await h.startEntry.handler(
    { initiation: "own_initiative", prompt: "work" },
    h.context,
  );
  assert.equal(proposalNoBrief.reason, "start_needs_brief");
});

test("(场景12) 无人值守轮：提案/启动一律拒绝（波次 1 unattended_turn 维持）", async () => {
  const h = makeHarness({ automationTurn: true, turnId: "turn_auto" });
  const output = await h.startEntry.handler(
    { title: "T", prompt: "P", initiation: "own_initiative" },
    h.context,
  );
  assert.equal(output.outcome, "rejected");
  assert.equal(output.reason, "unattended_turn");
  assert.equal(h.registry.listProposalsByLauncher("sess_launcher").length, 0);
});

