import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { waitForCoreTermination } = await import("../src/supervisor/coreTermination.ts");

function fakeCore({ sendThrows = false } = {}) {
  const core = new EventEmitter();
  core.pid = 4321;
  core.sent = [];
  core.killed = [];
  core.send = (message) => {
    if (sendThrows) throw new Error("IPC channel is closed");
    core.sent.push(message);
  };
  core.kill = (signal) => {
    core.killed.push(signal);
  };
  return core;
}

test("waitForCoreTermination resolves on graceful exit after IPC shutdown", async () => {
  const core = fakeCore();
  const waiting = waitForCoreTermination(core, { graceTimeoutMs: 5_000, killTimeoutMs: 2_000 });
  assert.deepEqual(core.sent, [{ command: "shutdown" }]);
  core.emit("exit", 0, null);
  await waiting;
  assert.deepEqual(core.killed, []);
});

test("waitForCoreTermination escalates to SIGKILL after the grace period", async () => {
  const core = fakeCore();
  const waiting = waitForCoreTermination(core, { graceTimeoutMs: 20, killTimeoutMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(core.killed, ["SIGKILL"]);
  core.emit("close", null, "SIGKILL");
  await waiting;
});

test("waitForCoreTermination rejects when no terminal event follows SIGKILL", async () => {
  const core = fakeCore();
  await assert.rejects(
    waitForCoreTermination(core, { graceTimeoutMs: 10, killTimeoutMs: 20 }),
    /did not terminate after SIGKILL/,
  );
  assert.deepEqual(core.killed, ["SIGKILL"]);
});

test("waitForCoreTermination force-kills immediately when IPC is already closed", async () => {
  const core = fakeCore({ sendThrows: true });
  const waiting = waitForCoreTermination(core, { graceTimeoutMs: 5_000, killTimeoutMs: 1_000 });
  assert.deepEqual(core.killed, ["SIGKILL"]);
  core.emit("exit", null, "SIGKILL");
  await waiting;
});
