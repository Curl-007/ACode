import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 编排方案 Phase 1 的 core 派生/绑定层验收（specs/subagent-topology-persistence.md
 * R2/R3/R8/R9 + 验收场景 2/5/7 的单元面）：事件 → 边命令的纯函数派生（防御性读
 * payload、状态词表校验）、能力探测的全有或全无、收敛入口的缺席降级。
 */

const {
  subagentEdgeCommandFromEvent,
  bindSubagentEdgePersistence,
  convergeSubagentEdgesOnResume,
} = await import("../packages/core/src/subagent/edge-persistence.ts");

// SessionEventType 的字面值（contracts/src/events/session.events.ts）：
// subagent_spawned / subagent_stopped / background_task_completed。
const request = {
  agentType: "general-purpose",
  description: "request description",
  parentToolCallId: "call_9",
  sessionId: "sess_p",
};

test("SubagentSpawned derives a spawn command with lineage fields", () => {
  const command = subagentEdgeCommandFromEvent({
    payload: {
      agentId: "agent_1",
      agentType: "Explore",
      background: true,
      childSessionId: "sess_c1",
      description: "spawn description",
      model: "provider/model",
      outputFile: "/tmp/agent_1.output",
      status: "running",
    },
    request,
    timestampMs: 1_000,
    type: "subagent_spawned",
  });
  assert.deepEqual(command, {
    kind: "spawn",
    agentId: "agent_1",
    agentType: "Explore",
    background: true,
    childSessionId: "sess_c1",
    description: "spawn description",
    model: "provider/model",
    outputFile: "/tmp/agent_1.output",
    parentSessionId: "sess_p",
    parentToolCallId: "call_9",
    startedAt: 1_000,
  });
});

test("spawn derivation falls back to request fields and drops payload without agentId", () => {
  const fallback = subagentEdgeCommandFromEvent({
    payload: { agentId: "agent_2", status: "running" },
    request,
    timestampMs: 1_100,
    type: "subagent_spawned",
  });
  assert.equal(fallback.agentType, "general-purpose");
  assert.equal(fallback.description, "request description");
  assert.equal(fallback.background, false);
  assert.equal(fallback.childSessionId, null);

  assert.equal(
    subagentEdgeCommandFromEvent({
      payload: { status: "running" },
      request,
      timestampMs: 1_200,
      type: "subagent_spawned",
    }),
    undefined,
  );
});

test("SubagentStopped derives settle commands for terminal statuses only", () => {
  const completed = subagentEdgeCommandFromEvent({
    payload: { agentId: "agent_1", childSessionId: "sess_c1", status: "completed", totalTokens: 42 },
    request,
    timestampMs: 2_000,
    type: "subagent_stopped",
  });
  assert.deepEqual(completed, {
    kind: "settle",
    agentId: "agent_1",
    background: false,
    childSessionId: "sess_c1",
    endedAt: 2_000,
    error: null,
    outputFile: null,
    parentSessionId: "sess_p",
    status: "completed",
    totalTokens: 42,
  });

  const failed = subagentEdgeCommandFromEvent({
    payload: { agentId: "agent_1", background: true, error: "boom", outputFile: "/o", status: "failed" },
    request,
    timestampMs: 2_100,
    type: "subagent_stopped",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");
  assert.equal(failed.background, true);
  assert.equal(failed.outputFile, "/o");
  assert.equal(failed.totalTokens, null);

  // R9：非终态词不铸 settle 边（防御事件面未来出现中间态 status）。
  assert.equal(
    subagentEdgeCommandFromEvent({
      payload: { agentId: "agent_1", status: "running" },
      request,
      timestampMs: 2_200,
      type: "subagent_stopped",
    }),
    undefined,
  );
});

test("BackgroundTaskCompleted derives settle only for subagent tasks, reading outputPath/completedAt", () => {
  const stopped = subagentEdgeCommandFromEvent({
    payload: {
      childSessionId: "sess_c1",
      completedAt: new Date(4_000),
      outputPath: "/tmp/agent_1.output",
      status: "stopped",
      taskKind: "subagent",
      taskId: "agent_1",
    },
    request,
    timestampMs: 5_000,
    type: "background_task_completed",
  });
  assert.equal(stopped.kind, "settle");
  assert.equal(stopped.agentId, "agent_1");
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.endedAt, 4_000);
  assert.equal(stopped.outputFile, "/tmp/agent_1.output");
  assert.equal(stopped.background, true);

  // 非 subagent 任务（local_bash / dwf run 等）不铸边。
  assert.equal(
    subagentEdgeCommandFromEvent({
      payload: { status: "completed", taskKind: "local_bash", taskId: "bash_1" },
      request,
      timestampMs: 5_100,
      type: "background_task_completed",
    }),
    undefined,
  );

  // completedAt 缺席/非法时回退事件时间戳。
  const fallback = subagentEdgeCommandFromEvent({
    payload: { status: "lost", taskKind: "subagent", taskId: "agent_2" },
    request,
    timestampMs: 5_200,
    type: "background_task_completed",
  });
  assert.equal(fallback.endedAt, 5_200);
});

test("unknown event types derive nothing", () => {
  assert.equal(
    subagentEdgeCommandFromEvent({
      payload: { agentId: "agent_1" },
      request,
      timestampMs: 1,
      type: "subagent_progress",
    }),
    undefined,
  );
});

test("binding requires both write methods; absence degrades to undefined (all-or-nothing)", async () => {
  const calls = [];
  const fullStore = {
    upsertSubagentEdge: async (input) => {
      calls.push(["upsert", input]);
    },
    settleSubagentEdge: async (input) => {
      calls.push(["settle", input]);
      return true;
    },
  };
  const persistence = bindSubagentEdgePersistence(fullStore);
  assert.ok(persistence);

  await persistence.persist({
    kind: "spawn",
    agentId: "agent_1",
    agentType: "Explore",
    background: false,
    childSessionId: "sess_c1",
    description: "d",
    model: null,
    outputFile: null,
    parentSessionId: "sess_p",
    parentToolCallId: "call_1",
    startedAt: 10,
  });
  assert.equal(calls[0][0], "upsert");
  assert.equal(calls[0][1].status, "running");
  assert.equal(calls[0][1].agentId, "agent_1");

  await persistence.persist({
    kind: "settle",
    agentId: "agent_1",
    background: false,
    childSessionId: "sess_c1",
    endedAt: 20,
    error: null,
    outputFile: null,
    parentSessionId: "sess_p",
    status: "completed",
    totalTokens: 3,
  });
  assert.equal(calls[1][0], "settle");
  assert.equal(calls[1][1].status, "completed");

  // 只有 upsert 没有 settle = 边表永远停 running，比没有表更糟 → 整体降级。
  assert.equal(bindSubagentEdgePersistence({ upsertSubagentEdge: async () => {} }), undefined);
  assert.equal(bindSubagentEdgePersistence({ settleSubagentEdge: async () => {} }), undefined);
  assert.equal(bindSubagentEdgePersistence({}), undefined);
  assert.equal(bindSubagentEdgePersistence(null), undefined);
  assert.equal(bindSubagentEdgePersistence("store"), undefined);
});

test("resume convergence entry degrades silently without the capability", async () => {
  assert.equal(await convergeSubagentEdgesOnResume(undefined, { sessionID: "sess_p" }), 0);
  assert.equal(await convergeSubagentEdgesOnResume({}, { sessionID: "sess_p" }), 0);

  let seen = null;
  const store = {
    convergeSubagentEdges: async (input) => {
      seen = input;
      return 3;
    },
  };
  assert.equal(await convergeSubagentEdgesOnResume(store, { now: 9, sessionID: "sess_p" }), 3);
  assert.deepEqual(seen, { now: 9, sessionID: "sess_p" });

  // 返回值非数字（畸形替身）不炸调用方。
  assert.equal(
    await convergeSubagentEdgesOnResume({ convergeSubagentEdges: async () => "many" }, { sessionID: "s" }),
    0,
  );
});
