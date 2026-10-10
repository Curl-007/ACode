import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * D5 并发治理面只读诊断投影的验收测试。
 *
 * 覆盖规格 apps/acode-cli/specs/concurrency-diagnostics-projection.md 的验收场景 1–4
 * 与 R4 契约成员形状。纪律断言：投影纯读（schedule() 结果不受 snapshot() 影响）、
 * 缺失即未知（端口缺席不猜测）、只写本地 debug 日志（无遥测/网络引用）。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const { ToolScheduler } = await import("../packages/core/src/tool/scheduler.ts");
const { getConcurrencyDiagnostics, logConcurrencyDiagnostics } = await import(
  "../packages/core/src/runtime/methods/concurrency-diagnostics.ts"
);
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { planResearchAgentCount } = await import(
  "../packages/core/src/runtime/helpers/runtime-reminders.ts"
);
const { EXPLORE_AGENT_TYPE } = await import("../packages/core/src/subagent/explore.ts");
const { createRootTraceContext } = await import("../packages/contracts/src/index.ts");

const NOW_MS = 1_700_000_000_000;

function readOnlyToolCalls(count) {
  return Array.from({ length: count }, (_, index) => ({
    toolCallId: `tool_${index}`,
    toolName: "Read",
    dependsOn: [],
  }));
}

function makeTask(overrides) {
  return {
    taskId: overrides.taskId ?? `task_${Math.random().toString(36).slice(2)}`,
    agentId: overrides.agentId ?? "agent_test",
    agentType: overrides.agentType ?? "general-purpose",
    description: "test task",
    status: overrides.status ?? "running",
    startedAt: new Date(NOW_MS),
    type: overrides.type ?? "local_agent",
    ...(overrides.isBackgrounded === undefined ? {} : { isBackgrounded: overrides.isBackgrounded }),
  };
}

function makeRuntimeStub(overrides = {}) {
  const registry = new InMemoryRuntimeTaskRegistry();
  for (const task of overrides.tasks ?? []) registry.register(task);
  return {
    toolScheduler: overrides.toolScheduler ?? new ToolScheduler(),
    runtimeTaskRegistry: registry,
    now: () => new Date(NOW_MS),
    ...(overrides.dynamicWorkflowRunPort === undefined
      ? {}
      : { dynamicWorkflowRunPort: overrides.dynamicWorkflowRunPort }),
    ...(overrides.modelRequestAdmission === undefined
      ? {}
      : { modelRequestAdmission: overrides.modelRequestAdmission }),
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
  };
}

test("(场景 4) ToolScheduler.snapshot 是纯投影：穿插读取不改变调度结果", () => {
  const scheduler = new ToolScheduler();
  // 默认口径：caps = DEFAULT_MAX_CONCURRENCY（10），尚无调度时水位为 0。
  assert.deepEqual(scheduler.snapshot(), {
    maxConcurrency: 10,
    lastScheduleMaxParallelGroupWidth: 0,
  });

  const tools = readOnlyToolCalls(3);
  const first = scheduler.schedule(tools);
  const snapshotBetween = scheduler.snapshot();
  const second = scheduler.schedule(tools);
  // 纯投影红线（R2）：两次 schedule 的分组结果逐字段一致，中间穿插 snapshot() 读取无副作用。
  assert.deepEqual(second, first);
  assert.equal(snapshotBetween.maxConcurrency, 10);
  // 3 个只读工具无依赖 → 一个宽度 3 的并行组。
  assert.equal(snapshotBetween.lastScheduleMaxParallelGroupWidth, 3);
  assert.equal(scheduler.snapshot().lastScheduleMaxParallelGroupWidth, 3);
});

test("(场景 4) ToolScheduler.snapshot 反映配置的 maxConcurrency 与组宽度上界", () => {
  const scheduler = new ToolScheduler({ maxConcurrency: 2 });
  assert.equal(scheduler.snapshot().maxConcurrency, 2);
  // 5 个只读工具、上限 2 → 分组宽度不超过 caps（投影不得报告超过上限的水位）。
  scheduler.schedule(readOnlyToolCalls(5));
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.lastScheduleMaxParallelGroupWidth, 2);
  assert.ok(
    snapshot.lastScheduleMaxParallelGroupWidth <= snapshot.maxConcurrency,
    "projected width must respect the configured cap",
  );
});

test("(场景 1) 空 runtime：四域齐全，caps/current/degraded 的缺省形状如实", () => {
  const snapshot = getConcurrencyDiagnostics.call(makeRuntimeStub());
  assert.equal(snapshot.generatedAtMs, NOW_MS);
  assert.deepEqual(Object.keys(snapshot.domains).sort(), [
    "dynamic_workflow",
    "plan_explore",
    "subagent_background",
    "tool_scheduler",
  ]);

  const { tool_scheduler: toolScheduler, plan_explore: planExplore } = snapshot.domains;
  assert.equal(toolScheduler.caps, 10);
  assert.equal(toolScheduler.current, 0);
  assert.equal(toolScheduler.degraded, false);
  // Plan Explore 的 caps 与提示词文案引用同一个常量（R3），且如实标注非强制。
  assert.equal(planExplore.caps, planResearchAgentCount);
  assert.equal(planExplore.caps, 3);
  assert.equal(planExplore.current, 0);
  assert.equal(planExplore.degraded, false);
  assert.equal(planExplore.facts.enforced, false);
  assert.equal(planExplore.facts.carrier, "prompt");

  // subagent 后台无显式上限：caps 必须是 undefined，不得伪造哨兵数字（R1）。
  const background = snapshot.domains.subagent_background;
  assert.equal(background.caps, undefined);
  assert.equal(background.current, 0);
  assert.equal(background.degraded, false);

  // 端口缺席 → 缺失即未知（R2）：caps undefined、admission "unavailable"、不报降级。
  const workflow = snapshot.domains.dynamic_workflow;
  assert.equal(workflow.caps, undefined);
  assert.equal(workflow.current, 0);
  assert.equal(workflow.degraded, false);
  assert.equal(workflow.facts.admission, "unavailable");
});

test("(场景 2) registry 事实：Explore / 后台 agent / dwf run 各归各域", () => {
  const snapshot = getConcurrencyDiagnostics.call(
    makeRuntimeStub({
      dynamicWorkflowRunPort: { concurrencyCeiling: () => 14 },
      tasks: [
        makeTask({ agentType: EXPLORE_AGENT_TYPE, taskId: "explore_1" }),
        makeTask({ agentType: EXPLORE_AGENT_TYPE, taskId: "explore_2" }),
        makeTask({
          agentType: "general-purpose",
          isBackgrounded: true,
          taskId: "background_agent",
        }),
        makeTask({
          type: "local_dynamic_workflow",
          isBackgrounded: true,
          taskId: "dwf_run",
        }),
        makeTask({
          agentType: EXPLORE_AGENT_TYPE,
          status: "completed",
          taskId: "explore_done",
        }),
      ],
    }),
  );

  // 终态任务不计数：running 的 Explore 只有 2 个。
  assert.equal(snapshot.domains.plan_explore.current, 2);
  // subagent_background.current 口径 = backgrounded+running 的 local_agent（dwf run 不算进来，
  // 但出现在按 type 的分解事实里——后台面板全景，R3）。
  assert.equal(snapshot.domains.subagent_background.current, 1);
  assert.deepEqual(snapshot.domains.subagent_background.facts.backgroundRunningByType, {
    local_agent: 1,
    local_dynamic_workflow: 1,
  });
  assert.equal(snapshot.domains.dynamic_workflow.caps, 14);
  assert.equal(snapshot.domains.dynamic_workflow.current, 1);
});

test("(场景 3) 降级投影：AIMD 压低或冷却中 → degraded；恢复 → 不降级", () => {
  const admissionWith = (bucket) => ({ concurrencyBuckets: () => [bucket] });
  const base = { key: "provider/model", ceiling: 14, inFlight: 0, waiters: 0 };

  const throttled = getConcurrencyDiagnostics.call(
    makeRuntimeStub({
      dynamicWorkflowRunPort: { concurrencyCeiling: () => 14 },
      modelRequestAdmission: admissionWith({ ...base, cap: 6 }),
    }),
  );
  assert.equal(throttled.domains.dynamic_workflow.degraded, true);
  assert.deepEqual(throttled.domains.dynamic_workflow.facts.admission, [
    { ...base, cap: 6 },
  ]);

  const cooling = getConcurrencyDiagnostics.call(
    makeRuntimeStub({
      modelRequestAdmission: admissionWith({ ...base, cap: 14, cooldownUntil: NOW_MS + 1000 }),
    }),
  );
  assert.equal(cooling.domains.dynamic_workflow.degraded, true);

  // 冷却已过期（cooldownUntil <= now）不是降级事实。
  const cooledDown = getConcurrencyDiagnostics.call(
    makeRuntimeStub({
      modelRequestAdmission: admissionWith({ ...base, cap: 14, cooldownUntil: NOW_MS - 1 }),
    }),
  );
  assert.equal(cooledDown.domains.dynamic_workflow.degraded, false);

  // cap === ceiling 且无冷却：健康。
  const healthy = getConcurrencyDiagnostics.call(
    makeRuntimeStub({ modelRequestAdmission: admissionWith({ ...base, cap: 14 }) }),
  );
  assert.equal(healthy.domains.dynamic_workflow.degraded, false);

  // 配置性下调不是 degraded（R1）：tool scheduler caps 改小仍不报降级。
  const configured = getConcurrencyDiagnostics.call(
    makeRuntimeStub({ toolScheduler: new ToolScheduler({ maxConcurrency: 1 }) }),
  );
  assert.equal(configured.domains.tool_scheduler.caps, 1);
  assert.equal(configured.domains.tool_scheduler.degraded, false);
});

test("(R4) 治理器 observer 实现契约成员 concurrencyBuckets：只读、准入语义不变", async () => {
  const { getWorkflowConcurrencyGovernor } = await import(
    "../packages/cli-workflow/src/workflow-concurrency-governor.ts"
  );
  const admission = getWorkflowConcurrencyGovernor().observer();
  assert.equal(typeof admission.concurrencyBuckets, "function");
  const before = admission.concurrencyBuckets();
  assert.ok(Array.isArray(before));

  const ticket = admission.tryAcquire({
    model: { providerId: "test-provider", modelId: "test-model" },
  });
  assert.ok(ticket, "observer fast path must always admit");
  const during = admission.concurrencyBuckets();
  const bucket = during.find((entry) => entry.key === "test-provider/test-model");
  assert.ok(bucket, "admitted request must be visible in the projection");
  assert.equal(bucket.inFlight, 1);
  assert.equal(bucket.cap, bucket.ceiling);
  assert.equal(bucket.waiters, 0);
  assert.equal(bucket.cooldownUntil, undefined);
  // 契约形状：只暴露收窄字段，控制器内部状态（epoch/streak）不外泄。
  assert.deepEqual(Object.keys(bucket).sort(), [
    "cap",
    "ceiling",
    "inFlight",
    "key",
    "waiters",
  ]);

  // 纯投影：读取快照不消耗名额、不改变准入结果（再取一张票仍然立即成功）。
  admission.concurrencyBuckets();
  const second = admission.tryAcquire({
    model: { providerId: "test-provider", modelId: "test-model" },
  });
  assert.ok(second, "reading the projection must not affect admission");
  ticket.release();
  second.release();
  const after = admission.concurrencyBuckets().find((entry) => entry.key === "test-provider/test-model");
  assert.equal(after.inFlight, 0);
});

test("(R5) debug 日志：事件名与形状；只走 logger.debug，无网络/遥测引用", () => {
  const entries = [];
  const logger = {
    debug: (message, context) => entries.push({ message, context }),
    info: () => assert.fail("diagnostics must not log at info level"),
    warn: () => assert.fail("diagnostics must not log at warn level"),
    error: () => assert.fail("diagnostics must not log at error level"),
  };
  const runtime = makeRuntimeStub({ logger });
  logConcurrencyDiagnostics(runtime, createRootTraceContext({ sessionId: "sess_test" }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, "Concurrency diagnostics snapshot");
  assert.equal(entries[0].context.event, "concurrency_diagnostics_snapshot");
  assert.equal(entries[0].context.module, "core.runtime");
  assert.equal(entries[0].context.status, "completed");
  assert.ok(entries[0].context.domains.tool_scheduler);
  assert.equal(entries[0].context.generatedAtMs, NOW_MS);
});

test("(红线) 投影源码只写本地 debug 日志：无遥测/网络/持久化引用", async () => {
  const source = await read(
    "apps/acode-cli/packages/core/src/runtime/methods/concurrency-diagnostics.ts",
  );
  // 收紧口径：只断言**代码级**引用（导入/网络调用），注释里提及 "no-telemetry 红线" 是文档事实。
  assert.doesNotMatch(source, /from\s+["'][^"']*telemetry/i);
  assert.doesNotMatch(source, /fetch\(|new\s+WebSocket|https?:\/\//);
  assert.doesNotMatch(source, /appendEvent|eventStore|sessionStore|writeFile/);
  assert.match(source, /logger\?\.debug/);
  // turn 级日志点确实装配在 executeTurnCommand（每 turn 至多一条）。
  const turnSource = await read("apps/acode-cli/packages/core/src/runtime/methods/turn.ts");
  assert.match(turnSource, /logConcurrencyDiagnostics\(this, turnTraceContext\);/);
});
