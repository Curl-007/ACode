import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowRunCommandContext } from "../packages/workflow-run-command/src/index.ts";

const TRACE = { traceId: "trace_workflow_run_command" };

function deps(overrides = {}) {
  return {
    traceContext: TRACE,
    prepareUserExecutionBoundary: async () => {},
    getRuntime: () => ({
      trackResumedDynamicWorkflowRun: async () => {},
      startSavedWorkflowRun: async () => ({ ok: true }),
      amendWorkflowRunSettings: async () => ({ ok: true }),
    }),
    ...overrides,
  };
}

test("resume 只在 port 成功后读取 runtime 并追踪", async () => {
  const order = [];
  const tracked = [];
  const context = createWorkflowRunCommandContext(
    deps({
      resumePort: {
        async resume(runId) {
          order.push(`port:${runId}`);
          return { ok: true, runId, toolCallId: "call_resume" };
        },
      },
      getRuntime() {
        order.push("runtime");
        return {
          async trackResumedDynamicWorkflowRun(input) {
            order.push("track");
            tracked.push(input);
          },
          startSavedWorkflowRun: async () => ({ ok: true }),
          amendWorkflowRunSettings: async () => ({ ok: true }),
        };
      },
    }),
  );

  const result = await context.resumeWorkflowRun({ workId: "dwf_1", name: "resumed" });
  assert.deepEqual(result, { ok: true, runId: "dwf_1", toolCallId: "call_resume" });
  assert.deepEqual(order, ["port:dwf_1", "runtime", "track"]);
  assert.deepEqual(tracked, [
    {
      runId: "dwf_1",
      toolCallId: "call_resume",
      name: "resumed",
      traceContext: TRACE,
    },
  ]);
});

test("resume 拒绝不读取 runtime，也不注册追踪", async () => {
  let runtimeReads = 0;
  const refused = { ok: false, reason: "not_resumable" };
  const context = createWorkflowRunCommandContext(
    deps({
      resumePort: { resume: async () => refused },
      getRuntime() {
        runtimeReads++;
        throw new Error("runtime must stay lazy");
      },
    }),
  );
  assert.deepEqual(await context.resumeWorkflowRun({ workId: "dwf_2" }), refused);
  assert.equal(runtimeReads, 0);
});

for (const [method, runtimeMethod, input] of [
  ["startSavedWorkflow", "startSavedWorkflowRun", { name: "saved", scope: "project" }],
  ["amendWorkflowRunSettings", "amendWorkflowRunSettings", { runId: "dwf_3", maxConcurrency: 2 }],
]) {
  test(`${method} 固定 prepare → runtime → execute 顺序`, async () => {
    const order = [];
    const result = { ok: true };
    const context = createWorkflowRunCommandContext(
      deps({
        prepareUserExecutionBoundary: async ({ traceContext }) => {
          assert.equal(traceContext, TRACE);
          order.push("prepare");
        },
        getRuntime() {
          order.push("runtime");
          return {
            trackResumedDynamicWorkflowRun: async () => {},
            [runtimeMethod]: async (actual) => {
              order.push("execute");
              assert.deepEqual(actual, { ...input, traceContext: TRACE });
              return result;
            },
          };
        },
      }),
    );
    assert.deepEqual(await context[method](input), result);
    assert.deepEqual(order, ["prepare", "runtime", "execute"]);
  });
}

test("prepare 失败时不读取 runtime，也不执行 command", async () => {
  let runtimeReads = 0;
  const context = createWorkflowRunCommandContext(
    deps({
      prepareUserExecutionBoundary: async () => {
        throw new Error("prepare failed");
      },
      getRuntime() {
        runtimeReads++;
        throw new Error("runtime must stay lazy");
      },
    }),
  );
  await assert.rejects(context.startSavedWorkflow({ name: "saved" }), /prepare failed/);
  assert.equal(runtimeReads, 0);
});
