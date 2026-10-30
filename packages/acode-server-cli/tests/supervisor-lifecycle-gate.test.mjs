import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as defer } from "node:timers/promises";

const [{ LifecycleOperationGate }, { ControlRequestError }] = await Promise.all([
  import("../src/supervisor/lifecycleOperationGate.ts"),
  import("../src/ipc/controlError.ts"),
]);

test("run dedupes stop-during-stop onto the same promise", async () => {
  const gate = new LifecycleOperationGate();
  let calls = 0;
  let release;
  const first = gate.run(
    "stop",
    () =>
      new Promise((resolve) => {
        calls += 1;
        release = () => resolve("stopped");
      }),
  );
  assert.equal(gate.active?.kind, "stop");
  const second = gate.run("stop", () => {
    calls += 1;
    return Promise.resolve("other");
  });
  await defer();
  assert.equal(typeof release, "function");
  release();
  assert.equal(await first, "stopped");
  assert.equal(await second, "stopped");
  assert.equal(calls, 1);
  assert.equal(gate.active, undefined);
});

test("run rejects conflicting operations while one is in flight", async () => {
  const gate = new LifecycleOperationGate();
  let release;
  const first = gate.run(
    "stop",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  assert.throws(
    () => gate.run("restart", () => Promise.resolve()),
    (error) => {
      assert.ok(error instanceof ControlRequestError);
      assert.equal(error.code, "operation-in-progress");
      assert.equal(error.retryable, true);
      return true;
    },
  );
  await defer();
  release();
  await first;
  // gate 释放后同/异类操作可再次进入
  assert.equal(await gate.run("restart", () => Promise.resolve("restarted")), "restarted");
});

test("startAcknowledged defers the operation until the ack can be written", async () => {
  const gate = new LifecycleOperationGate();
  const order = [];
  gate.startAcknowledged("uninstall", () => {
    order.push("operation");
    return Promise.resolve();
  });
  order.push("after-call");
  await defer();
  await defer();
  assert.deepEqual(order, ["after-call", "operation"]);
});

test("startAcknowledged checks the gate before returning the ack", async () => {
  const gate = new LifecycleOperationGate();
  let release;
  const first = gate.run(
    "update",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  assert.throws(
    () => gate.startAcknowledged("stop", () => Promise.resolve()),
    (error) => {
      assert.ok(error instanceof ControlRequestError);
      assert.equal(error.code, "operation-in-progress");
      return true;
    },
  );
  await defer();
  release();
  await first;
});
