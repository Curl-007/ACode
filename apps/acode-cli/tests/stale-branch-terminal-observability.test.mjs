import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 修正项 #5 的验收测试：stale-branch 丢弃后 registry 终态仍可观察。
 *
 * 规格 apps/acode-cli/specs/command-terminal-state-audit.md §C（stale-branch 丢弃的可观测性
 * 约定）。钉住的产品约定（此前只活在 runtime-command-generation.ts 的源码注释里）：
 *
 *   1. stale-branch 丢弃的是**通知注入**，不是终态。rewind 与后台 completion 存在竞态，
 *      旧分支的命令/事件必须在持久化和 provider 注入前再次校验 generation 后丢弃；
 *      但任务自身的终态仍在 runtime task registry 的快照里。
 *   2. 两条丢弃路径（命令 isStaleBranchRuntimeCommand / 事件 isStaleBranchRuntimeTaskEvent）
 *      对 registry **只读不写**——丢弃动作本身不得触碰任务快照。
 *   3. waitForTerminal 不做 branch fencing：跨代等待方照常拿到终态，「丢弃」≠「终态丢失」。
 *   4. 日志分级：命令丢弃走 **info**（一条命令一行；「队列丢弃」是 CLI 侧明列必须可观测
 *      的面，debug 生产不落盘）；事件路径**刻意**保持 debug（事件粒度触发，一个 stale 任务
 *      rewind 后可连发多条，提 info 会造成日志突发）。
 *
 * 驱动的是真实实现（registry + runtime-command-generation），runtime 用最小替身。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const CLI = "apps/acode-cli/packages";

const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const {
  isStaleBranchRuntimeCommand,
  isStaleBranchRuntimeTaskEvent,
} = await import("../packages/core/src/runtime/methods/runtime-command-generation.ts");
const { SessionEventType } = await import("../packages/contracts/src/index.ts");

const TRACE = {
  attributes: {},
  parentSpanId: undefined,
  queryId: undefined,
  sessionId: "sess_stale_branch",
  spanId: "span_stale_branch",
  traceId: "trace_stale_branch",
  turnId: undefined,
};

function createLogger() {
  const entries = { debug: [], info: [] };
  return {
    entries,
    debug: (message, context) => entries.debug.push({ context, message }),
    info: (message, context) => entries.info.push({ context, message }),
  };
}

function taskSnapshot(overrides = {}) {
  return {
    agentId: "task_bg_1",
    agentType: "general-purpose",
    branchGeneration: 0,
    description: "background worker",
    startedAt: new Date(1_700_000_000_000),
    status: "running",
    taskId: "task_bg_1",
    type: "local_agent",
    ...overrides,
  };
}

/** 最小 AgentRuntimeInternal 替身：只含两条丢弃路径真正读取的字段。 */
function createRuntime({ branchGeneration = 1 } = {}) {
  const registry = new InMemoryRuntimeTaskRegistry();
  const logger = createLogger();
  const runtime = { branchGeneration, logger, runtimeTaskRegistry: registry };
  return { logger, registry, runtime };
}

function notificationCommand(overrides = {}) {
  return {
    branchGeneration: 0,
    createdAt: new Date(1_700_000_000_000),
    id: "cmd_notify_1",
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    taskId: "task_bg_1",
    text: 'Agent general-purpose task "bg worker" completed.',
    traceContext: TRACE,
    ...overrides,
  };
}

test("(1) 命令丢弃只丢通知注入：registry 终态在 get 与 waitForTerminal 两条通道都仍可观察", async () => {
  const { registry, runtime } = createRuntime({ branchGeneration: 1 });
  // 旧分支（generation 0）上注册的任务已自然收尾。
  registry.register(taskSnapshot({ branchGeneration: 0 }));
  registry.update("task_bg_1", (task) => ({
    ...task,
    resultText: "final artifact",
    status: "completed",
  }));

  // rewind 已发生：runtime.branchGeneration = 1，命令带着旧代 0 到达 → 判 stale 丢弃。
  const dropped = isStaleBranchRuntimeCommand(runtime, notificationCommand({ branchGeneration: 0 }));
  assert.equal(dropped, true);

  // 终态通道一：registry.get 的快照原样在场（丢弃动作没有触碰它）。
  const snapshot = registry.get("task_bg_1");
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.resultText, "final artifact");

  // 终态通道二：waitForTerminal 不做 branch fencing——任务代际(0) ≠ 活动代际(1)
  // 不影响等待方立即拿到终态（§C 约定的核心：等待方照常拿到终态）。
  const waited = await registry.waitForTerminal("task_bg_1");
  assert.equal(waited.status, "completed");
  assert.equal(waited.resultText, "final artifact");
});

test("(2) 两条丢弃路径对 registry 只读不写：update/remove/register/queueMessage 均未被触碰", () => {
  const { registry, runtime } = createRuntime();
  registry.register(taskSnapshot({ status: "completed" }));

  const mutations = [];
  for (const method of [
    "queueMessage",
    "register",
    "remove",
    "requestBackground",
    "setActiveBranchGeneration",
    "update",
  ]) {
    const original = registry[method].bind(registry);
    registry[method] = (...args) => {
      mutations.push(method);
      return original(...args);
    };
  }

  assert.equal(isStaleBranchRuntimeCommand(runtime, notificationCommand()), true);
  assert.equal(
    isStaleBranchRuntimeTaskEvent(runtime, {
      payload: { taskId: "task_bg_1" },
      type: SessionEventType.BackgroundTaskCompleted,
    }),
    true,
  );
  assert.deepEqual(mutations, [], "丢弃路径写入了 registry：§C「只读快照」约定被破坏");
});

test("(3) 命令丢弃日志走 info（debug→info 已提升），事件名与对账字段齐全", () => {
  const { logger, runtime } = createRuntime();
  isStaleBranchRuntimeCommand(runtime, notificationCommand());

  assert.equal(logger.entries.debug.length, 0, "命令丢弃落到了 debug：生产不可见，提升回退了");
  assert.equal(logger.entries.info.length, 1);
  const context = logger.entries.info[0].context;
  assert.equal(context.event, "runtime.command.stale_branch_dropped");
  assert.equal(context.module, "core.runtime");
  // 对账面：丢的是哪条命令、哪个代际、什么模式，以及 trace 关联。
  assert.equal(context.commandId, "cmd_notify_1");
  assert.equal(context.branchGeneration, 0);
  assert.equal(context.currentBranchGeneration, 1);
  assert.equal(context.mode, "task-notification");
  assert.equal(context.traceId, "trace_stale_branch");
});

test("(4) 姊妹路径（task 事件）刻意不同级：debug、事件名不同，四类事件与 agentId 回退都识别", () => {
  const { logger, registry, runtime } = createRuntime();
  registry.register(taskSnapshot({ branchGeneration: 0 }));

  const fenced = [
    SessionEventType.BackgroundTaskUpdated,
    SessionEventType.BackgroundTaskCompleted,
    SessionEventType.SubagentMessage,
    SessionEventType.SubagentStopped,
  ];
  for (const type of fenced) {
    assert.equal(
      isStaleBranchRuntimeTaskEvent(runtime, { payload: { taskId: "task_bg_1" }, type }),
      true,
      `${type} 未被识别为围栏内事件`,
    );
  }
  // payload 只有 agentId 时同样能定位任务（SubagentMessage/Stopped 的形状）。
  assert.equal(
    isStaleBranchRuntimeTaskEvent(runtime, {
      payload: { agentId: "task_bg_1" },
      type: SessionEventType.SubagentStopped,
    }),
    true,
  );

  assert.equal(logger.entries.info.length, 0, "事件路径提到了 info：rewind 后会日志突发");
  assert.equal(logger.entries.debug.length, fenced.length + 1);
  assert.equal(logger.entries.debug[0].context.event, "runtime.task_event.stale_branch_dropped");
  assert.equal(logger.entries.debug[0].context.taskId, "task_bg_1");
  assert.equal(logger.entries.debug[0].context.eventType, SessionEventType.BackgroundTaskUpdated);
});

test("(5) waitForTerminal 不做 branch fencing：跨代 waiter 照常收到旧分支任务的终态", async () => {
  const { registry } = createRuntime();
  registry.register(taskSnapshot({ branchGeneration: 0, status: "running" }));
  // rewind 到新分支后，旧分支任务的生命周期仍在收尾。
  registry.setActiveBranchGeneration(3);

  const waited = registry.waitForTerminal("task_bg_1");
  let resolved = false;
  void waited.then(() => {
    resolved = true;
  });

  registry.update("task_bg_1", (task) => ({ ...task, status: "killed" }));
  assert.equal((await waited).status, "killed");
  // waiter 的 then 回调在 await waited 之后必然已运行（它注册得更早）。
  assert.equal(resolved, true, "waiter 没有被结算：waitForTerminal 出现了 branch fencing");
  assert.equal(registry.get("task_bg_1").status, "killed");
});

test("(6) 对照组：同代、围栏外 mode、无 taskId、任务不存在、围栏外事件类型都不丢弃", () => {
  const { logger, registry, runtime } = createRuntime({ branchGeneration: 2 });
  registry.register(taskSnapshot({ branchGeneration: 2 }));

  // 同代命令/事件：不 stale。
  assert.equal(
    isStaleBranchRuntimeCommand(runtime, notificationCommand({ branchGeneration: 2 })),
    false,
  );
  assert.equal(
    isStaleBranchRuntimeTaskEvent(runtime, {
      payload: { taskId: "task_bg_1" },
      type: SessionEventType.BackgroundTaskUpdated,
    }),
    false,
  );
  // 围栏外 mode（用户 prompt）即使命令带旧代也不丢弃（围栏只圈通知/子代理消息/控制轮）。
  assert.equal(
    isStaleBranchRuntimeCommand(runtime, notificationCommand({ branchGeneration: 0, mode: "prompt" })),
    false,
  );
  // control-only-turn 在围栏内：旧代的设置轮同样丢弃（它也是「注入」而非终态）。
  assert.equal(
    isStaleBranchRuntimeCommand(
      runtime,
      notificationCommand({ branchGeneration: 0, mode: "control-only-turn" }),
    ),
    true,
  );
  // 事件缺 taskId / 任务不存在 / 围栏外事件类型：一律放行（返回 false），且不产生日志。
  assert.equal(
    isStaleBranchRuntimeTaskEvent(runtime, { payload: {}, type: SessionEventType.SubagentMessage }),
    false,
  );
  assert.equal(
    isStaleBranchRuntimeTaskEvent(runtime, {
      payload: { taskId: "task_ghost" },
      type: SessionEventType.SubagentMessage,
    }),
    false,
  );
  assert.equal(
    isStaleBranchRuntimeTaskEvent(runtime, {
      payload: { taskId: "task_bg_1" },
      type: SessionEventType.TurnComplete,
    }),
    false,
  );
  assert.equal(logger.entries.debug.length, 0, "未丢弃的路径产生了日志");
  assert.equal(logger.entries.info.length, 1, "只有 (6) 里那条 control-only-turn 丢弃应记 info");
});

test("(7) 约定文字与调用点形状在案（防回退）", async () => {
  const generation = await read(`${CLI}/core/src/runtime/methods/runtime-command-generation.ts`);
  // §C 的 spec 互引：源码注释与 spec 必须互相指回，避免各自漂移。
  assert.match(generation, /specs\/command-terminal-state-audit\.md §C/u, "§C 引用消失了");
  assert.match(generation, /丢弃的是\*\*通知注入\*\*，不是终态/u, "「丢通知不丢终态」约定文字缺失");
  assert.match(generation, /waitForTerminal 不做 branch fencing/u);
  // 分级约定：命令路径 info + 队列丢弃可观测理由；事件路径刻意 debug + 突发理由。
  assert.match(generation, /runtime\.logger\?\.info\(/u, "命令丢弃的 info 提升回退了");
  assert.match(generation, /runtime\.logger\?\.debug\(/u, "事件路径被误提到 info（或 debug 被删）");
  assert.match(generation, /刻意不同级/u, "两条路径分级差异的理由说明缺失");
  assert.match(generation, /runtime\.command\.stale_branch_dropped/u);
  assert.match(generation, /runtime\.task_event\.stale_branch_dropped/u);

  // 调用点形状：active-loop 先 removeById 出队，再判 stale 并 continue——
  // 出队事实不回滚，丢弃的只是后续的持久化与 provider 注入。
  const activeLoop = await read(`${CLI}/core/src/runtime/methods/runtime-command-active-loop.ts`);
  const removeAt = activeLoop.indexOf("this.runtimeCommandQueue.removeById(command.id)");
  const staleAt = activeLoop.indexOf("isStaleBranchRuntimeCommand(this, removed)");
  assert.ok(removeAt > 0, "active-loop 的 removeById 调用点找不到了");
  assert.ok(staleAt > removeAt, "stale 判定跑到了出队之前：调用点形状变了，结论需复核");
});
