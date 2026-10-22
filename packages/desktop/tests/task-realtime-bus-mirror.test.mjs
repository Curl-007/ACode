import assert from "node:assert/strict";
import { test } from "node:test";

// specs/task-realtime-bus-mirror.md 验收场景：
// - finding #2：replay 镜像非权威 + streamBatches 在 terminal/lease 释放/host 退出均被清理；
//   超过 60 批 / 512KB 后 replay 被截断，新 observer 收到 stream_mirror_gap；oversized 单批降级。
// - finding #4：按 task/workspace 分桶去重——多 run 并发下 observer 无重复流事件；run 终止后桶被回收。
const { TaskRealtimeBus } = await import("../src/main/taskRealtimeBus.ts");

const WS = "/ws/a";
const DELIVER = "task-realtime-deliver";

// 静默 logger，避免默认 logger 落盘（mkdirSync）。
const silentLogger = { info() {}, warn() {} };

// 伪 Electron UtilityProcess：记录 postMessage，暴露 emitMessage/emitExit 驱动 bus 监听器。
function makeChild() {
  const posted = [];
  const messageListeners = [];
  const exitListeners = [];
  return {
    posted,
    on(event, cb) {
      if (event === "message") messageListeners.push(cb);
    },
    once(event, cb) {
      if (event === "exit") exitListeners.push(cb);
    },
    off() {},
    postMessage(msg) {
      posted.push(msg);
    },
    emitMessage(msg) {
      for (const cb of messageListeners) cb(msg);
    },
    emitExit() {
      for (const cb of exitListeners) cb();
    },
    // 只看真正投递给 renderer/host 的 realtime 事件。
    deliveries() {
      return posted.filter((m) => m.type === DELIVER).map((m) => m.event);
    },
  };
}

function target(taskId, runId) {
  return { workspacePath: WS, workspaceKey: WS, taskId, runId, traceId: runId };
}
function leaseAcquire(taskId, runId, leaseRequestId) {
  return { type: "task-run-lease-acquire", request: { ...target(taskId, runId), leaseRequestId } };
}
function leaseRelease(taskId, runId) {
  return { type: "task-run-lease-release", target: target(taskId, runId) };
}
function streamOp(taskId, runId, event) {
  return { type: "task-stream-op-publish", target: target(taskId, runId), op: { kind: "stream_event", event } };
}
function chunk(taskId, runId, content = "hi") {
  return streamOp(taskId, runId, { type: "agent_message_chunk", taskId, traceId: runId, content });
}
function terminal(taskId, runId) {
  return streamOp(taskId, runId, { type: "task_complete", taskId, traceId: runId });
}
function permission(taskId, runId, pad) {
  const event = { type: "permission_request", taskId, traceId: runId };
  if (pad) event.pad = pad;
  return streamOp(taskId, runId, event);
}
function snapshotPublish(eventId, taskId) {
  return {
    type: "task-realtime-publish",
    event: {
      type: "task_snapshot_invalidated",
      eventId,
      workspacePath: WS,
      workspaceKey: WS,
      traceId: "trace-" + eventId,
      createdAt: 1,
      reason: "task_status_changed",
      taskId,
    },
  };
}

function makeBus(opts = {}) {
  return new TaskRealtimeBus({ logger: silentLogger, ...opts });
}
function registerOwner(bus, hostId = "host-owner", child = makeChild()) {
  bus.registerHost({ hostId, windowId: 1, child, workspaceKeys: [WS] });
  return child;
}
function gapEvents(child) {
  return child.deliveries().filter((e) => e.type === "task_snapshot_invalidated" && e.reason === "stream_mirror_gap");
}

test("finding #2：terminal event 删除 streamBatch", () => {
  const bus = makeBus();
  const owner = registerOwner(bus);
  owner.emitMessage(leaseAcquire("taskA", "runA", "lr1"));
  owner.emitMessage(chunk("taskA", "runA"));
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 1, "非 terminal op 建立镜像批");

  owner.emitMessage(terminal("taskA", "runA"));
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 0, "terminal event 后 streamBatch 被删");
  const batches = owner.deliveries().filter((e) => e.type === "task_stream_mirror_batch");
  assert.ok(batches.some((b) => b.terminal === true), "owner 收到 terminal mirror batch");
  owner.emitExit();
});

test("finding #2：lease 释放删除 streamBatch", () => {
  const bus = makeBus();
  const owner = registerOwner(bus);
  owner.emitMessage(leaseAcquire("taskA", "runA", "lr1"));
  owner.emitMessage(chunk("taskA", "runA"));
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 1);

  owner.emitMessage(leaseRelease("taskA", "runA"));
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 0, "lease 释放后 streamBatch 被删");
  assert.equal(bus.collectMemoryDiagnostics().leases, 0);
  owner.emitExit();
});

test("finding #2：host 退出无条件删除 streamBatch（非 terminal 残留修复）", () => {
  const bus = makeBus();
  const owner = registerOwner(bus);
  const observer = makeChild();
  bus.registerHost({ hostId: "host-obs", windowId: 2, child: observer, workspaceKeys: [WS] });

  owner.emitMessage(leaseAcquire("taskA", "runA", "lr1"));
  owner.emitMessage(chunk("taskA", "runA"));
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 1, "退出前镜像批存在");

  // host 异常退出：run 未到 terminal、也无 pendingOps 可 flush——旧实现会残留镜像批。
  owner.emitExit();
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 0, "host 退出后 streamBatch 被无条件回收");
  assert.equal(bus.collectMemoryDiagnostics().leases, 0);
  assert.ok(gapEvents(observer).some((e) => e.reason === "stream_mirror_gap") ||
    observer.deliveries().some((e) => e.reason === "stream_mirror_owner_lost"),
    "observer 收到 owner lost 失效通知");
});

test("finding #2：超过 60 批后 replay 截断，新 observer 收到 stream_mirror_gap", () => {
  const bus = makeBus();
  const owner = registerOwner(bus);
  owner.emitMessage(leaseAcquire("taskA", "runA", "lr1"));
  // 61 个 immediate(permission) op → 61 次 flush → replay 上限 60，最旧批被 shift，fromSeq!==1。
  for (let i = 0; i < 61; i++) {
    owner.emitMessage(permission("taskA", "runA"));
  }
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 1, "镜像批仍存活（非 terminal）");

  const observer = makeChild();
  bus.registerHost({ hostId: "host-late", windowId: 2, child: observer, workspaceKeys: [WS] });
  assert.ok(gapEvents(observer).length >= 1, "replay 有缺口 → 新 observer 收到 stream_mirror_gap 走权威快照");
  owner.emitExit();
});

test("finding #2：replay 总字节超 512KB 后截断，新 observer 收到 stream_mirror_gap", () => {
  const bus = makeBus();
  const owner = registerOwner(bus);
  owner.emitMessage(leaseAcquire("taskA", "runA", "lr1"));
  const pad = "x".repeat(40_000); // 每批 ~40KB，单批 <512KB（不触发 oversized），累计 >512KB 触发字节阈值。
  for (let i = 0; i < 20; i++) {
    owner.emitMessage(permission("taskA", "runA", pad));
  }
  const observer = makeChild();
  bus.registerHost({ hostId: "host-late", windowId: 2, child: observer, workspaceKeys: [WS] });
  assert.ok(gapEvents(observer).length >= 1, "字节阈值截断 replay → 新 observer 收到 stream_mirror_gap");
  owner.emitExit();
});

test("finding #2：oversized 单批降级——owner 收分片 relay_owner，observer 收 stream_mirror_gap", () => {
  const bus = makeBus();
  const owner = registerOwner(bus);
  const observer = makeChild();
  bus.registerHost({ hostId: "host-obs", windowId: 2, child: observer, workspaceKeys: [WS] });
  owner.emitMessage(leaseAcquire("taskA", "runA", "lr1"));

  owner.emitMessage(chunk("taskA", "runA", "x".repeat(600_000))); // 600KB 文本 op
  owner.emitMessage(permission("taskA", "runA")); // immediate → 强制 flush，触发 oversized 降级

  const ownerRelay = owner.deliveries().filter(
    (e) => e.type === "task_stream_mirror_batch" && e.deliveryPurpose === "relay_owner",
  );
  assert.ok(ownerRelay.length >= 1, "owner 收到连续小批次 relay_owner（不丢 mirror seq）");
  assert.ok(gapEvents(observer).length >= 1, "observer 收到 stream_mirror_gap 走快照补齐");
  owner.emitExit();
});

test("finding #4：多 run 并发下去重按 task 分桶——observer 无重复流事件", () => {
  // seenEventLimit=3：旧全局单队列会被 taskA 的高频事件把 taskB 的 eventId 挤出滑窗导致重复投递。
  const bus = makeBus({ seenEventLimit: 3 });
  const owner = registerOwner(bus);
  const observer = makeChild();
  bus.registerHost({ hostId: "host-obs", windowId: 2, child: observer, workspaceKeys: [WS] });

  const countFor = (eventId) => observer.deliveries().filter((e) => e.eventId === eventId).length;

  owner.emitMessage(snapshotPublish("evtB", "taskB"));
  assert.equal(countFor("evtB"), 1, "taskB 事件首次投递");

  // taskA 灌入远超窗口的事件量，填满 taskA 自己的桶。
  for (let i = 0; i < 10; i++) {
    owner.emitMessage(snapshotPublish("evtA" + i, "taskA"));
  }

  // 重投 taskB 同一 eventId：分桶后 taskB 桶未被 taskA 挤占 → 应被去重。
  owner.emitMessage(snapshotPublish("evtB", "taskB"));
  assert.equal(countFor("evtB"), 1, "分桶去重：taskA 高频不导致 taskB 事件重复投递");

  // 对照：taskA 内自身重复仍被去重。
  owner.emitMessage(snapshotPublish("evtA9", "taskA"));
  assert.equal(countFor("evtA9"), 1, "同桶内重复事件仍去重");
  owner.emitExit();
});

test("finding #4：run 终止（terminal）回收其去重桶", () => {
  const bus = makeBus();
  const owner = registerOwner(bus);
  owner.emitMessage(leaseAcquire("taskA", "runA", "lr1"));
  owner.emitMessage(snapshotPublish("evtA", "taskA"));
  assert.ok(bus.collectMemoryDiagnostics().seenEventBuckets >= 1, "publish 建立 taskA 去重桶");

  owner.emitMessage(terminal("taskA", "runA"));
  assert.equal(bus.collectMemoryDiagnostics().seenEventBuckets, 0, "terminal 后 taskA 去重桶被回收");
  owner.emitExit();
});

test("finding #4：host 退出回收其名下所有去重桶", () => {
  const bus = makeBus();
  const owner = registerOwner(bus);
  owner.emitMessage(leaseAcquire("taskA", "runA", "lr1"));
  owner.emitMessage(leaseAcquire("taskB", "runB", "lr2"));
  owner.emitMessage(snapshotPublish("evtA", "taskA"));
  owner.emitMessage(snapshotPublish("evtB", "taskB"));
  assert.ok(bus.collectMemoryDiagnostics().seenEventBuckets >= 2, "两个 run 各建一个去重桶");

  owner.emitExit();
  assert.equal(bus.collectMemoryDiagnostics().seenEventBuckets, 0, "host 退出后去重桶全部回收，防泄漏");
});
