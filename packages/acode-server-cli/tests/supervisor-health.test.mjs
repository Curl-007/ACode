import test from "node:test";
import assert from "node:assert/strict";

const [{ CoreHealthMonitor }, contracts] = await Promise.all([
  import("../src/supervisor/coreHealth.ts"),
  import("../src/contracts.ts"),
]);

test("Core health transitions from healthy to degraded/unresponsive and recovers", () => {
  let now = 1_000;
  const monitor = new CoreHealthMonitor({ timeoutMs: 30_000, now: () => now });

  assert.equal(monitor.snapshot().health, "unknown");
  monitor.markReady();
  assert.equal(monitor.snapshot().health, "healthy");

  now += 15_001;
  assert.equal(monitor.snapshot(now).health, "degraded");
  assert.equal(monitor.currentHealth(), "healthy", "queries must not consume a transition");
  assert.equal(monitor.evaluate().health, "degraded");
  now += 15_000;
  assert.equal(monitor.evaluate().health, "unresponsive");

  monitor.markHeartbeat();
  assert.equal(monitor.snapshot().health, "healthy");
  assert.equal(monitor.snapshot().lastHeartbeatAt, now);
});

test("Core health reset clears stale generation and old status snapshots remain readable", () => {
  let now = 2_000;
  const monitor = new CoreHealthMonitor({ timeoutMs: 1_000, now: () => now });
  monitor.markReady();
  monitor.reset();
  assert.deepEqual(monitor.snapshot(), { health: "unknown", lastHeartbeatAt: null });

  const parsed = contracts.serverStatusSchema.parse({
    protocolVersion: 1,
    state: "ready",
    pid: 42,
    port: 1234,
    host: "127.0.0.1",
    version: "test",
    generation: 1,
    startedAt: 2_000,
    lastExitReason: null,
    serviceRegistered: false,
    runningTaskCount: 0,
    crashBudget: { crashCount: 0, nextRestartDelayMs: 1_000, exhausted: false },
    updatedAt: now,
  });
  assert.equal(parsed.coreHealth, "unknown");
  assert.equal(parsed.lastHeartbeatAt, null);
});
