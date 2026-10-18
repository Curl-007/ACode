import assert from "node:assert/strict";
import { test } from "node:test";
import { listScriptWorkflowRunsPayloadSchema } from "../../../packages/shared/src/acode-protocol-v4/script-workflow-management.ts";
import { V4CapabilityUnsupportedError } from "../packages/bootstrap/src/acode-protocol-v4/commands/handlers/interaction-background.ts";
import { scriptWorkflowManagementHandlers } from "../packages/bootstrap/src/acode-protocol-v4/commands/handlers/script-workflow-management.ts";

// v4 命令组 handler 层测试（t-8 验证门 P3-5/P3-6，A5/A6 覆盖缺口）：
// 依据 apps/acode-cli/specs/script-workflow-management-surface.md §4/§8.2 与 handler
// 文件头注释的错误面承诺。存储层 limit 截断与协议 schema 边界已分别在 adapters /
// packages/shared 有测试；这里钉 handler 自身的两个行为——能力缺席错误面、limit 透传。

const WORKSPACE = { workspacePath: "/tmp/proj", workspaceKey: "/tmp/proj" };

function makeHost(app) {
  return {
    getRecord(sessionId) {
      if (sessionId !== "session-1") return undefined;
      return {
        app,
        traceContext: { traceId: "trace_script_workflow_mgmt" },
        workspace: { workspacePath: WORKSPACE.workspacePath },
        persistence: "immediate",
      };
    },
  };
}

function makeEnvelope(payload) {
  return { sessionId: "session-1", payload };
}

const EMPTY_RUNS_RESULT = { type: "listScriptWorkflowRuns", runs: [], truncated: false };

test("A6 能力缺席：app 未实现 listScriptWorkflowRuns → V4CapabilityUnsupportedError", async () => {
  const host = makeHost({ sessionId: "session-1" });
  await assert.rejects(
    scriptWorkflowManagementHandlers.listScriptWorkflowRuns(
      host,
      makeEnvelope({ workspace: WORKSPACE }),
    ),
    (error) => {
      assert.ok(error instanceof V4CapabilityUnsupportedError);
      assert.equal(error.reasonCode, "fault.command.capabilityUnsupported");
      assert.match(error.message, /listScriptWorkflowRuns/);
      return true;
    },
  );
});

test("A6 能力缺席按方法独立判定：runs 在场不救 definitions 缺席", async () => {
  const host = makeHost({
    sessionId: "session-1",
    async listScriptWorkflowRuns() {
      return EMPTY_RUNS_RESULT;
    },
  });
  await assert.rejects(
    scriptWorkflowManagementHandlers.listScriptWorkflowDefinitions(
      host,
      makeEnvelope({ workspace: WORKSPACE }),
    ),
    (error) =>
      error instanceof V4CapabilityUnsupportedError &&
      /listScriptWorkflowDefinitions/.test(error.message),
  );
});

test("A5 limit 缺省：handler 不发明 limit 键，透传 { cwd } 由 app 层落缺省 50", async () => {
  const calls = [];
  const app = {
    sessionId: "session-1",
    async listScriptWorkflowRuns(input) {
      calls.push(input);
      return EMPTY_RUNS_RESULT;
    },
  };
  const result = await scriptWorkflowManagementHandlers.listScriptWorkflowRuns(
    makeHost(app),
    makeEnvelope({ workspace: WORKSPACE }),
  );
  assert.deepEqual(result, EMPTY_RUNS_RESULT, "app 结果原样上行");
  assert.deepEqual(calls, [{ cwd: "/tmp/proj" }], "缺省不得带 limit 键（app facade 落 50）");
});

test("A5 limit 边界：下界 1 与上限 200 原样透传；>200 由协议 schema 拒绝", async () => {
  const calls = [];
  const app = {
    sessionId: "session-1",
    async listScriptWorkflowRuns(input) {
      calls.push(input);
      return EMPTY_RUNS_RESULT;
    },
  };
  const host = makeHost(app);
  for (const limit of [1, 200]) {
    await scriptWorkflowManagementHandlers.listScriptWorkflowRuns(host, makeEnvelope({
      workspace: WORKSPACE,
      limit,
    }));
  }
  assert.deepEqual(calls, [
    { cwd: "/tmp/proj", limit: 1 },
    { cwd: "/tmp/proj", limit: 200 },
  ], "handler 层是透传语义：边界值不收敛不改写");
  assert.equal(
    listScriptWorkflowRunsPayloadSchema.safeParse({ workspace: WORKSPACE, limit: 201 })
      .success,
    false,
    "超限不收敛而是拒绝——拒绝点在 payload schema（shared 层有同款断言，这里钉完整边界）",
  );
  assert.equal(
    listScriptWorkflowRunsPayloadSchema.safeParse({ workspace: WORKSPACE, limit: 0 }).success,
    false,
  );
});
