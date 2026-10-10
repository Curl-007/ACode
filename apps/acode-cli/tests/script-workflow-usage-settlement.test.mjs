import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const { createSqliteSessionStore } =
  await import("../packages/adapters/src/storage/session-store/sqlite-session-store.ts");
const { ScriptWorkflowRuntime } =
  await import("../packages/cli-workflow/src/script-workflow-runtime.ts");
const { emptyScriptWorkflowStats } =
  await import("../packages/cli-workflow/src/script-workflow-format.ts");

async function fixture(t, mode = "success", options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "acode-workflow-usage-"));
  const dbPath = join(dir, "sessions.db");
  const store = createSqliteSessionStore({ dbPath });
  const raw = new DatabaseSync(dbPath);
  t.after(async () => {
    raw.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const sessionId = "sess_usage_parent";
  await store.createSession({
    directory: dir,
    id: sessionId,
    projectID: "proj_usage",
    slug: sessionId,
    title: "usage fixture",
    version: "v4",
  });
  const controller = new AbortController();
  const warnings = [];
  let childIndex = 0;
  const runtime = new ScriptWorkflowRuntime({
    createAgentRuntime: ({ childSessionId }) => ({
      async ensureSessionPersistedForExternalActivity() {
        const childNumber = ++childIndex;
        await store.createSession({
          directory: dir,
          id: childSessionId,
          parentID: sessionId,
          projectID: "proj_usage",
          slug: childSessionId,
          title: "usage child",
          version: "v4",
        });
        const messageId = `msg_usage_${childNumber}`;
        await store.saveMessage({
          agent: "fixture",
          id: messageId,
          mode: "build",
          parentID: `msg_parent_${childNumber}`,
          role: "assistant",
          sessionID: childSessionId,
          time: { created: Date.now() },
          tokens: {
            cache: { read: 0, write: 0 },
            input: 40,
            output: 50,
            reasoning: 10,
            total: 100,
          },
        });
        for (let index = 0; index < 2; index += 1) {
          await store.savePart({
            callID: `call_usage_${childNumber}_${index}`,
            id: `part_usage_${childNumber}_${index}`,
            messageID: messageId,
            sessionID: childSessionId,
            state: {
              input: {},
              metadata: {},
              output: "fixture",
              status: "completed",
              time: { end: Date.now(), start: Date.now() },
              title: "fixture",
            },
            tool: "Read",
            type: "tool",
          });
        }
      },
      async executeTurn() {
        if (mode === "failed") throw new Error("provider turn failed");
        if (mode === "cancelled") {
          controller.abort(new Error("run cancelled"));
          throw controller.signal.reason;
        }
        return {
          response: mode === "schema-invalid" ? "not JSON" : "result",
          traceId: "trace_usage_child",
          turnId: "turn_usage_child",
        };
      },
      getSessionModelSelection() {
        return undefined;
      },
    }),
    fileSystemPort: {
      async readTextFile() {
        return {
          content:
            'export const meta = { name: "usage", description: "usage fixture", phases: [] };' +
            (options.scriptBody ??
              (mode === "schema-invalid"
                ? 'return await agent("work", { schema: { type: "object" } });'
                : 'return await agent("work");')),
          truncated: false,
        };
      },
    },
    logger: { warn: (message, context) => warnings.push({ context, message }) },
    prepareUserExecutionBoundary: async () => {},
    progressAdapter: options.progressAdapter,
    runtime: { ensureSessionPersistedForExternalActivity: async () => {} },
    sessionId,
    sessionStore: store,
    traceContext: { traceId: "trace_usage" },
    workingDirectory: dir,
  });
  return { controller, dbPath, dir, raw, runtime, sessionId, store, warnings };
}

const delta = () => ({
  ...emptyScriptWorkflowStats(),
  agentCalls: 1,
  toolCalls: 2,
  tokens: { cacheRead: 0, cacheWrite: 0, input: 40, output: 50, reasoning: 10, total: 100 },
});

for (const mode of ["success", "failed", "cancelled", "schema-invalid"]) {
  test(`SWF-07: real runtime/SQLite retains child usage once on ${mode}`, async (t) => {
    const life = await fixture(t, mode);
    const result = await life.runtime.run(
      { runId: `wf_usage_${mode}`, scriptPath: join(life.dir, "usage.workflow.js") },
      { abortSignal: life.controller.signal },
    );
    const run = await life.store.getScriptWorkflowRun(result.runId);
    const activities = await life.store.listScriptWorkflowActivities({ runId: result.runId });
    const events = await life.store.listScriptWorkflowEvents({ runId: result.runId });
    assert.equal(
      result.status,
      mode === "success" ? "completed" : mode === "cancelled" ? "cancelled" : "failed",
    );
    assert.equal(run.budgetSpent, 100);
    assert.equal(run.stats.tokens.total, 100);
    assert.equal(run.stats.toolCalls, 2);
    assert.equal(run.stats.agentCalls, 1);
    assert.equal(run.stats.failedAgentCalls, mode === "success" ? 0 : 1);
    assert.equal(activities.length, 1);
    assert.equal(events.filter((event) => event.type === "workflow_usage").length, 1);
    assert.equal(
      events.find((event) => event.type === "workflow_usage").activityId,
      activities[0].id,
    );
    assert.ok(events.findIndex((event) => event.type === "workflow_usage") < events.length - 1);
  });
}

test("SWF-07: parallel agent completion never loses or duplicates usage", async (t) => {
  const life = await fixture(t, "success", {
    scriptBody:
      'return await parallel([() => agent("one"), () => agent("two"), () => agent("three")]);',
  });
  const result = await life.runtime.run({
    runId: "wf_usage_parallel",
    scriptPath: join(life.dir, "usage.workflow.js"),
  });
  assert.equal(result.status, "completed");
  const run = await life.store.getScriptWorkflowRun(result.runId);
  assert.equal(run.budgetSpent, 300);
  assert.equal(run.stats.agentCalls, 3);
  assert.equal(run.stats.toolCalls, 6);
  assert.equal(run.stats.failedAgentCalls, 0);
  const events = await life.store.listScriptWorkflowEvents({ runId: result.runId });
  assert.deepEqual(
    events
      .filter((event) => event.type === "workflow_usage")
      .map((event) => event.payload.spentTokens),
    [100, 200, 300],
  );
});

test("SWF-07: committed usage retry and reopening preserve the activity idempotency key", async (t) => {
  const life = await fixture(t);
  const result = await life.runtime.run({
    runId: "wf_usage_restart",
    scriptPath: join(life.dir, "usage.workflow.js"),
  });
  const [activity] = await life.store.listScriptWorkflowActivities({ runId: result.runId });
  const reopened = createSqliteSessionStore({ dbPath: life.dbPath });
  try {
    await Promise.all([
      life.store.recordScriptWorkflowActivityUsage({
        activityId: activity.id,
        delta: delta(),
        eventId: "event_retry_one",
        runId: result.runId,
      }),
      reopened.recordScriptWorkflowActivityUsage({
        activityId: activity.id,
        delta: delta(),
        eventId: "event_retry_two",
        runId: result.runId,
      }),
    ]);
    const run = await reopened.getScriptWorkflowRun(result.runId);
    assert.equal(run.budgetSpent, 100);
    assert.equal(run.stats.agentCalls, 1);
    const events = await reopened.listScriptWorkflowEvents({ runId: result.runId });
    assert.equal(events.filter((event) => event.type === "workflow_usage").length, 1);
  } finally {
    reopened.close();
  }
});

test("SWF-07: usage event failure rolls back aggregate; retry commits exactly once", async (t) => {
  const life = await fixture(t);
  const runId = "wf_usage_rollback";
  await life.store.createScriptWorkflowRun({
    cwd: life.dir,
    id: runId,
    name: "rollback",
    scriptHash: "hash",
    stats: emptyScriptWorkflowStats(),
  });
  const activity = await life.store.createScriptWorkflowActivity({
    callIndex: 1,
    callPath: "root/agent1",
    id: "activity_rollback",
    inputHash: "hash",
    runId,
    type: "agent",
  });
  life.raw.exec(
    "create trigger reject_usage before insert on workflow_event when new.type = 'workflow_usage' begin select raise(abort, 'usage write rejected'); end",
  );
  const request = {
    activityId: activity.id,
    delta: delta(),
    eventId: "event_rollback_usage",
    runId,
  };
  await assert.rejects(
    life.store.recordScriptWorkflowActivityUsage(request),
    /usage write rejected/,
  );
  const failed = await life.store.getScriptWorkflowRun(runId);
  assert.equal(failed.budgetSpent, 0);
  assert.equal(failed.stats.agentCalls, 0);
  assert.equal((await life.store.listScriptWorkflowEvents({ runId })).length, 0);
  life.raw.exec("drop trigger reject_usage");
  await life.store.recordScriptWorkflowActivityUsage(request);
  await life.store.recordScriptWorkflowActivityUsage(request);
  const committed = await life.store.getScriptWorkflowRun(runId);
  assert.equal(committed.budgetSpent, 100);
  assert.equal(committed.stats.agentCalls, 1);
});

test("SWF-07: concurrent phase update cannot overwrite an activity usage transaction", async (t) => {
  const life = await fixture(t);
  const runId = "wf_usage_metadata_race";
  await life.store.createScriptWorkflowRun({
    cwd: life.dir,
    id: runId,
    name: "metadata race",
    scriptHash: "hash",
    stats: emptyScriptWorkflowStats(),
  });
  const activity = await life.store.createScriptWorkflowActivity({
    callIndex: 1,
    callPath: "root/agent1",
    id: "activity_metadata_race",
    inputHash: "hash",
    runId,
    type: "agent",
  });
  // 旧实现先读取 run 后 await；此处同时入账，会让元数据更新把旧零统计覆写回去。
  await Promise.all([
    life.store.updateScriptWorkflowRun({ currentPhase: "review", id: runId, status: "running" }),
    life.store.recordScriptWorkflowActivityUsage({
      activityId: activity.id,
      delta: delta(),
      eventId: "event_metadata_race",
      runId,
    }),
  ]);
  const run = await life.store.getScriptWorkflowRun(runId);
  assert.equal(run.currentPhase, "review");
  assert.equal(run.status, "running");
  assert.equal(run.budgetSpent, 100);
  assert.equal(run.stats.agentCalls, 1);
  assert.equal(run.stats.toolCalls, 2);
});

test("SWF-07: post-commit failure retries without double counting or activity failure", async (t) => {
  const life = await fixture(t);
  const account = life.store.recordScriptWorkflowActivityUsage.bind(life.store);
  let first = true;
  life.store.recordScriptWorkflowActivityUsage = async (input) => {
    const run = await account(input);
    if (first) {
      first = false;
      throw new Error("reply lost after commit");
    }
    return run;
  };
  const result = await life.runtime.run({
    runId: "wf_usage_committed_reply_lost",
    scriptPath: join(life.dir, "usage.workflow.js"),
  });
  assert.equal(result.status, "completed");
  const run = await life.store.getScriptWorkflowRun(result.runId);
  const [activity] = await life.store.listScriptWorkflowActivities({ runId: result.runId });
  assert.equal(run.budgetSpent, 100);
  assert.equal(run.stats.agentCalls, 1);
  assert.equal(run.stats.failedAgentCalls, 0);
  assert.equal(activity.status, "completed");
});

test("SWF-07: projection failure does not change terminal activity or repeat usage", async (t) => {
  const life = await fixture(t, "success", {
    progressAdapter: {
      forgetRun() {},
      onEvent(event) {
        if (event.type === "workflow_usage") throw new Error("projection failed");
      },
      registerRun() {},
    },
  });
  const result = await life.runtime.run({
    runId: "wf_usage_projection_failure",
    scriptPath: join(life.dir, "usage.workflow.js"),
  });
  const run = await life.store.getScriptWorkflowRun(result.runId);
  const [activity] = await life.store.listScriptWorkflowActivities({ runId: result.runId });
  assert.equal(result.status, "completed");
  assert.equal(activity.status, "completed");
  assert.equal(run.stats.agentCalls, 1);
  assert.equal(run.stats.failedAgentCalls, 0);
  assert.equal(run.budgetSpent, 100);
  assert.ok(
    life.warnings.some((warning) => warning.context.event === "workflow.usage.projection_failed"),
  );
});

test("SWF-07: tail activity event failure preserves committed usage and activity terminal", async (t) => {
  const life = await fixture(t);
  life.raw.exec(
    "create trigger reject_activity_complete before insert on workflow_event when new.type = 'activity_completed' begin select raise(abort, 'tail event rejected'); end",
  );
  const result = await life.runtime.run({
    runId: "wf_usage_tail_failure",
    scriptPath: join(life.dir, "usage.workflow.js"),
  });
  const run = await life.store.getScriptWorkflowRun(result.runId);
  const [activity] = await life.store.listScriptWorkflowActivities({ runId: result.runId });
  const events = await life.store.listScriptWorkflowEvents({ runId: result.runId });
  assert.equal(activity.status, "completed");
  assert.equal(run.stats.agentCalls, 1);
  assert.equal(run.stats.failedAgentCalls, 0);
  assert.equal(run.budgetSpent, 100);
  assert.equal(events.filter((event) => event.type === "activity_failed").length, 0);
  assert.equal(events.filter((event) => event.type === "workflow_usage").length, 1);
});

test("SWF-07: unreadable child usage is durable incomplete, never presented as zero", async (t) => {
  const life = await fixture(t);
  const readMessages = life.store.messages.bind(life.store);
  life.store.messages = async (input) => {
    if (input.sessionID !== life.sessionId) throw new Error("usage read unavailable");
    return readMessages(input);
  };
  const result = await life.runtime.run({
    runId: "wf_usage_unknown",
    scriptPath: join(life.dir, "usage.workflow.js"),
  });
  const [activity] = await life.store.listScriptWorkflowActivities({ runId: result.runId });
  assert.equal(activity.result.usageAccounting.status, "incomplete");
  assert.match(result.response, /tokens: unknown .*usage accounting incomplete/);
  assert.match((await life.runtime.status({ runId: result.runId })).response, /tokens: unknown/);
  const events = await life.store.listScriptWorkflowEvents({ runId: result.runId });
  assert.equal(events.filter((event) => event.type === "workflow_usage").length, 0);
  assert.equal(events.filter((event) => event.type === "workflow_usage_incomplete").length, 1);
});

test("SWF-07: failed usage ledger and incomplete notification preserve successful activity", async (t) => {
  const life = await fixture(t);
  // 只拒绝用量事件；activity 的 durable incomplete 标记和其他生命周期事件仍可落盘。
  life.raw.exec(
    "create trigger reject_usage_events before insert on workflow_event when new.type in ('workflow_usage', 'workflow_usage_incomplete') begin select raise(abort, 'usage events unavailable'); end",
  );
  const result = await life.runtime.run({
    runId: "wf_usage_ledger_unavailable",
    scriptPath: join(life.dir, "usage.workflow.js"),
  });
  const [activity] = await life.store.listScriptWorkflowActivities({ runId: result.runId });
  const run = await life.store.getScriptWorkflowRun(result.runId);
  assert.equal(result.status, "completed");
  assert.equal(activity.status, "completed");
  assert.equal(activity.result.value, "result");
  assert.equal(activity.result.usageAccounting.status, "incomplete");
  assert.match(result.response, /tokens: unknown/);
  assert.equal(run.budgetSpent, 0);
  assert.equal(run.stats.failedAgentCalls, 0);
  assert.ok(
    life.warnings.some(
      (warning) => warning.context.event === "workflow.usage.incomplete_event_failed",
    ),
  );
});

test("SWF-07: tail event failure cannot resettle or erase durable incomplete activity result", async (t) => {
  const life = await fixture(t);
  const recordUsage = life.store.recordScriptWorkflowActivityUsage.bind(life.store);
  let usageAttempts = 0;
  life.store.recordScriptWorkflowActivityUsage = (input) => {
    usageAttempts += 1;
    return recordUsage(input);
  };
  life.raw.exec(
    "create trigger reject_usage_and_tail before insert on workflow_event when new.type in ('workflow_usage', 'activity_completed') begin select raise(abort, 'usage and tail unavailable'); end",
  );
  const result = await life.runtime.run({
    runId: "wf_usage_incomplete_tail",
    scriptPath: join(life.dir, "usage.workflow.js"),
  });
  const [activity] = await life.store.listScriptWorkflowActivities({ runId: result.runId });
  assert.equal(activity.status, "completed");
  assert.equal(activity.result.value, "result");
  assert.equal(activity.result.stats.tokens.total, 100);
  assert.equal(activity.result.usageAccounting.status, "incomplete");
  assert.equal(usageAttempts, 2);
  assert.match(result.response, /tokens: unknown/);
});

test("P1 SWF-08: pre-cancelled runtime run writes no startup facts", async (t) => {
  const life = await fixture(t);
  life.controller.abort(new Error("pre-cancelled"));
  await assert.rejects(
    life.runtime.run({
      runId: "wf_pre_cancelled",
      scriptPath: join(life.dir, "pre-cancelled.workflow.js"),
    }, { abortSignal: life.controller.signal }),
    /pre-cancelled/,
  );
  assert.equal((await life.store.getScriptWorkflowRun("wf_pre_cancelled")), null);
  assert.deepEqual(await life.store.listScriptWorkflowEvents({ runId: "wf_pre_cancelled" }), []);
});

test("P1 SWF-08: runtime facade resume 也拒绝 foreign owner 后再读脚本", async (t) => {
  const life = await fixture(t);
  await life.store.createSession({
    directory: join(life.dir, "other"),
    id: "sess_other",
    projectID: "proj_other",
    slug: "sess_other",
    title: "foreign owner",
    version: "v4",
  });
  await life.store.createScriptWorkflowRun({
    cwd: join(life.dir, "other"),
    id: "wf_runtime_foreign",
    name: "foreign",
    parentSessionId: "sess_other",
    scriptHash: "foreign-hash",
    scriptPath: join(life.dir, "other.workflow.js"),
    stats: {
      agentCalls: 0,
      failedAgentCalls: 0,
      toolCalls: 0,
      tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, reasoning: 0, total: 0 },
    },
  });
  let scriptReads = 0;
  // Replace the injected reader rather than relying on a path error: an owner failure must happen
  // before the runtime facade touches script contents.
  life.runtime.deps.fileSystemPort = {
    async readTextFile() {
      scriptReads += 1;
      throw new Error("foreign script must not be read");
    },
  };
  await assert.rejects(
    life.runtime.run({
      args: {},
      resumeFromRunId: "wf_runtime_foreign",
      runId: "wf_runtime_foreign",
      scriptPath: join(life.dir, "other.workflow.js"),
    }),
    (error) => error?.context?.ownerMismatch === true,
  );
  assert.equal(scriptReads, 0);
});
