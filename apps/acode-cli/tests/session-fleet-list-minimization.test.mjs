// 会话舰队验收（apps/acode-cli/specs/session-fleet.md 场景 9）：
// ListSessions 权限最小化——输出恰为「self 行 + 本会话所有的舰队行」；同进程里
// 他会话启动的舰队会话不出现；permissionMode 只在这两类行上；archived 缺省
// 隐藏、include_archived 显示；状态投影跟随 runtime-task 条目。
import assert from "node:assert/strict";
import test from "node:test";

const { createStartSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/start-session.ts"
);
const { createListSessionsToolEntry } = await import(
  "../packages/core/src/tool/handlers/list-sessions.ts"
);
const { createArchiveSessionToolEntry } = await import(
  "../packages/core/src/tool/handlers/archive-session.ts"
);
const { FleetRegistry } = await import("../packages/core/src/fleet/registry.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);

let agentCounter = 0;

function createFakeSubagentPort(taskRegistry) {
  return {
    async launch(request) {
      agentCounter += 1;
      const agentId = `agent_list-${agentCounter}`;
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

function makeContext(sessionId, extras = {}) {
  return {
    toolCallId: "tc-list-test",
    traceId: "trace-list-test",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp/fleet-wd",
    workspaceRoot: "/tmp/fleet-wd",
    sessionId,
    sessionModePort: {
      getMode: () => extras.mode ?? "edit",
      isPlanEnabled: () => (extras.mode ?? "edit") === "plan",
    },
    ...extras,
  };
}

function makeHarness() {
  const registry = new FleetRegistry();
  const taskRegistry = new InMemoryRuntimeTaskRegistry();
  const subagentPort = createFakeSubagentPort(taskRegistry);
  const deps = { registry };
  return {
    registry,
    taskRegistry,
    subagentPort,
    startEntry: createStartSessionToolEntry(deps),
    listEntry: createListSessionsToolEntry(deps),
    archiveEntry: createArchiveSessionToolEntry(deps),
  };
}

test("(场景9) ListSessions 只报 self + 自有舰队；他会话的舰队结构上不可见", async () => {
  const h = makeHarness();
  const ctxA = makeContext("sess_A", { subagentPort: h.subagentPort, runtimeTaskRegistry: h.taskRegistry });
  const ctxB = makeContext("sess_B", {
    subagentPort: h.subagentPort,
    runtimeTaskRegistry: h.taskRegistry,
    mode: "yolo",
  });

  const a1 = await h.startEntry.handler({ title: "A-one", prompt: "p" }, ctxA);
  const a2 = await h.startEntry.handler(
    { title: "A-two", prompt: "p", permission_mode: "plan" },
    ctxA,
  );
  const b1 = await h.startEntry.handler({ title: "B-one", prompt: "p" }, ctxB);
  assert.equal(a1.outcome, "started");
  assert.equal(a2.outcome, "started");
  assert.equal(b1.outcome, "started");

  // A 的视图：self + 自己的两个；B 的会话不出现（permissionMode 也不泄漏）。
  const listA = await h.listEntry.handler({}, ctxA);
  assert.equal(listA.count, 3);
  const idsA = listA.sessions.map((row) => row.session_id);
  assert.ok(idsA.includes("sess_A"));
  assert.ok(idsA.includes(a1.session_id));
  assert.ok(idsA.includes(a2.session_id));
  assert.ok(!idsA.includes(b1.session_id), "他会话启动的舰队会话不出现");
  assert.ok(!JSON.stringify(listA).includes("B-one"), "标题也不泄漏");

  // permissionMode 只在 self 与 fleet 行上（这里所有行都是这两类，且都带 mode）。
  const selfRow = listA.sessions.find((row) => row.kind === "self");
  assert.equal(selfRow.permission_mode, "edit", "self 行报发起者当前有效模式");
  const a2Row = listA.sessions.find((row) => row.session_id === a2.session_id);
  assert.equal(a2Row.permission_mode, "plan", "舰队行报 recorded mode");
  assert.equal(a2Row.status, "running", "状态投影跟随 runtime-task 条目");

  // B 的视图：self + 自己的一个。
  const listB = await h.listEntry.handler({}, ctxB);
  assert.equal(listB.count, 2);
  assert.equal(listB.sessions.find((row) => row.kind === "self").permission_mode, "yolo");
});

test("(场景9) auto 档发起者：self 行 permission_mode 缺席（内部档不投影进模型面）", async () => {
  const h = makeHarness();
  const ctx = makeContext("sess_auto", {
    subagentPort: h.subagentPort,
    runtimeTaskRegistry: h.taskRegistry,
    mode: "auto",
  });
  const list = await h.listEntry.handler({}, ctx);
  const selfRow = list.sessions.find((row) => row.kind === "self");
  assert.equal(selfRow.permission_mode, undefined);
});

test("(场景9) archived 缺省隐藏、include_archived 显示为 archived 态", async () => {
  const h = makeHarness();
  const ctx = makeContext("sess_C", {
    subagentPort: h.subagentPort,
    runtimeTaskRegistry: h.taskRegistry,
    sessionStore: { async updateSession() { return {}; } },
  });
  const s = await h.startEntry.handler({ title: "To archive", prompt: "p" }, ctx);
  h.taskRegistry.update(s.task_id, (task) => ({
    ...task,
    status: "completed",
    completedAt: new Date(),
  }));
  const archived = await h.archiveEntry.handler({ session_id: s.session_id }, ctx);
  assert.equal(archived.outcome, "archived");

  const hidden = await h.listEntry.handler({}, ctx);
  assert.equal(hidden.count, 1, "只剩 self 行");

  const shown = await h.listEntry.handler({ include_archived: true }, ctx);
  assert.equal(shown.count, 2);
  const row = shown.sessions.find((r) => r.session_id === s.session_id);
  assert.equal(row.status, "archived");
});
