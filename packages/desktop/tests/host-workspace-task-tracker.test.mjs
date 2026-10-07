import assert from "node:assert/strict";
import { test } from "node:test";

// specs/host-running-task-count.md 验收场景：workspace 计数与事件顺序、总量包含
// 无归属分量、workspace 级排除无归属分量、clearWorkspace 不清无归属分量、
// 负数防护、多 workspace 汇总。
const { createHostWorkspaceTaskTracker } = await import("../src/host/hostWorkspaceTaskTracker.ts");

function createHarness() {
  const events = [];
  const totals = [];
  const tracker = createHostWorkspaceTaskTracker(
    (event) => events.push(event),
    (total) => totals.push(total),
  );
  return { tracker, events, totals };
}

const wsA = { workspacePath: "/ws/a", workspaceIdentity: "identity-a" };
const wsB = { workspacePath: "/ws/b" };

test("workspace begin/finish：计数、幂等与事件顺序（先 workspace 后 total）", () => {
  const { tracker, events, totals } = createHarness();
  assert.equal(tracker.begin("t1", wsA), true);
  assert.equal(tracker.begin("t1", wsA), false, "同 taskId 重复 begin 幂等");
  assert.equal(tracker.getRunningTaskCount(wsA), 1);
  assert.equal(tracker.getTotalRunningTaskCount(), 1);
  assert.deepEqual(events[0], { ...wsA, runningTaskCount: 1 });
  assert.deepEqual(totals, [1], "幂等 begin 不重复上报 total");

  tracker.begin("t2", wsA);
  assert.equal(tracker.getTotalRunningTaskCount(), 2);
  tracker.finish("t1", wsA);
  tracker.finish("t2", wsA);
  assert.equal(tracker.getRunningTaskCount(wsA), 0);
  assert.equal(tracker.getTotalRunningTaskCount(), 0);
  assert.deepEqual(totals, [1, 2, 1, 0]);
  assert.equal(events.length, 4, "begin t1 / begin t2 / finish t1 / finish t2 各一次 workspace 事件");
});

test("finish 未知任务不发事件、不产生负数", () => {
  const { tracker, events, totals } = createHarness();
  tracker.finish("nope", wsA);
  assert.deepEqual(events, []);
  assert.deepEqual(totals, []);
  assert.equal(tracker.getTotalRunningTaskCount(), 0);
});

test("无归属 RPC：进总量、不进 workspace 桶、不发 workspace 事件", () => {
  const { tracker, events, totals } = createHarness();
  tracker.beginUnattributedRpc();
  tracker.beginUnattributedRpc();
  assert.equal(tracker.getTotalRunningTaskCount(), 2);
  assert.equal(tracker.getRunningTaskCount(wsA), 0, "workspace 级计数不得包含无归属分量");
  assert.deepEqual(events, [], "无归属变更没有 workspace 事件");
  assert.deepEqual(totals, [1, 2]);
  tracker.finishUnattributedRpc();
  tracker.finishUnattributedRpc();
  tracker.finishUnattributedRpc();
  assert.equal(tracker.getTotalRunningTaskCount(), 0, "多余的 finish 被负数防护吸收");
  assert.deepEqual(totals, [1, 2, 1, 0, 0]);
});

test("clearWorkspace 清 workspace 分量、保留无归属分量", () => {
  const { tracker } = createHarness();
  tracker.begin("t1", wsA);
  tracker.begin("t2", wsB);
  tracker.beginUnattributedRpc();
  assert.equal(tracker.getTotalRunningTaskCount(), 3);
  tracker.clearWorkspace(wsA);
  assert.equal(tracker.getRunningTaskCount(wsA), 0);
  assert.equal(tracker.getRunningTaskCount(wsB), 1);
  assert.equal(tracker.getTotalRunningTaskCount(), 2, "剩余 = wsB 任务 + 无归属 RPC");
});

test("多 workspace 汇总：total = 各桶之和 + 无归属分量", () => {
  const { tracker } = createHarness();
  tracker.begin("t1", wsA);
  tracker.begin("t2", wsA);
  tracker.begin("t3", wsB);
  tracker.beginUnattributedRpc();
  assert.equal(
    tracker.getTotalRunningTaskCount(),
    tracker.getRunningTaskCount(wsA) + tracker.getRunningTaskCount(wsB) + 1,
  );
});
