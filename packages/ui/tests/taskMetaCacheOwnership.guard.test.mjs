import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// specs/task-meta-cache-ownership.md 守护：task meta 四副本的写入收口在
// lib/taskListMetaSync.ts 的 writeTaskMetaToCaches 事务，组件不得直调
// applyTaskQueryCacheMutation，也不得自己拼 optimistic/remote 多 store 写入。
// 与 services 层 lns.test.mjs（task-index 写入方白名单）同款源码扫描式门禁。
const root = fileURLToPath(new URL("../../../", import.meta.url));

async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? sources(`${dir}/${e.name}`)
        : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")
          ? [`${dir}/${e.name}`]
          : [],
    ),
  );
  return nested.flat();
}

// applyTaskQueryCacheMutation( 调用点的唯一白名单：
// - store/taskQueryCacheStore.ts：函数定义处
// - lib/taskListMetaSync.ts：唯一收口 lib（syncTaskMetaToTaskCaches + writeTaskMetaToCaches）
const ALLOWED_CALLERS = new Set([
  "packages/ui/src/store/taskQueryCacheStore.ts",
  "packages/ui/src/lib/taskListMetaSync.ts",
]);

test("applyTaskQueryCacheMutation 的调用点仅在收口 lib / store 定义处（组件零直调）", async () => {
  const offenders = [];
  for (const file of await sources(root + "packages/ui/src")) {
    const source = await readFile(file, "utf8");
    // 匹配调用点：applyTaskQueryCacheMutation( 。import 行是 `applyTaskQueryCacheMutation,`
    // 或 `applyTaskQueryCacheMutation }`，不带紧跟的 `(`，不会被误判为调用。
    if (!/applyTaskQueryCacheMutation\s*\(/.test(source)) {
      continue;
    }
    const rel = file.slice(root.length).replace(/\\/g, "/");
    if (!ALLOWED_CALLERS.has(rel)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `组件/其他模块不得直调 applyTaskQueryCacheMutation，应经 writeTaskMetaToCaches 事务。违规文件：${offenders.join(", ")}`,
  );
});

// 组件不得绕过事务直接写 remote timeline/pinned 副本的 upsert/removeTask。
// 收口 lib（taskListMetaSync.ts）与两个 remote store 自身除外。
const REMOTE_WRITE_ALLOWED = new Set([
  "packages/ui/src/lib/taskListMetaSync.ts",
  "packages/ui/src/store/remoteTimelineTaskStore.ts",
  "packages/ui/src/store/remotePinnedTaskStore.ts",
]);

test("remote timeline/pinned 副本写入仅经收口 lib（组件不直调 getState().upsertTask/removeTask）", async () => {
  const offenders = [];
  for (const file of await sources(root + "packages/ui/src")) {
    const rel = file.slice(root.length).replace(/\\/g, "/");
    if (REMOTE_WRITE_ALLOWED.has(rel)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    const hits = source.match(
      /useRemote(?:Timeline|Pinned)TaskStore\s*\.getState\(\)[\s\S]{0,40}?\.(?:upsertTask|removeTask)\s*\(/g,
    );
    if (hits) {
      offenders.push(`${rel} (${hits.length})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `组件不得直写 remote timeline/pinned 副本，应经 writeTaskMetaToCaches 事务。违规文件：${offenders.join(", ")}`,
  );
});
