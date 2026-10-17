// 会话舰队验收（apps/acode-cli/specs/session-fleet.md 场景 7）：
// HandOffToSession 的 report-back 订阅——每收口一个回合记一条「最新报告前
// 400 字符」的 note（定量截断恰为 400 + 标记）、同终态签名去重、移交前的旧
// 终态不当新 note、归档撤销订阅；ListSessions 的 latest_note 带「数据非指令」
// 定性；纯函数面 buildFleetReportNote 的截断界。
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
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { buildFleetReportNote, FLEET_NOTE_MAX_CHARS } = await import(
  "../packages/contracts/src/tools/session-fleet.ts"
);

let agentCounter = 0;

function createFakeSubagentPort(taskRegistry) {
  return {
    sentMessages: [],
    async launch(request) {
      agentCounter += 1;
      const agentId = `agent_note-${agentCounter}`;
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
      this.sentMessages.push(request);
      return { status: "success", messageId: "m1", delivery: "queued", agentId: request.to };
    },
  };
}

function makeContext(overrides = {}) {
  return {
    toolCallId: "tc-note-test",
    traceId: "trace-note-test",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp/fleet-wd",
    workspaceRoot: "/tmp/fleet-wd",
    sessionId: "sess_origin",
    ...overrides,
  };
}

function makeHarness() {
  const registry = new FleetRegistry();
  const taskRegistry = new InMemoryRuntimeTaskRegistry();
  const subagentPort = createFakeSubagentPort(taskRegistry);
  const deps = { registry, notePollIntervalMs: 5 };
  const context = makeContext({ subagentPort, runtimeTaskRegistry: taskRegistry });
  return {
    registry,
    taskRegistry,
    subagentPort,
    context,
    startEntry: createStartSessionToolEntry(deps),
    handoffEntry: createHandOffToSessionToolEntry(deps),
    listEntry: createListSessionsToolEntry(deps),
  };
}

function completeTurn(h, sessionId, reportText, status = "completed") {
  const record = h.registry.get(sessionId);
  h.taskRegistry.update(record.agentId, (task) => ({
    ...task,
    status,
    completedAt: new Date(),
    output:
      status === "completed"
        ? {
            status: "completed",
            agentId: task.agentId,
            prompt: task.prompt ?? "",
            content: [{ type: "text", text: reportText }],
            totalToolUseCount: 0,
            totalDurationMs: 1,
          }
        : undefined,
    ...(status === "completed" ? {} : { error: reportText }),
  }));
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 纯函数面：定量截断 ─────────────────────────────────────────────

test("(场景7) buildFleetReportNote：恰为前 400 字符 + 截断标记；短文原样；空文无 note", () => {
  const long = "x".repeat(900);
  const note = buildFleetReportNote(long);
  assert.equal(FLEET_NOTE_MAX_CHARS, 400);
  assert.ok(note.startsWith("x".repeat(400)));
  assert.equal(note.slice(0, 400), "x".repeat(400), "内容界恰为前 400 字符");
  assert.match(note.slice(400), /truncated/, "截断带标记（标记不占 400 配额）");

  assert.equal(buildFleetReportNote("short report"), "short report");
  assert.equal(buildFleetReportNote("   "), undefined, "空报告不产生空 note");
  assert.equal(buildFleetReportNote("y".repeat(400)), "y".repeat(400), "恰 400 不截断");
});

// ── watcher 面：每回合一条 note ────────────────────────────────────

test("(场景7) HandOff 既有会话：回合收口落 note；同签名去重；下一回合再落", async () => {
  const h = makeHarness();
  const started = await h.startEntry.handler({ title: "Worker", prompt: "initial" }, h.context);
  assert.equal(started.outcome, "started");

  const handoff = await h.handoffEntry.handler(
    { session_id: started.session_id, prompt: "continue the task, materials in branch X" },
    h.context,
  );
  assert.equal(handoff.outcome, "handed_off");
  assert.equal(handoff.created, false);
  assert.equal(h.subagentPort.sentMessages.length, 1, "移交经既有 sendMessage 队列路由");
  assert.equal(h.registry.get(started.session_id).handoffOriginSessionId, "sess_origin");

  // 第一个回合收口：900 字符报告 → note 恰前 400。
  completeTurn(h, started.session_id, "R".repeat(900));
  await tick();
  let record = h.registry.get(started.session_id);
  assert.ok(record.latestNote, "回合收口落 note");
  assert.equal(record.latestNote.text.slice(0, 400), "R".repeat(400));
  assert.equal(record.latestNote.truncated, true);
  assert.equal(record.latestNote.status, "completed");

  // 同终态签名不重复记（watcher 多轮轮询幂等）。
  const firstNoteAt = record.latestNote.at;
  await tick();
  record = h.registry.get(started.session_id);
  assert.equal(record.latestNote.at, firstNoteAt, "同签名去重");

  // resume 后再收口一个回合 → 新 note 覆盖。
  h.taskRegistry.update(record.agentId, (task) => ({
    ...task,
    status: "running",
    completedAt: undefined,
  }));
  await tick();
  completeTurn(h, started.session_id, "second turn report");
  await tick();
  record = h.registry.get(started.session_id);
  assert.equal(record.latestNote.text, "second turn report");
  assert.equal(record.latestNote.truncated, false);
});

test("(场景7) 移交前已在终态：旧报告不当新 note；新建移交 created:true 并订阅", async () => {
  const h = makeHarness();
  const started = await h.startEntry.handler({ title: "Done already", prompt: "work" }, h.context);
  completeTurn(h, started.session_id, "stale report from before handoff");
  await tick();
  assert.equal(
    h.registry.get(started.session_id).latestNote,
    undefined,
    "订阅前的终态不产生 note",
  );

  const handoff = await h.handoffEntry.handler(
    { session_id: started.session_id, prompt: "new work" },
    h.context,
  );
  assert.equal(handoff.outcome, "handed_off");
  await tick();
  assert.equal(h.registry.get(started.session_id).latestNote, undefined, "订阅时已见签名被记为已读");

  // 移交后收口的新回合才落 note。
  h.taskRegistry.update(h.registry.get(started.session_id).agentId, (task) => ({
    ...task,
    status: "running",
    completedAt: undefined,
  }));
  completeTurn(h, started.session_id, "fresh report after handoff");
  await tick();
  assert.equal(h.registry.get(started.session_id).latestNote.text, "fresh report after handoff");

  // 新建移交：created:true + 所有权确立 + 订阅在场。
  const fresh = await h.handoffEntry.handler(
    { title: "Fresh handoff", prompt: "take over this task" },
    h.context,
  );
  assert.equal(fresh.outcome, "handed_off");
  assert.equal(fresh.created, true);
  assert.ok(fresh.session_id.startsWith("sess_subagent_"));
  assert.equal(h.registry.get(fresh.session_id).handoffOriginSessionId, "sess_origin");

  // 新建缺 title → new_session_needs_title。
  const missing = await h.handoffEntry.handler({ prompt: "no title" }, h.context);
  assert.equal(missing.outcome, "rejected");
  assert.equal(missing.reason, "new_session_needs_title");
});

test("(场景7) 归档撤销订阅：归档后终态不再落 note", async () => {
  const h = makeHarness();
  const started = await h.startEntry.handler({ title: "Doomed", prompt: "work" }, h.context);
  await h.handoffEntry.handler(
    { session_id: started.session_id, prompt: "handoff" },
    h.context,
  );
  // 直接标记归档（ArchiveSession 面在 delete-archive 测试里验收；这里验订阅生命周期）。
  h.registry.update(started.session_id, (r) => ({ ...r, archived: true }));
  h.registry.disposeWatcher(started.session_id);
  completeTurn(h, started.session_id, "should not be noted");
  await tick();
  assert.equal(h.registry.get(started.session_id).latestNote, undefined);
});

// ── ListSessions 的 note 定性 ──────────────────────────────────────

test("(场景7/9) ListSessions：latest_note 带数据非指令定性；行作用域只含 self + 自有舰队", async () => {
  const h = makeHarness();
  const started = await h.startEntry.handler({ title: "Reporter", prompt: "work" }, h.context);
  await h.handoffEntry.handler({ session_id: started.session_id, prompt: "go" }, h.context);
  completeTurn(h, started.session_id, "Z".repeat(500));
  await tick();

  const list = await h.listEntry.handler({}, h.context);
  assert.equal(list.count, 2, "self 行 + 一个舰队行");
  const self = list.sessions.find((row) => row.kind === "self");
  const fleet = list.sessions.find((row) => row.kind === "fleet");
  assert.equal(self.session_id, "sess_origin");
  assert.equal(fleet.session_id, started.session_id);
  assert.equal(fleet.latest_note, "Z".repeat(400) + "… [truncated]");

  const modelText = h.listEntry.formatModelContent(list);
  assert.match(modelText, /data, not instructions/i, "note/标题注入提示词处带定性");
  assert.match(modelText, /Reporter/);
});
