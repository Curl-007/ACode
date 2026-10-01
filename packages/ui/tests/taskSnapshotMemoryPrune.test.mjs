import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createACodeTaskServiceProxy,
  selectRetainedSnapshotEntries,
  SNAPSHOT_CACHE_MAX_ENTRIES,
  SNAPSHOT_CACHE_MAX_TOTAL_BYTES,
} from "../src/hooks/useACodeTaskService.js";
import { uiMemoryDiagnosticsRegistry } from "../src/lib/memoryDiagnostics.js";

// specs/renderer-memory-budget.md 规则 4 验收：
// 任务快照的内存缓存与 localStorage 持久缓存执行同一预算（20 条 / 2MB），每次写入后剪枝。

function fakeService(buildSnapshot) {
  return {
    async getTaskSnapshotWithEtag(params) {
      return {
        notModified: false,
        etag: `etag:${params.taskId}`,
        snapshot: buildSnapshot(params),
      };
    },
  };
}

function buildSnapshot(taskId, fillerSize) {
  return {
    taskId,
    messages: [{ role: "user", content: "x".repeat(fillerSize) }],
  };
}

test("共享剪枝纯函数与持久层同参数：条数上限 20，保留最新", () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({
    updatedAt: 1000 + i,
    sizeBytes: 1024,
  }));
  const retained = selectRetainedSnapshotEntries(entries);
  assert.equal(retained.length, SNAPSHOT_CACHE_MAX_ENTRIES);
  // 排序新→旧：保留的应是 updatedAt 最大的 20 条。
  assert.equal(retained[0].updatedAt, 1024);
  assert.equal(retained[retained.length - 1].updatedAt, 1005);
});

test("共享剪枝纯函数与持久层同参数：总字节上限 2MB", () => {
  const fatEntries = Array.from({ length: 5 }, (_, i) => ({
    updatedAt: 2000 + i,
    sizeBytes: 600 * 1024,
  }));
  const retained = selectRetainedSnapshotEntries(fatEntries);
  const totalBytes = retained.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  assert.ok(retained.length < fatEntries.length, "超字节预算的条目必须被剪掉");
  assert.ok(totalBytes <= SNAPSHOT_CACHE_MAX_TOTAL_BYTES, `totalBytes=${totalBytes}`);
  // 同一输入两次剪枝结果一致（内存层/持久层共用即天然对称）。
  assert.deepEqual(
    selectRetainedSnapshotEntries(fatEntries).map((entry) => entry.updatedAt),
    retained.map((entry) => entry.updatedAt),
  );
});

test("连续写入 25 条不同 key 后内存 Map ≤20 条且总字节 ≤2MB", async () => {
  // 每条约 64KB：25 条共 ~1.6MB，先触达 20 条上限。
  const fillerSize = 64 * 1024;
  const proxy = createACodeTaskServiceProxy(
    fakeService((params) => buildSnapshot(params.taskId, fillerSize)),
  );
  for (let i = 0; i < 25; i += 1) {
    await proxy.getTaskSnapshot({
      workspacePath: "/tmp/snap-ws",
      taskId: `task-${i}`,
      clientMode: "desktop-continuous",
    });
  }
  const diagnostics = uiMemoryDiagnosticsRegistry.collect();
  const entries = diagnostics["taskSnapshotCache.entries"];
  const bytes = diagnostics["taskSnapshotCache.bytes"];
  assert.ok(
    entries <= SNAPSHOT_CACHE_MAX_ENTRIES,
    `内存快照条数应 ≤${SNAPSHOT_CACHE_MAX_ENTRIES}，实际 ${entries}`,
  );
  assert.ok(
    bytes <= SNAPSHOT_CACHE_MAX_TOTAL_BYTES,
    `内存快照字节应 ≤${SNAPSHOT_CACHE_MAX_TOTAL_BYTES}，实际 ${bytes}`,
  );
  assert.ok(bytes > 0, "应统计到内存条目字节");
});

test("单条超预算大头快照也受总字节约束", async () => {
  // 每条 ~600KB，5 条共 ~3MB：字节预算先于条数上限生效。
  const fillerSize = 600 * 1024;
  const proxy = createACodeTaskServiceProxy(
    fakeService((params) => buildSnapshot(params.taskId, fillerSize)),
  );
  for (let i = 0; i < 5; i += 1) {
    await proxy.getTaskSnapshot({
      workspacePath: "/tmp/snap-ws-fat",
      taskId: `fat-${i}`,
      clientMode: "desktop-continuous",
    });
  }
  const diagnostics = uiMemoryDiagnosticsRegistry.collect();
  const entries = diagnostics["taskSnapshotCache.entries"];
  const bytes = diagnostics["taskSnapshotCache.bytes"];
  assert.ok(entries < 5, `字节预算应先于条数上限生效，实际保留 ${entries} 条`);
  assert.ok(
    bytes <= SNAPSHOT_CACHE_MAX_TOTAL_BYTES,
    `内存快照字节应 ≤${SNAPSHOT_CACHE_MAX_TOTAL_BYTES}，实际 ${bytes}`,
  );
});
