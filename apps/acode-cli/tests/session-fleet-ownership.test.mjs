// 会话舰队验收（apps/acode-cli/specs/session-fleet.md 场景 1/3/10）：
// 所有权封闭负例（编造 id / 他会话 id / 失败 launch 不确立所有权 / title 寻址）、
// StartSession 成功面（session_id 恒等式、registry 条目、标题落库）、
// 无人值守变更面拒绝。全程走工具 handler 面 + 替身端口，不起真实 child runtime。
import assert from "node:assert/strict";
import test from "node:test";

const { createStartSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/start-session.ts"
);
const { createSendToSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/send-to-session.ts"
);
const { createListSessionsToolEntry } = await import(
  "../packages/core/src/tool/handlers/list-sessions.ts"
);
const { FleetRegistry } = await import("../packages/core/src/fleet/registry.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);

// ── 替身面 ─────────────────────────────────────────────────────────

let agentCounter = 0;

/** 替身 SubagentPort：镜像 runner 的可观察效果（async_launched 输出 + registry 条目）。 */
function createFakeSubagentPort(taskRegistry, options = {}) {
  return {
    launchCalls: [],
    async launch(request) {
      this.launchCalls.push(request);
      if (options.failLaunch) throw options.failLaunch;
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

function createFakeSessionStore() {
  return {
    updates: [],
    entries: [],
    async updateSession(input) {
      this.updates.push(input);
      return { id: input.id };
    },
    async saveSessionEntry(entry) {
      this.entries.push(entry);
    },
  };
}

function makeContext(overrides = {}) {
  return {
    toolCallId: "tc-fleet-test",
    traceId: "trace-fleet-test",
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

function makeHarness(overrides = {}) {
  const registry = new FleetRegistry();
  const taskRegistry = new InMemoryRuntimeTaskRegistry();
  const sessionStore = createFakeSessionStore();
  const subagentPort = createFakeSubagentPort(taskRegistry, overrides.port ?? {});
  const deps = { registry };
  return {
    registry,
    taskRegistry,
    sessionStore,
    subagentPort,
    deps,
    startEntry: createStartSessionToolEntry(deps),
    sendEntry: createSendToSessionToolEntry(deps),
    listEntry: createListSessionsToolEntry(deps),
    context: makeContext({ subagentPort, sessionStore, runtimeTaskRegistry: taskRegistry, ...overrides.context }),
  };
}

// ── 场景 1：StartSession 成功面 ────────────────────────────────────

test("(场景1) StartSession 成功：session_id 恒等式、registry 记录、所有权、标题落库", async () => {
  const h = makeHarness();
  const output = await h.startEntry.handler(
    { title: "Refactor auth", prompt: "Do the refactor." },
    h.context,
  );
  assert.equal(output.outcome, "started", JSON.stringify(output));
  assert.match(output.session_id, /^sess_subagent_agent_test-\d+$/);
  assert.equal(output.task_id, output.session_id.slice("sess_subagent_".length));
  assert.equal(output.title, "Refactor auth");
  assert.equal(output.mode, "build", "缺席 permission_mode = 继承发起者当前档");

  const record = h.registry.get(output.session_id);
  assert.ok(record, "舰队记录已建立");
  assert.equal(record.launchedBySessionId, "sess_launcher");
  assert.equal(record.launchedByToolCallId, "tc-fleet-test");
  assert.equal(record.archived, false);

  // 标题经 updateSession(title, custom) 落库（best-effort 面被行使）。
  const titleUpdate = h.sessionStore.updates.find((u) => u.id === output.session_id);
  assert.ok(titleUpdate, "标题写 store");
  assert.equal(titleUpdate.title, "Refactor auth");
  assert.equal(titleUpdate.titleSource, "custom");

  // 进程面复用：runtime-task 有 local_agent 条目（TaskOutput/TaskStop 可观测）。
  assert.ok(h.taskRegistry.get(output.task_id));
});

// ── 场景 3：所有权封闭负例 ─────────────────────────────────────────

test("(场景3a) 编造 id → unknown_session；title 寻址同样 unknown_session（不按标题推断）", async () => {
  const h = makeHarness();
  const started = await h.startEntry.handler(
    { title: "Refactor auth", prompt: "work" },
    h.context,
  );
  assert.equal(started.outcome, "started");

  const fabricated = await h.sendEntry.handler(
    { session_id: "sess_totally-made-up", message: "hi" },
    h.context,
  );
  assert.equal(fabricated.outcome, "rejected");
  assert.equal(fabricated.reason, "unknown_session");

  // 用标题当 id：记录明明在场，也绝不按标题匹配（R3）。
  const byTitle = await h.sendEntry.handler(
    { session_id: "Refactor auth", message: "hi" },
    h.context,
  );
  assert.equal(byTitle.outcome, "rejected");
  assert.equal(byTitle.reason, "unknown_session");
  assert.match(byTitle.message, /never inferred|titles/i);
});

test("(场景3b) 别的会话启动的 id → not_owned_by_caller", async () => {
  const h = makeHarness();
  const started = await h.startEntry.handler({ title: "Theirs", prompt: "work" }, h.context);
  assert.equal(started.outcome, "started");

  const otherContext = makeContext({
    sessionId: "sess_other_launcher",
    subagentPort: h.subagentPort,
    sessionStore: h.sessionStore,
    runtimeTaskRegistry: h.taskRegistry,
  });
  const sendEntry = createSendToSessionToolEntry({ registry: h.registry });
  const stolen = await sendEntry.handler(
    { session_id: started.session_id, message: "give me" },
    otherContext,
  );
  assert.equal(stolen.outcome, "rejected");
  assert.equal(stolen.reason, "not_owned_by_caller");
});

test("(场景3c) launch 抛错 → 不确立所有权（registry 无记录）", async () => {
  const boom = new Error("provider exploded");
  const h = makeHarness({ port: { failLaunch: boom } });
  await assert.rejects(
    () => h.startEntry.handler({ title: "Doomed", prompt: "work" }, h.context),
    /provider exploded/,
    "基础设施故障 fail-loud 上抛（拒绝不是错误的另一面）",
  );
  assert.equal(h.registry.listByLauncher("sess_launcher").length, 0, "报错的调用不确立所有权");
});

test("(场景3 补充) 业务拒绝（模式越界）同样不产生记录", async () => {
  const h = makeHarness();
  const output = await h.startEntry.handler(
    { title: "Too much", prompt: "work", permission_mode: "yolo" },
    makeContext({
      ...h.context,
      subagentPort: h.subagentPort,
      sessionStore: h.sessionStore,
      runtimeTaskRegistry: h.taskRegistry,
      sessionModePort: { getMode: () => "build", isPlanEnabled: () => false },
    }),
  );
  assert.equal(output.outcome, "rejected");
  assert.equal(output.reason, "mode_above_launcher");
  assert.equal(h.registry.listByLauncher("sess_launcher").length, 0);
  assert.equal(h.subagentPort.launchCalls.length, 0, "拒绝发生在 launch 之前，进程面零消耗");
});

// ── 场景 10：无人值守变更面 ────────────────────────────────────────

test("(场景10) automationTurn/offPeakTurn：Start/Send 拒绝 unattended_turn，List 照常", async () => {
  const h = makeHarness();
  for (const flag of [{ automationTurn: true }, { offPeakTurn: true }]) {
    const ctx = { ...h.context, ...flag };
    const start = await h.startEntry.handler({ title: "Nope", prompt: "work" }, ctx);
    assert.equal(start.outcome, "rejected");
    assert.equal(start.reason, "unattended_turn");

    const send = await h.sendEntry.handler(
      { session_id: "sess_whatever", message: "hi" },
      ctx,
    );
    assert.equal(send.outcome, "rejected");
    assert.equal(send.reason, "unattended_turn");
  }
  const list = await h.listEntry.handler({}, { ...h.context, automationTurn: true });
  assert.equal(list.count >= 1, true, "只读面在无人值守轮照常");
  assert.equal(h.subagentPort.launchCalls.length, 0);
});
