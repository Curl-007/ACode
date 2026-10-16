// 会话舰队验收（apps/acode-cli/specs/session-fleet.md 场景 5/6）：
// DeleteSessions——yolo 下仍 ask（bypass 免疫钉死在权限服务判定序上）、批量上限、
// 绝不删本会话、resolveInput 在确认窗之前收口；ArchiveSession——在跑拒绝而非强制、
// 共享 worktree 与已完成 side 会话级联、self 语义、归档后路由门结构性关闭。
import assert from "node:assert/strict";
import test from "node:test";

const { createStartSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/start-session.ts"
);
const { createArchiveSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/archive-session.ts"
);
const { createDeleteSessionsToolEntry } = await import(
  "../packages/core/src/tool/handlers/delete-sessions.ts"
);
const { createSendToSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/send-to-session.ts"
);
const { FleetRegistry } = await import("../packages/core/src/fleet/registry.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const { DELETE_SESSIONS_TOOL_NAME, FLEET_DELETE_BATCH_MAX } = await import(
  "../packages/contracts/src/tools/session-fleet.ts"
);

let agentCounter = 0;

function createFakeSubagentPort(taskRegistry) {
  return {
    async launch(request) {
      agentCounter += 1;
      const agentId = `agent_arch-${agentCounter}`;
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
    async sendMessage(request) {
      return { status: "success", messageId: "m1", delivery: "queued", to: request.to };
    },
  };
}

function makeContext(overrides = {}) {
  return {
    toolCallId: "tc-arch-test",
    traceId: "trace-arch-test",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp/fleet-wd",
    workspaceRoot: "/tmp/fleet-wd",
    sessionId: "sess_launcher",
    ...overrides,
  };
}

function makeHarness() {
  const registry = new FleetRegistry();
  const taskRegistry = new InMemoryRuntimeTaskRegistry();
  const subagentPort = createFakeSubagentPort(taskRegistry);
  const storeUpdates = [];
  const sessionStore = {
    async updateSession(input) {
      storeUpdates.push(input);
      return { id: input.id };
    },
  };
  const stops = [];
  const backgroundTaskControlPort = {
    async stopBackgroundTask(taskId) {
      stops.push(taskId);
      taskRegistry.update(taskId, (task) => ({
        ...task,
        status: "stopped",
        completedAt: new Date(),
      }));
      return { ok: true, taskId, status: "stopped" };
    },
  };
  const deps = { registry };
  const context = makeContext({
    subagentPort,
    sessionStore,
    runtimeTaskRegistry: taskRegistry,
    backgroundTaskControlPort,
  });
  return {
    registry,
    taskRegistry,
    subagentPort,
    storeUpdates,
    stops,
    context,
    startEntry: createStartSessionToolEntry(deps),
    archiveEntry: createArchiveSessionToolEntry(deps),
    deleteEntry: createDeleteSessionsToolEntry(deps),
    sendEntry: createSendToSessionToolEntry(deps),
  };
}

async function startSession(h, title, overrides = {}) {
  const output = await h.startEntry.handler({ title, prompt: "work" }, h.context);
  assert.equal(output.outcome, "started", JSON.stringify(output));
  if (overrides.worktree) {
    h.registry.update(output.session_id, (r) => ({
      ...r,
      worktree: { path: overrides.worktree, branch: "acode/session/x" },
    }));
  }
  return output;
}

function markTerminal(h, sessionId, status = "completed") {
  const record = h.registry.get(sessionId);
  h.taskRegistry.update(record.agentId, (task) => ({
    ...task,
    status,
    completedAt: new Date(),
  }));
}

// ── 场景 5：DeleteSessions 的 bypass 免疫审批 ──────────────────────

test("(场景5) yolo 下 delete 仍 ask：requiresUserInteraction 先于 yolo 直通（权限服务钉死）", () => {
  const service = new PermissionService();
  const entry = createDeleteSessionsToolEntry({ registry: new FleetRegistry() });
  // entry 的静态声明面（toContracts 读顶层优先，两处都必须为 true）。
  assert.equal(entry.requiresUserInteraction, true);
  assert.equal(entry.metadata.requiresUserInteraction, true);

  for (const mode of ["build", "edit", "yolo"]) {
    const decision = service.checkPermission(
      {
        toolName: DELETE_SESSIONS_TOOL_NAME,
        input: { session_ids: ["sess_a"] },
        riskLevel: "high",
        mode,
      },
      {
        readOnly: false,
        destructive: true,
        requiresUserInteraction: true,
        needsApproval: true,
        riskLevel: "high",
        sideEffectScope: "session",
      },
    );
    assert.equal(decision.decision, "ask", `mode=${mode} 必须 ask（bypass 免疫）`);
    assert.equal(decision.ruleId, "tool.userInteraction");
  }
});

test("(场景5) resolveInput 在确认窗之前收口：批量上限 / self / 所有权", async () => {
  const h = makeHarness();
  const started = await startSession(h, "Keeper");
  const resolveInput = h.deleteEntry.resolveInput;

  // 批量上限（schema max 之外的 handler 面同判）。
  const tooMany = resolveInput(
    { session_ids: Array.from({ length: FLEET_DELETE_BATCH_MAX + 1 }, (_, i) => `sess_x${i}`) },
    { sessionId: "sess_launcher" },
  );
  assert.equal(tooMany.result, false);
  assert.match(tooMany.message, /at most 25/);

  // 绝不删本会话：字面量 self 与真实自身 id 双形态。
  const selfAlias = resolveInput(
    { session_ids: [started.session_id, "self"] },
    { sessionId: "sess_launcher" },
  );
  assert.equal(selfAlias.result, false);
  assert.match(selfAlias.message, /never delete the current session/i);
  const selfId = resolveInput(
    { session_ids: ["sess_launcher"] },
    { sessionId: "sess_launcher" },
  );
  assert.equal(selfId.result, false);

  // 所有权逐条：混入一个未拥有 id → 整单在弹卡前退回。
  const mixed = resolveInput(
    { session_ids: [started.session_id, "sess_stranger"] },
    { sessionId: "sess_launcher" },
  );
  assert.equal(mixed.result, false);
  assert.match(mixed.message, /unknown_session|No fleet session/);

  // 合法列表放行（弹卡时列表必然全部合法）。
  const valid = resolveInput({ session_ids: [started.session_id] }, { sessionId: "sess_launcher" });
  assert.equal(valid.result, true);
});

test("(场景5) delete 执行：在跑先停、registry/舰队除名、store 归档标记", async () => {
  const h = makeHarness();
  const running = await startSession(h, "Runner");
  const done = await startSession(h, "Done");
  markTerminal(h, done.session_id);
  const runningAgentId = h.registry.get(running.session_id).agentId;

  const out = await h.deleteEntry.handler(
    { session_ids: [running.session_id, done.session_id] },
    h.context,
  );
  assert.equal(out.outcome, "deleted");
  assert.deepEqual(out.deleted.sort(), [running.session_id, done.session_id].sort());
  assert.deepEqual(out.stopped, [running.session_id], "在跑的先行停止");
  assert.deepEqual(h.stops, [runningAgentId], "停止走既有 backgroundTaskControlPort 面");

  // 除名 = 所有权消灭 + runtime-task 条目移除（SendMessage/TaskOutput 自然 not-found）。
  assert.equal(h.registry.get(running.session_id), undefined);
  assert.equal(h.registry.get(done.session_id), undefined);
  assert.equal(h.taskRegistry.get(running.task_id), undefined);
  assert.equal(h.taskRegistry.get(done.task_id), undefined);

  // 数据面诚实语义：store 面是归档标记（无 delete 原语，spec 非目标 #7）。
  const archived = h.storeUpdates.filter((u) => u.timeArchived !== undefined);
  assert.equal(archived.length, 2);
  assert.match(out.message, /transcripts remain on disk/i);
});

// ── 场景 6：归档级联与拒绝 ─────────────────────────────────────────

test("(场景6a) 目标在跑 → session_running，零副作用（拒绝而非强制）", async () => {
  const h = makeHarness();
  const running = await startSession(h, "Busy");
  const out = await h.archiveEntry.handler({ session_id: running.session_id }, h.context);
  assert.equal(out.outcome, "rejected");
  assert.equal(out.reason, "session_running");
  assert.match(out.message, /TaskStop/);
  assert.equal(h.registry.get(running.session_id).archived, false, "零副作用");
  assert.ok(h.taskRegistry.get(running.task_id), "runtime-task 条目未动");
  assert.equal(
    h.storeUpdates.filter((u) => u.timeArchived !== undefined).length,
    0,
    "拒绝路径不落任何归档标记（标题落库是 launch 自己的 best-effort 面）",
  );
});

test("(场景6b) 共享 worktree 级联归档；级联对象在跑 → 整单拒绝", async () => {
  const h = makeHarness();
  const a = await startSession(h, "A", { worktree: "/tmp/wt-shared" });
  const b = await startSession(h, "B", { worktree: "/tmp/wt-shared" });
  markTerminal(h, a.session_id);
  markTerminal(h, b.session_id);

  const out = await h.archiveEntry.handler({ session_id: a.session_id }, h.context);
  assert.equal(out.outcome, "archived");
  assert.deepEqual(out.cascaded, [b.session_id], "共享 worktree 的终态会话随单归档");
  assert.equal(h.registry.get(b.session_id).archived, true);
  assert.equal(h.taskRegistry.get(b.task_id), undefined, "级联对象的 runtime 条目一并移除");

  // 级联对象在跑 → cascade_session_running，整单不落（原子性）。
  const h2 = makeHarness();
  const c = await startSession(h2, "C", { worktree: "/tmp/wt-2" });
  const d = await startSession(h2, "D", { worktree: "/tmp/wt-2" });
  markTerminal(h2, c.session_id);
  const refused = await h2.archiveEntry.handler({ session_id: c.session_id }, h2.context);
  assert.equal(refused.outcome, "rejected");
  assert.equal(refused.reason, "cascade_session_running");
  assert.equal(h2.registry.get(c.session_id).archived, false, "整单不落");
});

test("(场景6c) 目标启动的已完成 side 会话级联；在跑嵌套不动不阻塞", async () => {
  const h = makeHarness();
  const parent = await startSession(h, "Parent");
  markTerminal(h, parent.session_id);

  // 嵌套：parent 的 child 会话再启动两个（一个终态一个在跑），launchedBy = parent。
  const childCtx = makeContext({
    sessionId: parent.session_id,
    subagentPort: h.subagentPort,
    sessionStore: h.context.sessionStore,
    runtimeTaskRegistry: h.taskRegistry,
  });
  const sideDone = await h.startEntry.handler({ title: "Side done", prompt: "w" }, childCtx);
  const sideRunning = await h.startEntry.handler({ title: "Side running", prompt: "w" }, childCtx);
  markTerminal(h, sideDone.session_id);

  const out = await h.archiveEntry.handler({ session_id: parent.session_id }, h.context);
  assert.equal(out.outcome, "archived");
  assert.deepEqual(out.cascaded, [sideDone.session_id], "只收已完成的 side 会话");
  assert.equal(h.registry.get(sideRunning.session_id).archived, false, "在跑嵌套不动、不阻塞");
});

test("(场景6e) 归档会话 SendToSession → session_archived；runtime 条目移除使既有面自然 not-found", async () => {
  const h = makeHarness();
  const s = await startSession(h, "Gone");
  markTerminal(h, s.session_id);
  const archived = await h.archiveEntry.handler({ session_id: s.session_id }, h.context);
  assert.equal(archived.outcome, "archived");

  const send = await h.sendEntry.handler(
    { session_id: s.session_id, message: "still there?" },
    h.context,
  );
  assert.equal(send.outcome, "rejected");
  assert.equal(send.reason, "session_archived");
  assert.match(send.message, /ReadSessionContext/);
});

test("(场景6d) self：主会话 → 仅 store timeArchived；舰队 child → 记录即刻 archived 且在飞条目不 remove", async () => {
  const h = makeHarness();
  // 主交互会话 self：无舰队记录，仅落 store 归档标记。
  const main = await h.archiveEntry.handler({ session_id: "self" }, h.context);
  assert.equal(main.outcome, "archived");
  const mark = h.storeUpdates.find((u) => u.id === "sess_launcher");
  assert.ok(mark?.timeArchived, "主会话 timeArchived 落库");

  // 舰队 child self：记录即刻 archived；自己的在飞 runtime-task 条目不 remove
  // （finalize 漏斗还在写它，spec R7）。
  const s = await startSession(h, "Selfish");
  const childCtx = makeContext({
    sessionId: s.session_id,
    subagentPort: h.subagentPort,
    sessionStore: h.context.sessionStore,
    runtimeTaskRegistry: h.taskRegistry,
  });
  const selfOut = await h.archiveEntry.handler({ session_id: "self" }, childCtx);
  assert.equal(selfOut.outcome, "archived");
  assert.equal(h.registry.get(s.session_id).archived, true);
  assert.ok(h.taskRegistry.get(s.task_id), "在飞条目保留（回合自然收口）");
});
