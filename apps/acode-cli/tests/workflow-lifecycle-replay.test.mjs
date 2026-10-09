import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  WorkflowEngine,
  WorkflowError,
  InMemoryJournalStore,
} from "../packages/dynamic-workflow/src/index.ts";
import { runWorkflowScript } from "../packages/dynamic-workflow-runtime/src/index.ts";
import { executeWorldRead } from "../packages/cli-workflow/src/workflow-world-read.ts";
import { createNodeExecutionAdapter } from "../packages/adapters/src/exec/node-execution-adapter.ts";

const askSpecs = new Map([["ask#1", { typed: false }]]);
const validate = () => ({ ok: true });
const makeDriver = (journal, executeWorldRead) => ({
  journal,
  emit() {},
  createActorSession: async () => ({ id: "actor-session" }),
  startAsk() {},
  respondToSubmit() {},
  cancelAsk() {},
  executeWorldRead,
});

test(
  "DWF-01: engine.settled 等 world 取消 drain，终态事件晚于节点取消",
  { timeout: 5000 },
  async () => {
    const journal = new InMemoryJournalStore();
    let rejectWorld;
    let receivedSignal;
    const ready = Promise.withResolvers();
    const engine = new WorkflowEngine({
      runId: "drain-order",
      caps: { maxConcurrency: 1 },
      askSpecs,
      validate,
      driver: makeDriver(journal, (_op, _args, signal) => {
        receivedSignal = signal;
        ready.resolve();
        return new Promise((_resolve, reject) => {
          rejectWorld = reject;
        });
      }),
    });
    const world = engine.worldRead("world#1", "run", []);
    const outcome = assert.rejects(world, { code: "Cancelled" });
    await ready.promise;
    engine.complete("race winner");
    assert.equal(receivedSignal.aborted, true);
    let settled = false;
    void engine.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(journal.getRun("drain-order").status, "running");
    rejectWorld(new Error("execution drained"));
    assert.equal((await engine.settled).status, "completed");
    await outcome;
    const events = journal.listEvents("drain-order").map(({ event }) => event);
    assert.equal(events.at(-1).type, "run-settled");
    assert.ok(
      events.some((event) => event.type === "node-settled" && event.outcome === "cancelled"),
    );
    assert.equal(journal.getNode("drain-order", "world#1", 1).status, "running");
  },
);

for (const terminal of [
  "completed",
  "user",
  "model",
  "interrupted",
  "provider",
  "superseded",
  "errored",
]) {
  test(
    `DWF-01: ${terminal} 取消真实 world 子进程，终态后无写入且兄弟 run 完成`,
    { timeout: 15000 },
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "acode-world-lifecycle-"));
      const adapter = createNodeExecutionAdapter();
      const journal = new InMemoryJournalStore();
      const marker = join(cwd, "marker.txt");
      const siblingMarker = join(cwd, "sibling.txt");
      const ready = Promise.withResolvers();
      const worldDeps = {
        cwd,
        fileSystemPort: {},
        declaredRunCommands: new Set([process.execPath]),
      };
      const executionPort = {
        run(request, options) {
          return adapter.run(request, {
            ...options,
            onEvent(event) {
              if (event.type === "stdout" && event.text.includes("ready")) ready.resolve();
            },
          });
        },
      };
      const engine = new WorkflowEngine({
        runId: `world-${terminal}`,
        caps: { maxConcurrency: 1 },
        askSpecs,
        validate,
        driver: makeDriver(journal, (op, args, signal) =>
          executeWorldRead({ ...worldDeps, executionPort, signal }, op, args),
        ),
      });
      const sibling = new WorkflowEngine({
        runId: `sibling-${terminal}`,
        caps: { maxConcurrency: 1 },
        askSpecs,
        validate,
        driver: makeDriver(journal, (op, args, signal) =>
          executeWorldRead({ ...worldDeps, executionPort: adapter, signal }, op, args),
        ),
      });
      try {
        const running = engine.worldRead("world#1", "run", [
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'x');console.log('ready');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),15)",
            marker,
          ],
          { timeoutMs: 8000 },
        ]);
        const rejected = assert.rejects(running, {
          code: terminal === "errored" ? "UnknownActor" : "Cancelled",
        });
        await ready.promise;
        const siblingWork = sibling.worldRead("world#1", "run", [
          process.execPath,
          [
            "-e",
            "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'finished'),90)",
            siblingMarker,
          ],
          { timeoutMs: 8000 },
        ]);
        if (terminal === "completed") engine.complete("winner");
        else if (terminal === "errored")
          await assert.rejects(engine.ask("ask#1", "unknown", "fail run"), {
            code: "UnknownActor",
          });
        else
          engine.stop(
            terminal,
            terminal === "provider" || terminal === "interrupted"
              ? new WorkflowError("Interrupted", "test failure")
              : undefined,
            terminal === "superseded" ? "successor" : undefined,
          );
        const settlement = await engine.settled;
        assert.equal(
          settlement.status,
          terminal === "errored" || terminal === "completed" ? terminal : "stopped",
        );
        await rejected;
        const afterSettlement = await readFile(marker, "utf8");
        await delay(80);
        assert.equal(await readFile(marker, "utf8"), afterSettlement);
        assert.equal((await siblingWork).exitCode, 0);
        assert.equal(await readFile(siblingMarker, "utf8"), "finished");
        sibling.complete("done");
        await sibling.settled;
      } finally {
        engine.stop("user");
        sibling.stop("user");
        await adapter.close();
        await rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
      }
    },
  );
}

test(
  "DWF-01: 真 harness 的 Promise.race return 会取消已在写文件的 world 输家",
  { timeout: 15000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acode-world-race-"));
    const marker = join(cwd, "marker.txt");
    const journal = new InMemoryJournalStore();
    const adapter = createNodeExecutionAdapter();
    const ready = Promise.withResolvers();
    const code =
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'x');console.log('ready');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),15)";
    const scriptText = [
      `const work = world.run(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(code)}, ${JSON.stringify(marker)}]);`,
      'const a = agent("worker");',
      'return await Promise.race([work, a.ask("winner")]);',
    ].join("\n");
    try {
      const settlement = await runWorkflowScript({
        cwd,
        runId: "harness-race",
        scriptText,
        askSpecs,
        validate,
        caps: { maxConcurrency: 1 },
        makeDriver: (sink) => ({
          ...makeDriver(journal, (op, args, signal) =>
            executeWorldRead(
              {
                cwd,
                fileSystemPort: {},
                declaredRunCommands: new Set([process.execPath]),
                signal,
                executionPort: {
                  run: (request, options) =>
                    adapter.run(request, {
                      ...options,
                      onEvent(event) {
                        if (event.type === "stdout" && event.text.includes("ready"))
                          ready.resolve();
                      },
                    }),
                },
              },
              op,
              args,
            ),
          ),
          startAsk(_session, instance) {
            void ready.promise.then(() => sink.askTurnEnded(instance, "winner"));
          },
        }),
      });
      assert.equal(settlement.status, "completed");
      assert.equal(settlement.artifact, "winner");
      const afterSettlement = await readFile(marker, "utf8");
      await delay(80);
      assert.equal(await readFile(marker, "utf8"), afterSettlement);
      assert.equal(journal.listEvents("harness-race").at(-1).event.type, "run-settled");
    } finally {
      await adapter.close();
      await rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
    }
  },
);

test(
  "DWF-02: 真 harness 恢复预算拒绝分支，shared ask ordinal 保真且零 live 派发",
  { timeout: 15000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acode-budget-replay-"));
    const journal = new InMemoryJournalStore();
    const scriptText = [
      'const a = agent("worker");',
      "const ask = (text: string) => a.ask(text);",
      'const first = ask("first");',
      'let branch = "success";',
      'try { await ask("refused"); } catch (error) { branch = String((error as { code: string }).code); }',
      "await first;",
      "const next = await ask(branch);",
      "report({ branch, next });",
      'log("checkpoint");',
      "return branch;",
    ].join("\n");
    try {
      let expectedNodes;
      for (let generation = 0; generation < 3; generation++) {
        let control;
        const dispatched = [];
        const settlement = await runWorkflowScript({
          cwd,
          runId: "budget-replay",
          scriptText,
          scriptHash: "unchanged",
          askSpecs,
          validate,
          caps: { maxConcurrency: 1, maxPendingAsks: 1, maxAsksPerRun: 2 },
          control: {
            bind(api) {
              control = api;
            },
          },
          makeDriver: (sink) => ({
            ...makeDriver(journal, async () => undefined),
            emit(event) {
              if (generation === 0 && event.type === "log" && event.message === "checkpoint")
                control.stop("interrupted");
            },
            startAsk(_session, instance, message) {
              dispatched.push(instance);
              setTimeout(() => sink.askTurnEnded(instance, `answer:${message.instructions}`), 30);
            },
          }),
        });
        assert.equal(settlement.status, generation === 0 ? "stopped" : "completed");
        const rows = journal.listNodes("budget-replay").filter((node) => node.kind === "ask");
        assert.equal(rows.length, 3);
        assert.deepEqual(
          rows.map((node) => node.actorSeq),
          [0, undefined, 1],
        );
        assert.equal(rows[1].status, "failed");
        assert.deepEqual(rows[1].error.details, { limit: "pending", cap: 1, actual: 1 });
        if (generation === 0) expectedNodes = structuredClone(rows);
        else {
          assert.equal(settlement.artifact, "AgentBudgetExceeded");
          assert.deepEqual(dispatched, []);
          assert.deepEqual(rows, expectedNodes);
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
    }
  },
);
