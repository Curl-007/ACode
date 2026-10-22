import assert from "node:assert/strict";
import { test } from "node:test";
import { writeTaskMetaToCaches } from "../src/lib/taskListMetaSync.js";
import { useACodeSessionStore } from "../src/store/acodeSessionStore.js";
import { useRemoteTimelineTaskStore } from "../src/store/remoteTimelineTaskStore.js";
import { useRemotePinnedTaskStore } from "../src/store/remotePinnedTaskStore.js";
import { useTaskQueryCacheStore } from "../src/store/taskQueryCacheStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "../src/lib/taskQueryCache.js";

// specs/task-meta-cache-ownership.md 组合守护：真实 store 上跑 rename/pin(乐观+回滚)/archive，
// 断言 optimistic 池、remote timeline、remote pinned、query cache meta 四副本一致，
// 且乐观失败回滚后不残留 drift。

function makeTask(workspacePath, workspaceIdentity, taskId, overrides = {}) {
  return {
    taskId,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    title: `task-${taskId}`,
    createdAt: 1000,
    updatedAt: 2000,
    status: "completed",
    pinned: false,
    archived: false,
    ...overrides,
  };
}

function readOptimistic(workspacePath, workspaceIdentity, taskId) {
  const workspaceState = useACodeSessionStore
    .getState()
    .getWorkspaceState(workspacePath, workspaceIdentity);
  return workspaceState.optimisticTaskListByTaskId[taskId];
}

function readQueryCacheMeta(workspacePath, workspaceIdentity, taskId) {
  const entityKey = buildTaskEntityKey({ taskId, workspacePath, workspaceIdentity });
  return useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey];
}

function readRemoteTimelineIds(workspacePath, workspaceIdentity) {
  const key = buildTaskWorkspaceKey(workspacePath, workspaceIdentity);
  return (useRemoteTimelineTaskStore.getState().itemsByWorkspaceKey[key] ?? []).map((t) => t.taskId);
}

function readRemotePinnedIds(workspacePath, workspaceIdentity) {
  const key = buildTaskWorkspaceKey(workspacePath, workspaceIdentity);
  return (useRemotePinnedTaskStore.getState().itemsByWorkspaceKey[key] ?? []).map((t) => t.taskId);
}

function resetRemote(workspacePath, workspaceIdentity) {
  useRemoteTimelineTaskStore.getState().clearWorkspace(workspacePath, workspaceIdentity);
  useRemotePinnedTaskStore.getState().clearWorkspace(workspacePath, workspaceIdentity);
}

test("rename（远端 workspace）：四副本标题一致，remote pinned 不被触碰", () => {
  const workspacePath = "/tmp/ws-rename";
  const workspaceIdentity = "remote-rename";
  const taskId = "t-rename";
  resetRemote(workspacePath, workspaceIdentity);
  // 预置远端 timeline 里有该 task（旧标题），模拟已加载列表。
  useRemoteTimelineTaskStore
    .getState()
    .upsertTask(makeTask(workspacePath, workspaceIdentity, taskId, { title: "old-title" }));

  const previousTask = makeTask(workspacePath, workspaceIdentity, taskId, { title: "old-title" });
  const nextTask = makeTask(workspacePath, workspaceIdentity, taskId, {
    title: "new-title",
    titleOverridden: true,
  });

  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity,
    taskId,
    previousTask,
    nextTask,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: false, archived: false },
    optimistic: "upsert",
    remoteTimeline: "upsert",
  });

  // 四副本一致：optimistic 池 / query cache meta / remote timeline 都拿到新标题。
  assert.equal(readOptimistic(workspacePath, workspaceIdentity, taskId)?.title, "new-title");
  assert.equal(readQueryCacheMeta(workspacePath, workspaceIdentity, taskId)?.title, "new-title");
  const timelineItem = useRemoteTimelineTaskStore
    .getState()
    .itemsByWorkspaceKey[buildTaskWorkspaceKey(workspacePath, workspaceIdentity)].find(
      (t) => t.taskId === taskId,
    );
  assert.equal(timelineItem?.title, "new-title");
  // remote pinned placement=none：pinned 区不出现该 task。
  assert.deepEqual(readRemotePinnedIds(workspacePath, workspaceIdentity), []);
});

test("pin 乐观→回滚（远端 workspace）：副本从 timeline 移入 pinned 再精确移回，无 drift", () => {
  const workspacePath = "/tmp/ws-pin";
  const workspaceIdentity = "remote-pin";
  const taskId = "t-pin";
  resetRemote(workspacePath, workspaceIdentity);
  const item = makeTask(workspacePath, workspaceIdentity, taskId);
  // 预置：task 在 timeline 区。
  useRemoteTimelineTaskStore.getState().upsertTask(item);
  assert.deepEqual(readRemoteTimelineIds(workspacePath, workspaceIdentity), [taskId]);
  assert.deepEqual(readRemotePinnedIds(workspacePath, workspaceIdentity), []);

  // 乐观阶段：pin 目标态——移出 timeline、移入 pinned。
  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity,
    taskId,
    previousTask: item,
    nextTask: item,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: true, archived: false },
    remoteTimeline: "remove",
    remotePinned: "upsert",
  });
  assert.deepEqual(readRemoteTimelineIds(workspacePath, workspaceIdentity), [], "乐观后应移出 timeline");
  assert.deepEqual(readRemotePinnedIds(workspacePath, workspaceIdentity), [taskId], "乐观后应移入 pinned");

  // 回滚阶段（RPC 失败）：与乐观精确互逆——回到 timeline、移出 pinned，query cache 回未 pin 态。
  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity,
    taskId,
    previousTask: item,
    nextTask: item,
    previousState: { pinned: true, archived: false },
    nextState: { pinned: false, archived: false },
    remoteTimeline: "upsert",
    remotePinned: "remove",
  });
  assert.deepEqual(
    readRemoteTimelineIds(workspacePath, workspaceIdentity),
    [taskId],
    "回滚后应回到 timeline",
  );
  assert.deepEqual(readRemotePinnedIds(workspacePath, workspaceIdentity), [], "回滚后应移出 pinned");
  // query cache meta 成员关系回到未 pin（pinned:false）。
  assert.equal(readQueryCacheMeta(workspacePath, workspaceIdentity, taskId)?.pinned, false);
});

test("archive（远端 workspace）：清 task 运行态 + 远端 timeline/pinned 双副本移除", () => {
  const workspacePath = "/tmp/ws-archive";
  const workspaceIdentity = "remote-archive";
  const taskId = "t-archive";
  resetRemote(workspacePath, workspaceIdentity);
  const item = makeTask(workspacePath, workspaceIdentity, taskId);
  useRemoteTimelineTaskStore.getState().upsertTask(item);
  // optimistic 池预置一条，验证 clearTaskState 路径不残留运行态。
  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity,
    taskId,
    previousTask: item,
    nextTask: item,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: false, archived: false },
    optimistic: "upsert",
  });
  assert.ok(readOptimistic(workspacePath, workspaceIdentity, taskId), "归档前 optimistic 池应有该 task");

  const archivedMeta = makeTask(workspacePath, workspaceIdentity, taskId, { archived: true });
  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity,
    taskId,
    previousTask: item,
    nextTask: archivedMeta,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: false, archived: true },
    clearTaskState: true,
    remoteTimeline: "remove",
    remotePinned: "remove",
  });

  assert.deepEqual(readRemoteTimelineIds(workspacePath, workspaceIdentity), [], "归档后 timeline 应移除");
  assert.deepEqual(readRemotePinnedIds(workspacePath, workspaceIdentity), [], "归档后 pinned 应移除");
  assert.equal(readQueryCacheMeta(workspacePath, workspaceIdentity, taskId)?.archived, true);
});

test("本地 workspace（无 identity）：remote 副本写入被 gating 跳过，只落 optimistic + query cache", () => {
  const workspacePath = "/tmp/ws-local";
  const taskId = "t-local";
  const previousTask = makeTask(workspacePath, undefined, taskId, { title: "old" });
  const nextTask = makeTask(workspacePath, undefined, taskId, { title: "new", titleOverridden: true });

  writeTaskMetaToCaches({
    workspacePath,
    taskId,
    previousTask,
    nextTask,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: false, archived: false },
    optimistic: "upsert",
    // 即使声明了 remote placement，identity 缺失也应跳过，不误写以 identity 为键的远端 store。
    remoteTimeline: "upsert",
    remotePinned: "upsert",
  });

  assert.equal(readOptimistic(workspacePath, undefined, taskId)?.title, "new");
  assert.equal(readQueryCacheMeta(workspacePath, undefined, taskId)?.title, "new");
  // 远端 store 不应出现本地 workspace 的键。
  const timelineKey = buildTaskWorkspaceKey(workspacePath, undefined);
  assert.equal(useRemoteTimelineTaskStore.getState().itemsByWorkspaceKey[timelineKey], undefined);
  assert.equal(useRemotePinnedTaskStore.getState().itemsByWorkspaceKey[timelineKey], undefined);
});
