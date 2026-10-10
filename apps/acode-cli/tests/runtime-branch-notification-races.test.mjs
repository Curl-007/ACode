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
const { CoreErrorType } = await import("../packages/contracts/src/errors/index.ts");
const { SessionEventType } = await import("../packages/contracts/src/index.ts");

const trace = {
  attributes: {},
  sessionId: "sess_branch_races",
  spanId: "span_branch_races",
  traceId: "trace_branch_races",
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture(t, model) {
  const dir = await mkdtemp(join(tmpdir(), "acode-branch-races-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "sessions.db") });
  await store.createSession({
    directory: dir,
    id: trace.sessionId,
    projectID: "proj_branch_races",
    slug: "branch-races",
    title: "branch races",
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
      modelFactory: () => {
        if (!model) throw new Error("Unexpected model request in race fixture");
        return model;
      },
      sessionStore: store,
      traceContext: trace,
    },
  );
  t.after(async () => {
    runtime.beginShutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { runtime, store, dir, port: getRuntimeBranchRestorePort(runtime) };
}

function command(mode, generation = 0) {
  const common = {
    branchGeneration: generation,
    createdAt: new Date(),
    id: `cmd_${mode}_${generation}`,
    mode,
    priority: "next",
    text: "old completion",
    traceContext: trace,
  };
  return mode === "task-notification"
    ? { ...common, source: "background_task", taskId: "task_race" }
    : {
        ...common,
        source: "subagent_message",
        responseId: "response_race",
        agentId: "agent_race",
        agentType: "test",
        childSessionId: "sess_child",
        childToolCallId: "tool_child",
        summary: "completed",
        messageLength: common.text.length,
      };
}

for (const mode of ["task-notification", "subagent-message"]) {
  for (const activeLoop of [false, true]) {
    test(`CLI-05: ${mode} ${activeLoop ? "active-loop" : "outer drain"} serializes context and rejects injection after restore`, async (t) => {
      const { runtime, port, store } = await fixture(t);
      const entered = deferred();
      const gate = deferred();
      const calls = [];
      runtime.ensureContextInitialized = async () => {
        entered.resolve();
        await gate.promise;
      };
      runtime.executeTurnCommand = async (input) => calls.push(input);
      runtime.runtimeCommandQueue.enqueue(command(mode));
      const draining = activeLoop
        ? runtime.drainPendingRuntimeCommandsForActiveLoop()
        : runtime.drainRuntimeCommandQueue();
      await entered.promise;
      let restored = false;
      const restore = port.restoreFromSession({ revert: { branchGeneration: 5 } }).then(() => {
        restored = true;
      });
      await setImmediate();
      // 初始化本身会改写 context/history，必须与恢复重建使用同一次授权。
      assert.equal(restored, false);
      assert.equal(runtime.branchGeneration, 0);
      gate.resolve();
      const result = await draining;
      await restore;
      assert.equal(runtime.branchGeneration, 5);
      assert.deepEqual(calls, []);
      if (activeLoop) {
        assert.equal(result.drained, 0);
        assert.deepEqual(result.runtimeEntries, []);
        assert.deepEqual(result.messageIds, []);
      }
      assert.equal((await store.messages({ sessionID: trace.sessionId })).length, 1);
      assert.equal(runtime.runtimeCommandDrainActive, false);
    });
  }
}

test("CLI-05: a notification waiting behind a branch transition cannot initialize, append or promote", async (t) => {
  const { runtime, store, port } = await fixture(t);
  const entered = deferred();
  const gate = deferred();
  const transition = port.prepareRewind(null);
  const commit = transition.commitAfterPersist(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const notification = command("task-notification");
  await store.saveSessionInput({
    id: notification.id,
    sessionID: trace.sessionId,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: { text: notification.text },
  });
  runtime.ensureContextInitialized = async () => assert.fail("stale command must not initialize");
  runtime.executeTurnCommand = async () => assert.fail("stale command must not start a turn");
  runtime.runtimeCommandQueue.enqueue(notification);
  const draining = runtime.drainRuntimeCommandQueue();
  await setImmediate();
  gate.resolve();
  assert.equal(await commit, true);
  await draining;
  assert.equal(runtime.messageHistory.borrowReadOnlyRuntimeEntries().length, 0);
  assert.equal((await store.messages({ sessionID: trace.sessionId })).length, 0);
  assert.equal((await store.getSessionInputById(notification.id)).status, "admitted");
});

for (const operation of ["resume", "rewind"]) {
  test(`CLI-05: real ${operation} hydration finishes before new-generation notification append`, async (t) => {
    const { runtime, store } = await fixture(t);
    await store.saveMessage({
      id: "msg_hydration_anchor",
      role: "user",
      sessionID: trace.sessionId,
      time: { created: Date.now() },
    });
    const entered = deferred();
    const gate = deferred();
    const readTarget = runtime.readSessionTargetForContext;
    runtime.readSessionTargetForContext = async (...args) => {
      entered.resolve();
      await gate.promise;
      return readTarget.apply(runtime, args);
    };
    const rebuilding =
      operation === "resume"
        ? runtime.resumeFromStore()
        : runtime.rewindConversationToMessage({
            events: [],
            targetMessageId: "msg_hydration_anchor",
            traceContext: trace,
          });
    await entered.promise;
    const calls = [];
    runtime.executeTurnCommand = async (input) => calls.push(input);
    const current = command("task-notification", runtime.branchGeneration);
    current.text = "new branch completion";
    runtime.runtimeCommandQueue.enqueue(current);
    const draining = runtime.drainRuntimeCommandQueue();
    await setImmediate();
    assert.equal((await store.messages({ sessionID: trace.sessionId })).length, 1);
    assert.deepEqual(calls, []);
    gate.resolve();
    await rebuilding;
    await draining;
    assert.deepEqual(calls, [current.text]);
    assert.ok(
      runtime.messageHistory
        .borrowReadOnlyRuntimeEntries()
        .some((entry) => entry.message?.content === current.text),
    );
  });
}

test("CLI-05: restore waits through real synthetic message and part persistence", async (t) => {
  const { runtime, store, port } = await fixture(t);
  const entered = deferred();
  const gate = deferred();
  const savePart = store.savePart.bind(store);
  store.savePart = async (...args) => {
    entered.resolve();
    await gate.promise;
    return savePart(...args);
  };
  runtime.ensureContextInitialized = async () => {};
  runtime.executeTurnCommand = async () =>
    assert.fail("old notification must not run after restore");
  runtime.runtimeCommandQueue.enqueue(command("task-notification"));
  const draining = runtime.drainRuntimeCommandQueue();
  await entered.promise;
  let restored = false;
  const restore = port.restoreFromSession({ revert: { branchGeneration: 5 } }).then(() => {
    restored = true;
  });
  await setImmediate();
  assert.equal(restored, false);
  assert.equal(runtime.branchGeneration, 0);
  gate.resolve();
  await Promise.all([draining, restore]);
  const messages = await store.messages({ sessionID: trace.sessionId });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].parts.length, 1);
  assert.equal(messages[0].parts[0].text, "old completion");
});

for (const stage of ["SessionStart", "ModelRequest"]) {
  test(`CLI-05: real notification turn remembers its branch across ${stage} await and releases reservation`, async (t) => {
    let invoked = 0;
    const model = {
      providerId: "test",
      modelId: "test",
      properties: {
        contextWindow: 100000,
        inputFormat: { supportsText: true, supportsImage: true },
      },
      options: {},
      optionSpecs: { maxOutputTokens: { max: 1000 }, reasoningLevel: { values: [] } },
      generateText: async () => {
        invoked += 1;
        return { text: "done", finishReason: "stop", usage: {} };
      },
      streamText: async function* () {
        invoked += 1;
        yield { type: "text_delta", text: "done" };
      },
    };
    const { runtime, port } = await fixture(t, model);
    runtime.shouldStreamModelText = () => false;
    const entered = deferred();
    const gate = deferred();
    if (stage === "SessionStart") {
      runtime.runSessionStartHooks = async () => {
        entered.resolve();
        await gate.promise;
        return { additionalContexts: [] };
      };
    } else {
      const appendEvent = runtime.appendEvent;
      runtime.appendEvent = async (event, ...args) => {
        if (event.type === SessionEventType.ModelRequest) {
          entered.resolve();
          await gate.promise;
        }
        return appendEvent.call(runtime, event, ...args);
      };
    }
    runtime.runtimeCommandQueue.enqueue(command("task-notification"));
    const draining = runtime.drainRuntimeCommandQueue();
    await entered.promise;
    await port.restoreFromSession({ revert: { branchGeneration: 5 } });
    gate.resolve();
    await draining;
    assert.equal(invoked, 0);
    assert.equal(runtime.activeTurnStartReservation, undefined);
    assert.equal(runtime.activeTurn, undefined);
    assert.equal(runtime.runtimeCommandDrainActive, false);
  });
}

test("CLI-05: hydration failure keeps the durable generation and releases the branch authorization", async (t) => {
  const { runtime, store, port } = await fixture(t);
  await store.saveMessage({
    id: "msg_failed_hydration",
    role: "user",
    sessionID: trace.sessionId,
    time: { created: Date.now() },
  });
  runtime.readSessionTargetForContext = async () => {
    throw new Error("hydration fixture failure");
  };
  await assert.rejects(
    runtime.rewindConversationToMessage({
      events: [],
      targetMessageId: "msg_failed_hydration",
      traceContext: trace,
    }),
    /hydration fixture failure/,
  );
  assert.equal(runtime.branchGeneration, 1);
  assert.equal((await store.getSession(trace.sessionId)).revert.branchGeneration, 1);
  assert.equal(await port.restoreFromSession({ revert: { branchGeneration: 2 } }), 2);
});

for (const streaming of [false, true]) {
  test(`CLI-05: ${streaming ? "stream" : "generate"} does not invoke provider after media projection changes branch`, async (t) => {
    let invoked = 0;
    const model = {
      providerId: "test",
      modelId: "test",
      properties: {
        contextWindow: 100000,
        inputFormat: { supportsText: true, supportsImage: true },
      },
      options: {},
      optionSpecs: { maxOutputTokens: { max: 1000 } },
      generateText: async () => {
        invoked += 1;
        return { text: "done", finishReason: "stop", usage: {} };
      },
      streamText: async function* () {
        invoked += 1;
        yield { type: "text_delta", text: "done" };
      },
    };
    const { runtime, port, dir } = await fixture(t, model);
    const entered = deferred();
    const gate = deferred();
    runtime.artifactStore = {
      ensureMediaAttachmentPath: async () => {
        entered.resolve();
        await gate.promise;
        return { status: "ready", path: join(dir, "fixture.png") };
      },
    };
    runtime.shouldStreamModelText = () => streaming;
    const request = runtime.runModelTextRequest({
      branchGeneration: 0,
      assistantMessageId: "msg_provider_race",
      events: [],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                kind: "inline",
                uri: "acode-artifact://fixture/image",
                mimeType: "image/png",
              },
            },
          ],
        },
      ],
      model,
      tools: [],
      traceContext: trace,
    });
    const rejection = assert.rejects(
      request,
      (error) => error.type === CoreErrorType.TurnCancelled,
    );
    await entered.promise;
    await port.restoreFromSession({ revert: { branchGeneration: 5 } });
    gate.resolve();
    await rejection;
    assert.equal(invoked, 0);
  });
}
