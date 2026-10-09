import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

const { AgentRuntime } = await import("../packages/core/src/runtime/agent-runtime.ts");
const { createSqliteSessionStore } =
  await import("../packages/adapters/src/storage/session-store/sqlite-session-store.ts");
const { createInMemorySessionEventStore } =
  await import("../packages/contracts/src/events/in-memory-session-event-store.ts");
const { getRuntimeBranchRestorePort } =
  await import("../packages/core/src/runtime/turn-coordination.ts");
const { SessionEventType } = await import("../packages/contracts/src/index.ts");

const trace = {
  attributes: {},
  sessionId: "sess_continuation_race",
  spanId: "span_race",
  traceId: "trace_race",
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture(t, generateText) {
  const dir = await mkdtemp(join(tmpdir(), "acode-continuation-races-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "sessions.db") });
  await store.createSession({
    directory: dir,
    id: trace.sessionId,
    projectID: "proj_race",
    slug: "race",
    title: "race",
    version: "v4",
  });
  const runtime = new AgentRuntime(
    trace.sessionId,
    {
      mode: "build",
      workingDirectory: dir,
      modelSelection: { providerId: "test", modelId: "test" },
    },
    {
      eventStore: createInMemorySessionEventStore(),
      sessionStore: store,
      traceContext: trace,
      modelFactory: () => ({
        providerId: "test",
        modelId: "test",
        options: {},
        properties: { contextWindow: 100000, inputFormat: { supportsText: true } },
        optionSpecs: { maxOutputTokens: { max: 1000 }, reasoningLevel: { values: [] } },
        generateText,
      }),
    },
  );
  t.after(async () => {
    runtime.beginShutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await runtime.resumeFromStore();
  return { runtime, store, port: getRuntimeBranchRestorePort(runtime) };
}

function notification() {
  return {
    branchGeneration: 0,
    createdAt: new Date(),
    id: "cmd_continue_race",
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    text: "completed background task",
    traceContext: trace,
  };
}

for (const stage of ["target read", "verifier passed", "verifier needs continuation"]) {
  test(`CLI-05: notification goal loop retains its generation across ${stage} await`, async (t) => {
    const entered = deferred();
    const gate = deferred();
    let verifierCalls = 0;
    const { runtime, store, port } = await fixture(t, async () => {
      verifierCalls += 1;
      entered.resolve();
      await gate.promise;
      return {
        text: JSON.stringify({
          passed: stage === "verifier passed",
          reason: "fixture",
          nextAction: "continue work",
        }),
        finishReason: "stop",
        usage: {},
      };
    });
    await store.createTarget({ objective: "finish fixture", sessionID: trace.sessionId });
    const turns = [];
    runtime.executeTurnCommand = async (input) => {
      turns.push(input);
      return { response: "fixture", traceId: trace.traceId };
    };
    if (stage === "target read") {
      const readTarget = runtime.readSessionTargetForContext;
      runtime.readSessionTargetForContext = async (...args) => {
        entered.resolve();
        await gate.promise;
        return readTarget.apply(runtime, args);
      };
    }
    runtime.runtimeCommandQueue.enqueue(notification());
    const draining = runtime.drainRuntimeCommandQueue();
    await entered.promise;
    await port.restoreFromSession({ revert: { branchGeneration: 5 } });
    gate.resolve();
    await draining;
    assert.deepEqual(turns, ["completed background task"]);
    assert.equal(verifierCalls, stage === "target read" ? 0 : 1);
    assert.equal((await store.readTarget({ sessionID: trace.sessionId })).status, "active");
    assert.equal(runtime.runtimeCommandDrainActive, false);
  });
}

test("CLI-05: same-generation verifier completes a target while restore waits for its durable write", async (t) => {
  const { runtime, store, port } = await fixture(t, async () => ({
    text: JSON.stringify({ passed: true, reason: "all fixture evidence verified" }),
    finishReason: "stop",
    usage: {},
  }));
  await store.createTarget({ objective: "finish fixture", sessionID: trace.sessionId });
  runtime.executeTurnCommand = async () => ({ response: "done", traceId: trace.traceId });
  const entered = deferred();
  const gate = deferred();
  const updateTargetStatus = store.updateTargetStatus.bind(store);
  store.updateTargetStatus = async (...args) => {
    entered.resolve();
    await gate.promise;
    return updateTargetStatus(...args);
  };
  runtime.runtimeCommandQueue.enqueue(notification());
  const draining = runtime.drainRuntimeCommandQueue();
  await entered.promise;
  let restored = false;
  const restore = port.restoreFromSession({ revert: { branchGeneration: 5 } }).then(() => {
    restored = true;
  });
  await setImmediate();
  assert.equal(restored, false);
  gate.resolve();
  await Promise.all([draining, restore]);
  assert.equal((await store.readTarget({ sessionID: trace.sessionId })).status, "complete");
});

test("CLI-05: resume ignores an unversioned caller message snapshot and requests its refresh", async (t) => {
  const { runtime, store } = await fixture(t);
  const oldMessages = await store.messages({ sessionID: trace.sessionId });
  await store.saveMessage({
    id: "msg_new_authority",
    role: "user",
    sessionID: trace.sessionId,
    time: { created: Date.now() },
  });
  await store.savePart({
    id: "part_new_authority",
    type: "text",
    text: "new authoritative input",
    sessionID: trace.sessionId,
    messageID: "msg_new_authority",
  });
  const result = await runtime.resumeFromStore({ persistedMessages: oldMessages });
  assert.equal(result.persistedMessagesReloadRequired, true);
  assert.ok(
    runtime.messageHistory
      .borrowReadOnlyRuntimeEntries()
      .some((entry) => entry.message?.content === "new authoritative input"),
  );
});

test("CLI-05: cancelled verifier cannot pause a new branch while its cancellation event is pending", async (t) => {
  const { runtime, store, port } = await fixture(t, async () => {
    runtime.activeForegroundExecution.controller.abort(new Error("fixture cancelled"));
    throw new Error("fixture provider aborted");
  });
  await store.createTarget({ objective: "finish fixture", sessionID: trace.sessionId });
  runtime.executeTurnCommand = async () => ({ response: "done", traceId: trace.traceId });
  const entered = deferred();
  const gate = deferred();
  const appendEvent = runtime.appendEvent;
  runtime.appendEvent = async (event, ...args) => {
    if (
      event.type === SessionEventType.TargetCompletionVerification &&
      event.payload.status === "cancelled"
    ) {
      entered.resolve();
      await gate.promise;
    }
    return appendEvent.call(runtime, event, ...args);
  };
  runtime.runtimeCommandQueue.enqueue(notification());
  const draining = runtime.drainRuntimeCommandQueue();
  await entered.promise;
  await port.restoreFromSession({ revert: { branchGeneration: 5 } });
  gate.resolve();
  await draining;
  assert.equal((await store.readTarget({ sessionID: trace.sessionId })).status, "active");
});

test("CLI-05: current-branch verifier cancellation holds authorization through target pause persistence", async (t) => {
  const { runtime, store, port } = await fixture(t, async () => {
    runtime.activeForegroundExecution.controller.abort(new Error("fixture cancelled"));
    throw new Error("fixture provider aborted");
  });
  await store.createTarget({ objective: "finish fixture", sessionID: trace.sessionId });
  runtime.executeTurnCommand = async () => ({ response: "done", traceId: trace.traceId });
  const entered = deferred();
  const gate = deferred();
  const updateTargetStatus = store.updateTargetStatus.bind(store);
  store.updateTargetStatus = async (...args) => {
    assert.equal(args[0].status, "paused");
    entered.resolve();
    await gate.promise;
    return updateTargetStatus(...args);
  };
  runtime.runtimeCommandQueue.enqueue(notification());
  const draining = runtime.drainRuntimeCommandQueue();
  await entered.promise;
  let restored = false;
  const restore = port.restoreFromSession({ revert: { branchGeneration: 5 } }).then(() => {
    restored = true;
  });
  await setImmediate();
  assert.equal(restored, false);
  gate.resolve();
  await Promise.all([draining, restore]);
  assert.equal((await store.readTarget({ sessionID: trace.sessionId })).status, "paused");
});
