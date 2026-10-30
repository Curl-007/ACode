// Overnight（K3）完成信号的 host→main 转发器测试（specs/overnight-completion-notify.md §7）。
// 被测：packages/desktop/src/host/hostOvernightCompletion.ts —— 订阅 agent 的
// onDynamicOvernightCompletion 事件，原样镜像成 HostResponseTypes.OvernightCompletionNotify 给 main。
// house style：直接 import 真实 .ts 源，注入 fake agentService（@acode/rpc 的 Event 约定：
// (listener) => IDisposable），无 electron、无真实 agent 子进程。
import assert from "node:assert/strict";
import test from "node:test";

const { createHostOvernightCompletionForwarder } = await import(
  "../src/host/hostOvernightCompletion.ts"
);
const { HostResponseTypes } = await import("@acode/shared");

/**
 * fake agentService：onDynamicOvernightCompletion() 返回一个 @acode/rpc 风格的 Event——
 * 即 (listener) => IDisposable。测试用 emit() 触发订阅者，模拟 agent 子进程经 stdio 上报的完成信号。
 */
function createFakeAgentService() {
  let listener = null;
  let disposed = false;
  return {
    disposed: () => disposed,
    hasListener: () => listener !== null && !disposed,
    emit(signal) {
      if (listener && !disposed) listener(signal);
    },
    onDynamicOvernightCompletion: () => (cb) => {
      listener = cb;
      return {
        dispose() {
          disposed = true;
          listener = null;
        },
      };
    },
  };
}

function createHarness(agentService) {
  const posted = [];
  const warns = [];
  const forwarder = createHostOvernightCompletionForwarder({
    getAgentService: () => agentService,
    postMessage: (message) => posted.push(message),
    logger: { warn: (message, detail) => warns.push([message, detail]) },
  });
  return { forwarder, posted, warns };
}

const signal = {
  runId: "overnight-run-1",
  parentTaskId: "sess-visible-parent",
  outcome: "completed",
  morningReportReady: true,
};

test("startForwarding：agent 完成信号原样镜像成 HostResponseTypes.OvernightCompletionNotify", () => {
  const agentService = createFakeAgentService();
  const { forwarder, posted } = createHarness(agentService);
  forwarder.startForwarding();

  agentService.emit(signal);

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], {
    type: HostResponseTypes.OvernightCompletionNotify,
    runId: "overnight-run-1",
    parentTaskId: "sess-visible-parent",
    outcome: "completed",
    morningReportReady: true,
  });
});

test("转发器不改写载荷：failed / cancelled / morningReportReady=false 各原样透传", () => {
  const agentService = createFakeAgentService();
  const { forwarder, posted } = createHarness(agentService);
  forwarder.startForwarding();

  agentService.emit({ ...signal, outcome: "failed", morningReportReady: false });
  agentService.emit({ ...signal, runId: "run-2", outcome: "cancelled", morningReportReady: false });

  assert.equal(posted.length, 2);
  assert.equal(posted[0].outcome, "failed");
  assert.equal(posted[0].morningReportReady, false);
  assert.equal(posted[1].outcome, "cancelled");
  assert.equal(posted[1].runId, "run-2");
  // 转发器不做去重/幂等——那是 main 侧 notifier 的职责（单一裁决者），host 只转发。
});

test("退订函数生效：dispose 后 agent 再发信号不再镜像给 main", () => {
  const agentService = createFakeAgentService();
  const { forwarder, posted } = createHarness(agentService);
  const stop = forwarder.startForwarding();

  agentService.emit(signal);
  assert.equal(posted.length, 1);

  stop(); // 服务换代 / host dispose 时退订
  assert.equal(agentService.disposed(), true);
  agentService.emit({ ...signal, runId: "run-after-stop" });
  assert.equal(posted.length, 1, "退订后不再转发");
});

test("agentService 不可用（undefined）：startForwarding 返回 no-op 退订，不抛错", () => {
  const { forwarder, posted } = createHarness(undefined);
  const stop = forwarder.startForwarding();
  assert.equal(typeof stop, "function");
  stop(); // no-op，不抛
  assert.equal(posted.length, 0);
});

test("订阅抛错：降级为 no-op 退订 + warn 一次，不崩溃 host", () => {
  const agentService = {
    onDynamicOvernightCompletion: () => {
      throw new Error("agent service disposed mid-subscribe");
    },
  };
  const { forwarder, posted, warns } = createHarness(agentService);
  const stop = forwarder.startForwarding();
  assert.equal(typeof stop, "function");
  stop();
  assert.equal(posted.length, 0);
  assert.equal(warns.length, 1, "订阅失败记一次 warn");
  assert.match(warns[0][0], /subscribe failed/);
});
