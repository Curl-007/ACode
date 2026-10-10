import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowWiring } from "../packages/bootstrap/src/app/workflow-wiring.ts";
import { createWorkflowAppFacade } from "../packages/bootstrap/src/app/workflow-app-facade.ts";
import { reduceWorkflowRunsState } from "../../../packages/shared/src/acode-protocol-v4/workflow-runs-reducer.ts";
import { createSqliteSessionStore } from "../packages/adapters/src/storage/session-store/sqlite-session-store.ts";
import { createRuntimeModel } from "../packages/core/src/runtime/methods/runtime-model.ts";

// 与生产 child factory 解析同一个 Core 公开入口，mock 只替换外部模型执行边界。
const { AgentRuntime } = await import("../packages/core/dist/index.js");

const SESSION = "sess_workflow_boundary";
const TRACE = { traceId: "trace_workflow_boundary" };
const unexpected = () => {
  throw new Error("边界之外的端口不得调用");
};

function scriptStore(runs = []) {
  const calls = [];
  return {
    calls,
    store: {
      createScriptWorkflowRun: unexpected,
      createScriptWorkflowActivity: unexpected,
      getScriptWorkflowRun: async () => undefined,
      async listScriptWorkflowRuns(input) {
        calls.push(input);
        return input.statuses ? [] : runs;
      },
      async listScriptWorkflowEvents({ runId }) {
        return [{ id: `${runId}_started`, runId, type: "workflow_started", payload: {} }];
      },
    },
  };
}

function facadeDeps(overrides = {}) {
  return {
    getRuntime: unexpected,
    prepareUserExecutionBoundary: unexpected,
    sessionStore: {},
    sessionId: SESSION,
    traceContext: TRACE,
    ...overrides,
  };
}

function wiringDeps(overrides = {}) {
  return {
    appOptions: {},
    appVersion: "test",
    configResult: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    logger: {},
    modelFactory: unexpected,
    permissionService: {},
    prepareUserExecutionBoundary: unexpected,
    getRuntime: unexpected,
    runtimeConfig: {},
    sessionId: SESSION,
    sessionStore: {},
    storageRoot: "/storage",
    traceContext: TRACE,
    workingDirectory: "/workspace",
    executionPort: {},
    concurrency: {},
    ...overrides,
  };
}

function project(payloads) {
  let state;
  for (const payload of payloads) state = reduceWorkflowRunsState(state, payload) ?? state;
  return state?.runs ?? [];
}

test("workflow wiring 构造保持惰性；缺少 DWF journal 时脚本 facade 仍可使用", async () => {
  const { store } = scriptStore();
  let runtimeReads = 0;
  let runtimeReady = false;
  const wiring = createWorkflowWiring(
    wiringDeps({
      sessionStore: store,
      getRuntime() {
        runtimeReads++;
        assert.equal(runtimeReady, true, "构造不得访问尚未就绪的父 runtime");
        return {};
      },
    }),
  );
  assert.equal(runtimeReads, 0);
  assert.equal(wiring.dynamicWorkflowRunPort, undefined);
  assert.equal(typeof wiring.scriptWorkflowFacade.workflowPort.start, "function");
  runtimeReady = true;
  const status = await wiring.scriptWorkflowFacade.scriptWorkflowStatus({ runId: "wf_missing" });
  assert.equal(status.response, "No workflow run found.");
  assert.equal(status.traceId, TRACE.traceId);
  assert.equal(runtimeReads, 1);
});

test("script-only app 仍能发现并冷回放脚本，按父会话隔离并保留 exclude", async () => {
  const { store, calls } = scriptStore([
    {
      id: "wf_visible",
      status: "completed",
      updatedAt: 30,
      name: "visible",
      toolCallId: "call_visible",
    },
    { id: "wf_live", status: "completed", updatedAt: 20, name: "live" },
  ]);
  const facade = createWorkflowAppFacade(facadeDeps({ sessionStore: store }));
  const summaries = await facade.listDynamicWorkflowRuns({ limit: 1 });
  assert.deepEqual(
    summaries.map(({ runId }) => runId),
    ["wf_visible"],
  );
  assert.equal(summaries[0].dialect, "script");
  assert.equal(summaries[0].toolCallId, "call_visible");
  const replay = await facade.replayDynamicWorkflowRuns({ excludeRunIds: new Set(["wf_live"]) });
  const projected = project(replay);
  assert.deepEqual(
    projected.map(({ runId }) => runId),
    ["wf_visible"],
  );
  assert.equal(projected[0].status, "completed");
  assert.equal(projected[0].dialect, "script");
  assert.ok(calls.every(({ parentSessionId }) => parentSessionId === SESSION));
  assert.equal(facade.resumeWorkflowRun, undefined);
  assert.equal(facade.startSavedWorkflow, undefined);
  assert.equal(facade.listDynamicWorkflowRunEvents, undefined);
});

test("两源发现按 updatedAt 归并再 limit；冷回放保留 DWF 在前并传递 exclude", async () => {
  const { store } = scriptStore([
    { id: "wf_new", status: "completed", updatedAt: 40, name: "new" },
    { id: "wf_old", status: "completed", updatedAt: 10, name: "old" },
  ]);
  const calls = [];
  const dynamicWorkflowRunPort = {
    async listRunsForSession(limit) {
      assert.equal(this, dynamicWorkflowRunPort, "抽取不能丢失端口 this");
      calls.push({ kind: "list", limit });
      return [{ runId: "dwf_middle", updatedAt: 25 }, { runId: "dwf_undated" }];
    },
    async replayProgressForSession(input) {
      assert.equal(this, dynamicWorkflowRunPort);
      calls.push({ kind: "replay", input });
      return [{ runId: "dwf_middle", type: "dwf-sentinel" }];
    },
  };
  const facade = createWorkflowAppFacade(
    facadeDeps({ sessionStore: store, dynamicWorkflowRunPort }),
  );
  assert.deepEqual(
    (await facade.listDynamicWorkflowRuns({})).map(({ runId }) => runId),
    ["wf_new", "dwf_middle", "wf_old", "dwf_undated"],
  );
  assert.deepEqual(
    (await facade.listDynamicWorkflowRuns({ limit: 2 })).map(({ runId }) => runId),
    ["wf_new", "dwf_middle"],
  );
  const input = { excludeRunIds: new Set(["wf_new"]) };
  const replay = await facade.replayDynamicWorkflowRuns(input);
  assert.equal(replay[0].type, "dwf-sentinel");
  assert.deepEqual([...new Set(replay.map(({ runId }) => runId))], ["dwf_middle", "wf_old"]);
  assert.equal(calls.at(-1).input, input);
  assert.deepEqual(
    calls.filter(({ kind }) => kind === "list").map(({ limit }) => limit),
    [undefined, 2],
  );
});

test("resume 等端口成功后重新追踪；拒绝与失败不读取 runtime", async () => {
  const order = [];
  const resume = Promise.withResolvers();
  const tracked = [];
  const facade = createWorkflowAppFacade(
    facadeDeps({
      dynamicWorkflowRunPort: {
        resume: (runId) => {
          order.push(`resume:${runId}`);
          return resume.promise;
        },
      },
      getRuntime() {
        order.push("runtime");
        return {
          async trackResumedDynamicWorkflowRun(input) {
            order.push("track");
            tracked.push(input);
          },
        };
      },
    }),
  );
  const pending = facade.resumeWorkflowRun({ workId: "dwf_1", name: "resumed" });
  assert.deepEqual(order, ["resume:dwf_1"]);
  const result = { ok: true, runId: "dwf_1", toolCallId: "call_resume" };
  resume.resolve(result);
  assert.equal(await pending, result);
  assert.deepEqual(order, ["resume:dwf_1", "runtime", "track"]);
  assert.deepEqual(tracked, [
    { runId: "dwf_1", toolCallId: "call_resume", name: "resumed", traceContext: TRACE },
  ]);
  const refused = { ok: false, reason: "not_resumable" };
  const refusalFacade = createWorkflowAppFacade(
    facadeDeps({ dynamicWorkflowRunPort: { resume: async () => refused } }),
  );
  assert.equal(await refusalFacade.resumeWorkflowRun({ workId: "dwf_2" }), refused);
  const failedFacade = createWorkflowAppFacade(
    facadeDeps({
      dynamicWorkflowRunPort: {
        resume: async () => {
          throw new Error("resume failed");
        },
      },
    }),
  );
  await assert.rejects(failedFacade.resumeWorkflowRun({ workId: "dwf_3" }), /resume failed/);
});

for (const [method, runtimeMethod, input] of [
  [
    "startSavedWorkflow",
    "startSavedWorkflowRun",
    { name: "saved", scope: "project", args: { value: 1 } },
  ],
  [
    "amendWorkflowRunSettings",
    "amendWorkflowRunSettings",
    { runId: "dwf_before", maxConcurrency: 2 },
  ],
]) {
  test(`${method} 等 prepare 成功后才获取 runtime；边界失败不启动`, async () => {
    const order = [];
    const ready = Promise.withResolvers();
    const result = { ok: true };
    const facade = createWorkflowAppFacade(
      facadeDeps({
        dynamicWorkflowRunPort: { amend: unexpected, getScript: unexpected },
        prepareUserExecutionBoundary: (options) => {
          assert.deepEqual(options, { traceContext: TRACE });
          order.push("prepare");
          return ready.promise;
        },
        getRuntime() {
          order.push("runtime");
          return {
            [runtimeMethod]: async (actual) => {
              order.push("execute");
              assert.deepEqual(actual, { ...input, traceContext: TRACE });
              return result;
            },
          };
        },
      }),
    );
    const pending = facade[method](input);
    assert.deepEqual(order, ["prepare"]);
    ready.resolve();
    assert.equal(await pending, result);
    assert.deepEqual(order, ["prepare", "runtime", "execute"]);
    const blocked = createWorkflowAppFacade(
      facadeDeps({
        dynamicWorkflowRunPort: { amend: unexpected, getScript: unexpected },
        prepareUserExecutionBoundary: async () => {
          throw new Error("prepare failed");
        },
      }),
    );
    await assert.rejects(blocked[method](input), /prepare failed/);
  });
}

test("产物与工作区读面整组注册；缺一个成员不能暴露半可用能力", () => {
  const artifacts = [
    "listDynamicWorkflowRunArtifacts",
    "listDynamicWorkflowRunArtifactItems",
    "readDynamicWorkflowRunArtifact",
  ];
  const workspace = ["listDynamicWorkflowRunWorkspaceNodes", "readDynamicWorkflowRunNodeResult"];
  for (const missing of ["listArtifacts", "listArtifactItems", "readArtifact"]) {
    const port = {
      listArtifacts: unexpected,
      listArtifactItems: unexpected,
      readArtifact: unexpected,
    };
    delete port[missing];
    const facade = createWorkflowAppFacade(facadeDeps({ dynamicWorkflowRunPort: port }));
    for (const method of artifacts) assert.equal(facade[method], undefined);
  }
  for (const missing of ["listWorkspaceNodes", "readWorkspaceNodeResult"]) {
    const port = { listWorkspaceNodes: unexpected, readWorkspaceNodeResult: unexpected };
    delete port[missing];
    const facade = createWorkflowAppFacade(facadeDeps({ dynamicWorkflowRunPort: port }));
    for (const method of workspace) assert.equal(facade[method], undefined);
  }
  const absent = createWorkflowAppFacade(facadeDeps());
  assert.equal(absent.listDynamicWorkflowRuns, undefined);
  assert.equal(absent.replayDynamicWorkflowRuns, undefined);
  const incompleteAmend = createWorkflowAppFacade(
    facadeDeps({ dynamicWorkflowRunPort: { amend: unexpected } }),
  );
  assert.equal(incompleteAmend.amendWorkflowRunSettings, undefined);
});

test("公开读面完整转发参数与返回值，不触发用户执行边界", async () => {
  const calls = [];
  const port = Object.fromEntries(
    [
      "listEvents",
      "listArtifacts",
      "listArtifactItems",
      "readArtifact",
      "listWorkspaceNodes",
      "readWorkspaceNodeResult",
    ].map((name) => [
      name,
      (...args) => {
        const result = { name, args };
        calls.push(result);
        return result;
      },
    ]),
  );
  const facade = createWorkflowAppFacade(facadeDeps({ dynamicWorkflowRunPort: port }));
  const results = await Promise.all([
    facade.listDynamicWorkflowRunEvents({ runId: "run", afterSequence: 4, limit: 3 }),
    facade.listDynamicWorkflowRunArtifacts({ runId: "run" }),
    facade.listDynamicWorkflowRunArtifactItems({
      runId: "run",
      artifactId: "artifact",
      afterSequence: 2,
      limit: 5,
    }),
    facade.readDynamicWorkflowRunArtifact({ runId: "run", artifactId: "artifact", version: 7 }),
    facade.listDynamicWorkflowRunWorkspaceNodes({ runId: "run" }),
    facade.readDynamicWorkflowRunNodeResult({
      runId: "run",
      siteId: "site",
      ordinal: 2,
      maxBytes: 64,
    }),
  ]);
  assert.ok(results.every((result, index) => result === calls[index]));
  assert.deepEqual(calls, [
    { name: "listEvents", args: ["run", { afterSequence: 4, limit: 3 }] },
    { name: "listArtifacts", args: ["run"] },
    { name: "listArtifactItems", args: ["run", "artifact", { afterSequence: 2, limit: 5 }] },
    { name: "readArtifact", args: ["run", "artifact", 7] },
    { name: "listWorkspaceNodes", args: ["run"] },
    { name: "readWorkspaceNodeResult", args: ["run", "site", 2, { maxBytes: 64 }] },
  ]);
});

test(
  "真实 wiring 的脚本 child 与 DWF actor 共享 live model factory 和父进度入口",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acode-workflow-wiring-"));
    const store = createSqliteSessionStore({ dbPath: join(directory, "sessions.db") });
    let wiring;
    t.after(async () => {
      await wiring?.dynamicWorkflowRunPort?.close();
      store.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    });
    await store.createSession({
      directory,
      id: SESSION,
      projectID: "proj_boundary",
      slug: SESSION,
      title: "boundary",
      version: "v4",
    });
    const parentProgress = [];
    const modelReads = [];
    let version = "first";
    let ready = false;
    let runtimeReads = 0;
    const selection = { providerId: "fixture", modelId: "live" };
    const runtime = {
      getActiveTurnInfo: () => undefined,
      getSessionModelSelection: () => selection,
      getSessionEventStore: () => ({}),
      createChildClientPorts: () => ({}),
      notifyExternalChildSessionEvent: async () => {},
      ensureSessionPersistedForExternalActivity: async () => {},
      recordDynamicWorkflowRunProgress: async (progress) => {
        parentProgress.push(progress);
      },
      trackResidencyBlockingWork: (work) => work,
    };
    const modelFactory = (input) => {
      modelReads.push({ selection: input.selection, version });
      return {
        providerId: "fixture",
        modelId: "live",
        generateText: async () => ({ text: version }),
      };
    };
    // 真实 child constructor、driver、脚本沙箱、journal 与 projection 都执行；模型轮只返回可控文本。
    t.mock.method(
      AgentRuntime.prototype,
      "ensureSessionPersistedForExternalActivity",
      async function () {
        if (!(await store.getSession(this.sessionId))) {
          await store.createSession({
            directory,
            id: this.sessionId,
            parentID: SESSION,
            projectID: "proj_boundary",
            slug: this.sessionId,
            title: "child",
            version: "v4",
          });
        }
      },
    );
    t.mock.method(AgentRuntime.prototype, "executeTurn", async function () {
      const model = createRuntimeModel(this, { selection: this.getSessionModelSelection() });
      const response = await model.generateText({ messages: [] });
      return {
        response: response.text,
        traceId: TRACE.traceId,
        turnId: "turn_boundary",
        usage: {},
      };
    });
    const fileSystemPort = {
      readTextFile: async () => ({
        content:
          'export const meta = { name: "shared", description: "shared factory", phases: [] }; return await agent("script-child");',
        truncated: false,
      }),
    };
    wiring = createWorkflowWiring(
      wiringDeps({
        appOptions: {
          contextSourcePort: {},
          executionPort: {},
          fileSystemPort,
          httpClientPort: {},
        },
        configResult: {
          config: { network: {}, features: { skill: false }, skills: { enabled: false } },
        },
        fileSystemPort,
        httpClientPort: {},
        modelFactory,
        sessionStore: store,
        runtimeConfig: {
          workingDirectory: directory,
          modelSelection: selection,
          memory: { enabled: false },
        },
        workingDirectory: directory,
        storageRoot: directory,
        logger: {
          info() {},
          warn() {},
          debug() {},
          error() {},
          child() {
            return this;
          },
        },
        concurrency: {
          subscribe: () => () => {},
          tryAdmit: () => ({ onStatus() {}, release() {} }),
          admit: unexpected,
        },
        prepareUserExecutionBoundary: async () => {},
        getRuntime() {
          runtimeReads++;
          assert.equal(ready, true);
          return runtime;
        },
      }),
    );
    assert.equal(runtimeReads, 0);
    assert.equal(modelReads.length, 0);
    ready = true;
    const scripted = await wiring.scriptWorkflowFacade.runWorkflowScript({
      scriptPath: join(directory, "shared.workflow.js"),
      runId: "wf_shared",
    });
    assert.equal(
      scripted.status,
      "completed",
      JSON.stringify((await store.getScriptWorkflowRun("wf_shared"))?.failure),
    );
    assert.equal(modelReads[0]?.version, "first");
    version = "registry-updated";
    const launched = await wiring.dynamicWorkflowRunPort.submit({
      cwd: directory,
      parentSessionId: SESSION,
      trace: TRACE,
      scriptText: 'const worker = agent("worker"); return await worker.ask("dwf-child");',
    });
    assert.equal(launched.ok, true);
    const task = await wiring.dynamicWorkflowRunPort.waitForTask(launched.runId);
    assert.equal(task.status, "completed", JSON.stringify(task.error));
    assert.deepEqual(
      modelReads.map(({ version }) => version),
      ["first", "registry-updated"],
    );
    assert.ok(
      modelReads.every(
        (entry) =>
          entry.selection.providerId === selection.providerId &&
          entry.selection.modelId === selection.modelId,
      ),
    );
    const projected = project(parentProgress);
    assert.deepEqual(
      new Set(projected.map(({ runId }) => runId)),
      new Set(["wf_shared", launched.runId]),
    );
    assert.ok(projected.every(({ status }) => status === "completed"));
  },
);
