import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Supervisor } from "../src/supervisor/supervisor.ts";
import { resolveServerLayout } from "../src/runtime/paths.ts";
import { requestControl } from "../src/ipc/controlClient.ts";

async function until(read, predicate) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Supervisor did not reach expected state");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acode-auto-ready-"));
  const layout = resolveServerLayout(root);
  const children = [];
  const supervisor = new Supervisor({
    layout,
    version: "test",
    coreReadyTimeoutMs: 400,
    coreStopGraceTimeoutMs: 1_000,
    launcher: {
      launch(generation) {
        // 每次 launch 必须在前一个真实 child 的 OS 终态之后。
        assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
        const child = spawn(
          process.execPath,
          [
            "-e",
            `
          process.on("message", (message) => {
            if (message.command === "crash") process.exit(1);
            if (message.command === "shutdown") {
              process.send({ type: "ready", host: "127.0.0.1", port: 4321, version: "test", generation: ${generation} });
              setTimeout(() => process.exit(0), 25);
            }
          });
          ${generation === 2 ? "" : `process.send({ type: "ready", host: "127.0.0.1", port: 4321, version: "test", generation: ${generation} });`}
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
    await supervisor.stop();
    children.forEach((child) => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    await rm(root, { recursive: true, force: true });
  });
  await supervisor.start();
  await until(
    () => supervisor.status(),
    (status) => status.state === "ready",
  );
  children[0].send({ command: "crash" });
  await until(
    () => supervisor.status(),
    (status) => children.length === 2 && status.state === "starting",
  );
  return { supervisor, children, layout };
}

test("automatic restart ready deadline drains the real child before budgeted recovery", async (t) => {
  const { supervisor, children, layout } = await fixture(t);
  const failed = await until(
    () => requestControl(layout.controlEndpoint, { command: "status" }, 1_000),
    (status) => status.state === "crashed" && status.lastExitReason?.includes("ready deadline"),
  );
  assert.equal(failed.crashBudget.crashCount, 2);
  assert.equal(failed.pid, null);
  assert.ok(children[1].exitCode !== null || children[1].signalCode !== null);
  const recovered = await until(
    () => supervisor.status(),
    (status) => status.state === "ready" && children.length === 3,
  );
  assert.equal(recovered.generation, 3);
  assert.equal(recovered.coreHealth, "healthy");
});

test("explicit stop cancels automatic ready deadline and late ready cannot revive Core", async (t) => {
  const { supervisor, children } = await fixture(t);
  const stopped = await supervisor.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.pid, null);
  assert.equal(stopped.coreHealth, "unknown");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(supervisor.status().state, "stopped");
  assert.equal(children.length, 2);
  assert.ok(children[1].exitCode !== null || children[1].signalCode !== null);
});
