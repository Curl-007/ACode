import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Supervisor } from "../src/supervisor/supervisor.ts";
import { resolveServerLayout } from "../src/runtime/paths.ts";
import { readPersistedStatus } from "../src/runtime/statusSnapshot.ts";
import { requestControl } from "../src/ipc/controlClient.ts";

async function until(read, predicate, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test("Supervisor exposes heartbeat loss and recovery over real IPC, fences restart and clears stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-supervisor-health-"));
  const layout = resolveServerLayout(root);
  const children = [];
  let now = 1_000;
  const supervisor = new Supervisor({
    layout,
    version: "test",
    now: () => now,
    coreHeartbeatTimeoutMs: 1_000,
    coreHeartbeatCheckIntervalMs: 50,
    coreStopGraceTimeoutMs: 1_000,
    launcher: {
      launch(generation) {
        const child = spawn(
          process.execPath,
          [
            "-e",
            `
          process.on("message", (message) => {
            if (message.command === "shutdown") process.exit(0);
            if (message.command === "heartbeat") {
              process.send({ type: "heartbeat", at: 9999999999, runningTaskCount: 2 });
            }
          });
          process.send({ type: "ready", host: "127.0.0.1", port: 1234, version: "test", generation: ${generation} });
        `,
          ],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        children.push(child);
        return child;
      },
    },
  });
  t.after(async () => {
    await supervisor.stop("test-cleanup");
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  });

  const started = await supervisor.start();
  assert.equal(started.coreHealth, "unknown");
  await until(
    () => supervisor.status(),
    (s) => s.state === "ready",
    "Core should become ready",
  );
  assert.equal(supervisor.status().lastHeartbeatAt, now);

  now = 1_501;
  const degraded = await requestControl(layout.controlEndpoint, { command: "status" });
  assert.equal(degraded.coreHealth, "degraded");
  assert.equal(degraded.state, "ready");
  now = 2_001;
  await until(
    () => readPersistedStatus(layout),
    (s) => s?.coreHealth === "unresponsive",
    "health loss should persist",
  );
  assert.equal(
    supervisor.status().pid,
    children[0].pid,
    "heartbeat loss must retain the current Core",
  );

  now = 2_500;
  children[0].send({ command: "heartbeat" });
  await until(
    () => requestControl(layout.controlEndpoint, { command: "status" }),
    (s) => s.coreHealth === "healthy" && s.runningTaskCount === 2,
    "heartbeat should recover health",
  );
  assert.equal(supervisor.status().lastHeartbeatAt, now, "use receive time, not child time");

  const oldChild = children[0];
  await supervisor.restart();
  await until(
    () => supervisor.status(),
    (s) => s.state === "ready",
    "replacement should become ready",
  );
  const before = supervisor.status();
  now = 3_000;
  oldChild.emit("message", { type: "heartbeat", at: 1, runningTaskCount: 99 });
  assert.equal(supervisor.status().runningTaskCount, 0);
  assert.equal(supervisor.status().lastHeartbeatAt, before.lastHeartbeatAt);
  assert.equal(supervisor.status().generation, 2);

  const stopped = await supervisor.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.pid, null);
  assert.equal(stopped.coreHealth, "unknown");
  assert.equal(stopped.lastHeartbeatAt, null);
  assert.equal(stopped.runningTaskCount, 0);
});

test("Supervisor ignores early and stopping Core activity messages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-supervisor-early-"));
  let child;
  let earlyReceived = false;
  const supervisor = new Supervisor({
    layout: resolveServerLayout(root),
    version: "test",
    launcher: {
      launch() {
        child = spawn(
          process.execPath,
          [
            "-e",
            `
          process.on("message", (message) => {
            if (message.command === "shutdown") setTimeout(() => process.exit(0), 100);
          });
          process.send({ type: "heartbeat", at: 123, runningTaskCount: 9 });
        `,
          ],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        child.on("message", () => {
          earlyReceived = true;
        });
        return child;
      },
    },
  });
  t.after(async () => {
    await supervisor.stop("test-cleanup");
    if (child?.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  });
  await supervisor.start();
  await until(() => earlyReceived, Boolean, "early heartbeat should arrive");
  assert.equal(supervisor.status().state, "starting");
  assert.equal(supervisor.status().coreHealth, "unknown");
  assert.equal(supervisor.status().runningTaskCount, 0);

  const stopping = supervisor.stop();
  await until(
    () => supervisor.status(),
    (s) => s.state === "stopping",
    "Core should be stopping",
  );
  child.emit("message", { type: "task-activity", runningTaskCount: 99 });
  assert.equal(supervisor.status().coreHealth, "unknown");
  assert.equal(supervisor.status().lastHeartbeatAt, null);
  assert.equal(supervisor.status().runningTaskCount, 0);
  await stopping;
});
