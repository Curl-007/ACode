import assert from "node:assert/strict";
import test from "node:test";

const { createScriptWorkflowToolPort } =
  await import("../packages/cli-workflow/src/script-workflow-tool-port.ts");

test("SWF-02: completed getTask 从 durable workflow_completed 事件返回完整脚本结果", async () => {
  const store = {
    async createScriptWorkflowActivity() {},
    async createScriptWorkflowRun() {},
    async getScriptWorkflowRun() {
      return {
        budgetSpent: 0,
        createdAt: 1,
        cwd: "/tmp",
        id: "wf_result_review",
        kind: "script",
        name: "review",
        scriptHash: "hash",
        scriptPath: "/tmp/review.workflow.js",
        startedAt: 1,
        status: "completed",
        updatedAt: 2,
      };
    },
    async listScriptWorkflowActivities() {
      return [];
    },
    async listScriptWorkflowEvents() {
      return [{ payload: { result: { ok: true, count: 2 } }, type: "workflow_completed" }];
    },
  };
  const port = createScriptWorkflowToolPort({
    fileSystemPort: {},
    getRuntime: () => undefined,
    sessionId: "sess_result",
    sessionStore: store,
    storageRoot: "/tmp",
    traceContext: { traceId: "trace_result" },
    workingDirectory: "/tmp",
  });
  const task = await port.getTask("wf_result_review");
  assert.equal(task.status, "completed");
  assert.match(task.output.response, /result: \{"ok":true,"count":2\}/);
});
