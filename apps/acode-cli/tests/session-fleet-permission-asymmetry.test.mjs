// 会话舰队验收（apps/acode-cli/specs/session-fleet.md 场景 2/4）：
// 权限不对称——launch 只紧不松（mode_above_launcher / plan vessel / 收紧不支持）、
// 升权动态 requiresUserInteraction（权限服务 yolo 下仍 ask）、降权/平调直通、
// 无人值守升权拒绝 + 降权直通、recorded mode 持久化 execution-state。
import assert from "node:assert/strict";
import test from "node:test";

const { createStartSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/start-session.ts"
);
const { createSetSessionPermissionModeToolEntry } = await import(
  "../packages/core/src/tool/handlers/set-session-permission-mode.ts"
);
const { FleetRegistry } = await import("../packages/core/src/fleet/registry.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { resolveFleetLaunchMode, isFleetModeEscalation } = await import(
  "../packages/core/src/fleet/mode-policy.ts"
);
const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const { SESSION_ENTRY_EXECUTION_STATE } = await import(
  "../packages/contracts/src/interfaces/session-store.port.ts"
);

let agentCounter = 0;

function createFakeSubagentPort(taskRegistry) {
  return {
    launchCalls: [],
    async launch(request) {
      this.launchCalls.push(request);
      agentCounter += 1;
      const agentId = `agent_perm-${agentCounter}`;
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
  };
}

function makeContext(mode, overrides = {}) {
  return {
    toolCallId: "tc-perm-test",
    traceId: "trace-perm-test",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp/fleet-wd",
    workspaceRoot: "/tmp/fleet-wd",
    sessionId: "sess_launcher",
    sessionModePort: {
      getMode: () => mode,
      isPlanEnabled: () => mode === "plan",
      getPrePlanMode: () => undefined,
      supportsPermissionFullAccess: () => false,
      enterPlanMode: async () => {},
      exitPlanMode: async () => {},
    },
    ...overrides,
  };
}

function makeHarness(mode = "yolo") {
  const registry = new FleetRegistry();
  const taskRegistry = new InMemoryRuntimeTaskRegistry();
  const subagentPort = createFakeSubagentPort(taskRegistry);
  const entries = [];
  const sessionStore = {
    async updateSession(input) {
      return { id: input.id };
    },
    async saveSessionEntry(entry) {
      entries.push(entry);
    },
  };
  return {
    registry,
    taskRegistry,
    subagentPort,
    entries,
    startEntry: createStartSessionToolEntry({ registry }),
    setModeEntry: createSetSessionPermissionModeToolEntry({ registry }),
    context: makeContext(mode, { subagentPort, sessionStore, runtimeTaskRegistry: taskRegistry }),
  };
}

// ── 场景 2：launch 只紧不松 ────────────────────────────────────────

test("(场景2) yolo 发起者：请求 yolo/缺席 → 继承；请求 plan → Plan vessel", async () => {
  const h = makeHarness("yolo");
  const inherit = await h.startEntry.handler({ title: "A", prompt: "p" }, h.context);
  assert.equal(inherit.outcome, "started");
  assert.equal(inherit.mode, "yolo");
  assert.equal(h.subagentPort.launchCalls[0].agentType, "general-purpose");

  const plan = await h.startEntry.handler(
    { title: "B", prompt: "p", permission_mode: "plan" },
    h.context,
  );
  assert.equal(plan.outcome, "started");
  assert.equal(plan.mode, "plan");
  assert.equal(
    h.subagentPort.launchCalls[1].agentType,
    "Plan",
    "plan 档 vessel = bundled Plan preset（permissionMode: plan 地板）",
  );
  assert.equal(h.registry.get(plan.session_id).modeLineage, "plan");
});

test("(场景2) build 发起者：请求 yolo → mode_above_launcher；请求 edit → tightening 不支持", async () => {
  const h = makeHarness("build");
  const up = await h.startEntry.handler(
    { title: "A", prompt: "p", permission_mode: "yolo" },
    h.context,
  );
  assert.equal(up.outcome, "rejected");
  assert.equal(up.reason, "mode_above_launcher");
  assert.match(up.message, /tighten-only/);

  const down = await h.startEntry.handler(
    { title: "B", prompt: "p", permission_mode: "edit" },
    h.context,
  );
  assert.equal(down.outcome, "rejected");
  assert.equal(down.reason, "mode_tightening_unsupported");
  assert.equal(h.subagentPort.launchCalls.length, 0, "拒绝先于 launch，进程面零消耗");
});

test("(场景2) 纯函数面：严苛度序对齐 MODE_SEVERITY（auto<plan<edit<build<yolo）", () => {
  // resolveFleetLaunchMode 的拒绝/继承矩阵（消费 nesting-policy 单一事实源）。
  assert.equal(resolveFleetLaunchMode({ launcherMode: "plan" }).kind, "inherit");
  assert.equal(
    resolveFleetLaunchMode({ requested: "build", launcherMode: "plan" }).reason,
    "mode_above_launcher",
  );
  assert.equal(
    resolveFleetLaunchMode({ requested: "plan", launcherMode: "auto" }).reason,
    "mode_above_launcher",
    "auto 是最严档：任何可请求模式都高于它",
  );
  assert.equal(
    resolveFleetLaunchMode({ requested: "plan", launcherMode: "edit" }).kind,
    "plan_vessel",
  );
  // 升权判定（SetSessionPermissionMode 的能力位依据）。
  assert.equal(isFleetModeEscalation("plan", "build"), true);
  assert.equal(isFleetModeEscalation("edit", "build"), true);
  assert.equal(isFleetModeEscalation("build", "edit"), false);
  assert.equal(isFleetModeEscalation("yolo", "plan"), false);
  assert.equal(isFleetModeEscalation("build", "build"), false, "平调不是升权");
});

// ── 场景 4：升权不对称 ─────────────────────────────────────────────

test("(场景4a) 升权 → resolvePermissionCapability 动态置 requiresUserInteraction；降权/平调不置", async () => {
  const h = makeHarness("yolo");
  const started = await h.startEntry.handler(
    { title: "Planned", prompt: "p", permission_mode: "plan" },
    h.context,
  );
  assert.equal(started.outcome, "started");

  const resolver = h.setModeEntry.resolvePermissionCapability;
  assert.ok(resolver, "动态能力位在 entry 上");

  const escalation = resolver({ session_id: started.session_id, mode: "build" });
  assert.deepEqual(escalation, { requiresUserInteraction: true });

  const sidegrade = resolver({ session_id: started.session_id, mode: "plan" });
  assert.equal(sidegrade, undefined, "平调直通（不升 ask）");

  const unknown = resolver({ session_id: "sess_nope", mode: "yolo" });
  assert.equal(unknown, undefined, "记录缺席不为必拒的调用打断用户");
});

test("(场景4a-权限服务) requiresUserInteraction 在 yolo 下仍是 ask（bypass 免疫通道）", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      toolName: "SetSessionPermissionMode",
      input: { session_id: "sess_x", mode: "yolo" },
      riskLevel: "low",
      mode: "yolo",
    },
    {
      readOnly: false,
      destructive: false,
      requiresUserInteraction: true,
      needsApproval: false,
      riskLevel: "low",
      sideEffectScope: "session",
    },
  );
  assert.equal(decision.decision, "ask", "升权 ask 先于 yolo 直通（tool.userInteraction）");
  assert.equal(decision.ruleId, "tool.userInteraction");
});

test("(场景4b) 升权经批准后 handler 落记录 + 持久化；无人值守升权直接拒绝", async () => {
  const h = makeHarness("yolo");
  const started = await h.startEntry.handler(
    { title: "Planned", prompt: "p", permission_mode: "plan" },
    h.context,
  );
  const id = started.session_id;

  // 交互式升权（ask 已被权限层行使，handler 只见批准后的调用）。
  const up = await h.setModeEntry.handler({ session_id: id, mode: "build" }, h.context);
  assert.equal(up.outcome, "updated");
  assert.equal(up.mode, "build");
  assert.equal(up.previous_mode, "plan");
  assert.equal(up.binding, "next_turn_boundary", "plan 系会话：下个回合边界绑定");
  assert.equal(h.registry.get(id).mode, "build");

  // 持久化 execution-state 条目（冷恢复/resume 读回面）。
  const entry = h.entries.find((e) => e.sessionID === id);
  assert.ok(entry, "recorded mode 落 execution-state 条目");
  assert.equal(entry.type, SESSION_ENTRY_EXECUTION_STATE);
  assert.deepEqual(entry.data, { mode: "build", planEnabled: false });

  // 无人值守升权：automationTurn → escalation_unattended（即使 ask 被批准也不执行）。
  const auto = await h.setModeEntry.handler(
    { session_id: id, mode: "yolo" },
    { ...h.context, automationTurn: true },
  );
  assert.equal(auto.outcome, "rejected");
  assert.equal(auto.reason, "escalation_unattended");
  assert.equal(h.registry.get(id).mode, "build", "拒绝不落记录");
});

test("(场景4d) 无人值守降权直通（收紧不放大权限，R1/场景4d）", async () => {
  const h = makeHarness("yolo");
  const started = await h.startEntry.handler({ title: "Loose", prompt: "p" }, h.context);
  const id = started.session_id;
  assert.equal(h.registry.get(id).mode, "yolo");

  const down = await h.setModeEntry.handler(
    { session_id: id, mode: "plan" },
    { ...h.context, offPeakTurn: true },
  );
  assert.equal(down.outcome, "updated");
  assert.equal(down.binding, "cold_restore", "天花板系会话：recorded 绑定冷恢复面");
  assert.equal(h.registry.get(id).mode, "plan");
  const entry = h.entries.find((e) => e.sessionID === id);
  assert.deepEqual(entry.data, { mode: "build", planEnabled: true }, "plan 记录为 planEnabled 条目");
});

test("(场景4 补充) 归档会话调权 → session_archived；所有权封闭照常", async () => {
  const h = makeHarness("build");
  const started = await h.startEntry.handler({ title: "X", prompt: "p" }, h.context);
  h.registry.update(started.session_id, (r) => ({ ...r, archived: true }));
  const out = await h.setModeEntry.handler(
    { session_id: started.session_id, mode: "plan" },
    h.context,
  );
  assert.equal(out.outcome, "rejected");
  assert.equal(out.reason, "session_archived");
});
