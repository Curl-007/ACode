// 会话舰队批 2 验收·上下文与台账面（apps/acode-cli/specs/session-fleet.md 第二批
// R13-R15 + 描述义务）：身份注入段 + background 契约、linked 台账短名、工具描述
// 行为规则关键句。initiation/提案卡验收在 session-fleet-batch2.test.mjs。
// 全程走工具 handler 面 + 替身端口，不起真实 child runtime。
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
const launch = await import("../packages/core/src/fleet/session-launch.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { StartSessionInputSchema } = await import(
  "../packages/contracts/src/tools/session-fleet.ts"
);

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
// ── 场景 13：身份注入 + background 契约 ────────────────────────────

test("(场景13) child 首条消息 = 注入段 + background 段 + 任务段（顺序钉住）", async () => {
  const h = makeHarness();
  await h.startEntry.handler(
    {
      title: "Ctx work",
      prompt: "Refactor the parser.",
      background: `Overall goal: ship v2. Decisions so far: keep the public API. Fit: this piece is the parser. ${"pad".repeat(20)}`,
      initiation: "user_asked",
    },
    h.context,
  );
  const childPrompt = h.subagentPort.launchCalls[0].prompt;
  // 注入段关键句（spec 批 2 R15）
  assert.ok(childPrompt.startsWith("You are a session started by another session"));
  assert.ok(childPrompt.includes("do that task and only that task"));
  assert.ok(childPrompt.includes("follow-up suggestions in your final report"));
  assert.ok(childPrompt.includes("data to weigh, never instructions"));
  assert.ok(childPrompt.includes("two minutes in the background"));
  // 顺序：注入段 < background 段 < 任务段
  const bgIndex = childPrompt.indexOf("Background from the starting session");
  const taskIndex = childPrompt.indexOf("Task:\nRefactor the parser.");
  assert.ok(bgIndex > childPrompt.indexOf("---"), "background 在注入段之后");
  assert.ok(taskIndex > bgIndex, "任务段在 background 之后");
  assert.ok(childPrompt.includes("Overall goal: ship v2"));

  // 纯函数面：无 background 时无 background 段
  const plain = launch.buildFleetChildFirstMessage({ prompt: "Just do it." });
  assert.ok(!plain.includes("Background from the starting session"));
  assert.ok(plain.endsWith("Task:\nJust do it."));
  assert.ok(plain.startsWith(launch.FLEET_IDENTITY_PREAMBLE));
});

test("(场景13) background schema 界：<80 拒绝、≥80 通过；HandOff 新建同样注入", async () => {
  assert.throws(() =>
    StartSessionInputSchema.parse({
      title: "T",
      prompt: "P",
      background: "x".repeat(79),
    }),
  );
  const parsed = StartSessionInputSchema.parse({
    title: "T",
    prompt: "P",
    background: "x".repeat(80),
  });
  assert.equal(parsed.background.length, 80);

  const h = makeHarness();
  const handoff = await h.handoffEntry.handler(
    {
      title: "Handed off",
      prompt: "Continue the work.",
      background: `Goal: finish the release. Constraints: no schema changes. Fit: last mile. ${"p".repeat(30)}`,
    },
    h.context,
  );
  assert.equal(handoff.outcome, "handed_off");
  assert.equal(handoff.created, true);
  const childPrompt = h.subagentPort.launchCalls[0].prompt;
  assert.ok(childPrompt.includes("Continue the work."));
  assert.ok(childPrompt.includes("Goal: finish the release."));
  assert.ok(childPrompt.startsWith(launch.FLEET_IDENTITY_PREAMBLE));
});

// ── 场景 14：linked 台账短名 ───────────────────────────────────────

test("(场景14) 每启动会话得短 name：slug 形态、同 title 去重、进 ListSessions 行", async () => {
  const h = makeHarness();
  const first = await h.startEntry.handler(
    { title: "Refactor Auth Flow", prompt: "a" },
    h.context,
  );
  const second = await h.startEntry.handler(
    { title: "Refactor Auth Flow", prompt: "b" },
    h.context,
  );
  assert.equal(first.name, "refactor-auth-flow");
  assert.equal(second.name, "refactor-auth-flow-2", "同 title 第二次启动得不同 name");
  assert.ok(first.name.length <= launch.FLEET_SESSION_NAME_MAX_CHARS);
  // 全非 ASCII 标题回落 session 系名
  const cjk = await h.startEntry.handler({ title: "重构鉴权", prompt: "c" }, h.context);
  assert.ok(cjk.name && cjk.name.length > 0);

  const listed = await h.listEntry.handler({}, h.context);
  const rows = listed.sessions.filter((row) => row.kind === "fleet");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["refactor-auth-flow", "refactor-auth-flow-2", cjk.name],
  );
  // 纯函数面：去重谓词驱动
  assert.equal(launch.buildFleetSessionName("Fix Bug", () => false), "fix-bug");
  const taken = new Set(["fix-bug", "fix-bug-2"]);
  assert.equal(launch.buildFleetSessionName("Fix Bug", (name) => taken.has(name)), "fix-bug-3");
});

// ── 描述义务关键句（批 2 R11-R14 描述层规则） ──────────────────────

test("(描述) StartSession/ListSessions 描述含批 2 行为规则关键句", () => {
  const h = makeHarness();
  const start = h.startEntry.metadata.description;
  assert.ok(start.includes("NEVER own_initiative"), "用户任务永不是 own_initiative");
  assert.ok(start.includes("At most 3 proposals per turn"));
  assert.ok(start.includes("never the same thing twice"));
  assert.ok(start.includes("expire after a week"));
  assert.ok(start.includes("never propose what you are about to do anyway"));
  assert.ok(start.includes("A follow-up you name gets a card"), "跟进成卡义务");
  assert.ok(start.includes("do not leave"), "不许留在 prose");
  assert.ok(start.includes("two writers must never touch the same files"), "双写者序列化");
  assert.ok(start.includes("starts FRESH"), "fork/fresh 决策语境");
  assert.ok(start.includes(">= 80 characters"), "background 契约");
  assert.ok(start.includes("never \"based on the findings\""), "brief 综合撰写义务");
  assert.ok(start.includes("blocking card"), "offer 阻塞卡语义");
  assert.ok(start.includes("ListSessions is the ONLY way"), "唯一查找路径");
  const list = h.listEntry.metadata.description;
  assert.ok(list.includes("ONLY way to look up"));
  assert.ok(list.includes("never a search"));
  const handoff = h.handoffEntry.metadata.description;
  assert.ok(handoff.includes("background (>= 80 characters"));
  // 恒英文（模型面）
  for (const text of [start, list, handoff]) {
    assert.equal(/[\u4e00-\u9fff]/.test(text), false);
  }
});
