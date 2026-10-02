import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTaskQueryShapeKey,
  TASK_QUERY_CACHE_MAX_RESULTS,
  useTaskQueryCacheStore,
} from "../src/store/taskQueryCacheStore.js";
import {
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
  buildTaskWorkspaceKey,
} from "../src/lib/taskQueryCache.js";

// specs/renderer-memory-budget.md 规则 4 验收：
// 查询缓存同形状 supersede 与 LRU 上限；workspace 失效路径清理对应实体 meta。

function clearAll() {
  useTaskQueryCacheStore.getState().clearAll();
}

let itemSeq = 0;
function makeItem(workspacePath, taskId) {
  itemSeq += 1;
  return {
    taskId,
    workspacePath,
    title: `task-${taskId}`,
    createdAt: 900,
    updatedAt: 1000 + itemSeq,
    status: "completed",
    pinned: false,
    archived: false,
  };
}

function buildDescriptor(workspacePath, { search = "" } = {}) {
  return buildTaskListCacheDescriptor({
    kind: "workspace",
    workspaceScopes: [{ workspacePath }],
    sortBy: "updated",
    search,
    expanded: false,
    visibleLimit: 20,
  });
}

function makeEntry(workspacePath, version, items, { search = "" } = {}) {
  const descriptor = buildDescriptor(workspacePath, { search });
  return {
    queryKey: `${buildTaskListCacheKeyFromDescriptor(descriptor)}::version=${version}`,
    descriptor,
    items,
    total: items.length,
    hasMore: false,
    unreadTaskKeys: [],
  };
}

test("同形状新版本写入后旧版本键被删，条目数不随版本 bump 增长", () => {
  clearAll();
  assert.equal(TASK_QUERY_CACHE_MAX_RESULTS, 64);
  const workspacePath = "/tmp/ws-supersede";
  // 模拟 taskListVersion 连续 bump 6 代：版本化 queryKey 只增不删是
  // renderer 棘轮增长源之一，同形状必须只保留最新版本键。
  for (let version = 0; version <= 5; version += 1) {
    useTaskQueryCacheStore
      .getState()
      .setQueryResults([makeEntry(workspacePath, version, [makeItem(workspacePath, "t1")])]);
  }
  const state = useTaskQueryCacheStore.getState();
  const keys = Object.keys(state.resultsByQueryKey);
  assert.equal(keys.length, 1, `期望只保留 1 条，实际 ${keys.length}: ${keys.join(", ")}`);
  assert.ok(keys[0].endsWith("::version=5"), `应保留最新版本键，实际 ${keys[0]}`);
  assert.equal(state.queryLruOrder.length, 1);
  assert.equal(
    buildTaskQueryShapeKey(keys[0]),
    keys[0].replace(/::version=\d+$/, ""),
    "形状键应剥离版本尾段",
  );

  // 重复 republish 完全等价内容（同一 item 引用）不得新增条目，且应保持状态引用不变。
  const sameItem = makeItem(workspacePath, "t1");
  useTaskQueryCacheStore.getState().setQueryResults([makeEntry(workspacePath, 5, [sameItem])]);
  const stateBefore = useTaskQueryCacheStore.getState();
  useTaskQueryCacheStore.getState().setQueryResults([makeEntry(workspacePath, 5, [sameItem])]);
  const stateAfter = useTaskQueryCacheStore.getState();
  assert.equal(stateAfter, stateBefore, "等价 republish 应保持状态引用不变");
});

test("LRU 总量上限 64：超限淘汰最久未用，刚被重写的查询保留", () => {
  clearAll();
  const workspacePath = "/tmp/ws-lru";
  const store = useTaskQueryCacheStore.getState();
  const shapeKeys = [];
  for (let i = 0; i < TASK_QUERY_CACHE_MAX_RESULTS; i += 1) {
    const entry = makeEntry(workspacePath, 0, [], { search: `query-${i}` });
    shapeKeys.push(entry.queryKey);
    store.setQueryResults([entry]);
  }
  assert.equal(
    Object.keys(useTaskQueryCacheStore.getState().resultsByQueryKey).length,
    TASK_QUERY_CACHE_MAX_RESULTS,
  );

  // 重写最先写入的 query-0（同形状换新版本）：它变成最近使用，旧版本键同时被删。
  const refreshedOldest = makeEntry(workspacePath, 1, [], { search: "query-0" });
  store.setQueryResults([refreshedOldest]);
  // 再写入一个新查询形状，总量超限，此时最久未用的是 query-1。
  store.setQueryResults([makeEntry(workspacePath, 0, [], { search: "query-new" })]);

  const state = useTaskQueryCacheStore.getState();
  const keys = new Set(Object.keys(state.resultsByQueryKey));
  assert.equal(keys.size, TASK_QUERY_CACHE_MAX_RESULTS, "总量必须恒等于上限");
  assert.equal(keys.has(shapeKeys[0]), false, "query-0 旧版本键应被同形状淘汰");
  assert.equal(keys.has(refreshedOldest.queryKey), true, "刚重写的 query-0 新版本键应保留");
  assert.equal(keys.has(shapeKeys[1]), false, "最久未用的 query-1 应被 LRU 淘汰");
  assert.equal(keys.has(shapeKeys[2]), true, "query-2 未超限不应被淘汰");
  assert.equal(state.queryLruOrder.length, TASK_QUERY_CACHE_MAX_RESULTS);
});

test("workspace invalidate 后该 workspace 的 results 与 entity meta 均被清理", () => {
  clearAll();
  const pathA = "/tmp/ws-invalidate-a";
  const pathB = "/tmp/ws-invalidate-b";
  const wsKeyA = buildTaskWorkspaceKey(pathA);
  const store = useTaskQueryCacheStore.getState();

  // workspace A 写两个不同形状的键，验证失效路径跨形状/版本生效。
  const entryAPlain = makeEntry(pathA, 0, [makeItem(pathA, "a1"), makeItem(pathA, "a2")]);
  const entryASearch = makeEntry(pathA, 3, [makeItem(pathA, "a1")], { search: "alpha" });
  const entryB = makeEntry(pathB, 0, [makeItem(pathB, "b1")]);
  store.setQueryResults([entryAPlain, entryASearch, entryB]);

  const entityKeyA1 = `${wsKeyA}::a1`;
  const entityKeyA2 = `${wsKeyA}::a2`;
  const entityKeyB1 = `${buildTaskWorkspaceKey(pathB)}::b1`;
  store.setTaskUnreadOverlay({ taskId: "a1", workspacePath: pathA }, 12345);

  useTaskQueryCacheStore.getState().invalidateWorkspaceKeys([wsKeyA]);

  const state = useTaskQueryCacheStore.getState();
  assert.equal(state.resultsByQueryKey[entryAPlain.queryKey], undefined);
  assert.equal(state.resultsByQueryKey[entryASearch.queryKey], undefined);
  assert.ok(state.resultsByQueryKey[entryB.queryKey], "其它 workspace 的结果必须保留");
  assert.equal(state.taskMetaByEntityKey[entityKeyA1], undefined);
  assert.equal(state.taskMetaByEntityKey[entityKeyA2], undefined);
  assert.ok(state.taskMetaByEntityKey[entityKeyB1], "其它 workspace 的实体 meta 必须保留");
  assert.equal(
    state.taskUnreadOverlayByEntityKey[entityKeyA1],
    undefined,
    "失效 workspace 的 unread overlay 应一并清理",
  );
  assert.ok(
    state.queryLruOrder.every((queryKey) => !queryKey.includes(`workspaces=${wsKeyA}`)),
    "LRU 记录应同步剔除已失效的 query 键",
  );
  assert.equal(state.queryLruOrder.length, 1);
});
