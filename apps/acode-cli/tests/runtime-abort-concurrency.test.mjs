import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * review §7 盲区 1：取消/中止（abort）的专门覆盖。
 *
 * 对照 DWF-01 的 signal 全链（AGENTS.md「进程、协议与远程控制」）：
 *   engine-world.ts:120-121（准入即落 running，signal.throwIfAborted 在派发前）
 *   → workflow-driver.ts:461（executeWorldRead 把 signal 原样透传给世界读取）
 *   → workflow-world-read.ts:340-347（world.run 把 deps.signal 交给 ExecutionPort.run）
 *   → node-execution-adapter-lifecycle.ts:52-56 / node-execution-adapter-run.ts:47-49
 *     （外部 signal.abort → controller.abort；已 aborted → 派发前短路 cancelled）
 *
 * 覆盖点：
 *   1. world.run 把 deps.signal 透传到 ExecutionPort（链路 :340-347 的接线守护）；
 *   2. 运行中 run 被取消：真实子进程被终止，结算成 cancelled 终态（并发中止传播）；
 *   3. 取消前已 aborted：派发前短路，不产生子进程（cancelled before spawn，lifecycle :53-54）；
 *   4. 取消与结算的竞态：取消幂等——已 terminal 的后台任务再 cancel 不改写终态；
 *   5. 后台任务 cancel 传播 controller.abort（lifecycle :368-371）+ waitForBackgroundTask 中止即返回。
 *
 * 不用固定 sleep：用 waitUntil 有界轮询等「子进程 started」「后台任务离开 running」，
 * 与 mcp-startup-gate / prompt-routing 的既有范式一致。真实子进程用 process.execPath 阻塞脚本，
 * 只在断言它被 abort 终止时才依赖 OS 调度（cancel 是同步 controller.abort，非墙钟定时）。
 * 临时目录经 t.after 清理。
 */

const { createNodeExecutionAdapter } = await import(
  "../packages/adapters/src/exec/node-execution-adapter.ts"
);
const { executeWorldRead } = await import(
  "../packages/cli-workflow/src/workflow-world-read.ts"
);

/** 有界轮询（仓内 waitUntil 范式，mcp-startup-gate-deferred-tools.test.mjs:264）。 */
function waitUntil(predicate, timeoutMs = 15_000, stepMs = 15) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const loop = async () => {
      let satisfied = false;
      try {
        satisfied = await predicate();
      } catch {
        satisfied = false;
      }
      if (satisfied) return resolve(true);
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error("waitUntil timed out"));
      }
      setTimeout(loop, stepMs);
    };
    void loop();
  });
}

/** 阻塞脚本：打印 marker 后挂住，只能被外部 kill 终止。用于制造「运行中取消」。 */
const BLOCKER =
  "process.stderr.write('STARTED\\n'); setInterval(function(){}, 1000);";

function argvRequest(script) {
  return {
    command: { mode: "argv", file: process.execPath, args: ["-e", script] },
    timeoutMs: 20_000,
  };
}

/** 完成态 ExecutionResult（世界读取 stub 用），字段齐备以过 worldRun 的 ranToExit 判定。 */
function completedResult() {
  const now = new Date();
  return {
    cancelled: false,
    completedAt: now,
    durationMs: 0,
    exitCode: 0,
    startedAt: now,
    status: "completed",
    stderr: { bytes: 0, text: "", truncated: false },
    stdout: { bytes: 0, text: "", truncated: false },
    timedOut: false,
  };
}

// ── 1. signal 透传：world.run → ExecutionPort（链路 :340-347）───────────────

test("abort(1): world.run 把 deps.signal 原样透传给 ExecutionPort.run（链路接线守护）", async () => {
  let receivedSignal;
  const executionPort = {
    run: async (_request, options) => {
      receivedSignal = options?.signal;
      return completedResult();
    },
  };
  const controller = new AbortController();
  const result = await executeWorldRead(
    {
      cwd: "/workspace",
      declaredRunCommands: new Set(["echo"]),
      executionPort,
      fileSystemPort: {},
      signal: controller.signal,
    },
    "run",
    ["echo", []],
  );
  // signal 未被丢弃/替换：世界读取把同一个 AbortSignal 交给执行端口。
  assert.equal(receivedSignal, controller.signal, "world.run 未把 deps.signal 透传给 ExecutionPort");
  assert.equal(result.exitCode, 0);
});

test("abort(1b): signal 缺席时以 undefined 传给 ExecutionPort（不伪造 signal）", async () => {
  const seen = [];
  const executionPort = {
    run: async (_request, options) => {
      seen.push(options?.signal);
      return completedResult();
    },
  };
  await executeWorldRead(
    { cwd: "/workspace", declaredRunCommands: new Set(["echo"]), executionPort, fileSystemPort: {} },
    "run",
    ["echo", []],
  );
  assert.deepEqual(seen, [undefined], "无 signal 时不得伪造一个 AbortSignal");
});

// ── 2. 运行中取消：真实子进程被终止，结算成 cancelled ────────────────────────

test("abort(2): 运行中的 run 被取消——真实子进程终止且结算为 cancelled 终态", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-abort-mid-"));
  const adapter = createNodeExecutionAdapter({ outputRootDir: dir });
  t.after(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });

  const controller = new AbortController();
  let started = false;
  const runPromise = adapter.run(argvRequest(BLOCKER), {
    onEvent: (event) => {
      if (event.type === "started") started = true;
    },
    signal: controller.signal,
  });

  // 先确认真的 spawn 出子进程（进入「运行中」），再取消——这才是运行中取消而非派发前短路。
  await waitUntil(() => started);
  assert.equal(started, true, "前置：子进程必须已 started 才谈得上运行中取消");
  controller.abort();
  const result = await runPromise;

  assert.equal(result.cancelled, true, "取消后必须结算为 cancelled");
  assert.equal(result.status, "cancelled", `终态必须是 cancelled，实际 ${result.status}`);
});

// ── 3. 取消与派发竞态：已 aborted 的 signal 短路，不产生子进程 ────────────────

test("abort(3): signal 派发前已 aborted——短路为 cancelled before spawn，不跑子进程", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-abort-pre-"));
  const adapter = createNodeExecutionAdapter({ outputRootDir: dir });
  t.after(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });

  const controller = new AbortController();
  controller.abort();
  let sawStarted = false;
  const result = await adapter.run(argvRequest(BLOCKER), {
    onEvent: (event) => {
      if (event.type === "started") sawStarted = true;
    },
    signal: controller.signal,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(sawStarted, false, "已 aborted 时不得 spawn 子进程（派发前短路，run.ts:47-49）");
  assert.match(result.error?.message ?? "", /before spawn/iu, "错误应说明是 spawn 前取消");
});

// ── 4. 取消幂等：terminal 后台任务再 cancel 不改写终态 ───────────────────────

test("abort(4): 后台任务取消幂等——pre-aborted start 落 cancelled，重复 cancel 不改写终态", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-abort-idem-"));
  const adapter = createNodeExecutionAdapter({ outputRootDir: dir });
  t.after(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });

  const controller = new AbortController();
  controller.abort();
  const started = await adapter.start(argvRequest(BLOCKER), { signal: controller.signal });
  // 等它离开 running（pre-abort → controller.abort → 结算 cancelled）。
  await waitUntil(async () => {
    const snap = await adapter.getBackgroundTask(started.taskId);
    return snap?.status !== "running";
  });
  const settled = await adapter.getBackgroundTask(started.taskId);
  assert.equal(settled.status, "cancelled", "pre-aborted 后台任务应结算为 cancelled");

  // 重复取消：已 terminal 的任务，cancelBackgroundTask 不再改写状态（幂等）。
  const cancel1 = await adapter.cancelBackgroundTask(started.taskId);
  const cancel2 = await adapter.cancelBackgroundTask(started.taskId);
  assert.equal(cancel1?.status, "cancelled");
  assert.equal(cancel2?.status, "cancelled", "重复取消必须幂等，终态保持 cancelled");
});

test("abort(4b): 运行中后台任务——waitFor 可被等待者 signal 中止、cancelBackgroundTask 终止且幂等", async (t) => {
  // 一个真实阻塞子进程覆盖三件事（省掉重复的 5s 强杀窗口）：
  //   a) waitForBackgroundTask 收到等待者 signal.abort 立即返回快照（取消传播到等待者）；
  //   b) cancelBackgroundTask 终止运行中任务 → cancelled（lifecycle :368-371）；
  //   c) 重复 cancel 幂等、waitFor（无 signal）收敛到终态不悬挂。
  const dir = await mkdtemp(join(tmpdir(), "acode-abort-bg-run-"));
  const adapter = createNodeExecutionAdapter({ outputRootDir: dir });
  t.after(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });

  const started = await adapter.start(argvRequest(BLOCKER));
  // 等子进程真的起来（status running、有 pid），才是运行中取消而非派发前短路。
  await waitUntil(async () => {
    const snap = await adapter.getBackgroundTask(started.taskId);
    return snap?.status === "running" && snap?.pid !== undefined;
  });

  // a) 等待者 signal abort：立即用当前快照 resolve，不等子进程自然结束。
  const waitController = new AbortController();
  const waitPromise = adapter.waitForBackgroundTask(started.taskId, { signal: waitController.signal });
  waitController.abort();
  const waitSnapshot = await waitPromise;
  assert.equal(waitSnapshot?.taskId, started.taskId, "等待者 abort 后应返回该任务快照");
  assert.equal(waitSnapshot?.status, "running", "此刻任务仍在运行，等待者中止不改任务状态");

  // b) 真正取消运行中任务。
  const cancel1 = await adapter.cancelBackgroundTask(started.taskId);
  assert.equal(cancel1?.status, "cancelled", "运行中后台任务取消后应标记 cancelled");
  // c) 重复取消幂等（running 分支已走过，不再改写终态）。
  const cancel2 = await adapter.cancelBackgroundTask(started.taskId);
  assert.equal(cancel2?.status, "cancelled", "重复取消幂等");
  // 无 signal 的 waitFor 必须收敛到终态（取消结算后不悬挂）。
  const waited = await adapter.waitForBackgroundTask(started.taskId);
  assert.equal(waited?.status, "cancelled", "取消后等待应收敛到 cancelled 终态");
});
