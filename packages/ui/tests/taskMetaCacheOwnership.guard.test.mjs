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

// 组件不得绕过事务直接写 remote timeline/pinned 副本的 upsert/removeTask/clearWorkspace。
// 收口 lib（taskListMetaSync.ts）与两个 remote store 自身除外。
//
// FIX 2(2026-10-26 review P3)：此前的守护只匹配 40 字符窗口内的
// `useRemote(Timeline|Pinned)TaskStore.getState().upsertTask/removeTask(` 这一种字面写法，
// 漏掉「先解构再写」（const s = useRemoteTimelineTaskStore.getState(); s.upsertTask(...)）
// 与「selector 取写方法」（useRemoteTimelineTaskStore((s) => s.upsertTask)）等绕过形态。
// 现改为**按引用扫描**：任何 .tsx 组件只要引用了这两个 remote store，就断言它
// (a) 不出现任何写方法名（upsertTask/removeTask/clearWorkspace）——只读订阅/只读命令
//     的消费者没有理由提及写方法；且
// (b) 对该 store 的 .getState() 调用只能是显式登记的只读命令（refreshWorkspace）。
// 三种绕过形态（直接、先解构、selector）都会命中 (a) 或 (b)。
const REMOTE_WRITE_ALLOWED = new Set([
  "packages/ui/src/lib/taskListMetaSync.ts",
  "packages/ui/src/store/remoteTimelineTaskStore.ts",
  "packages/ui/src/store/remotePinnedTaskStore.ts",
]);

// .getState() 只读命令白名单：key = 相对文件路径，value = 该文件允许经 getState() 调用的只读命令。
// WorkspaceTimelineTasksSection.tsx 的 refreshWorkspace 是「拉取远端列表」的只读命令，
// 不写 task meta 副本（写入统一经 writeTaskMetaToCaches），故显式登记放行。
const REMOTE_GETSTATE_READONLY_COMMANDS = new Map([
  ["packages/ui/src/WorkspaceTimelineTasksSection.tsx", new Set(["refreshWorkspace"])],
]);

const REMOTE_STORE_REF_RE = /useRemote(?:Timeline|Pinned)TaskStore\b/;
// 写方法名按**裸词**匹配（不要求紧跟 `(`），这样三种绕过形态都会命中：
// 直接 `getState().upsertTask(...)`、先解构 `const s = getState(); s.removeTask(...)`、
// selector `useRemotePinnedTaskStore((s) => s.clearWorkspace)`。
// 组件的只读订阅只挑 itemsByWorkspaceKey/loadingByWorkspaceKey/totalByWorkspaceKey/
// hasMoreByWorkspaceKey 等读字段，不会提及任何写方法名，故裸词匹配不会误伤只读消费者。
const REMOTE_WRITE_METHOD_RE = /\b(?:upsertTask|removeTask|clearWorkspace)\b/g;
// getState() 调用后紧跟的成员名（允许换行/空白）；解构-first 形态会在此拿到 `undefined`（裸 getState()）。
const REMOTE_GETSTATE_MEMBER_RE =
  /useRemote(?:Timeline|Pinned)TaskStore\s*\.\s*getState\s*\(\s*\)\s*(?:\.\s*([A-Za-z_$][\w$]*))?/g;

test("remote timeline/pinned 副本写入仅经收口 lib（组件不直调写方法，含解构/selector 绕过形态）", async () => {
  const offenders = [];
  for (const file of await sources(root + "packages/ui/src")) {
    const rel = file.slice(root.length).replace(/\\/g, "/");
    if (REMOTE_WRITE_ALLOWED.has(rel)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    if (!REMOTE_STORE_REF_RE.test(source)) {
      continue;
    }

    // (a) 只读消费者不得出现任何 remote store 写方法名——覆盖直接/解构-first/selector 三种形态。
    const writeHits = [...new Set(source.match(REMOTE_WRITE_METHOD_RE) ?? [])];
    if (writeHits.length > 0) {
      offenders.push(`${rel} 提及 remote 副本写方法 [${writeHits.join(", ")}]`);
    }

    // (b) 对 remote store 的 getState() 调用只能是显式登记的只读命令。
    const allowedCommands = REMOTE_GETSTATE_READONLY_COMMANDS.get(rel) ?? new Set();
    for (const match of source.matchAll(REMOTE_GETSTATE_MEMBER_RE)) {
      const command = match[1];
      if (command && allowedCommands.has(command)) {
        continue;
      }
      offenders.push(
        `${rel} 经 getState() 调用未登记的 remote store 成员 ${command ? `"${command}"` : "（解构-first/裸 getState()）"}`,
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `组件不得直写 remote timeline/pinned 副本，应经 writeTaskMetaToCaches 事务。违规：${offenders.join("; ")}`,
  );
});
