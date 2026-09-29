import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 修正项 #3 的验收测试：runtime task registry 的终态 **first-wins**。
 *
 * 规格 apps/acode-cli/specs/subagent-terminal-first-wins.md，本文件逐条对应它的验收场景
 * 1-8（场景 9 是「本文件 + 既有 subagent-terminal-race-ordering.test.mjs 的翻转」，
 * 后者已按同一 spec 从「断言缺口存在」更新为「断言缺口已闭合」）。
 * (9) 组对应 spec 的「评审补强（2026-09-29）」R6 / 验收场景 10：runner 级的
 * finalizeBackgroundStopped 输家分支——原语层守卫拒绝写入后，调用方必须拿赢家快照收口，
 * 不发停止通知、不走 register(previousTask) 回滚。
 *
 * 修复的形状（R1/R2）：`InMemoryRuntimeTaskRegistry.update()` 是终态覆盖的**唯一入口**，
 * 守卫就落在这个原语上——「写入前后 status 都是终态且不相等」即拒绝，并返回**赢家快照**
 * （不是 undefined，那是「条目不存在」的既有信号）。
 *
 * 为什么必须落在原语层而不是调用方：runner.ts 的三条 finalize 路径都是
 * 「读快照判终态 → await 真实文件 I/O → 写快照」，守卫与写入之间的窗口客观存在，
 * 调用方各自判终态兜不住并发方向（(2) 就是这个窗口的确定性复刻）。
 *
 * 同时必须**放行**的既有语义（R3，(5)(6)(7)）：不改 status 的字段写入、终态 → 非终态、
 * 以及走 register() 的重臂与回滚。守卫过宽会打死通知认领、晚挂载合并与 resume 新生命。
 */

const root = new URL("../../../", import.meta.url);
// core.autocrlf=true 的机器上 git checkout 会把工作区重写为 CRLF，令含 \n 的
// 多行 indexOf/match 断言失真（约定文字核查是位置敏感的）；读取后统一归一为 LF。
const read = (path) =>
  readFile(new URL(path, root), "utf8").then((text) => text.replace(/\r\n/gu, "\n"));
const CLI = "apps/acode-cli/packages";

const { InMemoryRuntimeTaskRegistry, isTerminalRuntimeTask } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const {
  claimRuntimeBackgroundTaskNotification,
  registerRuntimeBackgroundTask,
  releaseRuntimeBackgroundTaskNotification,
  updateRuntimeBackgroundTask,
} = await import("../packages/core/src/tool/executor/background-task-registry.ts");
const { createExploreSubagentPort } = await import("../packages/core/src/subagent/runner.ts");

function snapshot(overrides = {}) {
  return {
    agentId: "task_1",
    agentType: "general-purpose",
    description: "first-wins probe",
    startedAt: new Date(1_700_000_000_000),
    status: "running",
    taskId: "task_1",
    type: "local_agent",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ── 场景 1 / 4：R1 判据与 R2 的返回值约定 ────────────────────────────

test("(1) 场景 1：终态不可被另一个终态覆盖，双向对称", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot());

  // running → completed：非终态 → 终态，放行。
  registry.update("task_1", (task) => ({ ...task, status: "completed" }));
  assert.equal(registry.get("task_1").status, "completed");

  // completed → killed：两侧都是终态且不相等 → 拒绝。
  registry.update("task_1", (task) => ({ ...task, status: "killed" }));
  assert.equal(registry.get("task_1").status, "completed", "completed 被 killed 覆盖");

  // 反向对称：不存在「哪个终态更权威」的偏序。
  const other = new InMemoryRuntimeTaskRegistry();
  other.register(snapshot({ status: "killed" }));
  other.update("task_1", (task) => ({ ...task, status: "completed" }));
  assert.equal(other.get("task_1").status, "killed", "killed 被 completed 覆盖");

  // TERMINAL_STATUSES 的其余成员同样受保护（failed / stopped / lost / cancelled）。
  for (const winner of ["failed", "stopped", "lost", "cancelled"]) {
    const each = new InMemoryRuntimeTaskRegistry();
    each.register(snapshot({ status: winner }));
    each.update("task_1", (task) => ({ ...task, status: "completed" }));
    assert.equal(each.get("task_1").status, winner, `${winner} 被 completed 覆盖`);
  }
});

test("(4) 场景 4：写入被拒时返回赢家快照，不是 undefined", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot({ status: "completed", resultText: "winner artifact" }));

  const rejected = registry.update("task_1", (task) => ({ ...task, status: "failed" }));
  // undefined 在本接口里的既有含义是「条目不存在」，调用方据此走 task_missing 分支
  // （runner.ts 的 `if (task)`、claim 的 `task === undefined ? true : claimed`）。
  assert.notEqual(rejected, undefined, "被拒的写入返回了 undefined：与「条目不存在」混淆");
  assert.equal(rejected.status, "completed");
  assert.equal(rejected.resultText, "winner artifact", "返回的不是赢家快照");

  // 对照：条目不存在时仍返回 undefined（两个信号必须可区分）。
  assert.equal(registry.update("task_missing", (task) => task), undefined);

  // 写入生效时返回新快照。
  const live = new InMemoryRuntimeTaskRegistry();
  live.register(snapshot());
  const written = live.update("task_1", (task) => ({ ...task, status: "failed" }));
  assert.equal(written.status, "failed");
});

// ── 场景 2 / 3：并发方向与两条读通道 ─────────────────────────────────

test("(2) 场景 2：并发方向也 first-wins——两条 finalize 的守卫都过了，先写者赢", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot());

  // 确定性复刻 runner.ts 三条 finalize 路径的形状：读快照过守卫 → await（真实文件 I/O 的位置）
  // → 写快照。两条路径的守卫都在 await **之前**通过（都读到 running），所以调用方各自的
  // 终态判断挡不住这个交错；原子性只能由原语层提供。
  const makeFinalize = (status) => async (gate) => {
    const current = registry.get("task_1");
    if (current && isTerminalRuntimeTask(current)) return { path: "fast-path-skip" };
    await gate;
    const written = registry.update("task_1", (task) => ({ ...task, status }));
    return { path: "wrote", winner: written?.status };
  };

  const completionGate = deferred();
  const stoppedGate = deferred();
  const completion = makeFinalize("completed")(completionGate.promise);
  const stopped = makeFinalize("killed")(stoppedGate.promise);

  // 先让 completion 的 I/O 落地（先写者），再放行 stopped 的写入（后到者）。
  completionGate.resolve();
  const completedResult = await completion;
  stoppedGate.resolve();
  const stoppedResult = await stopped;

  assert.equal(completedResult.winner, "completed");
  // 后到者的守卫早就通过了，所以它不是走快速路径退出，而是**在写入时被原语层拒绝**。
  assert.equal(stoppedResult.path, "wrote", "交错形状变了：后到者没有走到写入");
  assert.equal(stoppedResult.winner, "completed", "后写者覆盖成功：并发方向没有 first-wins");
  assert.equal(registry.get("task_1").status, "completed");
});

test("(3) 场景 3：waitForTerminal 与 registry.get() 报告同一个终态", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot());
  const waited = registry.waitForTerminal("task_1");

  registry.update("task_1", (task) => ({ ...task, status: "killed" }));
  registry.update("task_1", (task) => ({ ...task, status: "completed" }));

  // R5：一致性由 R1 保证。resolveWaiters 首次结算即删除整组 waiter 是**既有**语义（本项不改），
  // 而第二次覆盖被拒，所以事后轮询读到的快照与等待方结算的快照必然同值。
  assert.equal((await waited).status, "killed");
  assert.equal(registry.get("task_1").status, "killed", "两条读通道分叉了");
});

// ── 场景 5：R3 第一条——不改 status 的写入一律放行 ────────────────────

test("(5) 场景 5：终态条目上不改 status 的写入不被误挡", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot({ status: "completed" }));
  const deps = { runtimeTaskRegistry: registry };
  const toolCall = { id: "toolu_probe", input: { command: "sleep 1" }, name: "Bash" };

  // notified 认领令牌：真实调用方是 claim/releaseRuntimeBackgroundTaskNotification。
  // 认领写在**终态条目**上是常态（终态先落，通知后发），被挡住就会吞掉模型通知。
  assert.equal(
    claimRuntimeBackgroundTaskNotification(deps, toolCall, "task_1"),
    true,
    "终态条目上的通知认领被误挡",
  );
  assert.equal(registry.get("task_1").notified, true);
  assert.equal(registry.get("task_1").status, "completed");
  // 二次认领必须仍被 notified 去重（守卫不得改变 claim 的幂等语义）。
  assert.equal(claimRuntimeBackgroundTaskNotification(deps, toolCall, "task_1"), false);
  releaseRuntimeBackgroundTaskNotification(deps, toolCall, "task_1");
  assert.equal(registry.get("task_1").notified, false);
  assert.equal(registry.get("task_1").status, "completed");

  // messageSink：createMessageSinkRegistration 可能在终态之后才到达。
  const sink = { send: async () => "queued" };
  registry.update("task_1", (task) => ({ ...task, messageSink: sink }));
  assert.equal(registry.get("task_1").messageSink, sink);

  // pendingMessages：queueMessage 内部走 update。
  registry.queueMessage("task_1", {
    id: "msg_1",
    message: "late steering",
    queuedAt: new Date(1_700_000_000_000),
  });
  assert.equal(registry.get("task_1").pendingMessages?.length, 1);
  assert.equal(registry.drainMessages("task_1").length, 1);

  // 产物补齐：output / usage / resultText。
  registry.update("task_1", (task) => ({
    ...task,
    resultText: "artifact",
    usage: { totalTokens: 42 },
  }));
  assert.equal(registry.get("task_1").resultText, "artifact");
  assert.equal(registry.get("task_1").usage?.totalTokens, 42);
  assert.equal(registry.get("task_1").status, "completed");
});

// ── 场景 6 / 7：R3 第二、三条——重臂与晚挂载合并 ──────────────────────

test("(6) 场景 6：重臂走 register()，不被守卫触及；updateRuntimeBackgroundTask 在终态条目上原样返回", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(9);
  registry.register(
    snapshot({
      branchGeneration: 3,
      notified: true,
      status: "cancelled",
      taskId: "task_dwf",
      type: "local_dynamic_workflow",
    }),
  );

  // updateRuntimeBackgroundTask 自带守卫（终态时 patcher 原样返回 current），所以它的写入
  // 既不改 status、也不该被新守卫改变行为。
  const deps = { runtimeTaskRegistry: registry };
  const dwfCall = { id: "toolu_dwf", input: {}, name: "CreateWorkflow" };
  updateRuntimeBackgroundTask(deps, dwfCall, "task_dwf", "completed");
  assert.equal(registry.get("task_dwf").status, "cancelled", "终态条目的 status 被 update 改写了");

  // 重臂（resume 新生命）：dwf 分派名 + 既有条目已终态 → newLife → 走 register()。
  registerRuntimeBackgroundTask(deps, dwfCall, "task_dwf", {});
  const rearmd = registry.get("task_dwf");
  assert.equal(rearmd.status, "running", "重臂被守卫挡住：resume 的新生命起不来");
  // 结算面随重臂复位：上一轮的 claim 令牌必须作废，否则恢复后的终态通知被吞。
  assert.equal(rearmd.notified, false);
  // 走 register 而不是 update 的**理由**：register 按当前 activeBranchGeneration 重盖分支代，
  // 而 update 的 {...existing} 会把上一段生命的分支代带进新生命（→ stale-branch fencing 误丢）。
  assert.equal(rearmd.branchGeneration, 9, "新生命继承了上一段生命的分支代");

  // 新生命照常能进入终态，且此后同样受 first-wins 保护。
  registry.update("task_dwf", (task) => ({ ...task, status: "completed" }));
  assert.equal(registry.get("task_dwf").status, "completed");
  registry.update("task_dwf", (task) => ({ ...task, status: "failed" }));
  assert.equal(registry.get("task_dwf").status, "completed");
});

test("(7) 场景 7：晚挂载合并（终态 → running，走 update）不被误挡", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  // Bash/Agent 的 task id 一轮即弃，但 tracker 晚挂载会撞上**已认领**的终态条目。
  registry.register(snapshot({ notified: true, status: "completed", taskId: "task_bash" }));

  const deps = { runtimeTaskRegistry: registry };
  // Bash 不是 dwf 分派名 → rearm=false → newLife=false → 既有终态条目走 update() 合并。
  const bashCall = { id: "toolu_bash", input: { command: "sleep 1" }, name: "Bash" };
  registerRuntimeBackgroundTask(deps, bashCall, "task_bash", {});

  const merged = registry.get("task_bash");
  assert.equal(merged.status, "running", "终态 → 非终态被误挡：晚挂载合并失效");
  assert.equal(merged.isBackgrounded, true);
  // 非重臂：这是**同一**生命周期的认领令牌，不得被无差别复位（否则同一终态的通知二次入队）。
  assert.equal(merged.notified, true, "晚挂载合并误把 notified 复位了");

  // 合并回 running 之后，条目重新可进入终态并受 first-wins 保护。
  registry.update("task_bash", (task) => ({ ...task, status: "failed" }));
  assert.equal(registry.get("task_bash").status, "failed");
  registry.update("task_bash", (task) => ({ ...task, status: "completed" }));
  assert.equal(registry.get("task_bash").status, "failed");
});

// ── 场景 8：R4——约定文字与守卫同处一地 ───────────────────────────────

test("(8) 场景 8：约定文字在案，且写在被守的原语与三处 finalize 守卫上", async () => {
  const registry = await read(`${CLI}/core/src/runtime-task/registry.ts`);
  const runner = await read(`${CLI}/core/src/subagent/runner.ts`);

  // R4 的落点要求：约定写在**被守的原语**上（不是某个调用方），并写清「谁是赢家 / 为什么 /
  // 拒绝时返回什么」，表达强度对齐 dynamic-workflow/src/engine/engine-settlement.ts:7。
  assert.match(registry, /终态 \*\*first-wins\*\*/u, "update() 的 first-wins 约定文字缺失");
  assert.match(registry, /不得被\*\*另一个终态\*\*/u, "R1 判据的约定文字缺失");
  assert.match(registry, /第一个写下终态的路径就是赢家/u, "「谁是赢家」的约定文字缺失");
  assert.match(registry, /返回 `current`（而不是 undefined）/u, "R2 返回值约定文字缺失");
  // R3 的放行清单也必须在案，否则下一次改动无从判断守卫是否过宽。
  assert.match(registry, /不改 status 的字段写入/u);
  assert.match(registry, /终态 → 非终态/u);
  assert.match(registry, /走 register\(\)，不经这里/u);
  // 约定文字必须与守卫同处一地：紧挨着 update() 的**实现**（不是文件头的泛泛说明），
  // 且守卫代码就在这段注释之后的那个 update 体内。
  // 注意 indexOf 要从约定文字之后开始搜：同文件 :82 的 RuntimeTaskRegistry **接口**也声明了
  // 同形的 update(，从 0 开始搜会先命中接口声明，测不出「注释挨着实现」这件事。
  const conventionAt = registry.indexOf("终态 **first-wins**");
  const updateAt = registry.indexOf("  update(\n    id: string,", conventionAt);
  const guardAt = registry.indexOf("isTerminalRuntimeTask(current) &&", conventionAt);
  const winnerReturnAt = registry.indexOf("      return current;", conventionAt);
  assert.ok(conventionAt > 0, "找不到 first-wins 约定文字");
  assert.ok(
    updateAt > conventionAt && guardAt > updateAt && winnerReturnAt > guardAt,
    "约定文字与 update() 实现/守卫分离了：R4 要求两者同处一地",
  );

  // 三条 finalize 路径各有一条约定注释（R4 第二条），且都写明两件事：
  // 本处只是**快速路径**（省掉无谓的 artifact I/O），真正的原子性由**原语层**兜底。
  // 少了后半句，读者会误以为守卫本身就是原子的——那正是审计判「未文档化」的原状。
  assert.equal(
    runner.match(/终态 first-wins/gu)?.length,
    3,
    "runner.ts 三处 finalize 守卫的 first-wins 约定文字数量变了",
  );
  assert.equal(runner.match(/快速路径/gu)?.length, 3, "三处守卫的「快速路径」定性少了");
  assert.equal(runner.match(/原语层/gu)?.length, 3, "三处守卫的「原语层兜底」说明少了");
  assert.match(runner, /原子性由原语层兜底/u);
  assert.match(runner, /并发方向由 registry\.update 的原语层守卫兜底/u);
  assert.match(runner, /并发方向由原语层守卫兜底/u);
  // 约定与规格互相指回，避免各自漂移（completion / failure 两处直接引 spec 路径，
  // stopped 那处引「同款注释」，故为 2 次而非 3 次）。
  assert.ok(
    runner.match(/specs\/subagent-terminal-first-wins\.md/gu)?.length >= 2,
    "runner.ts 的守卫注释没有指回 specs/subagent-terminal-first-wins.md",
  );
  // registry.ts 的约定注明了它的表达强度对齐对象（workflow 侧的对照物），
  // 这样两侧约定漂移时能被看出来。
  assert.match(registry, /engine-settlement\.ts:7 的 first-wins 约定/u);
});

// ── (9) 评审补强 R6 / 场景 10：runner 级输家分支 ─────────────────────
//
// 原语层守卫（场景 1-8）只保证「写不进去」；本组钉住的是调用方的收口：
// finalizeBackgroundStopped 的写入被拒后，必须带赢家快照返回——不发停止通知、
// 不走 register(previousTask) 回滚。修复前的行为：update 返回值被忽略，
// enqueued=false 时 register() 用陈旧 running 快照覆盖赢家终态（register 不经守卫），
// registry 停在 running，waitForTerminal 与 get() 分叉（R5 反例）。
//
// 交错用「不 await 的 stopTask + 同步 registry 写入」确定性复刻（与场景 (2) 同法）：
// stopTask 同步通过快速路径判读后挂在 writeStoppedAgentArtifacts 的 await 上，
// 此时直接对 registry 写入赢家终态，再放行 stopTask 的续体。

function makeStoppedRacePort(registry, notifications) {
  return createExploreSubagentPort({
    enqueueParentTaskNotification: (notification) => {
      notifications.push(notification);
    },
    emitParentEvent: async () => undefined,
    runExploreAgent: async () => {
      throw new Error("unused: stopTask race probe");
    },
    runtimeTaskRegistry: registry,
  });
}

test("(9a) 场景 10①：I/O 窗口内 completion 抢先（已认领 notified），stopTask 返回赢家且不回滚", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot());
  const notifications = [];
  const port = makeStoppedRacePort(registry, notifications);

  const stopping = port.stopTask("task_1");
  // completion 路径在 writeStoppedAgentArtifacts 窗口内赢：终态 + 已认领通知。
  registry.update("task_1", (task) => ({
    ...task,
    status: "completed",
    notified: true,
    resultText: "winner artifact",
  }));
  const result = await stopping;

  assert.equal(result?.status, "completed", "输家没有拿到赢家快照");
  assert.equal(result?.resultText, "winner artifact");
  assert.equal(notifications.length, 0, "给实际 completed 的任务发了停止通知");
  const final = registry.get("task_1");
  assert.equal(final.status, "completed", "register(previousTask) 回滚覆盖了赢家终态");
  assert.equal(final.notified, true);
  assert.equal(final.resultText, "winner artifact");
});

test("(9b) 场景 10②：赢家未认领 notified 时，停止路径也不得代发/抢占认领", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot());
  const notifications = [];
  const port = makeStoppedRacePort(registry, notifications);

  const stopping = port.stopTask("task_1");
  registry.update("task_1", (task) => ({ ...task, status: "completed" }));
  const result = await stopping;

  assert.equal(result?.status, "completed");
  // 修复前此路径会把「已停止」通知入队并认领 notified，吞掉赢家自己的完成通知。
  assert.equal(notifications.length, 0, "输家代发了停止通知/抢占了 notified 认领");
  assert.equal(registry.get("task_1").status, "completed");
  assert.notEqual(registry.get("task_1").notified, true, "认领必须留给赢家自己的路径");
});

test("(9c) 场景 10③：双重 stopTask 并发（killed-over-killed），单通知、不回滚、不 throw", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register(snapshot({ agentId: "task_dup", taskId: "task_dup" }));
  const notifications = [];
  const port = makeStoppedRacePort(registry, notifications);

  // 两个 stopTask 都在对方提交前通过快速路径判读（条目仍 running），各自挂进 I/O 窗口；
  // 微任务顺序保证第一个先提交 killed 并认领，第二个的写入撞上已终态条目。
  const [first, second] = await Promise.all([
    port.stopTask("task_dup"),
    port.stopTask("task_dup"),
  ]);

  assert.equal(first?.status, "killed");
  assert.equal(second?.status, "killed", "后到的 stop 没有拿到赢家快照（修复前此处 throw + 回滚）");
  assert.equal(notifications.length, 1, "双重 stop 产生了第二条停止通知");
  const final = registry.get("task_dup");
  assert.equal(final.status, "killed", "第二个 stop 的回滚把条目退回了 running");
  assert.equal(final.notified, true);
});
