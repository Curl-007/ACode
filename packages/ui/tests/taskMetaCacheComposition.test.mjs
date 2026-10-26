import assert from "node:assert/strict";
import { test } from "node:test";
import { writeTaskMetaToCaches } from "../src/lib/taskListMetaSync.js";
import { useACodeSessionStore } from "../src/store/acodeSessionStore.js";
import { useRemoteTimelineTaskStore } from "../src/store/remoteTimelineTaskStore.js";
import { useRemotePinnedTaskStore } from "../src/store/remotePinnedTaskStore.js";
import { useTaskQueryCacheStore } from "../src/store/taskQueryCacheStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey, buildTaskListCacheDescriptor, buildTaskListCacheKeyFromDescriptor } from "../src/lib/taskQueryCache.js";

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

// query cache 播种：为某个 workspace 的 timeline / pinned descriptor 写入一条已知 total 的查询结果，
// 使后续 applyTaskMutation 的 nextTotal = total + Number(nextIncluded) - Number(previousIncluded)
// 有可断言的基准。visibleLimit=null（不切片），taskKeys 全部可见。
function seedQueryCache(workspacePath, workspaceIdentity, kind, { items, total }) {
  const descriptor = buildTaskListCacheDescriptor({
    kind,
    workspaceScopes: [
      { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) },
    ],
    sortBy: "updated",
    expanded: false,
    visibleLimit: null,
  });
  const queryKey = buildTaskListCacheKeyFromDescriptor(descriptor);
  useTaskQueryCacheStore
    .getState()
    .setQueryResults([{ queryKey, descriptor, items, total, hasMore: false }]);
  return { queryKey, descriptor };
}

function readQueryResult(queryKey) {
  return useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];
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
  useTaskQueryCacheStore.getState().clearAll();
  const item = makeTask(workspacePath, workspaceIdentity, taskId);
  // 预置：task 在 timeline 区。
  useRemoteTimelineTaskStore.getState().upsertTask(item);
  assert.deepEqual(readRemoteTimelineIds(workspacePath, workspaceIdentity), [taskId]);
  assert.deepEqual(readRemotePinnedIds(workspacePath, workspaceIdentity), []);

  // 播种 query cache：timeline descriptor 已计入该 task（total=1），pinned descriptor 未计入（total=0）。
  // 这是能捕获「非逆变回滚」的关键——没有 total 基准就看不到 applyTaskMutation 的计数漂移。
  const timelineQuery = seedQueryCache(workspacePath, workspaceIdentity, "timeline", {
    items: [item],
    total: 1,
  });
  const pinnedQuery = seedQueryCache(workspacePath, workspaceIdentity, "pinned", {
    items: [],
    total: 0,
  });
  assert.equal(readQueryResult(timelineQuery.queryKey).total, 1, "播种后 timeline total 应为 1");
  assert.equal(readQueryResult(pinnedQuery.queryKey).total, 0, "播种后 pinned total 应为 0");

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
  // 乐观后 query cache total：task 离开 timeline（1→0）、进入 pinned（0→1）。
  assert.equal(readQueryResult(timelineQuery.queryKey).total, 0, "乐观后 timeline total 应 −1");
  assert.equal(readQueryResult(pinnedQuery.queryKey).total, 1, "乐观后 pinned total 应 +1");

  // 回滚阶段（RPC 失败）：复用真实组件回滚阶段的参数形状——previousState 取乐观 nextState（{pinned:true}），
  // nextState 取乐观 previousState（{pinned:false}），是乐观迁移的精确逆变换。
  // 反例（回归钉住）：真实组件曾误传 {pinned:false}→{pinned:false}（非逆变），
  // applyTaskMutation 的两个 descriptor delta 都恒为 0，乐观阶段的 total 改动不会被撤销，
  // timeline total 停在 0、pinned total 停在 1，直到下次服务端 setQueryResult 覆盖。
  // 下面的 total 断言正是能捕获该漂移的检查（非逆变参数会让它们失败）。
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
  // query cache total 精确还原：timeline 回到 1、pinned 回到 0（非逆变回滚会在此暴露漂移）。
  assert.equal(readQueryResult(timelineQuery.queryKey).total, 1, "回滚后 timeline total 应还原为 1");
  assert.equal(readQueryResult(pinnedQuery.queryKey).total, 0, "回滚后 pinned total 应还原为 0");
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

// 反例回归钉住：证明上面 pin 回滚用例的 total 断言是「有牙的」。
// 用真实组件曾误传的非逆变回滚参数（{pinned:false}→{pinned:false}）跑同一序列，
// query cache total 必须停在漂移值（timeline 0、pinned 1）——这正是修复前组件的缺陷。
// 若哪天有人把 total 断言删掉或改松，这条对照用例会说明「为什么不能删」。
test("反例对照：非逆变回滚（{pinned:false}→{pinned:false}）会遗留 query cache total 漂移", () => {
  const workspacePath = "/tmp/ws-pin-drift";
  const workspaceIdentity = "remote-pin-drift";
  const taskId = "t-pin-drift";
  resetRemote(workspacePath, workspaceIdentity);
  useTaskQueryCacheStore.getState().clearAll();
  const item = makeTask(workspacePath, workspaceIdentity, taskId);
  useRemoteTimelineTaskStore.getState().upsertTask(item);
  const timelineQuery = seedQueryCache(workspacePath, workspaceIdentity, "timeline", {
    items: [item],
    total: 1,
  });
  const pinnedQuery = seedQueryCache(workspacePath, workspaceIdentity, "pinned", {
    items: [],
    total: 0,
  });

  // 乐观阶段（正确）。
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

  // 错误的回滚：成员态「同一态 → 同一态」，两个 descriptor 的 delta 都恒为 0。
  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity,
    taskId,
    previousTask: item,
    nextTask: item,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: false, archived: false },
    remoteTimeline: "upsert",
    remotePinned: "remove",
  });

  // 可见行/远端副本靠 wasVisible 分支与 placement 恢复正确……
  assert.deepEqual(readRemoteTimelineIds(workspacePath, workspaceIdentity), [taskId]);
  assert.deepEqual(readRemotePinnedIds(workspacePath, workspaceIdentity), []);
  // ……但 total 计数漂移：乐观阶段的 timeline −1 / pinned +1 没有被撤销。
  // 这两条断言刻画缺陷本身，与上面正确回滚用例的「total 还原」形成对照。
  assert.equal(readQueryResult(timelineQuery.queryKey).total, 0, "非逆变回滚遗留 timeline total 漂移");
  assert.equal(readQueryResult(pinnedQuery.queryKey).total, 1, "非逆变回滚遗留 pinned total 漂移");
});

// FIX 3 身份键不变量（specs/task-meta-cache-ownership.md「身份键不变量」）：
// upsert 的 workspaceKey 从 nextTask.workspaceIdentity 派生，remove 的从 write.workspaceIdentity 派生。
// 二者不等时同一次事务的 upsert/remove 会落到不同键，副本静默 drift。
// 这条用例钉住「mismatched 对不被静默接受」——即调用方必须保证
// nextTask.workspaceIdentity === write.workspaceIdentity，否则写入不落在同一个键上。
test("身份键不变量：nextTask.workspaceIdentity 与 write.workspaceIdentity 不等时 upsert/remove 落到不同键", () => {
  const workspacePath = "/tmp/ws-identity";
  const writeIdentity = "remote-write";
  const taskId = "t-identity";
  // 故意用与 write.workspaceIdentity 不同的 identity 构造 nextTask（违反不变量的调用）。
  const mismatchedNextTask = makeTask(workspacePath, "remote-task", taskId);
  resetRemote(workspacePath, writeIdentity);
  resetRemote(workspacePath, "remote-task");

  // upsert 从 nextTask 派生键 ⇒ 落到 "remote-task" 键，而不是 write 声明的 "remote-write"。
  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity: writeIdentity,
    taskId,
    previousTask: mismatchedNextTask,
    nextTask: mismatchedNextTask,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: false, archived: false },
    remoteTimeline: "upsert",
  });

  const writeKey = buildTaskWorkspaceKey(workspacePath, writeIdentity);
  const taskKey = buildTaskWorkspaceKey(workspacePath, "remote-task");
  // 断言漂移确实发生：upsert 落在 task 派生键，write 声明键为空。
  assert.equal(
    useRemoteTimelineTaskStore.getState().itemsByWorkspaceKey[writeKey],
    undefined,
    "write.workspaceIdentity 键不应被写入（不变量被违反时的后果）",
  );
  assert.deepEqual(
    (useRemoteTimelineTaskStore.getState().itemsByWorkspaceKey[taskKey] ?? []).map((t) => t.taskId),
    [taskId],
    "upsert 落在 nextTask 派生键，与 write 声明键分叉",
  );

  // 随后的 remove 用显式 write.workspaceIdentity ⇒ 只清 write 键，task 键上的副本残留。
  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity: writeIdentity,
    taskId,
    previousTask: mismatchedNextTask,
    nextTask: mismatchedNextTask,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: false, archived: false },
    remoteTimeline: "remove",
  });
  assert.deepEqual(
    (useRemoteTimelineTaskStore.getState().itemsByWorkspaceKey[taskKey] ?? []).map((t) => t.taskId),
    [taskId],
    "remove 清的是 write 键，nextTask 派生键上的副本残留——正是隐式耦合要防的静默 drift",
  );
});

// 不变量成立时（nextTask.workspaceIdentity === write.workspaceIdentity）upsert/remove 落在同一个键，
// 与 FIX 3 反例对照：证明当前所有真实组件调用方（同一 item/meta 流入两处）不触发 drift。
test("身份键不变量（成立）：identity 一致时 upsert 后 remove 精确清空同一个键", () => {
  const workspacePath = "/tmp/ws-identity-ok";
  const workspaceIdentity = "remote-ok";
  const taskId = "t-identity-ok";
  const task = makeTask(workspacePath, workspaceIdentity, taskId);
  resetRemote(workspacePath, workspaceIdentity);

  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity,
    taskId,
    previousTask: task,
    nextTask: task,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: false, archived: false },
    remoteTimeline: "upsert",
  });
  assert.deepEqual(readRemoteTimelineIds(workspacePath, workspaceIdentity), [taskId]);

  writeTaskMetaToCaches({
    workspacePath,
    workspaceIdentity,
    taskId,
    previousTask: task,
    nextTask: task,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: false, archived: false },
    remoteTimeline: "remove",
  });
  assert.deepEqual(readRemoteTimelineIds(workspacePath, workspaceIdentity), []);
});
