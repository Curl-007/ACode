// spare 池状态机测试(spec: packages/services/specs/agent-process-prewarm.md R1/R4)。
// spawnSpare 用 stub 注入,无真实进程;调度延迟全部收窄到毫秒级保证测试确定性。
import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentSparePrewarmPool,
  type AgentSparePoolTiming,
} from "../src/acode-agent/acodeAgentSparePrewarm.js";

const FAST_TIMING: Partial<AgentSparePoolTiming> = {
  warmDelayMs: 1,
  replenishDelayMs: 1,
  lossCooldownMs: 5,
  failureBackoffBaseMs: 1,
  failureBackoffMaxMs: 4,
  circuitFailureThreshold: 3,
  minSpareLifetimeMs: 50,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  message = "condition not met",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting: ${message}`);
}

interface PoolHarnessOptions {
  poolSize?: number;
  timing?: Partial<AgentSparePoolTiming>;
  spawn?: () => Promise<string>;
}

function createPoolHarness(options: PoolHarnessOptions = {}) {
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const infos: Array<{ message: string; context?: Record<string, unknown> }> = [];
  let spawnCalls = 0;
  let spawnSeq = 0;
  let rejectNext = false;
  const spawn =
    options.spawn ??
    (async () => {
      spawnCalls += 1;
      if (rejectNext) {
        throw new Error("simulated spawn failure");
      }
      return `spare-${(spawnSeq += 1)}`;
    });
  const pool = new AgentSparePrewarmPool<string>(
    {
      spawnSpare: spawn,
      logger: {
        info: (message, context) => infos.push({ message, context }),
        warn: (message, context) => warnings.push({ message, context }),
      },
    },
    {
      poolSize: options.poolSize ?? 1,
      timing: { ...FAST_TIMING, ...options.timing },
    },
  );
  return {
    pool,
    infos,
    warnings,
    spawnStats: () => ({ spawnCalls, spawnSeq }),
    failNextSpawn: () => {
      rejectNext = true;
    },
    recoverSpawn: () => {
      rejectNext = false;
    },
  };
}

test("首暖:start 后孵化 1 个备件;暖机前 miss 归因 not_warmed", async () => {
  const harness = createPoolHarness();
  // start 前无排程:池空且无补位在飞 → not_warmed(装配了但尚未暖机)。
  assert.equal(harness.pool.standbyCount, 0);
  harness.pool.start();
  assert.equal(harness.pool.missOutcome(), "spare_miss_not_warmed");
  await waitFor(() => harness.pool.standbyCount === 1, 5_000, "first spare warmed");
  assert.equal(harness.pool.peek(), "spare-1");
  assert.equal(harness.pool.snapshot().pendingTrigger, null);
  harness.pool.dispose();
});

test("认领即补位:take 后 miss 归因 consumed_race,补位自动孵化下一代", async () => {
  const harness = createPoolHarness();
  harness.pool.start();
  await waitFor(() => harness.pool.standbyCount === 1, 5_000, "first spare warmed");
  assert.equal(harness.pool.take("spare-1"), true);
  assert.equal(harness.pool.standbyCount, 0);
  // 补位已排程(consumed 触发):归因 consumed_race 而不是 not_warmed。
  assert.equal(harness.pool.missOutcome(), "spare_miss_consumed_race");
  await waitFor(() => harness.pool.standbyCount === 1, 5_000, "replenished after claim");
  assert.equal(harness.pool.peek(), "spare-2");
  // take 幂等:已取出的 entry 再 take/onLost 都不再记账。
  assert.equal(harness.pool.take("spare-1"), false);
  harness.pool.onLost("spare-1", { lifetimeMs: 10 });
  assert.equal(harness.pool.snapshot().consecutiveFailures, 0);
  harness.pool.dispose();
});

test("spawn 失败:指数退避,连续 3 次熔断,warn 恰好一次(验收场景 5)", async () => {
  const harness = createPoolHarness({
    spawn: async () => {
      throw Object.assign(new Error("command not configured"), { name: "Error" });
    },
  });
  harness.pool.start();
  await waitFor(() => harness.pool.snapshot().circuitOpen, 5_000, "circuit open");
  const snapshot = harness.pool.snapshot();
  assert.equal(snapshot.consecutiveFailures, 3);
  assert.equal(snapshot.standbyCount, 0);
  assert.equal(harness.warnings.length, 1, "熔断只 warn 一次");
  assert.match(harness.warnings[0]!.message, /spare prewarm disabled after consecutive failures/);
  assert.equal(harness.warnings[0]!.context?.errorName, "Error");
  // 熔断后 miss 归因 spawn_failed,且不再尝试补位。
  assert.equal(harness.pool.missOutcome(), "spare_miss_spawn_failed");
  await sleep(50);
  assert.equal(harness.pool.snapshot().circuitOpen, true);
  assert.equal(harness.pool.snapshot().pendingTrigger, null);
  harness.pool.dispose();
});

test("失败后退避中(未熔断)的 miss 归因是 spawn_failed", async () => {
  let calls = 0;
  const harness = createPoolHarness({
    timing: { failureBackoffBaseMs: 60, circuitFailureThreshold: 5 },
    spawn: async () => {
      calls += 1;
      throw new Error("nope");
    },
  });
  harness.pool.start();
  await waitFor(() => calls >= 1, 5_000, "first failure");
  assert.equal(harness.pool.missOutcome(), "spare_miss_spawn_failed");
  assert.equal(harness.pool.snapshot().circuitOpen, false);
  harness.pool.dispose();
});

test("短寿丢失按失败计退避;成功补位清零失败计数", async () => {
  const harness = createPoolHarness();
  harness.pool.start();
  await waitFor(() => harness.pool.standbyCount === 1, 5_000, "first spare warmed");
  // 存活 < minSpareLifetimeMs(50ms)的丢失 = 早夭/崩溃 → 失败路径。
  harness.pool.onLost("spare-1", { lifetimeMs: 5, errorName: "Weird Name!" });
  assert.equal(harness.pool.snapshot().consecutiveFailures, 1);
  assert.equal(harness.pool.missOutcome(), "spare_miss_spawn_failed");
  await waitFor(() => harness.pool.standbyCount === 1, 5_000, "replenished after short-lived loss");
  assert.equal(harness.pool.snapshot().consecutiveFailures, 0, "成功补位清零计数");
  assert.equal(harness.warnings.length, 0);
  harness.pool.dispose();
});

test("长寿丢失(含 CLI idle-exit TTL)走冷却补位,归因 not_warmed", async () => {
  const harness = createPoolHarness();
  harness.pool.start();
  await waitFor(() => harness.pool.standbyCount === 1, 5_000, "first spare warmed");
  harness.pool.onLost("spare-1", { lifetimeMs: 60_000 });
  assert.equal(harness.pool.snapshot().pendingTrigger, "loss");
  assert.equal(harness.pool.missOutcome(), "spare_miss_not_warmed");
  assert.equal(harness.pool.snapshot().consecutiveFailures, 0);
  await waitFor(() => harness.pool.standbyCount === 1, 5_000, "replenished after cooldown");
  assert.equal(harness.pool.peek(), "spare-2");
  harness.pool.dispose();
});

test("dispose:停排程、清索引;在飞 spawn 完成后不再入池", async () => {
  let releaseSpawn: ((value: string) => void) | undefined;
  const harness = createPoolHarness({
    spawn: () =>
      new Promise<string>((resolve) => {
        releaseSpawn = resolve;
      }),
  });
  harness.pool.start();
  await waitFor(() => harness.pool.snapshot().spawnInFlight, 5_000, "spawn in flight");
  harness.pool.dispose();
  assert.equal(harness.pool.snapshot().disposed, true);
  assert.equal(harness.pool.standbyCount, 0);
  // 在飞 spawn 在 dispose 后完成:进程回收归 manager,池不得索引(不可认领)。
  releaseSpawn?.("spare-late");
  await sleep(20);
  assert.equal(harness.pool.standbyCount, 0);
  assert.equal(harness.pool.missOutcome(), "spare_miss_not_warmed");
  // dispose 后 take/onLost/start 全部无效。
  harness.pool.start();
  harness.pool.onLost("spare-late", { lifetimeMs: 1 });
  await sleep(20);
  assert.equal(harness.pool.standbyCount, 0);
});

test("池大小 2:FIFO 认领,补齐到目标水位", async () => {
  const harness = createPoolHarness({ poolSize: 2 });
  harness.pool.start();
  await waitFor(() => harness.pool.standbyCount === 2, 5_000, "both spares warmed");
  const entries = harness.pool.standbyEntries();
  assert.deepEqual(
    entries.map((entry) => entry),
    ["spare-1", "spare-2"],
  );
  // FIFO:最老备件先被认领。
  assert.equal(harness.pool.peek(), "spare-1");
  assert.equal(harness.pool.take("spare-1"), true);
  await waitFor(() => harness.pool.standbyCount === 2, 5_000, "replenished to pool size");
  assert.equal(harness.pool.peek(), "spare-2");
  assert.equal(harness.pool.standbyEntries().includes("spare-3"), true);
  harness.pool.dispose();
});
