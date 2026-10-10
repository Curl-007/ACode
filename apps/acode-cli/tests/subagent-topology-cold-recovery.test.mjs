import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 编排方案 Phase 1 的读侧验收（specs/subagent-topology-persistence.md R5/R8 +
 * 验收场景 4/5/6 的合成层面）：冷启动（parentEvents 为空、无 live 投影）时边表终态
 * 压过 async_launched/outcome 兜底，目录不再整体退化成 "lost"；边缺席时行为与既有
 * 三源合成一致；边的 running 不构成 live 事实、终态抑制乐观 running 推断。
 */

const {
  collectSubagentChildSessionIds,
  projectSessionSubagents,
  readPersistedSubagentEdges,
} = await import("../packages/bootstrap/src/acode-protocol/subagent-session-query.ts");
const { createSessionId } = await import("../packages/contracts/src/interfaces/shared.ts");

const childSessionId = createSessionId("subagent_agent_x");

/** 冷目录 fixture：后台 Agent 的 launch ACK tool part 已落盘，事件（内存）全丢。 */
function coldFixtures(edges) {
  const parentSession = { id: "sess_p", revert: undefined };
  const messages = [
    {
      info: { id: "msg_1", role: "user" },
      parts: [
        {
          type: "tool",
          callID: "call_1",
          tool: "Agent",
          metadata: {},
          state: {
            status: "completed",
            input: { description: "deep search", run_in_background: true },
            output: "agentId: agent_x (background agent launched)",
            time: { end: 101, start: 100 },
          },
        },
      ],
    },
  ];
  const childSession = {
    id: childSessionId,
    taskType: "subagent_child",
    time: { updated: 500 },
  };
  return {
    revision: 1,
    parentSession,
    messages,
    childSessionsById: new Map([[childSessionId, childSession]]),
    childMessagesById: new Map([[childSessionId, []]]),
    childProjectionsById: new Map(),
    ...(edges ? { edges } : {}),
  };
}

const edge = (overrides = {}) => ({
  agentId: "agent_x",
  background: true,
  childSessionId,
  endedAt: 9_999,
  parentSessionId: "sess_p",
  parentToolCallId: "call_1",
  startedAt: 900,
  status: "lost",
  ...overrides,
});

test("cold recovery: a converged lost edge surfaces ended(lost) with edge timestamps", () => {
  const projection = projectSessionSubagents(coldFixtures([edge()]));
  assert.equal(projection.running.length, 0);
  assert.equal(projection.ended.length, 1);
  const ended = projection.ended[0];
  assert.equal(ended.status, "lost");
  assert.equal(ended.childSessionId, childSessionId);
  assert.equal(ended.agentId, "agent_x");
  assert.equal(ended.endedAt, 9_999);
  assert.equal(ended.startedAt, 900);
  assert.equal(ended.title, "deep search");
});

test("cold recovery: pre-crash terminal edges restore the real outcome, not lost", () => {
  const completed = projectSessionSubagents(coldFixtures([edge({ status: "completed" })]));
  assert.equal(completed.ended[0].status, "success");

  const failed = projectSessionSubagents(
    coldFixtures([edge({ error: "boom", status: "failed" })]),
  );
  assert.equal(failed.ended[0].status, "failed");

  const stopped = projectSessionSubagents(coldFixtures([edge({ status: "stopped" })]));
  assert.equal(stopped.ended[0].status, "cancelled");
});

test("without edges the projection keeps today's behavior byte for byte", () => {
  // 后台候选、无 stop relation、无 child outcome → 既有乐观 running 推断（:310-318）。
  const projection = projectSessionSubagents(coldFixtures(undefined));
  assert.equal(projection.ended.length, 0);
  assert.equal(projection.running.length, 1);
  assert.equal(projection.running[0].status, "running");
});

test("a stale running edge is not a live fact: optimism stays until convergence", () => {
  const projection = projectSessionSubagents(coldFixtures([edge({ endedAt: undefined, status: "running" })]));
  assert.equal(projection.ended.length, 0);
  assert.equal(projection.running.length, 1);
  assert.equal(projection.running[0].status, "running");
});

test("collectSubagentChildSessionIds merges edge-only child ids", () => {
  const fixtures = coldFixtures(undefined);
  const ids = collectSubagentChildSessionIds(
    fixtures.parentSession,
    fixtures.messages,
    undefined,
    [edge(), edge({ agentId: "agent_y", childSessionId: "sess_edge_only" })],
  );
  assert.ok(ids.includes(childSessionId));
  assert.ok(ids.includes("sess_edge_only"));
  assert.equal(new Set(ids).size, ids.length);
});

test("readPersistedSubagentEdges probes the store capability and normalizes rows defensively", async () => {
  const rows = [
    {
      agent_id: "agent_x",
      parent_session_id: "sess_p",
      child_session_id: childSessionId,
      agent_type: null,
      parent_tool_call_id: "call_1",
      description: "deep search",
      background: 1,
      model: null,
      output_file: null,
      status: "lost",
      started_at: 900,
      ended_at: 9_999,
      total_tokens: null,
      error: "session_resumed",
    },
    // 坏行：缺主键 / 缺状态 → 不采用也不清存储（消费边界防御纪律）。
    { agent_id: "", status: "lost" },
    { agent_id: "agent_z" },
    "not-a-row",
  ];
  const store = { readSubagentEdges: async () => rows };
  const edges = await readPersistedSubagentEdges(store, "sess_p");
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], {
    agentId: "agent_x",
    background: true,
    childSessionId,
    description: "deep search",
    endedAt: 9_999,
    error: "session_resumed",
    parentSessionId: "sess_p",
    parentToolCallId: "call_1",
    startedAt: 900,
    status: "lost",
  });

  // 能力缺席 / 非对象 / 抛错 / 非数组 → 空数组（降级不伪装成功）。
  assert.deepEqual(await readPersistedSubagentEdges({}, "sess_p"), []);
  assert.deepEqual(await readPersistedSubagentEdges(null, "sess_p"), []);
  assert.deepEqual(
    await readPersistedSubagentEdges(
      {
        readSubagentEdges: async () => {
          throw new Error("db gone");
        },
      },
      "sess_p",
    ),
    [],
  );
  assert.deepEqual(
    await readPersistedSubagentEdges({ readSubagentEdges: async () => "nope" }, "sess_p"),
    [],
  );
});
