// spare 认领集成测试(spec: packages/services/specs/agent-process-prewarm.md 验收场景 1/2/3/6/7/8/9)。
// 进程面用仓库既有 fixture 惯例:commandResolver 注入 `node -e` 假 CLI(对齐
// test/acodeAgentIdleExitAttribution.test.ts),真实 spawn/认领/回收,不用 mock 进程。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ACodeAgentProcessManager } from "../src/acode-agent/acodeAgentProcessManager.js";
import type { ACodeAgentSparePrewarmOptions } from "../src/acode-agent/acodeAgentProcessManager.js";
import type {
  AgentSparePoolTiming,
  AgentSparePrewarmConfig,
} from "../src/acode-agent/acodeAgentSparePrewarm.js";
import type {
  RuntimeProcessExitEvent,
  RuntimeProcessSpawnEvent,
} from "../src/process/runtimeProcessLifecycle.js";

const PROCESS_WAIT_TIMEOUT_MS = 20_000;
// 待命假 CLI:保持存活、不讲协议(测试只断言进程/池/identity 事实,不发协议请求)。
// 假 CLI 配合 graceful EOF：stdin 关闭即退出（对齐真实 CLI 的 stdin-close/idle-exit
// 语义）。旧桩 setInterval(()=>{},1000) 无视 stdin 永不退出，把 dispose 逼进强杀
// 路径，在 Windows 上偶发撞上残留 pid 校验竞态（flaky 失败 + 孤儿子进程吊住
// stdio 管道令 test runner 永不退出，2026-10-16 全量门禁实锤挂死 6 小时）。
const ALIVE_SCRIPT = "process.stdin.resume(); process.stdin.on('close', () => process.exit(0));";
const TIMING_LOG_MESSAGE = "ACode agent session start timing";
const CIRCUIT_WARN_MESSAGE = "ACode agent spare prewarm disabled after consecutive failures";

interface TimingEntry {
  outcome?: unknown;
  workspaceKey?: unknown;
  acquisitionMs?: unknown;
  sparePid?: unknown;
  spareAgeMs?: unknown;
  storageReady?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = PROCESS_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting: ${message}`);
}

/**
 * 捕获 session start timing 日志(spec R3 的观测面)。serviceLogger 的 sink 是 console
 * 对象本身,补丁 console.log 属性即可拦截;测试窗口内原样透传其余日志。
 */
async function captureLogs<T>(
  run: () => Promise<T>,
): Promise<{ result: T; timings: TimingEntry[]; circuitWarns: number }> {
  const timings: TimingEntry[] = [];
  let circuitWarns = 0;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    const index = args.indexOf(TIMING_LOG_MESSAGE);
    if (index >= 0) {
      const context = args[index + 1];
      if (context && typeof context === "object") {
        timings.push(context as TimingEntry);
      }
    }
    originalLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (args.some((arg) => typeof arg === "string" && arg.includes(CIRCUIT_WARN_MESSAGE))) {
      circuitWarns += 1;
    }
    originalWarn(...args);
  };
  try {
    const result = await run();
    return { result, timings, circuitWarns };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

interface HarnessOptions {
  prewarmCwd: string;
  config?: AgentSparePrewarmConfig;
  timing?: Partial<AgentSparePoolTiming>;
  resolverReturnsNull?: boolean;
  sparePrewarm?: Omit<ACodeAgentSparePrewarmOptions, "config" | "timing" | "prewarmCwd">;
}

function createHarness(options: HarnessOptions) {
  const spawns: RuntimeProcessSpawnEvent[] = [];
  const exits: RuntimeProcessExitEvent[] = [];
  let resolverCalls = 0;
  const manager = new ACodeAgentProcessManager({
    commandResolver: () => {
      resolverCalls += 1;
      if (options.resolverReturnsNull) {
        return null;
      }
      return {
        command: process.execPath,
        args: ["--input-type=module", "-e", ALIVE_SCRIPT],
      };
    },
    processLifecycleReporter: {
      onSpawn: (event) => spawns.push(event),
      onExit: (event) => exits.push(event),
    },
    sparePrewarm: {
      config: options.config ?? { enabled: true, poolSize: 1 },
      prewarmCwd: options.prewarmCwd,
      // 补位/冷却默认拉长到测试窗口外:认领后的补位不得干扰 pid/计数断言;
      // 熔断测试用自有 timing 覆盖。
      timing: {
        warmDelayMs: 1,
        replenishDelayMs: 60_000,
        lossCooldownMs: 60_000,
        failureBackoffBaseMs: 1,
        failureBackoffMaxMs: 4,
        circuitFailureThreshold: 2,
        minSpareLifetimeMs: 50,
        ...options.timing,
      },
      ...options.sparePrewarm,
    },
  });
  return {
    manager,
    spawns,
    exits,
    resolverCalls: () => resolverCalls,
    spareSpawn: () => spawns.find((event) => event.workspacePath === options.prewarmCwd),
    async waitSpareReady(): Promise<RuntimeProcessSpawnEvent> {
      await waitFor(() => manager.getSparePrewarmState()?.standbyCount === 1, "spare pooled");
      await waitFor(
        () => spawns.some((event) => event.workspacePath === options.prewarmCwd),
        "spare spawn event",
      );
      return this.spareSpawn()!;
    },
  };
}

async function makeTempDirs(count: number): Promise<string[]> {
  const dirs: string[] = [];
  for (let index = 0; index < count; index += 1) {
    dirs.push(await mkdtemp(join(tmpdir(), `acode-agent-prewarm-${index}-`)));
  }
  return dirs;
}

/**
 * 拆除兜底：disposeAllAndWait 即使抛错（如 Windows 强杀路径的残留 pid 偶发），
 * 也强杀本 harness 派生过的全部真实假 CLI 子进程——孤儿进程会经 stdio 管道把
 * test runner 吊死（整个套件跑完也不退出），必须结构性排除。
 */
async function teardownHarness(
  harness: ReturnType<typeof createHarness>,
  dirs: string[],
): Promise<void> {
  try {
    await harness.manager.disposeAllAndWait();
  } finally {
    for (const event of harness.spawns) {
      const pid = event.pid;
      if (typeof pid === "number" && pid > 0) {
        try {
          process.kill(pid);
        } catch {
          // 已退出/不可达——正是期望终态。
        }
      }
    }
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

test("认领命中 + 真实冒烟:getClient 返回备件 client,identity 归属真实 workspace(验收场景 1/9)", async (t) => {
  const [prewarmCwd, workspacePath] = await makeTempDirs(2);
  const harness = createHarness({ prewarmCwd });
  t.after(async () => {
    await teardownHarness(harness, [prewarmCwd, workspacePath]);
  });

  const spareSpawn = await harness.waitSpareReady();
  const { result: client, timings } = await captureLogs(() =>
    harness.manager.getClient({ workspacePath }),
  );

  assert.ok(client, "认领必须返回 client");
  assert.equal(timings.length, 1);
  assert.equal(timings[0]!.outcome, "spare_hit");
  assert.equal(timings[0]!.workspaceKey, workspacePath);
  assert.equal(timings[0]!.sparePid, spareSpawn.pid);
  assert.equal(timings[0]!.storageReady, false, "假 CLI 无 storage startup 宣告");
  assert.equal(typeof timings[0]!.acquisitionMs, "number");
  // 认领不产生第二个进程:resolver 只被备件 spawn 调用过一次。
  assert.equal(harness.resolverCalls(), 1);
  assert.equal(harness.spawns.length, 1);
  // 冒烟:认领后 runtime identity 以真实 workspaceKey 重建,generation=1,pid=备件 pid。
  const identity = await harness.manager.getRuntimeIdentity({ workspacePath });
  assert.equal(identity.workspaceKey, workspacePath);
  assert.equal(identity.generation, 1);
  assert.equal(identity.processId, spareSpawn.pid);
  assert.equal(identity.identity, `${workspacePath}:1:${spareSpawn.pid}`);
  // 池已消耗:standby 0,补位排程在测试窗口外(consumed)。
  assert.equal(harness.manager.getSparePrewarmState()?.standbyCount, 0);
  assert.equal(harness.manager.getSparePrewarmState()?.pendingTrigger, "consumed");
});

test("认领竞态单飞:两个 workspace 并发 getClient,恰一个 hit 一个 consumed_race(验收场景 2)", async (t) => {
  const [prewarmCwd, workspaceA, workspaceB] = await makeTempDirs(3);
  const harness = createHarness({ prewarmCwd });
  t.after(async () => {
    await teardownHarness(harness, [prewarmCwd, workspaceA, workspaceB]);
  });

  const spareSpawn = await harness.waitSpareReady();
  const { timings } = await captureLogs(async () => {
    const [clientA, clientB] = await Promise.all([
      harness.manager.getClient({ workspacePath: workspaceA }),
      harness.manager.getClient({ workspacePath: workspaceB }),
    ]);
    assert.notEqual(clientA, clientB, "两个 workspace 不得共享同一进程");
    return { clientA, clientB };
  });
  await waitFor(() => harness.spawns.length === 2, "cold spawn for the race loser");

  const outcomes = timings.map((entry) => entry.outcome).sort();
  assert.deepEqual(outcomes, ["spare_hit", "spare_miss_consumed_race"]);
  const identityA = await harness.manager.getRuntimeIdentity({ workspacePath: workspaceA });
  const identityB = await harness.manager.getRuntimeIdentity({ workspacePath: workspaceB });
  assert.equal(identityA.processId, spareSpawn.pid, "A 拿到备件");
  assert.notEqual(identityB.processId, spareSpawn.pid, "B 冷启动");
});

test("kill switch:config 关闭时不孵化备件,miss 归因 spare_miss_disabled(验收场景 3)", async (t) => {
  const [prewarmCwd, workspacePath] = await makeTempDirs(2);
  const harness = createHarness({
    prewarmCwd,
    config: { enabled: false, poolSize: 0, disabledReason: "kill_switch" },
  });
  t.after(async () => {
    await teardownHarness(harness, [prewarmCwd, workspacePath]);
  });

  const state = harness.manager.getSparePrewarmState();
  assert.equal(state?.configured, true);
  assert.equal(state?.enabled, false);

  const { timings } = await captureLogs(() => harness.manager.getClient({ workspacePath }));
  assert.equal(timings.length, 1);
  assert.equal(timings[0]!.outcome, "spare_miss_disabled");
  // 只有冷启动这一个进程,预热面完全没有动作。getClient 在 spawn 事件前就返回,等事件到达再断言。
  assert.equal(harness.resolverCalls(), 1);
  await waitFor(() => harness.spawns.length === 1, "cold spawn event");
  assert.equal(harness.spawns[0]!.workspacePath, workspacePath);
  await sleep(30);
  assert.equal(harness.resolverCalls(), 1, "disabled 池不得延迟孵化");
  assert.equal(harness.spawns.length, 1, "kill switch 下不得孵化任何备件");
});

test("认领门禁:ineligible 不消耗备件,后续合格 workspace 仍可认领(验收场景 7)", async (t) => {
  const [prewarmCwd, workspaceA, workspaceB] = await makeTempDirs(3);
  const harness = createHarness({
    prewarmCwd,
    sparePrewarm: {
      collectSpawnContextFacts: () => ({ cuaEnabled: false }),
      // 模拟 CUA 姿态门禁:workspaceA 不合格(备件缺 CUA env),workspaceB 合格。
      resolveClaimEligibility: (context) => context.workspacePath !== workspaceA,
    },
  });
  t.after(async () => {
    await teardownHarness(harness, [prewarmCwd, workspaceA, workspaceB]);
  });

  const spareSpawn = await harness.waitSpareReady();
  const first = await captureLogs(() => harness.manager.getClient({ workspacePath: workspaceA }));
  assert.equal(first.timings.length, 1);
  assert.equal(first.timings[0]!.outcome, "spare_miss_ineligible");
  // 门禁拒绝不消耗备件:A 冷启动,备件仍在池中待命。
  assert.equal(harness.manager.getSparePrewarmState()?.standbyCount, 1);
  await waitFor(() => harness.spawns.length === 2, "cold spawn for ineligible workspace");

  const second = await captureLogs(() => harness.manager.getClient({ workspacePath: workspaceB }));
  assert.equal(second.timings.length, 1);
  assert.equal(second.timings[0]!.outcome, "spare_hit");
  assert.equal(second.timings[0]!.sparePid, spareSpawn.pid);
  const identityB = await harness.manager.getRuntimeIdentity({ workspacePath: workspaceB });
  assert.equal(identityB.processId, spareSpawn.pid);
});

test("dispose 统一回收:待命备件随 disposeAllAndWait 退出,池清空(验收场景 6)", async (t) => {
  const [prewarmCwd, workspacePath] = await makeTempDirs(2);
  const harness = createHarness({ prewarmCwd });
  t.after(async () => {
    await Promise.all(
      [prewarmCwd, workspacePath].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const spareSpawn = await harness.waitSpareReady();
  await harness.manager.disposeAllAndWait();
  await waitFor(
    () => harness.exits.some((event) => event.pid === spareSpawn.pid),
    "spare process exit after dispose",
  );
  const state = harness.manager.getSparePrewarmState();
  assert.equal(state?.disposed, true);
  assert.equal(state?.standbyCount, 0);
  await assert.rejects(
    () => harness.manager.getClient({ workspacePath }),
    /disposed/,
    "dispose 后 getClient 维持既有拒绝语义",
  );
});

test("只读路径不认领:getExistingClient/getRuntimeIdentity 不消耗备件、不打 timing(验收场景 8)", async (t) => {
  const [prewarmCwd, workspacePath] = await makeTempDirs(2);
  const harness = createHarness({ prewarmCwd });
  t.after(async () => {
    await harness.manager.disposeAllAndWait();
    await Promise.all(
      [prewarmCwd, workspacePath].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  await harness.waitSpareReady();
  const { timings } = await captureLogs(async () => {
    assert.equal(
      harness.manager.getExistingClient({ workspacePath }),
      undefined,
      "备件不是任何真实 workspace 的已登记 runtime",
    );
    await assert.rejects(
      () => harness.manager.getRuntimeIdentity({ workspacePath }),
      /unavailable/,
    );
  });
  assert.equal(timings.length, 0, "被动 observer 不产生 session start timing 事件");
  assert.equal(harness.manager.getSparePrewarmState()?.standbyCount, 1);
  assert.equal(harness.resolverCalls(), 1);
});

test("spawn 失败熔断:resolver 不可用时退避熔断,warn 一次,miss 归因 spawn_failed(验收场景 5)", async (t) => {
  const [prewarmCwd, workspacePath] = await makeTempDirs(2);
  const harness = createHarness({
    prewarmCwd,
    resolverReturnsNull: true,
    timing: {
      warmDelayMs: 1,
      failureBackoffBaseMs: 1,
      failureBackoffMaxMs: 2,
      circuitFailureThreshold: 2,
    },
  });
  t.after(async () => {
    await harness.manager.disposeAllAndWait();
    await Promise.all(
      [prewarmCwd, workspacePath].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  // 捕获窗口覆盖「熔断发生 + 冷启动 miss」:warn 恰好一次在真实代码路径上验证。
  const { timings, circuitWarns } = await captureLogs(async () => {
    await waitFor(
      () => harness.manager.getSparePrewarmState()?.circuitOpen === true,
      "circuit open",
    );
    await assert.rejects(
      () => harness.manager.getClient({ workspacePath }),
      /not configured/,
      "冷启动路径同样失败,但失败语义不被预热改变",
    );
  });
  assert.equal(circuitWarns, 1, "熔断只 warn 一次");
  assert.equal(timings.length, 1);
  assert.equal(timings[0]!.outcome, "spare_miss_spawn_failed");
  // 熔断阈值=2:两次预热失败 + getClient 冷启动一次,之后池不再尝试补位。
  assert.equal(harness.resolverCalls(), 3);
  await sleep(30);
  assert.equal(harness.resolverCalls(), 3, "熔断后不得继续补位(反风暴)");
});
