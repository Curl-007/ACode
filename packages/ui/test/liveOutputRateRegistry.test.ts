import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import {
  LiveOutputRateRegistry,
  observeLiveOutputRateStore,
} from "../src/v4/composer/liveOutputRateRegistry.js";

function snapshot(
  sessionId: string,
  turnId: string,
  text: string,
  options: { phase?: string; logEpoch?: number } = {},
): ConversationSnapshot {
  return {
    sessionId,
    logEpoch: options.logEpoch ?? 1,
    revision: 1,
    seq: 1,
    control: { phase: options.phase ?? "running" },
    subagents: { revision: 1, childSessionIds: [], running: [], endedTotal: 0 },
    workflowRuns: { runs: [] },
    rows: {
      window: [{ kind: "assistantText", rowId: 1, turnId, state: "streaming", text }],
    },
  } as unknown as ConversationSnapshot;
}

test("samples the active turn and notifies subscribers only when the rate changes", () => {
  const registry = new LiveOutputRateRegistry();
  let notifications = 0;
  const unsubscribe = registry.subscribe(() => {
    notifications += 1;
  });
  const first = snapshot("s1", "t1", "hello");
  registry.observe(first, 1000);
  assert.equal(registry.read(first), null);
  const second = snapshot("s1", "t1", "hello world, this is a longer streaming text");
  registry.observe(second, 1800);
  const rate = registry.read(second);
  assert.ok(rate !== null && rate > 0);
  assert.ok(notifications > 0);
  unsubscribe();
});

test("terminal phase, new turn and reconnect clear the previous rate", () => {
  const registry = new LiveOutputRateRegistry();
  const s1 = snapshot("s1", "t1", "streaming text for measurement");
  const s2 = snapshot("s1", "t1", "streaming text for measurement and more");
  registry.observe(s1, 1000);
  registry.observe(s2, 2000);
  assert.ok(registry.read(s2) !== null);

  const terminal = snapshot("s1", "t1", "done", { phase: "completed" });
  registry.observe(terminal, 2100);
  assert.equal(registry.read(terminal), null);

  const nextTurn = snapshot("s1", "t2", "new turn streaming text", {});
  registry.observe(s2, 3000);
  registry.observe(nextTurn, 3100);
  assert.equal(registry.read(nextTurn), null);
});

test("bounded session cache keeps only the newest sessions", () => {
  const registry = new LiveOutputRateRegistry(2);
  for (const id of ["a", "b", "c"]) {
    const value = snapshot(id, "t1", "streaming text for measurement");
    registry.observe(value, 1000);
    registry.observe(snapshot(id, "t1", "streaming text for measurement and more"), 2000);
  }
  assert.equal(registry.read(snapshot("a", "t1", "x")), null);
  assert.ok(registry.read(snapshot("c", "t1", "x")) !== null);
});

test("store observer ignores the reconnect ACK's stale snapshot and resumes on the next frame", () => {
  const registry = new LiveOutputRateRegistry();
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  let listener: (() => void) | null = null;
  let state = {
    status: "live" as string,
    snapshot: snapshot("s1", "t1", "streaming text for measurement") as ConversationSnapshot | null,
  };
  const store = {
    getState: () => state,
    subscribe: (next: () => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  } as never;
  const stop = observeLiveOutputRateStore(store, registry, "s1");
  const frame1 = snapshot("s1", "t1", "streaming text for measurement");
  now = 2000;
  state = { status: "live", snapshot: frame1 };
  listener?.();
  const frame2 = snapshot("s1", "t1", "streaming text for measurement and a lot more");
  now = 3000;
  state = { status: "live", snapshot: frame2 };
  listener?.();
  assert.ok(registry.read(frame2) !== null);
  state = { status: "error", snapshot: frame2 };
  listener?.();
  assert.equal(registry.read(frame2), null);
  // 重连 ACK 恢复 live 时沿用旧快照（对象身份不变）→ 不重放旧样本。
  state = { status: "live", snapshot: frame2 };
  listener?.();
  assert.equal(registry.read(frame2), null);
  stop();
  Date.now = realNow;
});
